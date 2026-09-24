# Vian bot: presentation-maker

Telegram bot that creates and exports Presentation Maker decks from this repo.
Requires Vian v0.1.0-preview.3 or newer for portable bot-root resolution.

## Layout

| File | Role |
| --- | --- |
| `vian.json` | Provider/model, Telegram gate, runtime limits |
| `VIAN.md` | Bot instructions (Spanish) |
| `vian.tools.ts` | Trusted tools → local Bun API (or previous Go/Worker path in Windows mode) |
| `lib/` | API client, backend bootstrap, plan/song helpers; Vian supplies the bot root when loading tools |
| `.env` | Secrets (gitignored): Telegram token; app login only in Windows mode |

## Tools

- `ensure_backend` / `backend_status` — start/check Bun server (`:3210`)
- `list_projects`, `create_project`, `get_project`, `save_project`, `set_project_title`, `add_slide`
- `list_songs`, `prepare_song` — YouTube import + download until ready
- `upload_image` — bot attachment id → `POST /api/assets`
- `ai_generate_slides` — available only in the previous Windows/Worker mode
- `export_presentation` — PPTX export → Vian attachment for `send_attachment`

Built-in Vian tools also available: `list_attachments`, `send_attachment`.

## Local stack

The bot defaults to Linux local mode. Install Bun and the system tools, then run `npm ci && npm run linux:build` from the repository root. `ensure_backend` starts `bun apps/linux/server.ts`. Set `PRESENTATION_MAKER_DATA_DIR` to select the same database as a manually started server. Only the Telegram credential is needed in the bot `.env`; app login and Worker credentials are not used.

To use the previous Worker/Go stack, set `PRESENTATION_MAKER_MODE=windows` and retain its login and Worker configuration. See the root README for that stack.

## Vian commands

```bash
vian init ./bots/presentation-maker   # existing clone: fill local files and register globally
vian doctor presentation-maker
vian test presentation-maker 'Crea una presentación de prueba y expórtala'
vian daemon                 # or: vian service install && vian service start
vian telegram connect presentation-maker   # owner, hidden token prompt
vian access pending presentation-maker
vian access approve presentation-maker <code> --as owner
vian status
vian logs presentation-maker --follow
```

Keep `.env` and `.vian/` out of git (covered by this folder’s `.gitignore` and the root ignore rules).
