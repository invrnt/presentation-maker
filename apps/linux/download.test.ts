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
if (args.at(-1)?.includes('/shorts/')) process.exit(91);
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
import { Database } from 'bun:sqlite';
const db = new Database(${JSON.stringify(join(data,'app.db'))});
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
const cachedLink=await req('/api/songs/import','POST',{url:'https://www.youtube.com/shorts/video123456?feature=share'});
if(cachedLink.id!==song.id || !cachedLink.downloaded) throw Error('Canonical cache lookup failed');
const cached = await req('/api/songs/'+song.id+'/download','POST');
const cacheJob = await req('/api/jobs/'+cached.jobId);
// Local profile migration must never invoke the downloader again.
db.query('UPDATE media SET profile=? WHERE youtube_id=?').run('pptx-h264-aac-v2',song.id);
const originalDownloader=await Bun.file(${JSON.stringify(yt)}).text();
await Bun.write(${JSON.stringify(yt)}, '#!/bin/sh\\nexit 93\\n');
const migration=await req('/api/songs/'+song.id+'/download','POST');
let migrated;
for(let i=0;i<300;i++){migrated=await req('/api/jobs/'+migration.jobId);if(migrated.done)break;await Bun.sleep(50);}
if(!migrated.done||migrated.error)throw Error('Local migration failed');
await Bun.write(${JSON.stringify(yt)},originalDownloader);
const project = await req('/api/projects','POST');
for (const alias of ['second12345','third123456']) {
  db.query('INSERT INTO songs VALUES (?,?,?,?)').run(alias,'https://youtu.be/'+alias,alias,1);
  db.query('INSERT INTO media SELECT ?,path,poster,profile FROM media WHERE youtube_id=?').run(alias,song.id);
}
const operation={requestId:'ordered-batch',youtubeIds:[song.id,'third123456',song.id,'second12345']};
const added=await req('/api/projects/'+project.id+'/video-slides','POST',operation);
const replay=await req('/api/projects/'+project.id+'/video-slides','POST',operation);
const check=await req('/api/projects/'+project.id+'/validate');
const failureReq=async(path,method,body) => {const r=await handle(new Request('http://local'+path,{method,body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}));return {status:r.status,...await r.json()};};
const conflict=await failureReq('/api/projects/'+project.id+'/video-slides','POST',{...operation,youtubeIds:[song.id]});
const unavailable=await failureReq('/api/projects/'+project.id+'/video-slides','POST',{requestId:'not-ready',youtubeIds:[song.id,'missing1234']});
const saved=await req('/api/projects/'+project.id);
const stacked=structuredClone(saved.document);
stacked.slides[0].elements.push({...stacked.slides[0].elements[0],id:'other'});
const rejectedSave=await failureReq('/api/projects/'+project.id,'PUT',stacked);
// Old malformed documents must also be rejected at export, even if they bypassed saving.
db.query('UPDATE projects SET document=? WHERE id=?').run(JSON.stringify(stacked),project.id);
const rejectedExport=await failureReq('/api/projects/'+project.id+'/export','POST',{});
db.query('UPDATE projects SET document=? WHERE id=?').run(JSON.stringify(saved.document),project.id);
const exported = await req('/api/projects/'+project.id+'/export','POST');
const withTitle=await req('/api/projects','POST');
withTitle.document.slides[0].elements.push({id:'title',type:'text',text:'Conservar portada',x:0,y:0,width:1920,height:100});
await req('/api/projects/'+withTitle.id,'PUT',withTitle.document);
await Promise.all(['batch-a','batch-b'].map(requestId=>req('/api/projects/'+withTitle.id+'/video-slides','POST',{requestId,youtubeIds:[song.id]})));
const preserved=await req('/api/projects/'+withTitle.id);
const broken = await req('/api/songs/import','POST',{url:'https://youtu.be/broken12345'});
const failure = await req('/api/songs/'+broken.id+'/download','POST');
let failed;
for (let i=0;i<300;i++) { failed=await req('/api/jobs/'+failure.jobId); if(failed.done) break; await Bun.sleep(50); }
console.log(JSON.stringify({preserved,added,replay,check,conflict,unavailable,rejectedSave,rejectedExport,health,interrupted,sameJob:start.jobId===duplicate.jobId,job,catalog,cacheJob,exported,failed}));
`);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRESENTATION_MAKER_DATA_DIR: join(dir, 'data') }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.preserved.document.slides.length).toBe(3);
    expect(result.preserved.document.slides[0].elements[0].text).toBe('Conservar portada');
    expect(result.added.slideCount).toBe(4);
    expect(result.replay.replayed).toBe(true);
    expect(result.replay.addedSlideIds).toEqual(result.added.addedSlideIds);
    expect(result.check.slides.map(s => s.videoIds)).toEqual([['video123456'],['third123456'],['video123456'],['second12345']]);
    expect(result.conflict.failure.code).toBe('REQUEST_CONFLICT');
    expect(result.unavailable.failure.code).toBe('VIDEO_NOT_READY');
    expect(result.rejectedSave.failure.code).toBe('OVERLAPPING_VIDEOS');
    expect(result.rejectedExport.failure.code).toBe('OVERLAPPING_VIDEOS');
    expect(result.exported.validation.slideCount).toBe(4);
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
    expect(listing).toContain('ppt/slides/slide4.xml');
    expect(listing).not.toContain('ppt/slides/slide5.xml');
    for (let i=1;i<=4;i++) {
      const xml=await command(['unzip','-p',join(dir,'data','exports',result.exported.filename),`ppt/slides/slide${i}.xml`]);
      expect(xml.match(/<a:videoFile /g)?.length).toBe(1);
      expect(xml).toContain('<a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/>');
      const rels=await command(['unzip','-p',join(dir,'data','exports',result.exported.filename),`ppt/slides/_rels/slide${i}.xml.rels`]);
      expect(rels).toContain(`Target="../media/video${[1,2,1,3][i-1]}.mp4"`);
    }
    expect(listing).toContain('ppt/media/video1.mp4');
    expect(listing).toContain('ppt/media/video3.mp4');
    expect(listing).not.toContain('ppt/media/video4.mp4');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
