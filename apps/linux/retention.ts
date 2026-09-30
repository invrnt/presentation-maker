import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
export const TTL_MS = 24 * 3600_000;
/** Only app-owned working artifacts; never visit songs, media, credentials or history. */
export async function cleanupWorkingFiles(root: string, db: Database, now = Date.now(), active = new Set<string>()) {
  const cutoff = now - TTL_MS;
  let files = 0, bytes = 0;
  const projects = db.query('SELECT id FROM projects WHERE updated_at <= ?').all(Math.floor(cutoff / 1000)) as {id:string}[];
  db.transaction(() => {
    for (const { id } of projects) if (!active.has(id)) {
      db.query('DELETE FROM slide_operations WHERE project_id=?').run(id);
      db.query('DELETE FROM projects WHERE id=?').run(id);
    }
    db.query('DELETE FROM download_jobs WHERE done=1 AND created_at<=?').run(cutoff);
  })();
  for (const folder of ['exports','assets','tmp']) {
    for (const name of await readdir(join(root,folder)).catch(() => [] as string[])) {
      const path = join(root,folder,name);
      if (active.has(path)) continue;
      const info = await lstat(path).catch(() => undefined);
      if (!info || info.mtimeMs > cutoff || info.isSymbolicLink()) continue;
      await rm(path,{recursive:info.isDirectory(),force:true}); files++; bytes+=info.size;
    }
  }
  return {files,bytes};
}
