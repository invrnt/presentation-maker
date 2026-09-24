import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'pm-linux-test-'));
process.env.PRESENTATION_MAKER_DATA_DIR = data;
const { handle } = await import('./server.ts');
const request = (path: string, method = 'GET', value?: unknown) => handle(new Request(`http://127.0.0.1:3210${path}`, { method, body: value ? JSON.stringify(value) : undefined, headers: value ? { 'Content-Type': 'application/json' } : undefined }));

test('local projects persist and export a valid PPTX without remote calls', async () => {
  expect((await request('/api/health').then(r => r.json())).mode).toBe('linux-local');
  const created = await request('/api/projects', 'POST').then(r => r.json());
  const doc = created.document;
  doc.title = 'Prueba local';
  doc.slides[0].elements.push({ type: 'text', id: 'title', x: 100, y: 100, width: 1200, height: 200, text: 'Hola & Linux', fontSize: 60, fontWeight: 700, color: '#17211b', align: 'center' });
  expect((await request(`/api/projects/${doc.id}`, 'PUT', doc)).status).toBe(200);
  const read = await request(`/api/projects/${doc.id}`).then(r => r.json());
  expect(read.document.slides[0].elements[0].text).toBe('Hola & Linux');
  const result = await request(`/api/projects/${doc.id}/export`, 'POST').then(r => r.json());
  const file = await request(result.url);
  expect(file.status).toBe(200);
  const bytes = new Uint8Array(await file.arrayBuffer());
  expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b);
  expect((await request('/api/projects').then(r => r.json())).length).toBe(1);
  await rm(data, { recursive: true, force: true });
});

test('blocks remote endpoints and invalid media paths', async () => {
  expect((await request('/api/ai/plan', 'POST')).status).toBe(404);
  expect((await request('/api/admin/users', 'POST')).status).toBe(404);
  expect((await request('/media/assets/..%2Fnope')).status).toBe(404);
});
