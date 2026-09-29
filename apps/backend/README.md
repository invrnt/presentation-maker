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
