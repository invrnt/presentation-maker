import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, normalizeVideo, probe, checkMediaTools, mediaFailure, formatOptions } from './media.ts';

const dir = await mkdtemp(join(tmpdir(), 'pm-media-test-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
const cases = [
  { name: 'webm', video: ['-c:v', 'libvpx-vp9'], audio: ['-c:a', 'libopus'] },
  { name: 'mov', video: ['-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le'], audio: ['-c:a', 'pcm_s16le'] },
  { name: 'avi', video: ['-c:v', 'mpeg4'], audio: ['-c:a', 'libmp3lame'] },
  { name: 'hdr.mkv', video: ['-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'], audio: ['-c:a', 'flac'] },
  { name: 'silent.mkv', video: ['-c:v', 'ffv1', '-pix_fmt', 'yuv444p'], audio: [] },
];
for (const fixture of cases) test(`normalizes and fully decodes ${fixture.name}`, async () => {
  const src = join(dir, `source.${fixture.name}`), dst = join(dir, `${fixture.name}.mp4`);
  await command(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', fixture.audio.length ? 'testsrc2=size=320x180:rate=24' : 'testsrc=size=321x181:rate=24', ...(fixture.audio.length ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : []), '-t', '0.6', ...fixture.video, ...fixture.audio, src]);
  const result = await normalizeVideo(src, dst);
  expect(result.width % 2).toBe(0);
  expect(result.height % 2).toBe(0);
  const info = await probe(dst);
  expect(info.streams[0].codec_name).toBe('h264');
  expect(info.streams[0].pix_fmt).toBe('yuv420p');
  expect(info.streams[0].r_frame_rate).toBe('30/1');
  if (fixture.audio.length) {
    expect(info.streams[1].codec_name).toBe('aac');
    expect(info.streams[1].channels).toBe(2);
  } else expect(info.streams.length).toBe(1);
}, 30_000);

test('rejects corrupt input rather than publishing it', async () => {
  const src = join(dir, 'broken.webm');
  await writeFile(src, 'not a video');
  await expect(normalizeVideo(src, join(dir, 'broken.mp4'))).rejects.toThrow();
});
test('validates actual FFmpeg capabilities on this host', async () => {
  const result = await checkMediaTools();
  expect(result.errors.filter(e => e.includes('FFmpeg'))).toEqual([]);
});
test('reports missing tools and kills timed out process groups', async () => {
  await expect(command(['/no-such-tool'])).rejects.toThrow('No se pudo ejecutar');
  await expect(command(['sh', '-c', 'sleep 60 & wait'], 50)).rejects.toThrow('Tiempo máximo');
});
test('classifies actionable errors without leaking source URLs', () => {
  expect(mediaFailure('No space left on device').code).toBe('DISK_FULL');
  expect(mediaFailure('Connection timed out').retryable).toBe(true);
  expect(mediaFailure('HTTP Error 403 https://example.org/?signed=secret').detail).not.toContain('secret');
});

test('missing host dependencies are reported before download', async () => {
  const path = process.env.PATH;
  process.env.PATH = dir;
  try {
    const result = await checkMediaTools();
    expect(result.ready).toBe(false);
    expect(result.errors.length).toBe(4);
  } finally { process.env.PATH = path; }
});
const ytDlp = Bun.which('yt-dlp');
test.skipIf(!ytDlp)('real yt-dlp selects the nearest resolution including higher-only and portrait sources', async () => {
  for (const [heights, expected, portrait] of [
    [[720,1080,1440],1080,false], [[720,1000,1440],1000,false], [[1440,2160],1440,false], [[720,1080,1440],1080,true],
  ] as [number[], number, boolean][]) {
    const path = join(dir, 'formats.json');
    await writeFile(path, JSON.stringify({ id:'fixture',title:'Fixture',extractor:'generic',extractor_key:'Generic',webpage_url:'https://example.org/video',formats:heights.map(res => ({format_id:`r${res}`,url:`https://example.org/${res}.mp4`,ext:'mp4',vcodec:'h264',acodec:'aac',width:portrait ? res : res*16/9,height:portrait ? res*16/9 : res})) }));
    const chosen = await command([ytDlp!, '--ignore-config', '--load-info-json', path, '--simulate', ...formatOptions, '--print', 'format_id']);
    expect(chosen.trim()).toBe(`r${expected}`);
  }
}, 15_000);
