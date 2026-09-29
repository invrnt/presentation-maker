# Backend headless para el bot de Vian (Debian)

Este paquete está **diseñado para usarse como bot de Vian**: `bots/presentation-maker/vian.tools.ts` llama a la API local para crear presentaciones, gestionar imágenes y videos de YouTube, y devolver archivos PPTX como adjuntos. No incluye editor web, Worker ni credenciales. Usa Bun + SQLite; escucha solo en `127.0.0.1:3210`. En reposo no hay sondeo ni descargas: systemd mantiene un único proceso Bun a la espera de peticiones.

## Crear el paquete mínimo

Descarga el paquete de la última release en el equipo Debian:

```bash
curl -fLO https://github.com/invrnt/presentation-maker/releases/latest/download/presentation-maker-vian-debian.tar.gz
```

Para construirlo desde el repositorio con Bun instalado:

```bash
bash apps/backend/package.sh
```

En Debian, instala [Bun](https://bun.com/docs/installation) y Vian (véase [invrnt/vian](https://github.com/invrnt/vian)). Descomprime e instala **solo el paquete**, no el repositorio:

```bash
mkdir -p ~/presentation-maker-install
tar -xzf ~/presentation-maker-vian-debian.tar.gz -C ~/presentation-maker-install
bash ~/presentation-maker-install/install.sh
```

El instalador instala `ffmpeg`, `zip`, `unzip`, `curl` y `python3` mediante apt (solicita sudo). Descarga las últimas versiones estables oficiales de `yt-dlp` y Deno para `x86_64` o `aarch64`, verifica sus SHA-256 y las instala en `~/.local/share/presentation-maker-vian/bin/`. El ejecutable oficial de `yt-dlp` incluye los scripts EJS que YouTube requiere. El servicio prioriza estos binarios sobre los de apt. Al volver a ejecutar el instalador se actualizan ambos. También copia el backend compilado con `bun build`, la plantilla PPTX y los archivos del bot. Crea y arranca el servicio de usuario `presentation-maker-vian-backend.service`. Para funcionamiento día y noche, incluso tras cerrar sesión:

```bash
sudo loginctl enable-linger "$USER"
vian init ~/.local/share/presentation-maker-vian/bots/presentation-maker
vian doctor presentation-maker
vian service install
vian service start
```

Configura la credencial de Telegram siguiendo el README del bot. Los datos quedan en `~/.local/share/presentation-maker-linux/` y se conservan al reinstalar; también se conservan `.env`, `.vian/` y un `vian.json` existente. El servicio responde en `/api/health` y devuelve 404 para cualquier ruta de interfaz. Para comprobar las versiones instaladas:

```bash
systemctl --user status presentation-maker-vian-backend
curl http://127.0.0.1:3210/api/health
~/.local/share/presentation-maker-vian/bin/yt-dlp --version
~/.local/share/presentation-maker-vian/bin/deno --version
```

Para desarrollo desde el checkout, el backend original sigue en `apps/linux/server.ts`; ejecuta `PRESENTATION_MAKER_HEADLESS=1 bun apps/linux/server.ts` para probar la API sin interfaz. La instalación empaquetada no necesita Node, npm, Go, Cloudflare ni los archivos del editor.

## Actualizar una instalación existente

Desde v1.1.6 el instalador añade el comando a `~/.local/bin`:

```bash
presentation-maker update
```

Si esa carpeta no está en tu PATH, usa `~/.local/bin/presentation-maker update`. El comando descarga la última release estable, verifica el SHA-256 del paquete, guarda una copia privada del bot en `<instalación>/backups/` y ejecuta el instalador. Actualiza el backend, las herramientas del bot, yt-dlp y Deno, y reinicia el backend. Solo solicita sudo si faltan dependencias del sistema.

Conserva `vian.json`, `.env`, `VIAN.md`, `.vian/` y el servicio systemd existente, incluidos su puerto y directorio de datos personalizados. La configuración global de Vian y la base de datos de proyectos no se modifican. La copia contiene todo el directorio del bot, el `.env` de la instalación si existe y el archivo del servicio; no es una copia de los proyectos ni de la configuración global de Vian. No ejecutes la actualización mientras el bot esté generando una presentación o descargando videos.

Para actualizar una versión anterior que todavía no tiene el comando:

```bash
curl -fL https://github.com/invrnt/presentation-maker/releases/latest/download/presentation-maker \
  -o /tmp/presentation-maker-update &&
bash /tmp/presentation-maker-update update
```

Si usaste una ruta personalizada, añade `PRESENTATION_MAKER_INSTALL_DIR=/ruta/de/instalacion` antes de `bash`. El comando instalado detecta su propia carpeta en las siguientes actualizaciones. No hace falta volver a registrar el bot con `vian init`.

Si la instalación falla, el comando termina con error e indica la ruta de la copia. La copia no se borra automáticamente. Para recuperar archivos de configuración, extrae `bot.tar.gz` en una carpeta temporal y copia únicamente los archivos necesarios al bot instalado.

## Videos fiables y diagnóstico

El instalador y `ensure_backend` comprueban FFmpeg **ejecutando** sus codificadores
libx264/AAC y filtros zscale/tonemap; también se requieren ffprobe, yt-dlp y Deno.
`GET /api/media/health` devuelve `ready`, `errors` y la versión del perfil de video.
La salud básica `/api/health` indica si el servidor responde, independientemente de
las dependencias. Si falta alguna, vuelve a ejecutar el instalador.

- Se elige la resolución disponible más cercana a 1080p, incluso si es superior;
  funciona también con videos verticales. No se exige un contenedor o códec de origen.
- Las descargas tienen reintentos con espera creciente y no omiten fragmentos fallidos.
  Se rechazan emisiones en directo y estrenos aún no disponibles.
- Todo video se convierte a MP4 H.264 High 4.1, `yuv420p` de 8 bits, 30 fps y audio
  AAC-LC estéreo a 48 kHz si la fuente tiene audio. HDR se convierte a SDR.
  Se conserva la proporción, sin ampliar fuentes pequeñas, hasta 1920×1080 o
  1080×1920. Se comprueban códecs y duración y se decodifica el resultado completo
  antes de publicarlo. La miniatura usa el primer cuadro para admitir clips cortos.
- Una cola procesa un video a la vez para limitar CPU y disco; las solicitudes del
  mismo video comparten trabajo. El archivo final se publica mediante renombrado
  después de validarlo. Los temporales se eliminan al terminar y tras un reinicio.
- No hay un límite artificial de bytes para descargar videos. Se necesitan disco
  suficiente para la fuente, conversión y PPTX, y tiempo de CPU. El mínimo de 256 MB
  libres al iniciar no garantiza espacio para toda la operación. El tiempo máximo
  por proceso de descarga/conversión/validación es de 6 horas; se configura en el
  servicio con `PRESENTATION_MAKER_MEDIA_TIMEOUT_HOURS` (`0` elimina ese límite).
- `prepare_song` espera hasta un minuto. Si devuelve `downloaded=false` y `jobId`,
  el trabajo continúa aunque termine el turno del agente. Usa `get_download_job`;
  cuando termine, repite `prepare_song` con el id de la canción. Añade el video
  solamente con `downloaded=true`. Un error incluye `failure.code`, `retryable`,
  `message` y un diagnóstico sin URLs firmadas. Repetir `prepare_song` tras un fallo
  crea otro intento. Un reinicio marca los trabajos interrumpidos como fallidos.
- La API ofrece `GET /api/jobs/:id` y mantiene los eventos SSE para otros clientes.
  Los videos de la caché anterior deben prepararse nuevamente una vez para certificar
  el perfil nuevo. Las presentaciones se conservan.
- El PPTX incrusta una sola copia de cada video, aunque aparezca en varias slides.
  El bot descarga el PPTX al disco mediante streaming. Los límites de adjuntos de
  Vian/Telegram siguen aplicando (el `vian.json` incluido configura 50 MiB); un video
  descargable no implica que el PPTX pueda enviarse por ese canal.

El soporte de formatos depende de los decodificadores de FFmpeg. Videos privados,
DRM, restricciones regionales y bloqueos de YouTube no se pueden garantizar ni
sortear automáticamente. El flujo sigue aceptando enlaces de YouTube; esto no
agrega carga de archivos de video ni URLs de sitios arbitrarios.

Referencias: [selección de formatos de yt-dlp](https://github.com/yt-dlp/yt-dlp#format-selection)
y [filtros de FFmpeg](https://ffmpeg.org/ffmpeg-filters.html).

Pruebas del backend y del bot (requieren FFmpeg y Bun):

```bash
bun test apps/linux apps/backend/update.test.ts bots/presentation-maker/tests
bash apps/backend/package.sh
```
