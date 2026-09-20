import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const prompt = createInterface({ input: stdin, output: stdout })
const username = (await prompt.question("Usuario administrador: ")).trim()
const password = await prompt.question("Contraseña, mínimo 8 caracteres: ")
prompt.close()
if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username) || password.length < 8) {
  console.error("Usuario o contraseña no válidos.")
  process.exit(1)
}
// Cloudflare Workers rejects PBKDF2 counts above 100,000 in production.
const salt = randomBytes(16), iterations = 100000
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256")
const encoded = `pbkdf2$${iterations}$${salt.toString("hex")}$${hash.toString("hex")}`
const escape = (value) => value.replaceAll("'", "''")
const folder = mkdtempSync(join(tmpdir(), "presentation-maker-seed-"))
const file = join(folder, "seed.sql")
writeFileSync(file, `INSERT INTO users(id,username,password_hash,role,created_at) VALUES('${randomUUID()}','${escape(username)}','${encoded}','admin',${Math.floor(Date.now()/1000)}) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,role='admin';\n`, { mode: 0o600 })
const location = process.argv.includes("--local") ? "--local" : "--remote"
const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "d1", "execute", "DB", location, "--file", file], { stdio: "inherit" })
rmSync(folder, { recursive: true, force: true })
if (result.status !== 0) process.exit(result.status || 1)
console.log(`Administrador ${username} creado o actualizado.`)
