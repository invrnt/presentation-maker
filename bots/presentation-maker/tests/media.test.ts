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
  await expect(prepareSong(song.id, new AbortController().signal)).rejects.toThrow('Instala FFmpeg');
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

test('prepare_song returns unavailable media as data so Vian preserves the explanation', async () => {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/health') return Response.json({ ok: true, version: 'headless-bun-1' });
    if (path === '/api/media/health') return Response.json({ ready: true, errors: [] });
    if (path === '/api/songs') return Response.json([]);
    return Response.json({ error: 'El video no está disponible.', failure: { code: 'UNAVAILABLE', message: 'El video no está disponible.', retryable: false, detail: 'private diagnostic' } }, { status: 502 });
  }) as typeof fetch;
  const tools = (await import('../vian.tools.ts')).default;
  const result = await tools.prepare_song.execute({ urlOrId: 'https://youtu.be/unavailable' }, { abortSignal: new AbortController().signal, logger: { info() {}, error() {} }, attachments: {} } as any);
  expect(result).toEqual({ ok: false, failure: { code: 'UNAVAILABLE', message: 'El video no está disponible.', retryable: false } });
});
test('export reports transport and attachment limits separately at the 250 MiB boundary', async () => {
  const { exportLimit } = await import('../lib/tool-results.ts');
  const size = 250 * 1024 * 1024;
  const local = { attachments: { maxFileBytes: size }, gate: { telegram: { localApi: true, apiRoot: 'http://127.0.0.1:8081' } } };
  expect(exportLimit(size, local)).toBeUndefined();
  expect(exportLimit(size + 1, local)?.code).toBe('PPTX_TOO_LARGE');
  expect(exportLimit(size, { attachments: { maxFileBytes: size } })?.code).toBe('TELEGRAM_LOCAL_API_REQUIRED');
  expect(exportLimit(size, { ...local, attachments: { maxFileBytes: 50 * 1024 * 1024 } })?.code).toBe('ATTACHMENT_LIMIT');
});
