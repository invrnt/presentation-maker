# Presentation Maker — Especificación completa de implementación para agente ejecutor

> **Objetivo:** construir una aplicación privada, extremadamente simple y bonita para 4–5 usuarios, compatible con **Windows 8**, capaz de crear presentaciones `.pptx` con texto, imágenes y videos de YouTube embebidos físicamente dentro del archivo final.
>
> **Prioridad:** tener una primera versión funcional completa muy rápido. Evitar sobrearquitectura. Este documento fija las decisiones técnicas para que el agente pueda ejecutar el proyecto sin volver a debatir el stack.

---

# 1. Principios de implementación

El proyecto debe optimizarse para:

1. **Windows 8 real**, en hardware antiguo y con pocos recursos.
2. Inicio rápido y uso de RAM bajo.
3. Interfaz moderna, clara, bonita y muy simple.
4. Cero dependencia de Electron, Tauri, Node.js o Python instalados en el equipo final.
5. Proyectos almacenados localmente y accesibles incluso sin internet.
6. Repertorio de canciones y usuarios sincronizados remotamente mediante Cloudflare Worker + D1.
7. Videos descargados y cacheados localmente.
8. Exportación PPTX 100% local.
9. Videos físicamente embebidos dentro del `.pptx`; el archivo final debe funcionar sin internet.
10. Evitar complejidad no requerida por el caso de uso privado.
11. No implementar medidas de seguridad empresariales innecesarias, pero tampoco incluir malas prácticas que comprometan el sistema operativo.
12. No solicitar privilegios de administrador.
13. No desactivar Defender, SmartScreen ni crear exclusiones de antivirus.

---

# 2. Decisión de arquitectura

La arquitectura definitiva es:

```text
┌──────────────── Windows 8 ────────────────┐
│                                           │
│ PresentationMaker.exe                     │
│ │                                         │
│ ├─ Go 1.20.14                             │
│ │  ├─ servidor HTTP localhost             │
│ │  ├─ API local                           │
│ │  ├─ SQLite                              │
│ │  ├─ filesystem                          │
│ │  ├─ yt-dlp                              │
│ │  ├─ ffmpeg / ffprobe                    │
│ │  ├─ generación PPTX                     │
│ │  └─ proxy hacia Cloudflare Worker       │
│ │                                         │
│ └─ React/Vite embebido con //go:embed     │
│        ↓                                  │
│      navegador                            │
│                                           │
└──────────────────┬────────────────────────┘
                   │ HTTPS
                   ▼
┌──────────── Cloudflare ────────────┐
│ Worker + Hono                      │
│       │                            │
│       └── D1                       │
│           ├─ users                 │
│           ├─ sessions              │
│           └─ songs                 │
└────────────────────────────────────┘
```

## Regla clave

El frontend **nunca debe hablar directamente con D1**.

El flujo debe ser:

```text
React
  ↓
Go local
  ↓
Cloudflare Worker
  ↓
D1
```

Las credenciales de Cloudflare nunca deben incluirse en `PresentationMaker.exe`.

---

# 3. Stack exacto

## Frontend

```text
React
TypeScript
Vite
Tailwind CSS
Zustand
@atlaskit/pragmatic-drag-and-drop
lucide-react
```

No usar:

```text
Electron
Tauri
Three.js
WebAssembly FFmpeg
Node.js en runtime
```

El frontend debe compilarse previamente y quedar commiteado dentro del repositorio como `dist/`.

## Backend local

Usar exactamente:

```text
Go 1.20.14
```

Razón: Go 1.20 fue la última rama compatible oficialmente con Windows 7 y 8. Go 1.21 pasó a exigir Windows 10 o superior.

Referencia:

- https://go.dev/wiki/Windows
- https://go.dev/doc/devel/release

Backend:

```text
Go stdlib
chi opcional para routing
database/sql
SQLite driver compatible con Go 1.20
archive/zip
embed
os/exec
```

## Cloud

```text
Cloudflare Workers
Hono
Cloudflare D1
Drizzle ORM
Wrangler
```

## Herramientas multimedia

```text
yt-dlp compatible con Windows 8
ffmpeg compatible con Windows 8
ffprobe compatible con Windows 8
```

---

# 4. Compatibilidad de frontend

El frontend debe evitar generar JavaScript que requiera navegadores nuevos.

Configurar Vite con un target deliberadamente conservador:

```ts
export default defineConfig({
  build: {
    target: "es2019"
  }
})
```

Si se prueba específicamente con Chrome/Chromium 109 puede usarse ese objetivo, pero `es2019` es preferible como baseline sencillo.

---

# 5. Estructura sugerida del repositorio

```text
presentation-maker/
│
├─ apps/
│  ├─ web/
│  │  ├─ src/
│  │  ├─ public/
│  │  └─ dist/               # DEBE quedar commiteado
│  │
│  ├─ local/
│  │  ├─ cmd/
│  │  ├─ internal/
│  │  │  ├─ auth/
│  │  │  ├─ projects/
│  │  │  ├─ songs/
│  │  │  ├─ downloader/
│  │  │  ├─ pptx/
│  │  │  ├─ storage/
│  │  │  └─ cloud/
│  │  └─ main.go
│  │
│  └─ worker/
│     ├─ src/
│     ├─ drizzle/
│     ├─ drizzle.config.ts
│     └─ wrangler.toml
│
├─ install.ps1
├─ scripts/
│  ├─ build-source-zip.ps1
│  └─ seed-admin.ts
│
├─ source.zip
├─ pnpm-workspace.yaml
└─ README.md
```

Puede simplificarse si acelera la entrega. La prioridad es funcionamiento, no estructura académica.

---

# 6. Distribución final

La aplicación instalada debe terminar aproximadamente así:

```text
%LOCALAPPDATA%\PresentationMaker\
├── PresentationMaker.exe
├── bin\
│   ├── yt-dlp.exe
│   ├── ffmpeg.exe
│   └── ffprobe.exe
├── data\
│   └── app.db
├── cache\
│   ├── media\
│   └── thumbnails\
├── assets\
└── exports\
```

Debe existir un acceso directo:

```text
Desktop\Presentation Maker.lnk
```

que apunte a:

```text
%LOCALAPPDATA%\PresentationMaker\PresentationMaker.exe
```

---

# 7. Estrategia de instalación

Para este proyecto privado, con 4–5 usuarios y sin firma de código, usar un instalador PowerShell reproducible que compile el ejecutable localmente.

No usar esta estrategia para "engañar" antivirus. El binario sigue pudiendo ser analizado por Defender. La ventaja principal es tener una instalación reproducible y evitar depender exclusivamente de la reputación de un `.exe` descargado.

SmartScreen utiliza reputación de archivos y aplicaciones descargadas como una de sus señales:

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation

## Comando de instalación

El README puede indicar algo equivalente a:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/TU_USER/TU_REPO/main/install.ps1 -UseBasicParsing -OutFile $env:TEMP\app-install.ps1; & $env:TEMP\app-install.ps1"
```

`ExecutionPolicy Bypass` se aplica únicamente a ese proceso de PowerShell. No debe:

- desactivar Defender;
- modificar SmartScreen;
- crear exclusiones;
- modificar permanentemente políticas de seguridad.

Referencia:

- https://learn.microsoft.com/es-es/powershell/module/microsoft.powershell.core/about/about_execution_policies

---

# 8. Qué debe hacer `install.ps1`

El script debe ser legible, corto y mostrar progreso.

Flujo:

```text
[1/5] Downloading build tools
[2/5] Building application
[3/5] Installing media tools
[4/5] Creating desktop shortcut
[5/5] Done
```

## Pasos

### 1. Crear directorio final

```text
%LOCALAPPDATA%\PresentationMaker\
```

### 2. Crear workspace temporal

```text
%TEMP%\PresentationMakerInstaller\
```

### 3. Descargar Go 1.20.14 portable

Descargar:

```text
go1.20.14.windows-amd64.zip
```

desde fuente oficial.

Descomprimir en:

```text
%TEMP%\PresentationMakerInstaller\go\
```

No instalar Go globalmente.

### 4. Descargar `source.zip`

No depender de `git clone`.

El repositorio debe publicar:

```text
/source.zip
```

que contenga:

```text
Go source
frontend dist ya compilado
plantilla PPTX
assets necesarios
```

No instalar:

```text
git
node
pnpm
Go global
```

### 5. Verificar SHA-256

Todas las descargas binarias y ZIP relevantes deben tener un hash SHA-256 esperado.

El instalador debe abortar si el hash no coincide.

### 6. Compilar localmente

Usar:

```powershell
go build -trimpath -ldflags="-s -w -H windowsgui" -o PresentationMaker.exe
```

El ejecutable final no debe abrir una consola.

### 7. Descargar herramientas multimedia

Instalar:

```text
yt-dlp.exe
ffmpeg.exe
ffprobe.exe
```

en:

```text
%LOCALAPPDATA%\PresentationMaker\bin\
```

Usar builds conocidos compatibles con Windows 8.

### 8. Limpiar

Eliminar:

```text
Go temporal
source temporal
ZIPs temporales
```

### 9. Crear acceso directo

Crear:

```text
Desktop\Presentation Maker.lnk
```

### 10. Lanzar aplicación

Abrir:

```text
PresentationMaker.exe
```

---

# 9. Reglas de antivirus y seguridad del instalador

NO hacer:

```text
Disable-WindowsDefender
Add-MpPreference exclusion
desactivar SmartScreen
desactivar firewall
crear tareas ocultas
crear persistencia extraña
ejecutar PowerShell internamente en cada arranque
solicitar privilegios de administrador
```

Sí hacer:

- repositorio público si es posible;
- `install.ps1` completamente visible;
- dependencias desde fuentes oficiales;
- hashes SHA-256;
- instalación en `%LOCALAPPDATA%`;
- sin elevación;
- binario que escucha únicamente en `127.0.0.1`;
- sin modificación del sistema operativo.

---

# 10. Inicio de la aplicación

Al ejecutar:

```text
PresentationMaker.exe
        ↓
comprobar single-instance
        ↓
abrir SQLite
        ↓
levantar servidor local
        ↓
127.0.0.1:3210
        ↓
abrir navegador automáticamente
```

Nunca escuchar en:

```text
0.0.0.0
```

El servidor debe estar disponible solo localmente.

Si ya existe una instancia:

```text
segundo doble clic
→ abrir navegador
→ reutilizar instancia
```

---

# 11. Frontend embebido

El frontend React debe quedar incluido físicamente en el `.exe`.

Ejemplo:

```go
//go:embed web/dist/*
var frontend embed.FS
```

No requerir Node.js en el PC final.

React se compila antes y `dist/` queda commiteado.

---

# 12. Persistencia local

Usar:

```text
%LOCALAPPDATA%\PresentationMaker\
```

Datos:

```text
data/app.db
cache/media/
cache/thumbnails/
assets/
exports/
```

Los videos deben vivir en un cache global, no duplicados dentro de cada proyecto.

---

# 13. Base de datos local

Mantener SQLite extremadamente simple.

## `projects`

```text
id
title
document_json
created_at
updated_at
```

## `settings`

```text
key
value
```

## `media_cache`

```text
youtube_id
song_id
path
thumbnail_path
width
height
duration
status
updated_at
```

Guardar cada proyecto entero como JSON es aceptable y deseable para la v1.

---

# 14. Modelo del proyecto

Usar un canvas lógico de:

```text
1920 × 1080
```

Relación:

```text
16:9
```

Ejemplo:

```ts
type Project = {
  version: 1
  id: string
  title: string
  slides: Slide[]
}

type Slide = {
  id: string
  elements: Element[]
}

type Element =
  | TextElement
  | ImageElement
  | VideoElement
```

## Texto

```ts
type TextElement = {
  type: "text"
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  color: string
  align: "left" | "center" | "right"
}
```

## Imagen

```ts
type ImageElement = {
  type: "image"
  id: string
  assetId: string
  x: number
  y: number
  width: number
  height: number
  fit: "contain" | "cover"
}
```

## Video

```ts
type VideoElement = {
  type: "video"
  id: string
  youtubeId: string
  x: number
  y: number
  width: number
  height: number
  fit: "contain"
}
```

---

# 15. Rutas de la aplicación

```text
/login
/
/project/:id
/admin
```

Todas las rutas excepto `/login` requieren autenticación.

---

# 16. Autenticación

Usuarios y sesiones viven remotamente en D1.

Flujo:

```text
React
 ↓
POST localhost/api/auth/login
 ↓
Go
 ↓
Cloudflare Worker
 ↓
D1
```

Duración de sesión objetivo:

```text
365 días
```

Renovación automática.

El token debe almacenarse localmente desde Go/SQLite/config local, no depender exclusivamente de `localStorage`.

## Offline

Si existe una sesión local válida previamente conocida y no hay internet:

```text
permitir acceso
```

Cuando vuelva internet:

```text
revalidar sesión
```

La app es privada y esto es aceptable.

---

# 17. D1 — esquema remoto

## `users`

```text
id
username UNIQUE
password_hash
role
created_at
```

`role`:

```text
admin
normal
```

## `sessions`

```text
id
token_hash UNIQUE
user_id
created_at
expires_at
last_seen_at
```

## `songs`

```text
id
youtube_id UNIQUE
youtube_url
title
duration_seconds
created_by
created_at
```

No almacenar archivos de video en D1.

---

# 18. Drizzle

Mantener un esquema equivalente a:

```ts
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "normal"] }).notNull(),
  createdAt: integer("created_at").notNull(),
})

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
})

export const songs = sqliteTable("songs", {
  id: text("id").primaryKey(),
  youtubeId: text("youtube_id").notNull().unique(),
  youtubeUrl: text("youtube_url").notNull(),
  title: text("title").notNull(),
  durationSeconds: integer("duration_seconds"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

---

# 19. Primer usuario administrador

No hardcodear admin en la aplicación.

Crear un script:

```text
pnpm seed:admin
```

que pregunte:

```text
username
password
```

y cree el primer usuario en D1 mediante Wrangler.

---

# 20. Migraciones

Las migraciones deben ejecutarse desde desarrollo/deployment:

```bash
pnpm db:generate
pnpm db:migrate
```

o mediante Wrangler.

Regla:

```text
admin dentro de la app ≠ permiso para modificar schema D1
```

No meter un Cloudflare API token dentro del `.exe`.

---

# 21. Worker API

Mantener el backend remoto mínimo.

Endpoints necesarios:

```text
POST /v1/auth/login
GET  /v1/auth/me

GET  /v1/songs
POST /v1/songs

POST /v1/admin/users
```

Opcional:

```text
DELETE /v1/admin/users/:id
PATCH  /v1/admin/users/:id/password
```

solo si sale prácticamente gratis en tiempo.

---

# 22. API local

Endpoints aproximados:

```text
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout

GET  /api/projects
POST /api/projects
GET  /api/projects/:id
PUT  /api/projects/:id

POST /api/assets

GET  /api/songs
POST /api/songs/import
POST /api/songs/:id/download

GET  /api/jobs/:id/events

POST /api/projects/:id/export
GET  /api/exports/:id
```

Para progreso usar:

```text
Server-Sent Events
```

No WebSockets.

---

# 23. Pantalla inicial / historial

Después de login, `/` muestra proyectos.

Layout:

```text
┌────────────────────────────────────────────┐
│ Presentaciones                   usuario ▾ │
│                                            │
│ ┌────────────┐ ┌────────────┐ ┌──────────┐ │
│ │     +      │ │ preview    │ │ preview  │ │
│ │ Crear      │ │            │ │          │ │
│ │ nuevo      │ │ 19 sep...  │ │ 18 sep.. │ │
│ └────────────┘ └────────────┘ └──────────┘ │
│                                            │
└────────────────────────────────────────────┘
```

La primera tarjeta siempre es:

```text
+ Crear nuevo
```

No pedir nombre.

Nombre automático:

```text
19 de septiembre de 2026 · 10:17 p. m.
```

Cada proyecto nuevo debe crear automáticamente una slide vacía.

Siempre debe existir al menos una slide.

---

# 24. Editor principal

Layout objetivo:

```text
┌──────────────────────────────────────────────────┐
│ ← Presentaciones          Guardado      Exportar │
├───────────────────────────────┬──────────────────┤
│                               │ Buscar canción   │
│                               │                  │
│       EDITOR 16:9             │ 🔎 ...           │
│                               │                  │
│                               │ Canción A        │
│                               │ Canción B        │
│                               │ Canción C        │
│                               │                  │
├───────────────────────────────┴──────────────────┤
│   [1]   +   [2]   +   [3]   +   [4]  →         │
└──────────────────────────────────────────────────┘
```

Proporciones aproximadas:

```text
editor:     70%
repertorio: 30%
timeline:   150–170 px
```

Optimizar especialmente para:

```text
1366 × 768
```

Mínimo:

```text
1280 × 720
```

---

# 25. Estilo visual

Debe verse moderno pero no ser pesado.

Usar:

- Tailwind;
- fondos simples;
- bento boxes;
- bordes suaves;
- `border-radius` moderado;
- sombras pequeñas;
- iconos SVG;
- animaciones de 120–180 ms;
- skeletons ligeros;
- toasts breves.

Evitar:

- Three.js;
- animaciones complejas;
- blur grande;
- backdrop-filter extensivo;
- assets decorativos pesados;
- librerías UI enormes.

---

# 26. Canvas

Canvas lógico:

```text
1920 × 1080
```

Escalado visualmente con CSS.

Funciones v1:

```text
+ Texto
+ Imagen
```

Los elementos deben poder:

```text
seleccionarse
moverse
redimensionarse
eliminarse
```

No construir un editor gráfico completo tipo Canva.

---

# 27. Texto

Toolbar contextual mínima:

```text
Font
Size -  42  +
B
alineación
color
```

Fuentes seguras:

```text
Calibri
Arial
Verdana
Georgia
Times New Roman
Trebuchet MS
```

No implementar embedding de fuentes en v1.

---

# 28. Imágenes

Permitir:

```text
selector de archivo
drag & drop
```

Al añadir una imagen:

1. copiarla a almacenamiento local;
2. crear `assetId`;
3. añadir elemento al proyecto.

Funciones:

```text
mover
resize
delete
contain
cover
```

No implementar editor fotográfico.

---

# 29. Timeline

Usar:

```text
@atlaskit/pragmatic-drag-and-drop
```

Cada slide:

```text
┌─────────────┐
│ thumbnail   │
│             │
└─────────────┘
      4
```

Entre slides:

```text
[slide]   +   [slide]
```

El botón `+` aparece con hover.

Comportamientos:

```text
clic          seleccionar
drag          reordenar
hover gap     insertar
Delete        eliminar
Ctrl+D        duplicar
scroll wheel  horizontal
```

No permitir borrar la última slide.

---

# 30. Autosave

Todo cambio marca:

```text
dirty = true
```

Guardar con debounce:

```text
400–500 ms
```

Forzar guardado al:

```text
cambiar slide
reordenar
volver al home
exportar
cerrar/ocultar página
```

UI:

```text
Guardando…
Guardado
```

No usar modal.

---

# 31. Repertorio musical

El panel derecho debe usar **una sola barra inteligente**.

Placeholder:

```text
Buscar canción o pegar enlace de YouTube
```

Si el usuario escribe texto:

```text
buscar en el repertorio
```

Si pega URL de YouTube:

```text
detectar URL
→ mostrar opción Añadir
```

Ejemplo:

```text
Santo Santo               ✓
Oceans                     ↓
Reckless Love              ✓
Way Maker                  ↓
```

Convención:

```text
✓ = descargada localmente
↓ = existe en D1 pero no está en cache local
```

---

# 32. Añadir canción nueva

Flujo:

```text
pegar YouTube URL
        ↓
Go ejecuta yt-dlp metadata
        ↓
obtener:
- youtube ID
- título
- duración
        ↓
registrar metadata en D1
        ↓
iniciar descarga local
```

Estados UX:

```text
Obteniendo información…
Descargando 38%
Combinando video…
Preparando para PowerPoint…
Listo
```

No usar spinner genérico durante todo el proceso.

---

# 33. yt-dlp y Windows 8

No depender automáticamente del build oficial futuro.

yt-dlp anunció que sus ejecutables oficiales de Windows pasarán a requerir Windows 10 cuando migren a Python 3.14.

Referencia:

- https://github.com/yt-dlp/yt-dlp/issues/16917
- https://github.com/yt-dlp/yt-dlp

Para Windows 8:

```text
usar un build conocido y probado basado en una versión compatible
```

No usar:

```text
yt-dlp -U
```

sin control.

El instalador puede descargar una versión fijada y verificada por hash.

---

# 34. Descarga de video

Objetivo de compatibilidad:

```text
MP4
H.264
AAC
yuv420p
<=1080p
```

Preferir:

```text
video H.264 <=1080p
+
audio AAC/M4A
```

Si streams están separados:

```text
ffmpeg remux
```

sin recodificar cuando sea posible.

Solo recodificar si el codec final no es compatible.

En hardware viejo:

```text
máximo 1 descarga/transcodificación activa
```

Puede existir cola.

---

# 35. Selección de canción

Al tocar una canción:

## Si la slide actual está completamente vacía

```text
usar slide actual
```

## Si la slide actual contiene elementos

```text
crear slide inmediatamente después
seleccionarla
```

Después:

```text
si video no existe localmente:
    descargar
añadir VideoElement
centrar
maximizar dentro de 16:9
conservar proporción
```

Nunca deformar el video.

---

# 36. Videos verticales o con aspect ratio distinto

Ejemplo:

```text
┌─────────────────────────┐
│         ┌───────┐       │
│         │       │       │
│         │ video │       │
│         │       │       │
│         └───────┘       │
└─────────────────────────┘
```

Usar:

```text
fit = contain
```

No estirar a pantalla completa.

---

# 37. PPTX

La generación se hace completamente en Go.

No usar PptxGenJS en runtime.

Un `.pptx` es un ZIP con OOXML.

PowerPoint soporta media embebida físicamente mediante media parts internos.

Referencias útiles:

- https://learn.microsoft.com/en-us/openspecs/office_standards/ms-pptx/922b7818-6e5f-4641-a9c5-fab4063ec124
- https://learn.microsoft.com/en-us/openspecs/office_standards/ms-pptx/5e1b21c6-979f-45c5-8a46-fbef53a6e80a

---

# 38. No generar OOXML entero desde cero

Crear una vez un archivo:

```text
template.pptx
```

válido generado por PowerPoint.

Debe contener:

```text
theme
slideMaster
slideLayout
metadata base
```

Go debe:

1. abrir la plantilla;
2. copiar estructura base;
3. generar dinámicamente slides y relaciones;
4. añadir media;
5. actualizar manifests necesarios.

---

# 39. Estructura aproximada del PPTX

```text
presentation.pptx
├─ [Content_Types].xml
├─ _rels/
├─ ppt/
│  ├─ presentation.xml
│  ├─ _rels/
│  ├─ slides/
│  │  ├─ slide1.xml
│  │  ├─ slide2.xml
│  │  └─ _rels/
│  │     ├─ slide1.xml.rels
│  │     └─ slide2.xml.rels
│  ├─ media/
│  │  ├─ video1.mp4
│  │  ├─ image1.jpg
│  │  ├─ image2.png
│  │  └─ poster1.jpg
│  ├─ slideMasters/
│  ├─ slideLayouts/
│  └─ theme/
```

---

# 40. Poster frame de videos

Por cada video:

```text
ffmpeg
→ extraer frame
→ JPEG
```

La slide usa ese JPEG como representación visual y además relaciona el video interno.

---

# 41. Coordenadas PPTX

Canvas:

```text
1920 × 1080
```

PowerPoint widescreen:

```text
13.333 × 7.5 in
```

Transformación:

```text
pptX = x / 1920 * 13.333
pptY = y / 1080 * 7.5

pptW = width / 1920 * 13.333
pptH = height / 1080 * 7.5
```

Mantener todo relativo a este sistema.

---

# 42. Generación eficiente del ZIP

No meter videos completos en memoria.

Streaming:

```text
archivo.mp4
      ↓
zip.Writer
      ↓
presentation.pptx
```

Para entradas:

```text
XML      → DEFLATE
PNG/JPEG → normal
MP4      → STORE
```

Evitar comprimir MP4 otra vez.

Nunca:

```text
video → Base64 → RAM → PPTX
```

---

# 43. Exportación

Botón:

```text
Exportar PPTX
```

Flujo:

```text
guardar proyecto
      ↓
verificar assets
      ↓
verificar videos
      ↓
generar poster frames faltantes
      ↓
crear archivo temporal
      ↓
validar ZIP
      ↓
mover a exports/
      ↓
abrir/descargar archivo
```

Si falta un video y no hay internet:

```text
No se puede exportar todavía.

Falta:
• Nombre de canción
```

No crear archivos parcialmente rotos.

---

# 44. Admin

La administración debe ser mínima.

Menú de usuario admin:

```text
Usuarios
```

Pantalla:

```text
Crear usuario

Usuario
[________________]

Contraseña
[________________]

Rol
[ normal ▼ ]

[ Crear usuario ]
```

Eso es suficiente.

Opcional, solo si no retrasa:

```text
eliminar usuario
cambiar contraseña
```

---

# 45. Regla de permisos

Admin puede:

```text
crear usuarios
ver usuarios
opcionalmente eliminar usuarios
opcionalmente cambiar contraseña
```

Admin NO puede:

```text
modificar schema D1
obtener API token Cloudflare
ejecutar migraciones desde la app
```

---

# 46. UX de carga y errores

Siempre mostrar estados claros.

Ejemplos:

```text
Cargando repertorio…
Sin conexión — mostrando catálogo local
Descargando 42%
Preparando video…
Guardando…
Guardado
Exportando presentación…
```

Errores:

```text
No se pudo conectar.
Reintentar
```

No mostrar stack traces al usuario.

---

# 47. Comportamiento offline

Sin internet debe ser posible:

```text
abrir app
mantener sesión cacheada
ver proyectos
editar proyectos
usar imágenes locales
usar videos ya descargados
exportar si todos los videos requeridos están cacheados
```

No debe ser posible:

```text
añadir nuevo YouTube
descargar canciones no cacheadas
crear usuarios remotos
```

---

# 48. Single-instance

Debe existir un mecanismo sencillo para evitar múltiples servidores locales.

Una segunda ejecución:

```text
detectar instancia
→ abrir navegador
→ salir
```

Implementación aceptable:

- lock file + comprobación de proceso;
- socket/puerto;
- named mutex si se implementa de forma simple.

No sobrearquitecturar.

---

# 49. Navegador

La app abre:

```text
http://127.0.0.1:3210
```

No incluir un navegador propio.

Eso mantiene el runtime pequeño.

---

# 50. Criterios de rendimiento

Objetivo:

```text
RAM idle: baja
CPU idle: ~0%
startup: pocos segundos
```

Evitar procesos residentes innecesarios.

No hacer polling frecuente.

Para sincronizar canciones, una carga al abrir el repertorio y refresh explícito es suficiente.

---

# 51. Orden de ejecución

## Fase 0 — Compatibility spike

Antes de desarrollar la UI completa, validar en Windows 8 real o VM:

```text
Go 1.20.14 executable
↓
yt-dlp compatible
↓
video 1080p
↓
ffmpeg
↓
PPTX con video embebido
↓
abrir en PowerPoint
↓
reproducir sin internet
```

Esta es la prueba de mayor riesgo técnico.

No avanzar demasiado si esto falla.

---

## Fase 1 — Cloud

Implementar:

```text
D1
Drizzle schema
migrations
seed admin
login
sessions
songs
admin/user creation
```

---

## Fase 2 — Shell local

Implementar:

```text
Go HTTP server
React embed
single instance
browser launch
SQLite
auth proxy
route guards
```

---

## Fase 3 — Proyectos

Implementar:

```text
home
crear proyecto
historial
nombre automático
autosave
project JSON
```

---

## Fase 4 — Editor

Implementar:

```text
canvas 16:9
texto
imágenes
selección
move
resize
timeline
drag reorder
insertar
duplicar
eliminar
```

---

## Fase 5 — Música

Implementar:

```text
catálogo D1
smart search
pegar YouTube URL
metadata
descarga
progreso
cache
ffmpeg
video → slide
```

---

## Fase 6 — PPTX

Implementar:

```text
template
slides
texto
imágenes
poster frames
video embebido
streaming ZIP
export
```

---

## Fase 7 — Instalador

Implementar:

```text
install.ps1
Go 1.20.14 temporal
source.zip
hashes
build
ffmpeg
yt-dlp
shortcut
cleanup
launch
```

---

## Fase 8 — Pulido

Implementar únicamente lo necesario:

```text
loading states
errores
empty states
keyboard shortcuts
responsive 1366×768
Win8 testing
PowerPoint testing
```

---

# 52. Prioridad si hay límite de tiempo

Si el agente tiene menos de una hora, priorizar exactamente:

1. Shell Go + React.
2. Login.
3. Home con proyectos.
4. Editor simple.
5. Timeline.
6. Añadir canción por URL.
7. Descargar video.
8. Insertar video.
9. Exportar PPTX.
10. Admin básico.
11. Pulido.

No gastar tiempo primero en:

```text
animaciones sofisticadas
settings
themes
analytics
OAuth
telemetría
sistema de actualizaciones
migraciones desde UI
permisos complejos
tests exhaustivos
design system grande
```

---

# 53. Definition of Done

La v1 está terminada cuando cumple todo esto:

## Instalación

- [ ] Se instala desde un único comando PowerShell.
- [ ] No requiere administrador.
- [ ] No instala Go permanentemente.
- [ ] No instala Git.
- [ ] No instala Node.
- [ ] No instala pnpm.
- [ ] Verifica hashes de descargas.
- [ ] Crea acceso directo.
- [ ] Elimina toolchain temporal.
- [ ] No modifica Defender/SmartScreen.

## Windows

- [ ] Ejecuta en Windows 8.
- [ ] Backend compilado con Go 1.20.14.
- [ ] No muestra consola al iniciar.
- [ ] Usa únicamente `127.0.0.1`.
- [ ] Segunda ejecución reutiliza instancia.

## Auth

- [ ] `/login` funciona.
- [ ] Todas las demás rutas están protegidas.
- [ ] Sesión persiste entre reinicios.
- [ ] Sesión objetivo de 365 días.
- [ ] Funciona offline si ya hubo login válido.
- [ ] Admin puede crear usuario.

## Proyectos

- [ ] Home muestra proyectos.
- [ ] Primera tarjeta es “Crear nuevo”.
- [ ] Nombre automático con fecha humana en español.
- [ ] Cada proyecto comienza con una slide.
- [ ] Nunca existen cero slides.
- [ ] Autosave funciona.

## Editor

- [ ] Canvas 16:9.
- [ ] Texto.
- [ ] Fuente.
- [ ] Tamaño.
- [ ] Imágenes.
- [ ] Mover elementos.
- [ ] Redimensionar.
- [ ] Eliminar.

## Timeline

- [ ] Scroll horizontal.
- [ ] Selección.
- [ ] Reordenar por drag.
- [ ] `+` entre slides.
- [ ] Duplicar.
- [ ] Eliminar.
- [ ] No borrar última slide.

## Música

- [ ] Catálogo remoto.
- [ ] Buscar por nombre.
- [ ] Pegar URL YouTube.
- [ ] Obtener metadata.
- [ ] Guardar metadata en D1.
- [ ] Descargar localmente.
- [ ] Mostrar progreso.
- [ ] Cachear.
- [ ] Detectar cache existente.

## Video

- [ ] MP4 compatible.
- [ ] Máximo 1080p.
- [ ] H.264/AAC cuando sea posible.
- [ ] Mantener aspect ratio.
- [ ] Insertarse automáticamente en slide.

## PPTX

- [ ] Genera `.pptx`.
- [ ] Abre correctamente en PowerPoint.
- [ ] Texto aparece correctamente.
- [ ] Imágenes aparecen correctamente.
- [ ] Videos están físicamente embebidos.
- [ ] Reproduce videos offline.
- [ ] No usa Base64 para videos completos.
- [ ] Streaming de archivos grandes.
- [ ] No exporta si faltan videos.

## UX

- [ ] Carga rápida.
- [ ] UI moderna.
- [ ] Buena experiencia en 1366×768.
- [ ] Loading states explícitos.
- [ ] Sin modales innecesarios.
- [ ] Errores entendibles.
- [ ] Guardado automático visible.

---

# 54. Decisiones cerradas

El agente NO debe volver a debatir estas decisiones salvo que exista un bloqueo técnico demostrado:

```text
Go 1.20.14 para backend local
React + Vite para frontend
Tailwind
Zustand
Pragmatic Drag and Drop
Go localhost
browser externo
SQLite local
Worker + Hono
D1 + Drizzle
yt-dlp local
ffmpeg local
PPTX generado localmente
videos embebidos
instalación en %LOCALAPPDATA%
compilación local en install.ps1
frontend dist commiteado
sin Git/Node/Go permanente en máquina final
```

---

# 55. Criterio de éxito

El resultado correcto debe sentirse como una herramienta muy pequeña y específica:

```text
abrir
→ login
→ seleccionar/crear proyecto
→ añadir texto/imágenes
→ buscar o pegar canción
→ tocar canción
→ video aparece en una slide
→ reordenar slides
→ exportar
→ abrir PPTX sin internet
```

Todo lo que no contribuya directamente a ese flujo debe postergarse.

---

# 56. Nota final para el agente ejecutor

No conviertas este proyecto en una plataforma.

Es una herramienta privada para muy pocos usuarios.

Prioriza:

```text
funcionamiento
compatibilidad
rapidez
simplicidad
buena UI
```

por encima de:

```text
abstracciones
arquitectura distribuida
seguridad enterprise
configurabilidad extrema
generalización
```

Si surge una decisión menor que no está especificada aquí, elegir siempre la opción:

```text
más simple
más local
más rápida de implementar
más fácil de mantener
compatible con Windows 8
```

y continuar.
