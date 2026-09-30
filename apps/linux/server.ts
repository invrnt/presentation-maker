import { cleanupWorkingFiles } from './retention.ts';
import { Database } from 'bun:sqlite';
import { mkdir, rename, rm, statfs, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { validateDocument, DocumentError } from './document.ts';
import { exportPptx } from './pptx.ts';
import { command, mediaTools, mediaFailure, downloadOptions, formatOptions, normalizeVideo, mediaTimeout, MEDIA_PROFILE } from './media.ts';

// Also supports existing systemd units created before the managed tools directory.
const managedBin = resolve(import.meta.dir, '../../bin');
if (existsSync(join(managedBin, 'yt-dlp'))) process.env.PATH = `${managedBin}${delimiter}${process.env.PATH || ''}`;

const root = resolve(process.env.PRESENTATION_MAKER_DATA_DIR || join(process.env.HOME || '.', '.local/share/presentation-maker-linux'));
for (const path of ['assets', 'cache/media', 'cache/thumbnails', 'exports', 'tmp']) await mkdir(join(root, path), { recursive: true });
const db = new Database(join(root, 'app.db'), { create: true });
db.run('PRAGMA journal_mode=WAL');
db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
db.run('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, youtube_url TEXT NOT NULL, title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0)');
db.run('CREATE TABLE IF NOT EXISTS media (youtube_id TEXT PRIMARY KEY, path TEXT NOT NULL, poster TEXT NOT NULL)');
db.run('CREATE TABLE IF NOT EXISTS download_jobs (id TEXT PRIMARY KEY, youtube_id TEXT NOT NULL, message TEXT NOT NULL, error TEXT NOT NULL, done INTEGER NOT NULL, created_at INTEGER NOT NULL)');
// A restart cannot resume an interrupted ffmpeg/yt-dlp process; report the interruption explicitly.
db.run("UPDATE download_jobs SET message='Interrumpida', error='El servicio se reinició durante la descarga.', done=1 WHERE done=0");
db.query('DELETE FROM download_jobs WHERE done=1 AND created_at<?').run(Date.now() - 7 * 24 * 60 * 60_000);
if (!(db.query('PRAGMA table_info(media)').all() as any[]).some(c => c.name === 'profile')) db.run("ALTER TABLE media ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
// Scratch directories belong only to jobs; interrupted jobs are already marked failed.
for (const entry of await readdir(join(root, 'cache/media'))) {
  if (/^job-[a-f0-9]+$/.test(entry)) await rm(join(root, 'cache/media', entry), { recursive: true, force: true });
}
let downloadQueue = Promise.resolve();
const activeExports = new Set<string>();
const activeDownloads = new Map<string, string>();
type Job = { message: string; error: string; done: boolean };
function getJob(jobId: string): Job | null {
  const row = db.query('SELECT message,error,done FROM download_jobs WHERE id=?').get(jobId) as Job | null;
  return row ? { message: row.message, error: row.error, done: Boolean(row.done), ...(row.error ? { failure: mediaFailure(row.error) } : {}) } : null;
}
function updateJob(jobId: string, patch: Partial<Job>) {
  const current = getJob(jobId)!;
  const next = { ...current, ...patch };
  db.query('UPDATE download_jobs SET message=?,error=?,done=? WHERE id=?').run(next.message, next.error, Number(next.done), jobId);
}
db.run('CREATE TABLE IF NOT EXISTS slide_operations (project_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id, request_id))');
const documentFailure = (e: unknown) => e instanceof DocumentError ? json({ error: e.message, failure: { code: e.code, message: e.message, retryable: false } }, 422) : error('No se pudo completar la operación.', 500);
const id = () => crypto.randomUUID().replaceAll('-', '');
const validId = (s: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(s);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const error = (message: string, status = 400) => json({ error: message }, status);
const rowToProject = (r: any) => ({ id: r.id, title: r.title, document: JSON.parse(r.document), createdAt: r.created_at, updatedAt: r.updated_at });
const songToApi = (r: any) => ({ id: r.id, youtubeId: r.id, youtubeUrl: r.youtube_url, title: r.title, durationSeconds: r.duration, downloaded: r.profile === MEDIA_PROFILE && !!r.path && existsSync(r.path), posterUrl: r.poster && existsSync(r.poster) ? `/media/posters/${basename(r.poster)}` : undefined });
const songs = () => db.query('SELECT s.*,m.path,m.poster,m.profile FROM songs s LEFT JOIN media m ON m.youtube_id=s.id ORDER BY s.title COLLATE NOCASE').all().map(songToApi);
const safeFile = (dir: string, name: string) => basename(name) === name && (dir === 'exports' ? /^[\p{L}\p{N} ._-]{1,100}\.pptx$/u.test(name) : /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/.test(name)) ? join(root, dir, name) : null;
async function body(req: Request) { return req.json().catch(() => null); }
function youtubeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(u.hostname)) return null;
    return u.toString();
  } catch { return null; }
}
async function download(youtubeId: string, url: string, jobId: string) {
  const work = join(root, 'cache/media', `job-${jobId}`);
  const output = join(root, 'cache/media', `${youtubeId}.mp4`);
  try {
    const tools = await mediaTools();
    if (!tools.ready) throw new Error(`Faltan dependencias: ${tools.errors.join(' ')}`);
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw new Error('ENOSPC: se requieren al menos 256 MB libres para iniciar.');
    await mkdir(work, { recursive: true });
    const previous: any = db.query('SELECT path,profile FROM media WHERE youtube_id=?').get(youtubeId);
    const localSource = previous?.path && existsSync(previous.path) ? previous.path : undefined;
    updateJob(jobId, { message: localSource ? 'Actualizando formato desde la caché local…' : 'Descargando la resolución más cercana a 1080p…' });
    const temporary = localSource || (await command(['yt-dlp', ...downloadOptions, ...formatOptions, '--no-simulate', '--print', 'after_move:filepath', '--match-filters', '!is_live', '--merge-output-format', 'mkv', '-o', join(work, 'source.%(ext)s'), '--', url], mediaTimeout())).trim();
    if (!localSource && (!temporary.startsWith(join(work, 'source.')) || resolve(temporary) !== temporary || !existsSync(temporary))) throw new Error('yt-dlp no devolvió el archivo descargado.');
    updateJob(jobId, { message: 'Normalizando y verificando MP4 H.264/AAC…' });
    const converted = join(work, 'normalized.mp4');
    const info = await normalizeVideo(temporary, converted);
    const tempPoster = join(work, 'poster.jpg');
    await command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', converted, '-frames:v', '1', '-q:v', '3', tempPoster]);
    if (!existsSync(tempPoster)) throw new Error('No se pudo generar la miniatura del video.');
    const poster = join(root, 'cache/thumbnails', `${youtubeId}.jpg`);
    await rename(tempPoster, poster);
    await rename(converted, output);
    db.query('INSERT OR REPLACE INTO media (youtube_id,path,poster,profile) VALUES (?,?,?,?)').run(youtubeId, output, poster, MEDIA_PROFILE);
    updateJob(jobId, { message: `Listo: ${info.width}×${info.height}, MP4 H.264/AAC`, done: true });
  } catch (e) {
    const failure = mediaFailure(e);
    updateJob(jobId, { message: failure.message, error: failure.detail, done: true });
  } finally {
    activeDownloads.delete(youtubeId);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (path === '/api/health') return json({ ok: true, version: process.env.PRESENTATION_MAKER_HEADLESS === '1' ? 'headless-bun-1' : 'linux-bun-1', mode: 'linux-local' });
  if (path === '/api/media/health') return json(await mediaTools());
  if (path === '/api/auth/me') return json({ id: 'local', username: 'Local', role: 'normal' });
  if (path === '/api/projects' && method === 'GET') return json(db.query('SELECT * FROM projects ORDER BY updated_at DESC').all().map(rowToProject));
  if (path === '/api/projects' && method === 'POST') {
    const projectId = id(), now = Math.floor(Date.now()/1000);
    const doc = { version: 1, id: projectId, title: new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date()), slides: [{ id: id(), elements: [] }] };
    db.query('INSERT INTO projects VALUES (?,?,?,?,?)').run(projectId, doc.title, JSON.stringify(doc), now, now);
    return json(rowToProject(db.query('SELECT * FROM projects WHERE id=?').get(projectId)), 201);
  }
  const project = /^\/api\/projects\/([^/]+)(?:\/(export|video-slides|validate))?$/.exec(path);
  if (project && validId(project[1])) {
    const projectId = project[1], row: any = db.query('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!row) return error('No encontramos ese proyecto.', 404);
    if (project[2] === 'validate' && method === 'GET') {
      try { return json({ ok: true, ...validateDocument(JSON.parse(row.document)) }); }
      catch (e) { return documentFailure(e); }
    }
    if (project[2] === 'video-slides' && method === 'POST') {
      const input = await body(req);
      if (!input || typeof input.requestId !== 'string' || !validId(input.requestId) || !Array.isArray(input.youtubeIds) || !input.youtubeIds.length || input.youtubeIds.length > 200 || !input.youtubeIds.every((v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{6,20}$/.test(v))) return documentFailure(new DocumentError('INVALID_INPUT', 'Indica requestId y una lista ordenada de youtubeIds preparados.'));
      try {
        const result = db.transaction(() => {
          const fingerprint = JSON.stringify(input.youtubeIds);
          const prior: any = db.query('SELECT input,result FROM slide_operations WHERE project_id=? AND request_id=?').get(projectId,input.requestId);
          if (prior) {
            if (prior.input !== fingerprint) throw new DocumentError('REQUEST_CONFLICT', 'requestId ya fue utilizado con otros videos. Usa uno nuevo para una operación distinta.');
            return { ...JSON.parse(prior.result), replayed: true };
          }
          const doc = JSON.parse((db.query('SELECT document FROM projects WHERE id=?').get(projectId) as any).document);
          validateDocument(doc);
          const catalog = songs();
          const added = input.youtubeIds.map((youtubeId: string) => {
            const song: any = catalog.find((s: any) => s.youtubeId === youtubeId);
            if (!song?.downloaded) throw new DocumentError('VIDEO_NOT_READY', `El video ${youtubeId} no está preparado. Usa prepare_song y consulta get_download_job antes de añadirlo.`);
            return { id: id(), elements: [{ id:id(), type:'video', youtubeId, title:song.title, x:0, y:0, width:1920, height:1080, fit:'cover' }] };
          });
          // Reuse only the untouched placeholder; never discard authored slides.
          if (doc.slides.length === 1 && doc.slides[0].elements.length === 0) doc.slides = [];
          doc.slides.push(...added);
          const summary = validateDocument(doc);
          const result = { ok:true, projectId, addedSlideIds:added.map((s: any) => s.id), ...summary };
          db.query('UPDATE projects SET document=?,updated_at=? WHERE id=?').run(JSON.stringify(doc),Math.floor(Date.now()/1000),projectId);
          db.query('INSERT INTO slide_operations VALUES (?,?,?,?)').run(projectId,input.requestId,fingerprint,JSON.stringify(result));
          return result;
        })();
        return json(result);
      } catch (e) { return documentFailure(e); }
    }
    if (project[2] === 'export' && method === 'POST') {
      try {
        const doc = JSON.parse(row.document);
        const filename = `${doc.title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 70) || 'Presentacion'}-${id()}.pptx`;
        activeExports.add(projectId);
        try { await exportPptx(doc, db, root, join(root, 'exports', filename), activeExports); }
        finally { activeExports.delete(projectId); }
        return json({ url: `/api/exports/${encodeURIComponent(filename)}`, filename, validation: validateDocument(doc) });
      } catch (e) { return e instanceof DocumentError ? documentFailure(e) : error(e instanceof Error ? e.message : String(e), 409); }
    }
    if (method === 'GET' && !project[2]) return json(rowToProject(row));
    if (method === 'PUT' && !project[2]) {
      const doc = await body(req);
      if (!doc || doc.version !== 1 || doc.id !== projectId || typeof doc.title !== 'string' || !Array.isArray(doc.slides) || !doc.slides.length) return error('El proyecto no es válido.');
      try { validateDocument(doc); } catch (e) { return documentFailure(e); }
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
  if (path === '/api/maintenance/cleanup' && method === 'POST') return json(await cleanupWorkingFiles(root, db, Date.now(), activeExports));
  if (path === '/api/songs/import' && method === 'POST') {
    const input = await body(req), link = youtubeUrl(input?.url);
    if (!link) return error('Pega un enlace válido de YouTube.');
    try {
      const parsed = new URL(link);
      const cachedId = parsed.hostname === 'youtu.be' ? parsed.pathname.split('/')[1] : parsed.searchParams.get('v') || (/^\/(shorts|embed|live)\//.test(parsed.pathname) ? parsed.pathname.split('/')[2] : null);
      const cached = songs().find((s: any) => s.youtubeId === cachedId);
      if (cached) return json(cached);
      const meta = JSON.parse(await command(['yt-dlp', ...downloadOptions, '--dump-single-json', '--skip-download', '--', link]));
      if (meta.is_live || meta.live_status === 'is_upcoming') return error('Espera a que termine la transmisión en vivo para descargarla.');
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(meta.id)) return error('YouTube devolvió información inválida.', 502);
      db.query('INSERT INTO songs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,duration=excluded.duration').run(meta.id, link, meta.title || meta.id, Math.floor(meta.duration || 0));
      return json(songs().find((s: any) => s.id === meta.id), 201);
    } catch (e) { const failure = mediaFailure(e); return json({ error: failure.message, failure }, 502); }
  }
  const action = /^\/api\/songs\/([^/]+)\/download$/.exec(path);
  if (action && method === 'POST' && validId(action[1])) {
    const song: any = db.query('SELECT * FROM songs WHERE id=?').get(action[1]);
    if (!song) return error('No encontramos esa canción.', 404);
    const existing = activeDownloads.get(song.id);
    if (existing) return json({ jobId: existing }, 202);
    const jobId = id();
    db.query('INSERT INTO download_jobs VALUES (?,?,?,?,?,?)').run(jobId, song.id, 'En cola…', '', 0, Date.now());
    if (songs().find((s: any) => s.id === song.id)?.downloaded) updateJob(jobId, { done: true, message: 'Listo' });
    else { activeDownloads.set(song.id, jobId); downloadQueue = downloadQueue.then(() => download(song.id, song.youtube_url, jobId)).catch(console.error); }
    return json({ jobId }, 202);
  }
  const jobStatus = /^\/api\/jobs\/([^/]+)$/.exec(path);
  if (jobStatus && method === 'GET' && validId(jobStatus[1])) {
    const job = getJob(jobStatus[1]);
    return job ? json({ jobId: jobStatus[1], ...job }) : error('Descarga no encontrada.', 404);
  }
  const events = /^\/api\/jobs\/([^/]+)\/events$/.exec(path);
  if (events && validId(events[1])) {
    if (!getJob(events[1])) return error('Descarga no encontrada.', 404);
    let cancelled = false;
    return new Response(new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          while (!cancelled && !req.signal.aborted) {
            const job = getJob(events[1])!;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(job)}\n\n`));
            if (job.done) break;
            await Bun.sleep(1000);
          }
          if (!cancelled) controller.close();
        } catch { /* The subscriber disconnected; the job continues. */ }
      },
      cancel() { cancelled = true; }
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }
  for (const [prefix, dir] of [['/media/assets/','assets'], ['/media/posters/','cache/thumbnails'], ['/api/exports/','exports']]) {
    if (path.startsWith(prefix)) {
      const file = safeFile(dir, decodeURIComponent(path.slice(prefix.length)));
      if (!file || !existsSync(file)) return error('Archivo no encontrado.', 404);
      if (dir === 'exports' && method === 'DELETE') { await rm(file,{force:true}); return json({ok:true}); }
      return new Response(Bun.file(file), { headers: dir === 'exports' ? { 'Content-Disposition': `attachment; filename="${basename(file)}"` } : {} });
    }
  }
  if (path.startsWith('/api/') || path.startsWith('/media/') || process.env.PRESENTATION_MAKER_HEADLESS === '1') return error('Ruta no disponible.', 404);
  const dist = resolve(import.meta.dir, 'web/dist');
  const staticPath = resolve(dist, '.' + path);
  if (staticPath.startsWith(dist + '/') && existsSync(staticPath)) return new Response(Bun.file(staticPath));
  return new Response(Bun.file(join(dist, 'index.html')));
}

if (import.meta.main) {
  await cleanupWorkingFiles(root, db);
  let cleaning = false;
  setInterval(async () => { if (cleaning) return; cleaning = true; try { await cleanupWorkingFiles(root, db, Date.now(), activeExports); } catch { console.error('No se pudo completar la limpieza temporal.'); } finally { cleaning = false; } }, 60_000).unref();
  const port = Number(process.env.PRESENTATION_MAKER_PORT || 3210);
  Bun.serve({ hostname: '127.0.0.1', port, fetch: handle });
  console.log(`Presentation Maker Linux: http://127.0.0.1:${port}`);
}
