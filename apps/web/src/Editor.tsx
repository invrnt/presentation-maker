import { useEffect, useMemo, useRef, useState } from "react"
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter"
import { AlignCenter, AlignLeft, AlignRight, ArrowLeft, Check, Download, ImagePlus, LoaderCircle, Plus, Search, Sparkles, Trash2, Type, Upload, Video, X } from "lucide-react"
import { api } from "./api"
import { uid, useEditor } from "./store"
import type { AIPlan, AIPlannedText, ImageElement, Project, Slide, SlideElement, Song, TextElement, VideoElement } from "./types"

const WIDTH = 1920, HEIGHT = 1080
const LOCAL_ONLY = import.meta.env.VITE_LOCAL_ONLY === "1"

function Toolbar({ onImage, onAI }: { onImage: (file: File) => void; onAI: () => void }) {
  const { project, slideId, selectedId, addElement, updateElement, deleteElement } = useEditor()
  const slide = project?.slides.find((item) => item.id === slideId)
  const selected = slide?.elements.find((item) => item.id === selectedId)
  const input = useRef<HTMLInputElement>(null)
  const addText = () => addElement({ type: "text", id: uid(), x: 510, y: 420, width: 900, height: 180, text: "Escribe aquí", fontFamily: "Arial", fontSize: 64, fontWeight: 400, color: "#17211b", align: "center" })
  return <div className="editor-toolbar">
    {!LOCAL_ONLY && <><button className="ai-tool" onClick={onAI}><Sparkles size={17}/> Crear con IA</button><span className="tool-divider"/></>}
    <button onClick={addText}><Type size={17}/> Texto</button>
    <button onClick={() => input.current?.click()}><ImagePlus size={17}/> Imagen</button>
    <input ref={input} hidden type="file" accept="image/png,image/jpeg" onChange={(e) => e.target.files?.[0] && onImage(e.target.files[0])}/>
    {selected?.type === "text" && <>
      <span className="tool-divider"/>
      <select aria-label="Fuente" value={selected.fontFamily} onChange={(e) => updateElement(selected.id, { fontFamily: e.target.value })}>{["Calibri","Arial","Verdana","Georgia","Times New Roman","Trebuchet MS"].map((font) => <option key={font}>{font}</option>)}</select>
      <input className="size-input" aria-label="Tamaño" type="number" min={12} max={240} value={selected.fontSize} onChange={(e) => updateElement(selected.id, { fontSize: Number(e.target.value) })}/>
      <button className={selected.fontWeight >= 700 ? "active" : ""} onClick={() => updateElement(selected.id, { fontWeight: selected.fontWeight >= 700 ? 400 : 700 })}><strong>B</strong></button>
      {(["left", "center", "right"] as const).map((align) => <button key={align} className={selected.align === align ? "active" : ""} onClick={() => updateElement(selected.id, { align })}>{align === "left" ? <AlignLeft size={17}/> : align === "center" ? <AlignCenter size={17}/> : <AlignRight size={17}/>}</button>)}
      <input className="color-input" aria-label="Color" type="color" value={selected.color} onChange={(e) => updateElement(selected.id, { color: e.target.value })}/>
    </>}
    {selected?.type === "image" && <button onClick={() => updateElement(selected.id, { fit: selected.fit === "cover" ? "contain" : "cover" })}>Ajuste: {selected.fit === "cover" ? "recortar" : "completo"}</button>}
    {selected && <><span className="tool-divider"/><button className="danger-tool" onClick={deleteElement}><Trash2 size={16}/> Eliminar</button></>}
  </div>
}

function ElementView({ item, scale }: { item: SlideElement; scale: number }) {
  const { selectedId, selectElement, updateElement } = useEditor()
  const start = useRef<{ x: number; y: number; left: number; top: number; width: number; height: number; resize: boolean } | null>(null)
  function pointerDown(e: React.PointerEvent, resize = false) { e.stopPropagation(); selectElement(item.id); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY, left: item.x, top: item.y, width: item.width, height: item.height, resize } }
  function pointerMove(e: React.PointerEvent) { if (!start.current) return; const dx = (e.clientX - start.current.x) / scale, dy = (e.clientY - start.current.y) / scale; if (start.current.resize) updateElement(item.id, { width: Math.max(80, start.current.width + dx), height: Math.max(50, start.current.height + dy) }); else updateElement(item.id, { x: Math.max(0, Math.min(WIDTH - item.width, start.current.left + dx)), y: Math.max(0, Math.min(HEIGHT - item.height, start.current.top + dy)) }) }
  const style = { left: `${item.x / WIDTH * 100}%`, top: `${item.y / HEIGHT * 100}%`, width: `${item.width / WIDTH * 100}%`, height: `${item.height / HEIGHT * 100}%` }
  return <div className={`canvas-element ${selectedId === item.id ? "selected" : ""}`} style={style} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { start.current = null }}>
    {item.type === "text" && <div className="text-element" contentEditable suppressContentEditableWarning style={{ fontFamily: item.fontFamily, fontSize: item.fontSize * scale, fontWeight: item.fontWeight, color: item.color, textAlign: item.align }} onBlur={(e) => updateElement(item.id, { text: e.currentTarget.textContent || "" })}>{item.text}</div>}
    {item.type === "image" && <img draggable={false} src={item.url || `/media/assets/${item.assetId}`} style={{ objectFit: item.fit }} />}
    {item.type === "video" && <div className="video-element">{item.posterUrl ? <img draggable={false} src={item.posterUrl}/> : <div className="video-placeholder"><Video/><span>{item.title || "Video"}</span></div>}<span className="video-badge"><Video size={13}/> VIDEO</span></div>}
    {selectedId === item.id && <span className="resize-handle" onPointerDown={(e) => pointerDown(e, true)} onPointerMove={pointerMove} onPointerUp={() => { start.current = null }}/>} 
  </div>
}

function Canvas({ onImage }: { onImage: (file: File) => void }) {
  const { project, slideId, selectElement } = useEditor(); const wrap = useRef<HTMLDivElement>(null); const [scale, setScale] = useState(.5)
  const slide = project?.slides.find((item) => item.id === slideId)
  useEffect(() => { const resize = () => { if (wrap.current) setScale(Math.min(wrap.current.clientWidth / WIDTH, wrap.current.clientHeight / HEIGHT)) }; resize(); addEventListener("resize", resize); return () => removeEventListener("resize", resize) }, [])
  function drop(e: React.DragEvent) { e.preventDefault(); const file = [...e.dataTransfer.files].find((item) => item.type.startsWith("image/")); if (file) onImage(file) }
  return <div ref={wrap} className="canvas-wrap" onClick={() => selectElement(null)} onDragOver={(e) => e.preventDefault()} onDrop={drop}>
    <div className="canvas" style={{ width: WIDTH * scale, height: HEIGHT * scale }}>{slide?.elements.map((item) => <ElementView key={item.id} item={item} scale={scale}/>)}</div>
  </div>
}

function SlideThumb({ slide, index }: { slide: Slide; index: number }) {
  const ref = useRef<HTMLButtonElement>(null); const { slideId, selectSlide, reorder } = useEditor()
  useEffect(() => { const element = ref.current; if (!element) return; return draggable({ element, getInitialData: () => ({ slideId: slide.id }) }) }, [slide.id])
  useEffect(() => { const element = ref.current; if (!element) return; return dropTargetForElements({ element, getData: () => ({ slideId: slide.id }), onDrop: ({ source }) => { const from = String(source.data.slideId || ""); if (from) reorder(from, slide.id) } }) }, [slide.id, reorder])
  return <button ref={ref} className={`slide-thumb ${slideId === slide.id ? "active" : ""}`} onClick={() => selectSlide(slide.id)}><div className="mini-canvas">{slide.elements.slice(0, 8).map((item) => <span key={item.id} className={`mini-${item.type}`} style={{ left: `${item.x/WIDTH*100}%`, top: `${item.y/HEIGHT*100}%`, width: `${item.width/WIDTH*100}%`, height: `${item.height/HEIGHT*100}%` }}/>)}</div><span>{index + 1}</span></button>
}

function Timeline() {
  const { project, slideId, addSlide, duplicateSlide, deleteSlide } = useEditor()
  return <div className="timeline"><div className="slides-row">{project?.slides.map((slide, index) => <div className="slide-slot" key={slide.id}><SlideThumb slide={slide} index={index}/><button title="Insertar diapositiva" className="insert-slide" onClick={() => addSlide(slide.id)}><Plus size={14}/></button></div>)}</div><div className="timeline-actions"><button onClick={duplicateSlide}>Duplicar</button><button onClick={deleteSlide} disabled={project?.slides.length === 1 || !slideId}><Trash2 size={15}/> Eliminar</button></div></div>
}

async function prepareSong(song: Song, onStatus: (message: string) => void): Promise<Song> {
  if (song.downloaded) return song
  onStatus(`Preparando ${song.title}…`)
  const { jobId } = await api.downloadSong(song.id)
  await new Promise<void>((resolve, reject) => {
    const events = new EventSource(`/api/jobs/${jobId}/events`)
    events.onmessage = (event) => {
      const data = JSON.parse(event.data)
      onStatus(data.message)
      if (data.done) { events.close(); data.error ? reject(new Error(data.error)) : resolve() }
    }
    events.onerror = () => { events.close(); reject(new Error("Se perdió la conexión con la descarga.")) }
  })
  const songs = await api.songs()
  const ready = songs.find((item) => item.id === song.id)
  if (!ready?.downloaded) throw new Error(`No se pudo preparar ${song.title}.`)
  return ready
}

function AIModal({ project, currentSlideId, onClose, onApply }: { project: Project; currentSlideId: string | null; onClose: () => void; onApply: (plan: AIPlan, setStatus: (message: string) => void) => Promise<void> }) {
  const [message, setMessage] = useState("")
  const [images, setImages] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose() }; addEventListener("keydown", close); return () => removeEventListener("keydown", close) }, [busy, onClose])
  function addFiles(files: File[]) {
    const accepted = files.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= 4 * 1024 * 1024)
    setImages((current) => [...current, ...accepted].slice(0, 4))
    if (accepted.length !== files.length) setError("Usa hasta cuatro imágenes PNG, JPG o WebP de menos de 4 MB.")
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!message.trim() && !images.length) return
    setBusy(true); setError(""); setStatus("Leyendo tu solicitud…")
    try {
      const context = { id: project.id, title: project.title, currentSlideId, slides: project.slides.map((slide, index) => ({ id: slide.id, index, elements: slide.elements.map((item) => ({ type: item.type, ...(item.type === "text" ? { text: item.text } : {}), ...(item.type === "video" ? { title: item.title, youtubeId: item.youtubeId } : {}) })) })) }
      const result = await api.aiPlan(message.trim(), images, context)
      setStatus("Aplicando el plan…")
      await onApply(result.plan, setStatus)
      setStatus("Listo")
      setTimeout(onClose, 450)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo procesar la solicitud.")
      setStatus(""); setBusy(false)
    }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="ai-modal" role="dialog" aria-modal="true" aria-labelledby="ai-title"><header><div><span className="ai-modal-mark"><Sparkles size={20}/></span><div><p className="eyebrow">ASISTENTE DE PRESENTACIÓN</p><h2 id="ai-title">¿Qué quieres preparar?</h2></div></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Cerrar"><X size={20}/></button></header><form onSubmit={submit}><div className="ai-composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles([...event.dataTransfer.files]) }}><textarea autoFocus value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ejemplo: crea las diapositivas para estas canciones en el orden de la captura y añade una portada que diga Noche de alabanza"/><div className="ai-attachments">{images.map((file, index) => <span key={`${file.name}-${index}`}><ImagePlus size={14}/><span>{file.name}</span><button type="button" onClick={() => setImages((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Quitar ${file.name}`}><X size={13}/></button></span>)}</div><div className="ai-drop-row"><button type="button" onClick={() => input.current?.click()}><Upload size={16}/> Adjuntar imágenes</button><small>También puedes arrastrarlas aquí · máximo 4</small><input ref={input} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => addFiles([...(event.target.files || [])])}/></div></div>{status && <p className="ai-status"><LoaderCircle className={busy ? "spin" : ""} size={16}/>{status}</p>}{error && <p className="form-error">{error}</p>}<footer><button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="primary ai-submit" disabled={busy || (!message.trim() && !images.length)}>{busy ? <LoaderCircle className="spin" size={17}/> : <Sparkles size={17}/>} {busy ? "Procesando…" : "Procesar con IA"}</button></footer></form></section></div>
}

function SongPanel({ addVideo }: { addVideo: (song: Song) => void }) {
  const [songs, setSongs] = useState<Song[]>([]); const [query, setQuery] = useState(""); const [busy, setBusy] = useState(""); const [status, setStatus] = useState(""); const [error, setError] = useState("")
  const youtube = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(query.trim())
  useEffect(() => { api.songs().then(setSongs).catch(() => setStatus("Sin conexión. Mostrando el catálogo guardado.")) }, [])
  const filtered = useMemo(() => songs.filter((song) => song.title.toLowerCase().includes(query.toLowerCase())), [songs, query])
  async function importSong() { setBusy("import"); setStatus("Obteniendo información…"); setError(""); try { const song = await api.importSong(query.trim()); setSongs((items) => [song, ...items.filter((item) => item.id !== song.id)]); setQuery(""); await download(song) } catch (e) { setError(e instanceof Error ? e.message : "No se pudo añadir la canción.") } finally { setBusy("") } }
  async function download(song: Song) { setBusy(song.id); setError(""); try { const ready = await prepareSong(song, setStatus); const fresh = await api.songs(); setSongs(fresh); addVideo(ready) } catch (e) { setError(e instanceof Error ? e.message : "No se pudo descargar el video.") } finally { setBusy(""); setStatus("") } }
  async function choose(song: Song) { if (song.downloaded) addVideo(song); else await download(song) }
  return <aside className="song-panel"><div className="song-heading"><div><p className="eyebrow">REPERTORIO</p><h2>Canciones</h2></div><button className="icon-button" title="Actualizar" onClick={() => api.songs().then(setSongs)}><LoaderCircle size={17}/></button></div><div className="smart-search"><Search size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar o pegar enlace de YouTube"/></div>{youtube && <button className="add-youtube" disabled={busy === "import"} onClick={importSong}><Plus size={18}/><span><strong>Añadir desde YouTube</strong><small>{query.trim()}</small></span></button>}{status && <p className="download-status"><LoaderCircle className="spin" size={16}/>{status}</p>}{error && <p className="panel-error">{error}</p>}<div className="song-list">{!youtube && filtered.map((song) => <button key={song.id} className="song-row" onClick={() => choose(song)} disabled={!!busy}><span><strong>{song.title}</strong>{song.durationSeconds && <small>{Math.floor(song.durationSeconds/60)}:{String(song.durationSeconds%60).padStart(2,"0")}</small>}</span>{busy === song.id ? <LoaderCircle className="spin" size={18}/> : song.downloaded ? <Check className="ready" size={18}/> : <Download size={18}/>}</button>)}{!youtube && !filtered.length && <p className="empty-list">{query ? "No hay coincidencias." : "Pega un enlace de YouTube para añadir la primera canción."}</p>}</div></aside>
}

export function Editor({ id, onBack }: { id: string; onBack: () => void }) {
  const { project, slideId, dirty, setProject, applyProject, addElement, addSlide, selectSlide, markSaved, deleteElement, duplicateSlide, deleteSlide } = useEditor()
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [exporting, setExporting] = useState(false); const [aiOpen, setAiOpen] = useState(false)
  useEffect(() => { api.project(id).then((result) => setProject(result.document)).catch((e) => setError(e.message)).finally(() => setLoading(false)) }, [id, setProject])
  useEffect(() => { if (!dirty || !project) return; const timer = setTimeout(() => api.saveProject(project).then(markSaved).catch((e) => setError(e.message)), 450); return () => clearTimeout(timer) }, [dirty, project, markSaved])
  useEffect(() => { const key = (e: KeyboardEvent) => { const tag = (e.target as HTMLElement).tagName; if (["INPUT","TEXTAREA","SELECT"].includes(tag)) return; if (e.key === "Delete" || e.key === "Backspace") deleteElement(); if (e.ctrlKey && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSlide() } }; addEventListener("keydown", key); return () => removeEventListener("keydown", key) }, [deleteElement, duplicateSlide])
  async function upload(file: File) { try { const asset = await api.upload(file); const element: ImageElement = { type: "image", id: uid(), assetId: asset.assetId, url: asset.url, x: 460, y: 190, width: 1000, height: 700, fit: "contain" }; addElement(element) } catch (e) { setError(e instanceof Error ? e.message : "No se pudo añadir la imagen.") } }
  function addVideo(song: Song) { if (!project || !slideId) return; let target = project.slides.find((slide) => slide.id === slideId); if (target && target.elements.length) { addSlide(slideId); setTimeout(() => { const state = useEditor.getState(); const current = state.project?.slides.find((slide) => slide.id === state.slideId); if (current) state.addElement(video(song)) }, 0) } else addElement(video(song)) }
  const video = (song: Song): VideoElement => ({ type: "video", id: uid(), youtubeId: song.youtubeId, title: song.title, posterUrl: song.posterUrl, x: 160, y: 90, width: 1600, height: 900, fit: "contain" })
  function plannedText(item: AIPlannedText, index: number, hasVideo: boolean): TextElement {
    const x = Math.max(0, Math.min(WIDTH - 80, item.x ?? 200)); const y = Math.max(0, Math.min(HEIGHT - 40, item.y ?? (hasVideo ? 50 + index * 110 : 250 + index * 170)))
    return { type: "text", id: uid(), x, y, width: Math.min(item.width ?? 1520, WIDTH - x), height: Math.min(item.height ?? (hasVideo ? 100 : 140), HEIGHT - y), text: item.text, fontFamily: "Arial", fontSize: item.fontSize ?? (hasVideo ? 44 : 64), fontWeight: item.fontWeight ?? 700, color: item.color ?? "#17211b", align: item.align ?? "center" }
  }
  async function applyAIPlan(plan: AIPlan, setStatus: (message: string) => void) {
    if (!project) return
    const catalog = await api.songs(); const draft: Project = JSON.parse(JSON.stringify(project)); const originalCount = draft.slides.length
    const planned = plan.slides.map((item, order) => ({ item, order })).sort((a, b) => a.item.insertAt - b.item.insertAt || a.order - b.order)
    let inserted = 0; let firstNewSlide = ""; let changes = 0
    for (const { item } of planned) {
      let song: Song | undefined
      if (item.songId) {
        song = catalog.find((candidate) => candidate.id === item.songId)
        if (!song) throw new Error(`La IA eligió una canción que ya no existe en el repertorio: ${item.songId}`)
      } else if (item.youtubeUrl) {
        setStatus("Obteniendo información de YouTube…")
        song = await api.importSong(item.youtubeUrl)
      }
      if (song) song = await prepareSong(song, setStatus)
      const elements: SlideElement[] = []
      if (song) elements.push({ ...video(song), y: item.texts.length ? 190 : 90, height: item.texts.length ? 800 : 900 })
      elements.push(...item.texts.map((text, index) => plannedText(text, index, !!song)))
      if (!elements.length) continue
      const newSlide: Slide = { id: uid(), elements }
      const baseIndex = Math.max(0, Math.min(originalCount, item.insertAt)); const index = baseIndex + inserted
      draft.slides.splice(index, 0, newSlide); inserted++; changes++
      if (!firstNewSlide) firstNewSlide = newSlide.id
    }
    for (const edit of plan.existingSlideTexts) {
      const target = draft.slides.find((slide) => slide.id === edit.slideId)
      if (!target) continue
      const textCount = target.elements.filter((element) => element.type === "text").length
      target.elements.push(...edit.texts.map((text, index) => plannedText(text, textCount + index, target.elements.some((element) => element.type === "video"))))
      changes += edit.texts.length
    }
    if (!changes) throw new Error("La IA no propuso cambios aplicables.")
    applyProject(draft, firstNewSlide || slideId || undefined)
  }
  async function exportPptx() { if (!project) return; setExporting(true); setError(""); try { if (dirty) await api.saveProject(project); const result = await api.exportProject(project.id); location.href = result.url } catch (e) { setError(e instanceof Error ? e.message : "No se pudo exportar.") } finally { setExporting(false) } }
  function back() { if (dirty && project) api.saveProject(project).finally(onBack); else onBack() }
  if (loading) return <main className="splash"><LoaderCircle className="spin"/><p>Abriendo la presentación…</p></main>
  if (!project) return <main className="splash"><p>{error || "No encontramos esta presentación."}</p><button onClick={onBack}>Volver</button></main>
  return <main className="editor-shell"><header className="editor-header"><button className="back-link" onClick={back}><ArrowLeft size={18}/> Presentaciones</button><div className="document-title"><strong>{project.title}</strong><span>{dirty ? "Guardando…" : "Guardado"}</span></div><button className="primary export-button" disabled={exporting} onClick={exportPptx}>{exporting ? <LoaderCircle className="spin" size={17}/> : <Download size={17}/>} {exporting ? "Exportando…" : "Exportar PPTX"}</button></header><Toolbar onImage={upload} onAI={() => setAiOpen(true)}/>{error && <button className="editor-error" onClick={() => setError("")}>{error}<span>×</span></button>}<div className="editor-body"><section className="workspace"><Canvas onImage={upload}/><Timeline/></section><SongPanel addVideo={addVideo}/></div>{aiOpen && <AIModal project={project} currentSlideId={slideId} onClose={() => setAiOpen(false)} onApply={applyAIPlan}/>}</main>
}
