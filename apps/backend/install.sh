#!/usr/bin/env bash
set -euo pipefail

# Run from the extracted package as the Debian user who owns the Vian bot.
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${PRESENTATION_MAKER_INSTALL_DIR:-$HOME/.local/share/presentation-maker-vian}"
command -v bun >/dev/null || { echo 'Instala Bun (https://bun.com/docs/installation) y vuelve a ejecutar el instalador.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'Se necesita systemd con sesión de usuario.' >&2; exit 1; }
if command -v apt-get >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y ffmpeg yt-dlp zip unzip
fi
mkdir -p "$target/apps/backend" "$target/bots/presentation-maker/lib" "$HOME/.config/systemd/user"
cp "$source_dir/apps/backend/server.js" "$source_dir/apps/backend/template.pptx" "$source_dir/apps/backend/README.md" "$target/apps/backend/"
cp "$source_dir/bots/presentation-maker/vian.tools.ts" "$source_dir/bots/presentation-maker/VIAN.md" "$source_dir/bots/presentation-maker/README.md" "$target/bots/presentation-maker/"
cp "$source_dir/bots/presentation-maker/lib/"*.ts "$target/bots/presentation-maker/lib/"
if [[ ! -e "$target/bots/presentation-maker/vian.json" ]]; then
  cp "$source_dir/bots/presentation-maker/vian.json" "$target/bots/presentation-maker/"
fi
unit="$HOME/.config/systemd/user/presentation-maker-vian-backend.service"
cat > "$unit" <<EOF
[Unit]
Description=Presentation Maker headless backend for Vian

[Service]
Type=simple
Environment=PRESENTATION_MAKER_HEADLESS=1
Environment=PRESENTATION_MAKER_TEMPLATE=$target/apps/backend/template.pptx
Environment=PRESENTATION_MAKER_DATA_DIR=%h/.local/share/presentation-maker-linux
ExecStart=$(command -v bun) $target/apps/backend/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now presentation-maker-vian-backend.service
systemctl --user restart presentation-maker-vian-backend.service
echo "Backend instalado en $target; bot: $target/bots/presentation-maker"
echo "Para iniciarlo al arrancar sin sesión: sudo loginctl enable-linger $USER"
echo "Registrar bot: vian init '$target/bots/presentation-maker'"
