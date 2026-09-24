import { API_PASSWORD, API_USERNAME, BASE_URL, LINUX_LOCAL } from './config.ts';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}) as { error?: string });
  return body.error || `Error ${response.status}`;
}

export async function api<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function health(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, ...((await response.json()) as { version?: string }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'sin conexión' };
  }
}

export async function me(): Promise<{ id: string; username: string; role: string }> {
  return api('/api/auth/me');
}

export async function ensureLogin(signal?: AbortSignal): Promise<{ username: string; role: string }> {
  if (LINUX_LOCAL) return { username: 'Local', role: 'normal' };
  try {
    const user = await me();
    return { username: user.username, role: user.role };
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) throw error;
  }
  if (!API_USERNAME || !API_PASSWORD) {
    throw new Error(
      'Faltan PRESENTATION_MAKER_USERNAME y PRESENTATION_MAKER_PASSWORD en el .env del bot.',
    );
  }
  const user = await api<{ username: string; role: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: API_USERNAME, password: API_PASSWORD }),
    signal,
  });
  return { username: user.username, role: user.role };
}

export type TextElement = {
  type: 'text';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: 'left' | 'center' | 'right';
};

export type ImageElement = {
  type: 'image';
  id: string;
  assetId: string;
  url?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: 'contain' | 'cover';
};

export type VideoElement = {
  type: 'video';
  id: string;
  youtubeId: string;
  title?: string;
  posterUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fit: 'contain';
};

export type SlideElement = TextElement | ImageElement | VideoElement;

export type Slide = { id: string; elements: SlideElement[] };

export type ProjectDocument = {
  version: 1;
  id: string;
  title: string;
  slides: Slide[];
};

export type ProjectSummary = {
  id: string;
  title: string;
  document: ProjectDocument;
  createdAt: number;
  updatedAt: number;
};

export type Song = {
  id: string;
  youtubeId: string;
  youtubeUrl: string;
  title: string;
  durationSeconds?: number;
  downloaded: boolean;
  posterUrl?: string;
};

export type AIPlan = {
  summary: string;
  slides: {
    insertAt: number;
    songId: string | null;
    youtubeUrl: string | null;
    texts: Array<{
      text: string;
      x: number | null;
      y: number | null;
      width: number | null;
      height: number | null;
      fontSize: number | null;
      fontWeight: 400 | 700 | null;
      color: string | null;
      align: 'left' | 'center' | 'right' | null;
    }>;
  }[];
  existingSlideTexts: Array<{
    slideId: string;
    texts: Array<{
      text: string;
      x: number | null;
      y: number | null;
      width: number | null;
      height: number | null;
      fontSize: number | null;
      fontWeight: 400 | 700 | null;
      color: string | null;
      align: 'left' | 'center' | 'right' | null;
    }>;
  }>;
};

export function uid(): string {
  return `${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}`;
}

export function summarizeProject(project: ProjectSummary): Record<string, unknown> {
  const doc = project.document;
  return {
    id: project.id,
    title: doc?.title ?? project.title,
    slideCount: doc?.slides?.length ?? 0,
    slides: (doc?.slides ?? []).map((slide, index) => ({
      index,
      id: slide.id,
      elements: slide.elements.map((element) => ({
        type: element.type,
        id: element.id,
        ...(element.type === 'text' ? { text: element.text } : {}),
        ...(element.type === 'video'
          ? { youtubeId: element.youtubeId, title: element.title, downloadedHint: element.posterUrl }
          : {}),
        ...(element.type === 'image' ? { assetId: element.assetId } : {}),
      })),
    })),
  };
}

export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  await ensureLogin(signal);
  return api('/api/projects', { signal });
}

export async function getProject(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
  await ensureLogin(signal);
  return api(`/api/projects/${encodeURIComponent(id)}`, { signal });
}

export async function createProject(signal?: AbortSignal): Promise<ProjectSummary> {
  await ensureLogin(signal);
  return api('/api/projects', { method: 'POST', signal });
}

export async function saveProject(
  document: ProjectDocument,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  await ensureLogin(signal);
  if (document.version !== 1 || !document.id || document.slides.length < 1) {
    throw new Error('El proyecto no es válido: version=1, id y al menos una diapositiva.');
  }
  return api(`/api/projects/${encodeURIComponent(document.id)}`, {
    method: 'PUT',
    body: JSON.stringify(document),
    signal,
  });
}

export async function listSongs(signal?: AbortSignal): Promise<Song[]> {
  await ensureLogin(signal);
  return api('/api/songs', { signal });
}

export async function importSong(url: string, signal?: AbortSignal): Promise<Song> {
  await ensureLogin(signal);
  return api('/api/songs/import', {
    method: 'POST',
    body: JSON.stringify({ url }),
    signal,
  });
}

export async function downloadSong(songId: string, signal?: AbortSignal): Promise<{ jobId: string }> {
  await ensureLogin(signal);
  return api(`/api/songs/${encodeURIComponent(songId)}/download`, {
    method: 'POST',
    signal,
  });
}

export async function waitForJob(
  jobId: string,
  signal: AbortSignal,
  timeoutMs = 180_000,
): Promise<{ message: string; error?: string; done: boolean }> {
  const deadline = Date.now() + timeoutMs;
  const response = await fetch(`${BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/events`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await readError(response));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = { message: '', done: false as boolean, error: undefined as string | undefined };
  try {
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim()) as {
            message?: string;
            done?: boolean;
            error?: string;
          };
          last = {
            message: payload.message ?? last.message,
            done: Boolean(payload.done),
            error: payload.error || undefined,
          };
          if (last.done) return last;
        } catch {
          // ignore partial frames
        }
      }
      if (signal.aborted) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!last.done) throw new Error('La descarga no terminó a tiempo.');
  return last;
}

export async function uploadAsset(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ assetId: string; url: string }> {
  await ensureLogin(signal);
  const form = new FormData();
  const blob = new Blob([bytes], { type: mimeType });
  form.append('file', blob, filename);
  return api('/api/assets', { method: 'POST', body: form, signal });
}

export async function aiPlan(
  message: string,
  project: unknown,
  images: Array<{ mediaType: string; data: string }>,
  signal?: AbortSignal,
): Promise<{ plan: AIPlan; model: string }> {
  await ensureLogin(signal);
  const form = new FormData();
  form.append('message', message);
  form.append('project', JSON.stringify(project));
  for (const image of images) {
    const raw = Buffer.from(image.data, 'base64');
    form.append('images', new Blob([raw], { type: image.mediaType }), 'image');
  }
  return api('/api/ai/plan', { method: 'POST', body: form, signal });
}

export async function exportProject(
  id: string,
  signal?: AbortSignal,
): Promise<{ url: string; filename: string }> {
  await ensureLogin(signal);
  return api(`/api/projects/${encodeURIComponent(id)}/export`, {
    method: 'POST',
    signal,
  });
}

export async function downloadExport(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  await ensureLogin(signal);
  const response = await fetch(`${BASE_URL}${url}`, { signal });
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return new Uint8Array(await response.arrayBuffer());
}
