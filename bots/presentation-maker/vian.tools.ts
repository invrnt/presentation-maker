import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { ATTACHMENTS_DIR, LINUX_LOCAL } from './lib/config.ts';
import {
  aiPlan,
  createProject,
  downloadExport,
  ensureLogin,
  exportProject,
  getProject,
  health,
  listProjects,
  listSongs,
  saveProject,
  summarizeProject,
  uid,
  uploadAsset,
  type ProjectDocument,
  type SlideElement,
} from './lib/api.ts';
import { ensureBackend } from './lib/backend.ts';
import { applyAIPlan, prepareSong } from './lib/presentation.ts';

type Ctx = {
  abortSignal: AbortSignal;
  attachments: {
    register(input: { path: string; name: string; mimeType: string }): Promise<unknown> & {
      id?: string;
      name?: string;
    };
  };
  logger: { info(message: string): void; error(message: string): void };
};

const imageUrlPattern = /^https?:\/\/\S+$/i;

function assertId(value: string, field: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error(`${field} inválido.`);
  return value;
}

function assertProjectId(value: string): string {
  return assertId(value, 'projectId');
}

function loadAttachmentBytes(attachmentId: string): { bytes: Uint8Array; name: string; mimeType: string } {
  if (!/^att_[0-9a-f-]{16,64}$/i.test(attachmentId)) throw new Error('attachmentId inválido.');
  const root = resolve(ATTACHMENTS_DIR);
  const path = resolve(join(root, attachmentId));
  if (path !== root && !path.startsWith(root + sep)) throw new Error('Ruta de adjunto no permitida.');
  if (!existsSync(path)) throw new Error('El adjunto no existe o ya expiró. Vuelve a enviar la imagen.');
  const metaPath = `${path}.json`;
  let name = 'imagen.png';
  let mimeType = 'application/octet-stream';
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { name?: string; mimeType?: string };
      if (meta.name) name = meta.name;
      if (meta.mimeType) mimeType = meta.mimeType;
    } catch {
      // metadata optional
    }
  }
  const bytes = readFileSync(path);
  return { bytes: new Uint8Array(bytes), name, mimeType };
}

function pickMime(filename: string, declared: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png') || declared === 'image/png') return 'image/png';
  if (lower.endsWith('.webp') || declared === 'image/webp') return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || declared === 'image/jpeg') return 'image/jpeg';
  return declared.startsWith('image/') ? declared : 'image/jpeg';
}

function ensureExtension(filename: string, mime: string): string {
  if (/\.(jpe?g|png)$/i.test(filename)) return filename;
  if (mime === 'image/png') return filename.replace(/\.\w+$/, '') + '.png';
  return filename.replace(/\.\w+$/, '') + '.jpg';
}

async function withBackend<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const status = await ensureBackend(signal);
  if (!status.ready) {
    const reason = status.authError || status.backendError || status.workerError || 'el backend no quedó listo';
    throw new Error(`Backend no listo: ${reason}`);
  }
  return fn(signal);
}

export default {
  ensure_backend: {
    description:
      'Arranca y valida el servidor local de Presentation Maker. Úsala antes de cualquier otra operación.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input: object, ctx: Ctx) {
      const status = await ensureBackend(ctx.abortSignal);
      ctx.logger.info(`ensure_backend ready=${String(status.ready)}`);
      return status;
    },
  },

  backend_status: {
    description: 'Comprueba salud del backend local y quién está logueado, sin arrancar nada.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input: object) {
      const local = await health();
      let user: unknown = null;
      if (local.ok) {
        try {
          user = await ensureLogin(ctxSafe());
        } catch (error) {
          user = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      return { health: local, user };
    },
  },

  list_projects: {
    description: 'Lista las presentaciones existentes con id, título y número de diapositivas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input: object, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const projects = await listProjects(signal);
        return {
          projects: projects.map((project) => ({
            id: project.id,
            title: project.document?.title ?? project.title,
            slideCount: project.document?.slides?.length ?? 0,
            updatedAt: project.updatedAt,
          })),
        };
      });
    },
  },

  create_project: {
    description:
      'Crea una presentación vacía. Devuelve el proyecto con su primera diapositiva. Opcionalmente la renombra con save_project.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Título deseado. Si se omite, se usa la fecha en español del backend.',
        },
      },
      additionalProperties: false,
    },
    async execute(input: { title?: string }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const project = await createProject(signal);
        if (input.title?.trim()) {
          project.document.title = input.title.trim();
          await saveProject(project.document, signal);
        }
        return { project: summarizeProject(project), document: project.document };
      });
    },
  },

  get_project: {
    description:
      'Obtiene una presentación. Devuelve resumen; con includeDocument=true el JSON completo para editar y guardar.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        includeDocument: { type: 'boolean', default: false },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    async execute(input: { projectId: string; includeDocument?: boolean }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const project = await getProject(assertProjectId(input.projectId), signal);
        const summary = summarizeProject(project);
        return input.includeDocument
          ? { summary, document: project.document }
          : { summary, hint: 'Usa includeDocument=true para obtener el JSON editable.' };
      });
    },
  },

  save_project: {
    description:
      'Guarda el documento completo de una presentación (autosave del editor). Requiere version=1, mismo id y ≥1 diapositiva.',
    inputSchema: {
      type: 'object',
      properties: {
        document: {
          type: 'object',
          properties: {
            version: { type: 'number', const: 1 },
            id: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1, maxLength: 300 },
            slides: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object' } },
          },
          required: ['version', 'id', 'title', 'slides'],
          additionalProperties: false,
        },
      },
      required: ['document'],
      additionalProperties: false,
    },
    async execute(input: { document: ProjectDocument }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const document = input.document;
        assertProjectId(document.id);
        await saveProject(document, signal);
        return { ok: true, projectId: document.id, slideCount: document.slides.length };
      });
    },
  },

  set_project_title: {
    description: 'Cambia el título de una presentación sin tocar las diapositivas.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1, maxLength: 300 },
      },
      required: ['projectId', 'title'],
      additionalProperties: false,
    },
    async execute(input: { projectId: string; title: string }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const project = await getProject(assertProjectId(input.projectId), signal);
        project.document.title = input.title.trim();
        await saveProject(project.document, signal);
        return { ok: true, title: project.document.title };
      });
    },
  },

  add_slide: {
    description:
      'Añade una diapositiva al final (o en insertAt) con elementos ya construidos. Cada elemento necesita type text|image|video y geometría en 1920x1080. Los ids se generan si faltan.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        insertAt: { type: 'integer', minimum: 0, maximum: 200 },
        elements: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['text', 'image', 'video'] },
              x: { type: 'number', minimum: 0, maximum: 1920 },
              y: { type: 'number', minimum: 0, maximum: 1080 },
              width: { type: 'number', minimum: 1, maximum: 1920 },
              height: { type: 'number', minimum: 1, maximum: 1080 },
              text: { type: 'string', maxLength: 4000 },
              fontSize: { type: 'integer', minimum: 12, maximum: 240 },
              fontWeight: { type: 'integer', enum: [400, 700] },
              color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
              align: { type: 'string', enum: ['left', 'center', 'right'] },
              fontFamily: { type: 'string', maxLength: 80 },
              assetId: { type: 'string', maxLength: 120 },
              fit: { type: 'string', enum: ['contain', 'cover'] },
              youtubeId: { type: 'string', maxLength: 64 },
              title: { type: 'string', maxLength: 300 },
              posterUrl: { type: 'string', maxLength: 400 },
            },
            required: ['type', 'x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
        },
      },
      required: ['projectId', 'elements'],
      additionalProperties: false,
    },
    async execute(
      input: {
        projectId: string;
        insertAt?: number;
        elements: Array<Record<string, unknown>>;
      },
      ctx: Ctx,
    ) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const project = await getProject(assertProjectId(input.projectId), signal);
        const elements = input.elements.map((raw) => normalizeElement(raw));
        const slide = { id: uid(), elements };
        const index = input.insertAt ?? project.document.slides.length;
        project.document.slides.splice(Math.max(0, Math.min(project.document.slides.length, index)), 0, slide);
        await saveProject(project.document, signal);
        return { ok: true, slideId: slide.id, slideCount: project.document.slides.length };
      });
    },
  },

  prepare_song: {
    description:
      'Importa (si hace falta) y descarga un video de YouTube hasta que esté listo para embeber. Acepta URL o id del repertorio. Devuelve la canción con downloaded=true.',
    inputSchema: {
      type: 'object',
      properties: {
        urlOrId: { type: 'string', minLength: 4, maxLength: 500 },
      },
      required: ['urlOrId'],
      additionalProperties: false,
    },
    async execute(input: { urlOrId: string }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const song = await prepareSong(input.urlOrId.trim(), signal, (message) => ctx.logger.info(message));
        return { song };
      });
    },
  },

  list_songs: {
    description: 'Lista el repertorio de canciones (id, título, youtubeId, downloaded).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Filtro opcional por título.' },
      },
      additionalProperties: false,
    },
    async execute(input: { query?: string }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const songs = await listSongs(signal);
        const query = input.query?.trim().toLowerCase();
        const filtered = query ? songs.filter((song) => song.title.toLowerCase().includes(query)) : songs;
        return { songs: filtered.slice(0, 50), total: filtered.length };
      });
    },
  },

  upload_image: {
    description:
      'Sube una imagen del usuario (attachmentId de Telegram o base64) y devuelve assetId para usar en un elemento image.',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: {
          type: 'string',
          minLength: 4,
          maxLength: 80,
          description: 'Id opaco de adjunto (att_…). Prefiere esto sobre base64.',
        },
        base64: { type: 'string', minLength: 16, maxLength: 8_000_000 },
        filename: { type: 'string', maxLength: 120 },
        mediaType: { type: 'string', maxLength: 80 },
      },
      additionalProperties: false,
    },
    async execute(
      input: { attachmentId?: string; base64?: string; filename?: string; mediaType?: string },
      ctx: Ctx,
    ) {
      return withBackend(ctx.abortSignal, async (signal) => {
        let bytes: Uint8Array;
        let filename = input.filename || 'imagen.jpg';
        let mediaType = input.mediaType || '';
        if (input.attachmentId) {
          const attachment = loadAttachmentBytes(input.attachmentId);
          bytes = attachment.bytes;
          filename = input.filename || attachment.name;
          mediaType = input.mediaType || attachment.mimeType;
        } else if (input.base64) {
          bytes = new Uint8Array(Buffer.from(input.base64, 'base64'));
        } else {
          throw new Error('Indica attachmentId o base64.');
        }
        const mime = pickMime(filename, mediaType);
        if (mime === 'image/webp') {
          throw new Error('El backend solo acepta JPG o PNG. Convierte la WebP a JPG/PNG y vuelve a enviarla.');
        }
        if (!/image\/(png|jpeg)/.test(mime)) throw new Error('Usa una imagen JPG o PNG.');
        filename = ensureExtension(filename.replace(/[^\w.-]+/g, '_'), mime);
        const asset = await uploadAsset(bytes, filename, mime, signal);
        return { ...asset, mimeType: mime, widthHint: 'coloca el elemento con x,y,width,height en 1920x1080' };
      });
    },
  },

  ...(!LINUX_LOCAL ? { ai_generate_slides: {
    description:
      'Usa el planificador IA de la app (Crear con IA) y aplica el plan al proyecto: inserta diapositivas, textos y videos. Devuelve el documento guardado.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1, maxLength: 5000 },
        imageAttachmentIds: {
          type: 'array',
          maxItems: 4,
          items: { type: 'string', minLength: 4, maxLength: 80 },
        },
        imageUrls: {
          type: 'array',
          maxItems: 4,
          items: { type: 'string', minLength: 8, maxLength: 2000 },
          description: 'URLs de imagen opcionales si no hay adjuntos.',
        },
      },
      required: ['projectId', 'message'],
      additionalProperties: false,
    },
    async execute(
      input: {
        projectId: string;
        message: string;
        imageAttachmentIds?: string[];
        imageUrls?: string[];
      },
      ctx: Ctx,
    ) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const project = await getProject(assertProjectId(input.projectId), signal);
        const images: Array<{ mediaType: string; data: string }> = [];
        for (const id of input.imageAttachmentIds ?? []) {
          const attachment = loadAttachmentBytes(id);
          const mime = pickMime(attachment.name, attachment.mimeType);
          if (!/image\/(png|jpeg|webp)/.test(mime)) continue;
          images.push({ mediaType: mime, data: Buffer.from(attachment.bytes).toString('base64') });
        }
        for (const url of (input.imageUrls ?? []).slice(0, 4 - images.length)) {
          if (!imageUrlPattern.test(url)) continue;
          const response = await fetch(url, { signal });
          if (!response.ok) continue;
          const mime = response.headers.get('content-type') || 'image/jpeg';
          if (!/image\/(png|jpeg|webp)/.test(mime)) continue;
          const buffer = new Uint8Array(await response.arrayBuffer());
          images.push({ mediaType: mime, data: Buffer.from(buffer).toString('base64') });
        }
        const context = {
          id: project.document.id,
          title: project.document.title,
          currentSlideId: project.document.slides[0]?.id ?? null,
          slides: project.document.slides.map((slide, index) => ({
            id: slide.id,
            index,
            elements: slide.elements.map((element) => ({
              type: element.type,
              ...(element.type === 'text' ? { text: element.text } : {}),
              ...(element.type === 'video'
                ? { title: element.title, youtubeId: element.youtubeId }
                : {}),
            })),
          })),
        };
        const result = await aiPlan(input.message.trim(), context, images, signal);
        const applied = await applyAIPlan(project.document, result.plan, signal, (message) =>
          ctx.logger.info(message),
        );
        await saveProject(applied.document, signal);
        return {
          model: result.model,
          summary: applied.summary,
          changes: applied.changes,
          document: applied.document,
        };
      });
    },
  }} : {}),

  export_presentation: {
    description:
      'Exporta la presentación a .pptx y la registra como adjunto. Devuelve attachment para send_attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        filename: { type: 'string', minLength: 3, maxLength: 120 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    async execute(input: { projectId: string; filename?: string }, ctx: Ctx) {
      return withBackend(ctx.abortSignal, async (signal) => {
        const exportResult = await exportProject(assertProjectId(input.projectId), signal);
        const bytes = await downloadExport(exportResult.url, signal);
        const fs = await import('node:fs/promises');
        const os = await import('node:os');
        const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'pptx-'));
        const tempPath = join(tempDir, exportResult.filename);
        await fs.writeFile(tempPath, bytes);
        try {
          const attachment = await ctx.attachments.register({
            path: tempPath,
            name: input.filename?.trim() || exportResult.filename,
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          });
          return {
            message: 'Presentación exportada. Envíala con send_attachment.',
            filename: exportResult.filename,
            bytes: bytes.byteLength,
            attachment,
          };
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      });
    },
  },
};

function ctxSafe(): AbortSignal {
  return new AbortController().signal;
}

function normalizeElement(raw: Record<string, unknown>): SlideElement {
  const type = String(raw.type);
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    x: Number(raw.x),
    y: Number(raw.y),
    width: Number(raw.width),
    height: Number(raw.height),
  };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isFinite(base[key])) throw new Error(`Elemento inválido: ${key}.`);
  }
  if (type === 'text') {
    const text = String(raw.text ?? '');
    if (!text.trim()) throw new Error('El elemento de texto necesita contenido.');
    return {
      type: 'text',
      ...base,
      text,
      fontFamily: String(raw.fontFamily || 'Arial'),
      fontSize: Number(raw.fontSize || 64),
      fontWeight: Number(raw.fontWeight || 700) === 400 ? 400 : 700,
      color: String(raw.color || '#17211b'),
      align: (['left', 'center', 'right'] as const).includes(raw.align as 'left')
        ? (raw.align as 'left' | 'center' | 'right')
        : 'center',
    };
  }
  if (type === 'image') {
    const assetId = String(raw.assetId || '');
    if (!assetId) throw new Error('El elemento image necesita assetId de upload_image.');
    return {
      type: 'image',
      ...base,
      assetId,
      fit: raw.fit === 'cover' ? 'cover' : 'contain',
    };
  }
  if (type === 'video') {
    const youtubeId = String(raw.youtubeId || '');
    if (!youtubeId) throw new Error('El elemento video necesita youtubeId de prepare_song.');
    return {
      type: 'video',
      ...base,
      youtubeId,
      title: raw.title ? String(raw.title) : undefined,
      posterUrl: raw.posterUrl ? String(raw.posterUrl) : undefined,
      fit: 'contain',
    };
  }
  throw new Error(`Tipo de elemento no soportado: ${type}`);
}
