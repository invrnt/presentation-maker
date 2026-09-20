# Presentation Maker

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

Guarda la URL que imprime `wrangler deploy`. El instalador la compila dentro del ejecutable local, pero ninguna credencial de Cloudflare entra en la aplicación.

Para trabajar sin tocar la base remota:

```bash
cd apps/worker
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

## Preparar una publicación privada

1. Compila el frontend.
2. Genera `source.zip`.
3. Sube `install.ps1` y `source.zip` a una ubicación HTTPS accesible para tus amigos.
4. Copia el SHA-256 que imprime el script.

```powershell
npm run build -w apps/web
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-source-zip.ps1
```

El comando de instalación queda así:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr 'URL_DE_INSTALL_PS1' -UseBasicParsing -OutFile `$env:TEMP\pm-install.ps1; & `$env:TEMP\pm-install.ps1 -SourceUrl 'URL_DE_SOURCE_ZIP' -SourceSha256 'SHA256_DE_SOURCE_ZIP' -ApiUrl 'URL_DEL_WORKER'"
```

El script descarga Go 1.20.14 en una carpeta temporal, compila `PresentationMaker.exe`, instala FFmpeg 7.0.1 y una versión fijada de yt-dlp, crea el acceso directo y borra el entorno de compilación. No cambia Defender, SmartScreen, el firewall ni la política permanente de PowerShell.

## Compatibilidad de Windows

El ejecutable se compila con Go 1.20.14 y tiene subsistema Windows 6.01, por lo que funciona desde Windows 7 SP1 de 64 bits hasta Windows 11. FFmpeg 7.0.1 fue la última línea de builds de Gyan compatible con Windows 7 y 8.

Hay una limitación inevitable en Windows 7: yt-dlp dejó de admitirlo oficialmente después de `2024.10.22`. El instalador usa esa última versión en Windows 7 y muestra una advertencia. Como YouTube cambia con frecuencia, la descarga de videos puede dejar de funcionar allí. Windows 8, 8.1, 10 y 11 usan una versión posterior fijada y verificada. La edición de proyectos y la exportación con videos ya guardados siguen funcionando sin internet.

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
