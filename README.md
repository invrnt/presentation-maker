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

## Instalación en Windows 7, 8, 8.1, 10 y 11

El repositorio público ya contiene el instalador, el `source.zip` y la URL del Worker. En cada equipo abre PowerShell como usuario normal y ejecuta el mismo comando:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$u='https://raw.githubusercontent.com/invrnt/presentation-maker/0da5a3a8244f3e0c9eda67763b83bb41ad6cbff5/install.ps1';$p=Join-Path $env:TEMP 'presentation-maker-install.ps1';(New-Object Net.WebClient).DownloadFile($u,$p);& $p"
```

El comando usa `Net.WebClient` para que también funcione con el PowerShell incluido en Windows 7. No hace falta abrir PowerShell como administrador.

El instalador descarga `source.zip` desde GitHub, verifica el SHA-256 fijado, compila el ejecutable con Go 1.20.14, instala las herramientas multimedia, crea el acceso directo y abre la aplicación. En Windows 7 selecciona automáticamente la versión antigua de yt-dlp compatible con ese sistema; en Windows 8, 8.1, 10 y 11 usa la versión posterior fijada.

Si quieres regenerar una publicación después de cambiar el código:

1. Compila el frontend.
2. Genera `source.zip`.
3. Sube `source.zip` a la rama `main`.
4. Copia el SHA-256 nuevo al valor `$SourceSha256` de `install.ps1`.

```powershell
npm run build -w apps/web
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-source-zip.ps1
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
