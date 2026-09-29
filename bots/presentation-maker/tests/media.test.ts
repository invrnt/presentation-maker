import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

(globalThis as any).__VIAN_BOT_ROOT__ = join(import.meta.dir, '..');
const { prepareSong } = await import('../lib/presentation.ts');
const { waitForJob, saveExport } = await import('../lib/api.ts');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const song = { id: 'test1234567', youtubeId: 'test1234567', youtubeUrl: 'https://youtu.be/test1234567', title: 'Test', downloaded: false };

test('prepareSong preserves the actionable job error', async () => {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    return Response.json(path === '/api/songs' ? [song] : path.endsWith('/download') ? { jobId: 'job' } : { done: true, message: 'Faltan herramientas', error: 'ffmpeg ENOENT', failure: { code: 'DEPENDENCY_MISSING', message: 'Instala FFmpeg' } });
  }) as typeof fetch;
  await expect(prepareSong(song.id, new AbortController().signal)).rejects.toThrow('Instala FFmpeg (DEPENDENCY_MISSING): ffmpeg ENOENT');
});
test('a wait deadline returns a pending job rather than a false failure', async () => {
  globalThis.fetch = (async () => Response.json({ done: false, message: 'Normalizando' })) as typeof fetch;
  const job = await waitForJob('long-job', new AbortController().signal, 1);
  expect(job.done).toBe(false);
  expect(job.jobId).toBe('long-job');
});
test('exports are streamed to disk intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-export-test-'));
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([80,75])); c.enqueue(new Uint8Array([1,2,3])); c.close(); } }))) as typeof fetch;
    const path = join(dir, 'test.pptx');
    expect(await saveExport('/export', path)).toBe(5);
    expect([...await readFile(path)]).toEqual([80,75,1,2,3]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a temporary polling failure keeps the job available for later consultation', async () => {
  globalThis.fetch = (async () => { throw new Error('Connection reset'); }) as typeof fetch;
  const job = await waitForJob('retained-job', new AbortController().signal, 1);
  expect(job.done).toBe(false);
  expect(job.jobId).toBe('retained-job');
});
