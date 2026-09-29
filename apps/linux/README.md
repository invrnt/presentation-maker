# Presentation Maker on Linux

For a Debian bot-only deployment without the editor, see [apps/backend/README.md](../backend/README.md).

This is the local Linux server. It uses Bun and a SQLite database. It serves the existing editor in a Linux build that hides login, account management, updates and app AI. It makes no Cloudflare Worker or AI API calls. The Windows Go application remains at `apps/local`.

## Run

Install Bun 1.4 or newer, Node.js/npm for building the editor, and `ffmpeg` (including `ffprobe` and an H.264 encoder), `zip`, and `unzip` from your distro. YouTube extraction also needs a current stable official `yt-dlp` executable and Deno 2.3 or newer. The [headless Debian installer](../backend/README.md) downloads and verifies both automatically. For a source checkout, follow the official [yt-dlp installation guide](https://github.com/yt-dlp/yt-dlp/wiki/Installation) and [EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS); distro `yt-dlp` packages may lag behind YouTube changes.

```bash
npm ci
npm run linux:build
npm run linux:serve
```

Open `http://127.0.0.1:3210`. The server binds only to loopback. Data defaults to `~/.local/share/presentation-maker-linux/` and can be moved with `PRESENTATION_MAKER_DATA_DIR`. Change the port with `PRESENTATION_MAKER_PORT`. The Linux database is separate from the Windows database; there is no migration/import tool yet.

YouTube import uses `yt-dlp` for metadata. Download uses `yt-dlp`, Deno, `ffprobe`, and `ffmpeg` to produce H.264/AAC MP4 for PowerPoint, with files cached locally. Download only videos you own or are permitted to use. A network connection and a working YouTube extractor are needed for import and first download; cached videos and projects remain local.

## Vian bot

The bot now defaults to this Bun backend and starts it with `ensure_backend`. It needs a built `apps/linux/web/dist` from `npm run linux:build` for browser use, and `bun` in its `PATH`. Set `PRESENTATION_MAKER_DATA_DIR` to share a specific local database. App login and Worker credentials are not needed in Linux mode. The bot's model and Telegram settings remain Vian's own configuration; its app AI generation tool is unavailable in Linux mode. To use the previous Worker/Go bot path, set `PRESENTATION_MAKER_MODE=windows` in the bot environment.

## Checks

```bash
bun test apps/linux/server.test.ts
npm run linux:build
npm run build -w apps/web
```

Implementation references checked 2026-09-24: [Bun SQLite](https://bun.com/docs/runtime/sqlite) and [Bun HTTP routing/server](https://bun.com/docs/runtime/http/server) for Bun 1.4.2; [yt-dlp installation](https://github.com/yt-dlp/yt-dlp/wiki/Installation) for Debian package/upstream update options. The server has no added npm runtime dependencies.
