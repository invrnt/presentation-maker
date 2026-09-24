import { Database } from 'bun:sqlite';
import { mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { exportPptx } from './pptx.ts';

const root = resolve(process.env.PRESENTATION_MAKER_DATA_DIR || join(process.env.HOME || '.', '.local/share/presentation-maker-linux'));
for (const path of ['assets', 'cache/media', 'cache/thumbnails', 'exports']) await mkdir(join(root, path), { recursive: true });
const db = new Database(join(root, 'app.db'), { create: true });
db.run('PRAGMA journal_mode=WAL');
db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
db.run('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, youtube_url TEXT NOT NULL, title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0)');
db.run('CREATE TABLE IF NOT EXISTS media (youtube_id TEXT PRIMARY KEY, path TEXT NOT NULL, poster TEXT NOT NULL)');
const jobs = new Map<string, { message: string; error: string; done: boolean }>();
const id = () => crypto.randomUUID().replaceAll('-', '');
const validId = (s: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(s);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (message: string, status = 400) => json({ error: message }, status);
const rowToProject = (r: any) => ({ id: r.id, title: r.title, document: JSON.parse(r.document), createdAt: r.created_at, updatedAt: r.updated_at });
const songToApi = (r: any) => ({ id: r.id, youtubeId: r.id, youtubeUrl: r.youtube_url, title: r.title, durationSeconds: r.duration, downloaded: !!r.path && existsSync(r.path), posterUrl: r.poster && existsSync(r.poster) ? `/media/posters/${basename(r.poster)}` : undefined });
const songs = () => db.query('SELECT s.*,m.path,m.poster FROM songs s LEFT JOIN media m ON m.youtube_id=s.id ORDER BY s.title COLLATE NOCASE').all().map(songToApi);
const safeFile = (dir: string, name: string) => basename(name) === name && (dir === 'exports' ? /^[\p{L}\p{N} ._-]{1,100}\.pptx$/u.test(name) : /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/.test(name)) ? join(root, dir, name) : null;
async function body(req: Request) { return req.json().catch(() => null); }
function youtubeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(u.hostname)) return null;
    return u.toString();
  } catch { return null; }
}
async function command(args: string[], timeout = 120_000): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeout);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error((err || out).trim().split('\n').at(-1) || `${args[0]} terminó con código ${code}`);
  return out;
}
async function download(youtubeId: string, url: string, jobId: string) {
  const job = jobs.get(jobId)!;
  const base = join(root, 'cache/media', youtubeId);
  const temporary = `${base}.download.mp4`;
  const output = `${base}.mp4`;
  try {
    job.message = 'Descargando video…';
    await command(['yt-dlp', '--no-playlist', '--no-progress', '--retries', '5', '--fragment-retries', '5', '-f', 'bv*[height<=?1080]+ba/b[height<=?1080]/18/b', '-S', 'res:1080,vcodec:h264,acodec:aac', '--merge-output-format', 'mp4', '-o', temporary, '--', url], 20 * 60_000);
    job.message = 'Preparando MP4…';
    const info = JSON.parse(await command(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', temporary]));
    const codecs = Object.fromEntries(info.streams.map((s: any) => [s.codec_type, s.codec_name]));
    const compatible = codecs.video === 'h264' && (!codecs.audio || codecs.audio === 'aac');
    const converted = `${base}.converted.mp4`;
    await command(['ffmpeg', '-y', '-i', temporary, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', ...(compatible ? ['-c:v', 'copy', '-c:a', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k']), '-tag:v', 'avc1', '-movflags', '+faststart', converted], 20 * 60_000);
    await rename(converted, output);
    const poster = join(root, 'cache/thumbnails', `${youtubeId}.jpg`);
    await command(['ffmpeg', '-y', '-ss', '1', '-i', output, '-frames:v', '1', '-q:v', '3', poster]).catch(() => '');
    db.query('INSERT OR REPLACE INTO media VALUES (?,?,?)').run(youtubeId, output, existsSync(poster) ? poster : '');
    job.message = 'Listo'; job.done = true;
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e); job.done = true;
  } finally { await rm(temporary, { force: true }); await rm(`${base}.converted.mp4`, { force: true }); }
}
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (path === '/api/health') return json({ ok: true, version: 'linux-bun-1', mode: 'linux-local' });
  if (path === '/api/auth/me') return json({ id: 'local', username: 'Local', role: 'normal' });
  if (path === '/api/projects' && method === 'GET') return json(db.query('SELECT * FROM projects ORDER BY updated_at DESC').all().map(rowToProject));
  if (path === '/api/projects' && method === 'POST') {
    const projectId = id(), now = Math.floor(Date.now()/1000);
    const doc = { version: 1, id: projectId, title: new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date()), slides: [{ id: id(), elements: [] }] };
    db.query('INSERT INTO projects VALUES (?,?,?,?,?)').run(projectId, doc.title, JSON.stringify(doc), now, now);
    return json(rowToProject(db.query('SELECT * FROM projects WHERE id=?').get(projectId)), 201);
  }
  const project = /^\/api\/projects\/([^/]+)(?:\/(export))?$/.exec(path);
  if (project && validId(project[1])) {
    const projectId = project[1], row: any = db.query('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!row) return error('No encontramos ese proyecto.', 404);
    if (project[2] === 'export' && method === 'POST') {
      try {
        const doc = JSON.parse(row.document);
        const filename = `${doc.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 90) || 'Presentacion'}.pptx`;
        await exportPptx(doc, db, root, join(root, 'exports', filename));
        return json({ url: `/api/exports/${encodeURIComponent(filename)}`, filename });
      } catch (e) { return error(e instanceof Error ? e.message : String(e), 409); }
    }
    if (method === 'GET' && !project[2]) return json(rowToProject(row));
    if (method === 'PUT' && !project[2]) {
      const doc = await body(req);
      if (!doc || doc.version !== 1 || doc.id !== projectId || typeof doc.title !== 'string' || !Array.isArray(doc.slides) || !doc.slides.length) return error('El proyecto no es válido.');
      db.query('UPDATE projects SET title=?,document=?,updated_at=? WHERE id=?').run(doc.title, JSON.stringify(doc), Math.floor(Date.now()/1000), projectId);
      return json({ ok: true });
    }
  }
  if (path === '/api/assets' && method === 'POST') {
    const form = await req.formData().catch(() => null), file = form?.get('file');
    if (!(file instanceof File) || file.size > 20*1024*1024 || !['image/png','image/jpeg'].includes(file.type)) return error('Usa una imagen JPG o PNG de hasta 20 MB.');
    const ext = file.type === 'image/png' ? '.png' : '.jpg', name = id()+ext;
    await Bun.write(join(root, 'assets', name), file);
    return json({ assetId: name, url: `/media/assets/${name}` }, 201);
  }
  if (path === '/api/songs' && method === 'GET') return json(songs());
  if (path === '/api/songs/import' && method === 'POST') {
    const input = await body(req), link = youtubeUrl(input?.url);
    if (!link) return error('Pega un enlace válido de YouTube.');
    try {
      const meta = JSON.parse(await command(['yt-dlp', '--dump-single-json', '--skip-download', '--no-playlist', '--no-colors', '--', link]));
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(meta.id)) return error('YouTube devolvió información inválida.', 502);
      db.query('INSERT INTO songs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,duration=excluded.duration').run(meta.id, link, meta.title || meta.id, Math.floor(meta.duration || 0));
      return json(songs().find((s: any) => s.id === meta.id), 201);
    } catch (e) { return error(`No se pudo leer el video: ${e instanceof Error ? e.message : String(e)}`, 502); }
  }
  const action = /^\/api\/songs\/([^/]+)\/download$/.exec(path);
  if (action && method === 'POST' && validId(action[1])) {
    const song: any = db.query('SELECT * FROM songs WHERE id=?').get(action[1]);
    if (!song) return error('No encontramos esa canción.', 404);
    const jobId = id(); jobs.set(jobId, { message: 'En cola…', error: '', done: false });
    if (songs().find((s: any) => s.id === song.id)?.downloaded) { jobs.get(jobId)!.done = true; jobs.get(jobId)!.message = 'Listo'; }
    else void download(song.id, song.youtube_url, jobId);
    return json({ jobId }, 202);
  }
  const events = /^\/api\/jobs\/([^/]+)\/events$/.exec(path);
  if (events && validId(events[1])) {
    if (!jobs.has(events[1])) return error('Descarga no encontrada.', 404);
    return new Response(new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (let i=0; i<1200; i++) {
          const job = jobs.get(events[1])!;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job)}\n\n`));
          if (job.done) break;
          await Bun.sleep(1000);
        }
        controller.close();
      }
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }
  for (const [prefix, dir] of [['/media/assets/','assets'], ['/media/posters/','cache/thumbnails'], ['/api/exports/','exports']]) {
    if (path.startsWith(prefix)) {
      const file = safeFile(dir, decodeURIComponent(path.slice(prefix.length)));
      if (!file || !existsSync(file)) return error('Archivo no encontrado.', 404);
      return new Response(Bun.file(file), { headers: dir === 'exports' ? { 'Content-Disposition': `attachment; filename="${basename(file)}"` } : {} });
    }
  }
  if (path.startsWith('/api/') || path.startsWith('/media/')) return error('Ruta no disponible.', 404);
  const dist = resolve(import.meta.dir, 'web/dist');
  const staticPath = resolve(dist, '.' + path);
  if (staticPath.startsWith(dist + '/') && existsSync(staticPath)) return new Response(Bun.file(staticPath));
  return new Response(Bun.file(join(dist, 'index.html')));
}

if (import.meta.main) {
  const port = Number(process.env.PRESENTATION_MAKER_PORT || 3210);
  Bun.serve({ hostname: '127.0.0.1', port, fetch: handle });
  console.log(`Presentation Maker Linux: http://127.0.0.1:${port}`);
}
