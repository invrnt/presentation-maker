# Presentation Maker

**Linux local edition:** see [apps/linux/README.md](apps/linux/README.md) for the Bun + SQLite server, system video tools, build and run commands. The instructions below describe the existing Windows/Go/Cloudflare edition.

Aplicación privada para crear presentaciones con texto, imágenes y videos de YouTube guardados dentro del archivo PPTX. La interfaz está en español, los proyectos se guardan en el equipo y el servidor local solo escucha en `127.0.0.1`.

## Qué incluye

- Inicio de sesión remoto con acceso offline después del primer ingreso.
- Proyectos locales en SQLite y guardado automático cada 450 ms.
- Editor 16:9 con texto, imágenes, mover, redimensionar y eliminar.
- Timeline con insertar, duplicar, borrar y arrastrar diapositivas.
- Repertorio compartido en Cloudflare D1.
- Descarga secuencial de videos con progreso y caché local.
- Exportación PPTX local con imágenes y MP4 embebidos físicamente.
- Worker de Cloudflare para usuarios, sesiones y canciones.
- Instalador sin permisos de administrador, con verificación SHA-256.

## Desarrollo local

Requisitos de desarrollo: Node.js, npm y Go. Los equipos finales no necesitan ninguno de ellos.

```bash
npm install
npm run build -w apps/web
cd apps/local
go run .
```

Para conectar el servidor local a un Worker en desarrollo:

```bash
PRESENTATION_MAKER_API_URL=http://127.0.0.1:8787 go run .
```

Para mantener los datos de prueba dentro del repositorio temporal de trabajo:

```bash
PRESENTATION_MAKER_DATA_DIR=/tmp/presentation-maker-data go run .
```

## Configurar Cloudflare

Wrangler puede crear D1 automáticamente a partir de `apps/worker/wrangler.jsonc`.

```bash
cd apps/worker
npx wrangler login
npx wrangler deploy
npx wrangler d1 migrations apply DB --remote
npm run seed:admin
```

Puedes ejecutar `npm run seed:admin` de nuevo con el mismo usuario para restablecer su contraseña.

Guarda la URL que imprime `wrangler deploy`. El instalador la compila dentro del ejecutable local, pero ninguna credencial de Cloudflare entra en la aplicación.

Para trabajar sin tocar la base remota:

```bash
cd apps/worker
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

## Instalación en Windows 8, 8.1, 10 y 11

El repositorio público ya contiene el instalador, el `source.zip` y la URL del Worker. En cada equipo abre PowerShell como usuario normal y ejecuta el mismo comando:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Set-Variable ErrorActionPreference Stop;if([Environment]::OSVersion.Version -lt [Version]'6.2'){Write-Host 'Presentation Maker requiere Windows 8 o posterior.';exit 1};[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;(New-Object Net.WebClient).DownloadFile('https://github.com/invrnt/presentation-maker/releases/latest/download/install.ps1',[IO.Path]::Combine([IO.Path]::GetTempPath(),'presentation-maker-install.ps1')); & ([IO.Path]::Combine([IO.Path]::GetTempPath(),'presentation-maker-install.ps1'))"
```

El comando usa `Net.WebClient` y activa TLS 1.2 explícitamente. No hace falta abrir PowerShell como administrador.

El instalador descarga la última release de GitHub, verifica el SHA-256 publicado, compila la aplicación y su actualizador con Go 1.20.14, instala las herramientas multimedia, crea el acceso directo y abre la aplicación.

## Publicar una actualización

La app consulta una sola vez la última GitHub Release al abrir la pantalla de proyectos. Si encuentra una versión mayor, muestra el botón `Actualizar ahora`. El actualizador se abre como un proceso separado, enseña el progreso y reemplaza únicamente `PresentationMaker.exe` y `PresentationMakerUpdater.exe`. No toca `data`, `cache`, `assets`, `exports` ni `bin`.

Para publicar una versión nueva, actualiza el código en `main` y crea un tag semántico:

```bash
git tag v1.0.1
git push origin v1.0.1
```

El workflow `.github/workflows/release.yml` compila el frontend y crea la release con `source.zip`, `source.zip.sha256` e `install.ps1`. La versión del tag se compila dentro del ejecutable. Usa siempre `vMAJOR.MINOR.PATCH` y no reutilices un tag publicado.

El instalador descarga Go 1.20.14 en una carpeta temporal, compila `PresentationMaker.exe` y `PresentationMakerUpdater.exe`, instala FFmpeg 7.0.1 y yt-dlp 2026.08.19, crea el acceso directo y borra el entorno de compilación. No cambia Defender, SmartScreen, el firewall ni la política permanente de PowerShell.

Antes de usar YouTube, la aplicación comprueba que esa versión compatible de yt-dlp esté instalada y la actualiza si hace falta. Prefiere video H.264 y audio AAC de hasta 1080p. Si YouTube solo entrega VP9, AV1 u Opus, FFmpeg lo convierte automáticamente a MP4 H.264/AAC con píxeles `yuv420p` y carga rápida.

## Asistente de IA

El editor incluye `Crear con IA`. Acepta una instrucción y hasta cuatro imágenes PNG, JPG o WebP. El Worker añade el repertorio completo y el estado de las diapositivas, pide un plan estructurado a Vercel AI Gateway y devuelve operaciones que el cliente valida antes de modificar el proyecto.

La clave nunca entra en el ejecutable ni en D1. Configúrala como secret de Cloudflare y despliega el Worker:

```bash
cd apps/worker
npx wrangler secret put AI_GATEWAY_API_KEY
npm run db:migrate
npm run deploy
```

El modelo se guarda en D1. El valor inicial es `openai/gpt-5.6-luna`; un administrador puede cambiarlo desde `Usuarios > Modelo` escribiendo cualquier identificador `proveedor/modelo` admitido por Vercel AI Gateway.

## Compatibilidad de Windows

El soporte oficial comienza en Windows 8 de 64 bits y llega hasta Windows 11. El instalador usa Go 1.20.14 porque es la última línea de Go compatible con Windows 8. Windows 7 queda fuera porque sus instalaciones antiguas pueden no admitir la conexión TLS 1.2 que exigen GitHub y los demás servicios de descarga.

## Archivos locales

La instalación y los datos viven en:

```text
%LOCALAPPDATA%\PresentationMaker\
├── PresentationMaker.exe
├── bin\
├── data\app.db
├── cache\media\
├── cache\thumbnails\
├── assets\
└── exports\
```

Usa la descarga de YouTube solo con contenido propio o con permiso para descargar y reproducir.

## Comprobaciones antes de repartirla

```bash
npm run build
cd apps/local
GOTOOLCHAIN=go1.20.14 go test ./...
GOTOOLCHAIN=go1.20.14 GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -H windowsgui' -o PresentationMaker.exe .
```

Antes de enviarla a los demás, prueba en una máquina o VM con la versión mínima de Windows que realmente vayas a usar: iniciar sesión, descargar un video, exportar el PPTX, desconectar internet y reproducirlo en PowerPoint. Esa prueba no se puede sustituir desde Linux.
