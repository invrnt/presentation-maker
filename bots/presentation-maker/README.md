# Vian bot: presentation-maker

Telegram bot that creates and exports Presentation Maker decks from this repo.
Requires Vian v0.1.0-preview.3 or newer for portable bot-root resolution.

## Layout

| File | Role |
| --- | --- |
| `vian.json` | Provider/model, Telegram gate, runtime limits |
| `VIAN.md` | Bot instructions (Spanish) |
| `vian.tools.ts` | Trusted tools → local Go API + Worker |
| `lib/` | API client, backend bootstrap, plan/song helpers; Vian supplies the bot root when loading tools |
| `.env` | Secrets (gitignored): Telegram token + app login |

## Tools

- `ensure_backend` / `backend_status` — start/check Worker (`:8787`) + Go server (`:3210`) + login
- `list_projects`, `create_project`, `get_project`, `save_project`, `set_project_title`, `add_slide`
- `list_songs`, `prepare_song` — YouTube import + download until ready
- `upload_image` — bot attachment id → `POST /api/assets`
- `ai_generate_slides` — app AI planner (`/api/ai/plan`) + apply plan + save
- `export_presentation` — PPTX export → Vian attachment for `send_attachment`

Built-in Vian tools also available: `list_attachments`, `send_attachment`.

## Local stack

App login and Telegram credentials live in this bot's `.env` (`PRESENTATION_MAKER_USERNAME`, `PRESENTATION_MAKER_PASSWORD`, `TELEGRAM_BOT_TOKEN`). The app's `AI_GATEWAY_API_KEY` can live in the repository root `.env`. Both files stay local.
`ensure_backend` starts:

1. `npx wrangler dev` in `apps/worker` with `AI_GATEWAY_API_KEY`
2. `go run .` in `apps/local` with `PRESENTATION_MAKER_API_URL=http://127.0.0.1:8787`

Manual:

```bash
cd apps/worker && npx wrangler d1 migrations apply DB --local && npx wrangler dev
cd apps/local && PRESENTATION_MAKER_API_URL=http://127.0.0.1:8787 go run .
```

Seed admin (interactive): `npm run seed:admin -- --local`

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
