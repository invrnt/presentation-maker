import { useEffect, useState } from "react"
import { ArrowLeft, LogOut, Plus, ShieldCheck } from "lucide-react"
import { api, ApiError } from "./api"
import type { ProjectSummary, User } from "./types"
import { Editor } from "./Editor"

function navigate(path: string) { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")) }

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true)
    try { const user = await api.login(username.trim(), password); onLogin(user); navigate("/") }
    catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo iniciar sesión.") }
    finally { setBusy(false) }
  }
  return <main className="login-shell">
    <section className="login-card">
      <div className="brand-mark">P</div>
      <p className="eyebrow">PRESENTATION MAKER</p>
      <h1>Vuelve a tus presentaciones</h1>
      <p className="muted">Tus proyectos viven en este equipo y siguen disponibles sin conexión.</p>
      <form onSubmit={submit}>
        <label>Usuario<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Contraseña<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" disabled={busy || !username || !password}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
    </section>
  </main>
}

function Home({ user, logout }: { user: User; logout: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  useEffect(() => { api.projects().then(setProjects).catch((e) => setError(e.message)).finally(() => setLoading(false)) }, [])
  async function create() { const project = await api.createProject(); navigate(`/project/${project.id}`) }
  return <main className="home-shell">
    <header className="home-header">
      <div><p className="eyebrow">PRESENTATION MAKER</p><h1>Presentaciones</h1></div>
      <div className="user-actions"><span>{user.username}</span>{user.role === "admin" && <button className="ghost" onClick={() => navigate("/admin")}><ShieldCheck size={17}/> Usuarios</button>}<button className="icon-button" title="Cerrar sesión" onClick={logout}><LogOut size={18}/></button></div>
    </header>
    {loading && <p className="status-line">Cargando tus proyectos…</p>}
    {error && <div className="error-box">{error}</div>}
    <section className="project-grid">
      <button className="project-card create-card" onClick={create}><span className="big-plus"><Plus/></span><strong>Crear nuevo</strong><small>Empieza con una diapositiva vacía</small></button>
      {projects.map((item) => <button key={item.id} className="project-card" onClick={() => navigate(`/project/${item.id}`)}>
        <div className="project-preview"><span>{item.document.slides.length}</span><small>{item.document.slides.length === 1 ? "diapositiva" : "diapositivas"}</small></div>
        <strong>{item.title}</strong><small>Editado {new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(item.updatedAt * 1000)}</small>
      </button>)}
    </section>
  </main>
}

function Admin() {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [role, setRole] = useState("normal"); const [message, setMessage] = useState(""); const [error, setError] = useState("")
  async function submit(e: React.FormEvent) { e.preventDefault(); setError(""); setMessage(""); try { await api.createUser(username, password, role); setMessage(`Usuario ${username} creado.`); setUsername(""); setPassword("") } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo crear el usuario.") } }
  return <main className="admin-shell"><button className="back-link" onClick={() => navigate("/")}><ArrowLeft size={18}/> Presentaciones</button><section className="admin-card"><p className="eyebrow">ADMINISTRACIÓN</p><h1>Crear usuario</h1><p className="muted">Dale acceso a otra persona. Podrá usar la aplicación en su propio equipo.</p><form onSubmit={submit}><label>Usuario<input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3}/></label><label>Contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}/></label><label>Rol<select value={role} onChange={(e) => setRole(e.target.value)}><option value="normal">Normal</option><option value="admin">Administrador</option></select></label>{message && <p className="success-box">{message}</p>}{error && <p className="form-error">{error}</p>}<button className="primary" disabled={!username || password.length < 8}>Crear usuario</button></form></section></main>
}

export default function App() {
  const [path, setPath] = useState(location.pathname)
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)
  useEffect(() => { const change = () => setPath(location.pathname); addEventListener("popstate", change); return () => removeEventListener("popstate", change) }, [])
  useEffect(() => { api.me().then(setUser).catch((e) => { if (!(e instanceof ApiError) || e.status !== 401) console.error(e); if (location.pathname !== "/login") history.replaceState({}, "", "/login") }).finally(() => { setPath(location.pathname); setChecking(false) }) }, [])
  async function logout() { await api.logout().catch(() => undefined); setUser(null); navigate("/login") }
  if (checking) return <main className="splash"><div className="brand-mark">P</div><p>Abriendo tus presentaciones…</p></main>
  if (!user || path === "/login") return <Login onLogin={setUser}/>
  if (path === "/admin" && user.role === "admin") return <Admin />
  const project = path.match(/^\/project\/([^/]+)$/)
  if (project) return <Editor id={project[1]} onBack={() => navigate("/")} />
  return <Home user={user} logout={logout}/>
}
