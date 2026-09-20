import { Hono } from "hono"

type Variables = { user: { id: string; username: string; role: "admin" | "normal" } }
type AppEnv = { Bindings: Env; Variables: Variables }
type UserRow = { id: string; username: string; role: "admin" | "normal"; password_hash: string }
type SongRow = { id: string; youtube_id: string; youtube_url: string; title: string; duration_seconds: number | null }

const app = new Hono<AppEnv>()
const encoder = new TextEncoder()

app.use("/v1/*", async (c, next) => {
  if (Number(c.req.header("content-length") || 0) > 32_768) return c.json({ error: "Solicitud demasiado grande." }, 413)
  await next()
})

app.use("/v1/*", async (c, next) => {
  const started = Date.now()
  await next()
  console.log(JSON.stringify({ method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Date.now() - started }))
})

app.post("/v1/auth/login", async (c) => {
  const body: { username?: string; password?: string } = await c.req.json().catch(() => ({}))
  const username = body.username?.trim() || ""
  if (!username || !body.password) return c.json({ error: "Escribe tu usuario y contraseña." }, 400)
  const record = await c.env.DB.prepare("SELECT id,username,role,password_hash FROM users WHERE username=? COLLATE NOCASE").bind(username).first<UserRow>()
  if (!record || !(await verifyPassword(body.password, record.password_hash))) return c.json({ error: "Usuario o contraseña incorrectos." }, 401)
  const token = randomToken(32), now = Math.floor(Date.now() / 1000), expiresAt = now + 365 * 24 * 60 * 60
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), await sha256(token), record.id, now, expiresAt, now),
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
  ])
  return c.json({ token, expiresAt, user: { id: record.id, username: record.username, role: record.role } })
})

app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/auth/login") return next()
  const authorization = c.req.header("authorization") || ""
  if (!authorization.startsWith("Bearer ")) return c.json({ error: "Sesión requerida." }, 401)
  const now = Math.floor(Date.now() / 1000)
  const record = await c.env.DB.prepare(`SELECT users.id,users.username,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`).bind(await sha256(authorization.slice(7)), now).first<Omit<UserRow, "password_hash">>()
  if (!record) return c.json({ error: "La sesión terminó." }, 401)
  c.set("user", record)
  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?").bind(now, now + 365 * 24 * 60 * 60, await sha256(authorization.slice(7))).run())
  await next()
})

app.get("/v1/auth/me", (c) => c.json(c.get("user")))

app.get("/v1/songs", async (c) => {
  const result = await c.env.DB.prepare("SELECT id,youtube_id,youtube_url,title,duration_seconds FROM songs ORDER BY title COLLATE NOCASE").all<SongRow>()
  return c.json(result.results.map(songJSON))
})

app.post("/v1/songs", async (c) => {
  const body: { youtubeId?: string; youtubeUrl?: string; title?: string; durationSeconds?: number } = await c.req.json().catch(() => ({}))
  if (!body.youtubeId?.match(/^[A-Za-z0-9_-]{6,20}$/) || !body.youtubeUrl?.startsWith("https://") || !body.title?.trim()) return c.json({ error: "La información del video no es válida." }, 400)
  const existing = await c.env.DB.prepare("SELECT id,youtube_id,youtube_url,title,duration_seconds FROM songs WHERE youtube_id=?").bind(body.youtubeId).first<SongRow>()
  if (existing) return c.json(songJSON(existing))
  const row: SongRow = { id: crypto.randomUUID(), youtube_id: body.youtubeId, youtube_url: body.youtubeUrl, title: body.title.trim().slice(0, 200), duration_seconds: Math.max(0, Math.floor(body.durationSeconds || 0)) }
  await c.env.DB.prepare("INSERT INTO songs(id,youtube_id,youtube_url,title,duration_seconds,created_by,created_at) VALUES(?,?,?,?,?,?,?)").bind(row.id, row.youtube_id, row.youtube_url, row.title, row.duration_seconds, c.get("user").id, Math.floor(Date.now() / 1000)).run()
  return c.json(songJSON(row), 201)
})

app.post("/v1/admin/users", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Solo un administrador puede crear usuarios." }, 403)
  const body: { username?: string; password?: string; role?: string } = await c.req.json().catch(() => ({}))
  const username = body.username?.trim() || ""
  if (!username.match(/^[\p{L}\p{N}_.-]{3,40}$/u)) return c.json({ error: "El usuario debe tener entre 3 y 40 caracteres." }, 400)
  if (!body.password || body.password.length < 8) return c.json({ error: "La contraseña debe tener al menos 8 caracteres." }, 400)
  if (body.role !== "admin" && body.role !== "normal") return c.json({ error: "El rol no es válido." }, 400)
  const id = crypto.randomUUID()
  try { await c.env.DB.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)").bind(id, username, await hashPassword(body.password), body.role, Math.floor(Date.now() / 1000)).run() }
  catch { return c.json({ error: "Ese nombre de usuario ya existe." }, 409) }
  return c.json({ id, username, role: body.role }, 201)
})

app.notFound((c) => c.json({ error: "Ruta no encontrada." }, 404))
app.onError((error, c) => { console.error(JSON.stringify({ message: error.message, path: c.req.path })); return c.json({ error: "El servidor no pudo completar la solicitud." }, 500) })

function songJSON(row: SongRow) { return { id: row.id, youtubeId: row.youtube_id, youtubeUrl: row.youtube_url, title: row.title, durationSeconds: row.duration_seconds || undefined, downloaded: false } }
function bytesToHex(bytes: Uint8Array) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("") }
function hexToBytes(value: string) { return new Uint8Array(value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) || []) }
function randomToken(size: number) { const bytes = crypto.getRandomValues(new Uint8Array(size)); return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") }
async function sha256(value: string) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))) }
async function hashPassword(password: string) { const iterations = 210_000, salt = crypto.getRandomValues(new Uint8Array(16)); const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]); const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256)); return `pbkdf2$${iterations}$${bytesToHex(salt)}$${bytesToHex(hash)}` }
async function verifyPassword(password: string, stored: string) { const [method, rounds, saltHex, hashHex] = stored.split("$"); if (method !== "pbkdf2" || !rounds || !saltHex || !hashHex) return false; const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]); const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: Number(rounds) }, key, 256)); const expected = hexToBytes(hashHex); if (actual.length !== expected.length) return false; let difference = 0; for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index]; return difference === 0 }

export default app
