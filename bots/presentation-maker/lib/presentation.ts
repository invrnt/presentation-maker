import type { AIPlan, ProjectDocument, Slide, SlideElement, Song } from './api.ts';
import { downloadSong, importSong, listSongs, uid, waitForJob } from './api.ts';

export function plannedText(
  item: AIPlan['slides'][number]['texts'][number],
  index: number,
  hasVideo: boolean,
): SlideElement {
  const x = Math.max(0, Math.min(1920 - 80, item.x ?? 200));
  const y = Math.max(0, Math.min(1080 - 40, item.y ?? (hasVideo ? 50 + index * 110 : 250 + index * 170)));
  return {
    type: 'text',
    id: uid(),
    x,
    y,
    width: Math.min(item.width ?? 1520, 1920 - x),
    height: Math.min(item.height ?? (hasVideo ? 100 : 140), 1080 - y),
    text: item.text,
    fontFamily: 'Arial',
    fontSize: item.fontSize ?? (hasVideo ? 44 : 64),
    fontWeight: item.fontWeight ?? 700,
    color: item.color ?? '#17211b',
    align: item.align ?? 'center',
  };
}

export function videoElement(song: Song): SlideElement {
  return {
    type: 'video',
    id: uid(),
    youtubeId: song.youtubeId,
    title: song.title,
    posterUrl: song.posterUrl,
    x: 160,
    y: 90,
    width: 1600,
    height: 900,
    fit: 'contain',
  };
}

export async function prepareSong(
  urlOrId: string,
  signal: AbortSignal,
  onStatus?: (message: string) => void,
): Promise<Song> {
  const catalog = await listSongs(signal);
  let song: Song | undefined;
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(urlOrId)) {
    onStatus?.('Obteniendo información de YouTube…');
    song = catalog.find((item) => item.youtubeUrl === urlOrId || item.youtubeId === urlOrId);
    if (!song) song = await importSong(urlOrId, signal);
  } else {
    song = catalog.find((item) => item.id === urlOrId || item.youtubeId === urlOrId);
    if (!song) throw new Error('No encontré esa canción en el repertorio.');
  }
  if (song.downloaded) return song;
  onStatus?.(`Descargando “${song.title}”…`);
  const { jobId } = await downloadSong(song.id, signal);
  await waitForJob(jobId, signal);
  const fresh = await listSongs(signal);
  const ready = fresh.find((item) => item.id === song!.id);
  if (!ready?.downloaded) throw new Error(`No se pudo preparar ${song.title}.`);
  return ready;
}

export async function applyAIPlan(
  document: ProjectDocument,
  plan: AIPlan,
  signal: AbortSignal,
  onStatus?: (message: string) => void,
): Promise<{ document: ProjectDocument; changes: number; summary: string }> {
  const draft: ProjectDocument = JSON.parse(JSON.stringify(document));
  const catalog = await listSongs(signal);
  const originalCount = draft.slides.length;
  const planned = plan.slides
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.insertAt - b.item.insertAt || a.order - b.order);
  let inserted = 0;
  let changes = 0;

  for (const { item } of planned) {
    let song: Song | undefined;
    if (item.songId) {
      song = catalog.find((candidate) => candidate.id === item.songId);
      if (!song) throw new Error(`La IA eligió una canción inexistente: ${item.songId}`);
    } else if (item.youtubeUrl) {
      song = await prepareSong(item.youtubeUrl, signal, onStatus);
    }
    if (song && !song.downloaded) song = await prepareSong(song.youtubeUrl, signal, onStatus);

    const elements: SlideElement[] = [];
    if (song) {
      const video = videoElement(song) as Extract<SlideElement, { type: 'video' }>;
      video.y = item.texts.length ? 190 : 90;
      video.height = item.texts.length ? 800 : 900;
      elements.push(video);
    }
    elements.push(...item.texts.map((text, index) => plannedText(text, index, Boolean(song))));
    if (!elements.length) continue;

    const newSlide: Slide = { id: uid(), elements };
    const baseIndex = Math.max(0, Math.min(originalCount, item.insertAt));
    draft.slides.splice(baseIndex + inserted, 0, newSlide);
    inserted += 1;
    changes += 1;
  }

  for (const edit of plan.existingSlideTexts) {
    const target = draft.slides.find((slide) => slide.id === edit.slideId);
    if (!target) continue;
    const textCount = target.elements.filter((element) => element.type === 'text').length;
    const hasVideo = target.elements.some((element) => element.type === 'video');
    target.elements.push(...edit.texts.map((text, index) => plannedText(text, textCount + index, hasVideo)));
    changes += edit.texts.length;
  }

  if (!changes) throw new Error('La IA no propuso cambios aplicables.');
  return { document: draft, changes, summary: plan.summary };
}
