import { test,expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp,mkdir,writeFile,utimes,symlink,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupWorkingFiles,TTL_MS } from './retention.ts';
test('24h cleanup removes unsent work but preserves songs and active exports',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pm-retention-'));const db=new Database(':memory:');
 try {
  db.run('CREATE TABLE projects (id TEXT,updated_at INTEGER); CREATE TABLE slide_operations(project_id TEXT); CREATE TABLE download_jobs(done INTEGER,created_at INTEGER);');
  const now=Date.now(),old=new Date(now-TTL_MS-1000);
  for(const dir of ['exports','assets','tmp','cache/media','cache/thumbnails'])await mkdir(join(root,dir),{recursive:true});
  for(const file of ['exports/old.pptx','exports/active.pptx','assets/old.png','tmp/partial','cache/media/song.mp4','cache/thumbnails/song.jpg']){await writeFile(join(root,file),'keep or expire');await utimes(join(root,file),old,old);}
  await writeFile(join(root,'exports/new.pptx'),'new');
  await symlink(join(root,'cache/media'),join(root,'tmp/link'));
  db.query('INSERT INTO projects VALUES (?,?)').run('old',Math.floor(old.getTime()/1000));
  db.query('INSERT INTO projects VALUES (?,?)').run('active',Math.floor(old.getTime()/1000));
  db.run("INSERT INTO slide_operations VALUES ('old');");
  const result=await cleanupWorkingFiles(root,db,now,new Set(['active',join(root,'exports/active.pptx')]));
  expect(result.files).toBe(3);
  expect(await Bun.file(join(root,'exports/old.pptx')).exists()).toBe(false);
  for(const file of ['cache/media/song.mp4','cache/thumbnails/song.jpg','exports/new.pptx','exports/active.pptx'])expect(await Bun.file(join(root,file)).exists()).toBe(true);
  expect(db.query('SELECT id FROM projects').all()).toEqual([{id:'active'}]);
  expect(db.query('SELECT * FROM slide_operations').all()).toEqual([]);
 } finally {db.close();await rm(root,{recursive:true,force:true});}
});
