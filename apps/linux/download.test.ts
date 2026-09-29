import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from './media.ts';

test('API queues, deduplicates, publishes verified media, embeds it and exposes failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-download-test-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const source = join(dir, 'fixture.mkv');
    await command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '0.3', '-c:v', 'ffv1', source]);
    const data = join(dir, 'data');
    const scratch = join(data, 'cache/media/job-deadbeef');
    await mkdir(scratch, { recursive: true });
    const db = new Database(join(data, 'app.db'), { create: true });
    db.run('CREATE TABLE media (youtube_id TEXT PRIMARY KEY, path TEXT NOT NULL, poster TEXT NOT NULL)');
    db.query('INSERT INTO media VALUES (?,?,?)').run('legacy12345', source, '');
    db.run('CREATE TABLE songs (id TEXT PRIMARY KEY, youtube_url TEXT NOT NULL, title TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0)');
    db.run("INSERT INTO songs VALUES ('legacy12345','https://youtu.be/legacy12345','Legacy',1)");
    db.run('CREATE TABLE download_jobs (id TEXT PRIMARY KEY, youtube_id TEXT NOT NULL, message TEXT NOT NULL, error TEXT NOT NULL, done INTEGER NOT NULL, created_at INTEGER NOT NULL)');
    db.query('INSERT INTO download_jobs VALUES (?,?,?,?,?,?)').run('interrupted', 'legacy12345', 'Descargando', '', 0, Date.now());
    db.close();
    const yt = join(bin, 'yt-dlp');
    await writeFile(yt, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('test');
else if (args.includes('--dump-single-json')) console.log(JSON.stringify({ id: args.at(-1).includes('broken') ? 'broken12345' : 'video123456', title: 'Test', duration: 0.3 }));
else {
  if (args.at(-1).includes('broken')) { console.error('HTTP Error 403 https://example.org/?secret=hidden'); process.exit(1); }
  if (!args.includes('res~1080,hdr:SDR,vcodec:h264,acodec:aac') || !args.includes('--abort-on-unavailable-fragments')) process.exit(2);
  await Bun.sleep(200);
  const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mkv');
  await Bun.write(output, Bun.file(${JSON.stringify(source)}));
  console.log(output);
}
`);
    await chmod(yt, 0o755);
    await writeFile(join(bin, 'deno'), '#!/bin/sh\necho test\n');
    await chmod(join(bin, 'deno'), 0o755);
    const script = join(dir, 'check.ts');
    await writeFile(script, `
import { handle } from ${JSON.stringify(join(import.meta.dir, 'server.ts'))};
const req = async (path, method='GET', value) => {
  const response = await handle(new Request('http://localhost'+path, {method, ...(value ? {body:JSON.stringify(value),headers:{'Content-Type':'application/json'}} : {})}));
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const health = await req('/api/media/health');
const interrupted = await req('/api/jobs/interrupted');
const song = await req('/api/songs/import','POST',{url:'https://youtu.be/video123456'});
const start = await req('/api/songs/'+song.id+'/download','POST');
const duplicate = await req('/api/songs/'+song.id+'/download','POST');
let job;
for (let i=0;i<300;i++) { job=await req('/api/jobs/'+start.jobId); if(job.done) break; await Bun.sleep(50); }
const catalog = await req('/api/songs');
const cached = await req('/api/songs/'+song.id+'/download','POST');
const cacheJob = await req('/api/jobs/'+cached.jobId);
const project = await req('/api/projects','POST');
project.document.slides[0].elements.push({id:'v',type:'video',youtubeId:song.id,x:0,y:0,width:1920,height:1080});
project.document.slides.push({id:'repeat',elements:[{...project.document.slides[0].elements[0]}]});
await req('/api/projects/'+project.id,'PUT',project.document);
const exported = await req('/api/projects/'+project.id+'/export','POST');
const broken = await req('/api/songs/import','POST',{url:'https://youtu.be/broken12345'});
const failure = await req('/api/songs/'+broken.id+'/download','POST');
let failed;
for (let i=0;i<300;i++) { failed=await req('/api/jobs/'+failure.jobId); if(failed.done) break; await Bun.sleep(50); }
console.log(JSON.stringify({health,interrupted,sameJob:start.jobId===duplicate.jobId,job,catalog,cacheJob,exported,failed}));
`);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRESENTATION_MAKER_DATA_DIR: join(dir, 'data') }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.health.ready).toBe(true);
    expect(result.sameJob).toBe(true);
    expect(result.job.done).toBe(true);
    expect(result.job.error).toBe('');
    expect(result.catalog.find(s => s.id === 'video123456').downloaded).toBe(true);
    expect(result.catalog.find(s => s.id === 'legacy12345').downloaded).toBe(false);
    expect(result.interrupted.done).toBe(true);
    expect(result.interrupted.failure.code).toBe('INTERRUPTED');
    expect(existsSync(scratch)).toBe(false);
    expect(result.cacheJob.done).toBe(true);
    expect(result.failed.failure.code).toBe('ACCESS_RESTRICTED');
    expect(result.failed.error).not.toContain('hidden');
    const listing = await command(['unzip', '-l', join(dir, 'data', 'exports', result.exported.filename)]);
    expect(listing).toContain('ppt/media/video1.mp4');
    expect(listing).not.toContain('ppt/media/video2.mp4');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
