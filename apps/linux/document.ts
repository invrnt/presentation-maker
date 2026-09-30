/** Validate before persistence AND export (including legacy projects). */
export class DocumentError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function validateDocument(doc: any) {
  const invalid = (message: string): never => { throw new DocumentError('INVALID_DOCUMENT', message); };
  if (!doc || doc.version !== 1 || typeof doc.id !== 'string' || !doc.id || typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 300 || !Array.isArray(doc.slides) || !doc.slides.length || doc.slides.length > 200) invalid('El proyecto requiere título y entre 1 y 200 diapositivas.');
  const slideIds = new Set();
  let videoCount = 0;
  const slides = doc.slides.map((slide: any, index: number) => {
    if (!slide || typeof slide.id !== 'string' || !slide.id || slideIds.has(slide.id) || !Array.isArray(slide.elements) || slide.elements.length > 40) invalid(`Diapositiva ${index + 1}: id repetido o estructura inválida.`);
    slideIds.add(slide.id);
    const ids = new Set();
    const videos: any[] = [];
    for (const e of slide.elements) {
      if (!e || typeof e.id !== 'string' || !e.id || ids.has(e.id) || !['text','image','video'].includes(e.type)) invalid(`Diapositiva ${index + 1}: elemento inválido o id repetido.`);
      ids.add(e.id);
      if (![e.x,e.y,e.width,e.height].every(Number.isFinite) || e.x < 0 || e.y < 0 || e.width <= 0 || e.height <= 0 || e.x + e.width > 1920 || e.y + e.height > 1080) invalid(`Diapositiva ${index + 1}: los elementos deben caber en el lienzo 1920×1080.`);
      if (e.type === 'text' && typeof e.text !== 'string') invalid(`Diapositiva ${index + 1}: falta el texto.`);
      if (e.type === 'image' && !/^[a-zA-Z0-9_-]+\.(png|jpe?g)$/.test(e.assetId || '')) invalid(`Diapositiva ${index + 1}: imagen inválida.`);
      if (e.type === 'video') {
        if (!/^[a-zA-Z0-9_-]{6,20}$/.test(e.youtubeId || '')) invalid(`Diapositiva ${index + 1}: video inválido.`);
        if (videos.some(v => Math.min(v.x+v.width,e.x+e.width) > Math.max(v.x,e.x) && Math.min(v.y+v.height,e.y+e.height) > Math.max(v.y,e.y))) throw new DocumentError('OVERLAPPING_VIDEOS', `Diapositiva ${index + 1}: hay videos superpuestos. Pon cada video en una diapositiva separada con add_video_slides, o distribúyelos sin solaparse.`);
        videos.push(e); videoCount++;
      }
    }
    return { index: index + 1, slideId: slide.id, videoIds: videos.map(v => v.youtubeId), elementCount: slide.elements.length };
  });
  return { slideCount: slides.length, videoCount, slides };
}
