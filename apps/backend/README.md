# Backend headless para el bot de Vian (Debian)

Este paquete está **diseñado para usarse como bot de Vian**: `bots/presentation-maker/vian.tools.ts` llama a la API local para crear presentaciones, gestionar imágenes y videos de YouTube, y devolver archivos PPTX como adjuntos. No incluye editor web, Worker ni credenciales. Usa Bun + SQLite; escucha solo en `127.0.0.1:3210`. En reposo no hay sondeo ni descargas: systemd mantiene un único proceso Bun a la espera de peticiones.

## Crear el paquete mínimo

En el equipo con el repositorio y Bun instalado:

```bash
bash apps/backend/package.sh
scp presentation-maker-vian-debian.tar.gz usuario@debian:~/
```

En Debian, instala [Bun](https://bun.com/docs/installation) y Vian (véase [invrnt/vian](https://github.com/invrnt/vian)). Descomprime e instala **solo el paquete**, no el repositorio:

```bash
mkdir -p ~/presentation-maker-install
tar -xzf ~/presentation-maker-vian-debian.tar.gz -C ~/presentation-maker-install
bash ~/presentation-maker-install/install.sh
```

El instalador instala `ffmpeg`, `yt-dlp`, `zip` y `unzip` mediante apt (solicita sudo); copia el backend compilado con `bun build`, la plantilla PPTX y únicamente los archivos del bot a `~/.local/share/presentation-maker-vian/`. Crea y arranca el servicio de usuario `presentation-maker-vian-backend.service`. Para funcionamiento día y noche, incluso tras cerrar sesión:

```bash
sudo loginctl enable-linger "$USER"
vian init ~/.local/share/presentation-maker-vian/bots/presentation-maker
vian doctor presentation-maker
vian service install
vian service start
```

Configura la credencial de Telegram siguiendo el README del bot. Si Debian trae una versión antigua de `yt-dlp`, actualízala según [yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation). Los datos quedan en `~/.local/share/presentation-maker-linux/` y se conservan al reinstalar; también se conservan `.env`, `.vian/` y un `vian.json` existente. El servicio responde en `/api/health` y devuelve 404 para cualquier ruta de interfaz.

```bash
systemctl --user status presentation-maker-vian-backend
curl http://127.0.0.1:3210/api/health
```

Para desarrollo desde el checkout, el backend original sigue en `apps/linux/server.ts`; ejecuta `PRESENTATION_MAKER_HEADLESS=1 bun apps/linux/server.ts` para probar la API sin interfaz. La instalación empaquetada no necesita Node, npm, Go, Cloudflare ni los archivos del editor.
