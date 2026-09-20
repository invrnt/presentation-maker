import type { Project, ProjectSummary, Song, User } from "./types"

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "No se pudo completar la solicitud." }))
    throw new ApiError(body.error || "No se pudo completar la solicitud.", response.status)
  }
  return response.json() as Promise<T>
}

export const api = {
  me: () => request<User>("/api/auth/me"),
  login: (username: string, password: string) => request<User>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  createProject: () => request<ProjectSummary>("/api/projects", { method: "POST" }),
  project: (id: string) => request<ProjectSummary>(`/api/projects/${id}`),
  saveProject: (project: Project) => request<{ ok: true }>(`/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(project) }),
  upload: (file: File) => { const form = new FormData(); form.append("file", file); return request<{ assetId: string; url: string }>("/api/assets", { method: "POST", body: form }) },
  songs: () => request<Song[]>("/api/songs"),
  importSong: (url: string) => request<Song>("/api/songs/import", { method: "POST", body: JSON.stringify({ url }) }),
  downloadSong: (id: string) => request<{ jobId: string }>(`/api/songs/${id}/download`, { method: "POST" }),
  exportProject: (id: string) => request<{ url: string; filename: string }>(`/api/projects/${id}/export`, { method: "POST" }),
  createUser: (username: string, password: string, role: string) => request<User>("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password, role }) }),
}

