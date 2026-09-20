import { create } from "zustand"
import type { Project, Slide, SlideElement } from "./types"

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
export const blankSlide = (): Slide => ({ id: uid(), elements: [] })

type EditorStore = {
  project: Project | null
  slideId: string | null
  selectedId: string | null
  dirty: boolean
  setProject: (project: Project) => void
  applyProject: (project: Project, slideId?: string) => void
  selectSlide: (id: string) => void
  selectElement: (id: string | null) => void
  updateElement: (id: string, patch: Partial<SlideElement>) => void
  addElement: (element: SlideElement) => void
  deleteElement: () => void
  addSlide: (after?: string) => void
  duplicateSlide: () => void
  deleteSlide: () => void
  reorder: (source: string, target: string) => void
  markSaved: () => void
}

export const useEditor = create<EditorStore>((set) => ({
  project: null, slideId: null, selectedId: null, dirty: false,
  setProject: (project) => set({ project, slideId: project.slides[0]?.id ?? null, selectedId: null, dirty: false }),
  applyProject: (project, slideId) => set({ project, slideId: slideId || project.slides[0]?.id || null, selectedId: null, dirty: true }),
  selectSlide: (slideId) => set({ slideId, selectedId: null }),
  selectElement: (selectedId) => set({ selectedId }),
  updateElement: (id, patch) => set((state) => state.project ? ({ project: { ...state.project, slides: state.project.slides.map((slide) => slide.id === state.slideId ? { ...slide, elements: slide.elements.map((item) => item.id === id ? { ...item, ...patch } as SlideElement : item) } : slide) }, dirty: true }) : state),
  addElement: (element) => set((state) => state.project ? ({ project: { ...state.project, slides: state.project.slides.map((slide) => slide.id === state.slideId ? { ...slide, elements: [...slide.elements, element] } : slide) }, selectedId: element.id, dirty: true }) : state),
  deleteElement: () => set((state) => state.project && state.selectedId ? ({ project: { ...state.project, slides: state.project.slides.map((slide) => slide.id === state.slideId ? { ...slide, elements: slide.elements.filter((item) => item.id !== state.selectedId) } : slide) }, selectedId: null, dirty: true }) : state),
  addSlide: (after) => set((state) => { if (!state.project) return state; const slide = blankSlide(); const index = Math.max(0, state.project.slides.findIndex((item) => item.id === (after || state.slideId))); const slides = [...state.project.slides]; slides.splice(index + 1, 0, slide); return { project: { ...state.project, slides }, slideId: slide.id, selectedId: null, dirty: true } }),
  duplicateSlide: () => set((state) => { if (!state.project) return state; const index = state.project.slides.findIndex((item) => item.id === state.slideId); if (index < 0) return state; const copy: Slide = JSON.parse(JSON.stringify(state.project.slides[index])); copy.id = uid(); copy.elements.forEach((item) => { item.id = uid() }); const slides = [...state.project.slides]; slides.splice(index + 1, 0, copy); return { project: { ...state.project, slides }, slideId: copy.id, selectedId: null, dirty: true } }),
  deleteSlide: () => set((state) => { if (!state.project || state.project.slides.length === 1) return state; const index = state.project.slides.findIndex((item) => item.id === state.slideId); const slides = state.project.slides.filter((item) => item.id !== state.slideId); return { project: { ...state.project, slides }, slideId: slides[Math.min(Math.max(index, 0), slides.length - 1)].id, selectedId: null, dirty: true } }),
  reorder: (source, target) => set((state) => { if (!state.project || source === target) return state; const slides = [...state.project.slides]; const from = slides.findIndex((item) => item.id === source); const to = slides.findIndex((item) => item.id === target); if (from < 0 || to < 0) return state; const [moved] = slides.splice(from, 1); slides.splice(to, 0, moved); return { project: { ...state.project, slides }, dirty: true } }),
  markSaved: () => set({ dirty: false }),
}))

export { uid }
