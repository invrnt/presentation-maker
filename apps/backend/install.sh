#!/usr/bin/env bash
set -euo pipefail

# Run from the extracted package as the Debian user who owns the Vian bot.
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${PRESENTATION_MAKER_INSTALL_DIR:-$HOME/.local/share/presentation-maker-vian}"
# Non-interactive sessions may not load Bun's PATH entry from the shell profile.
bun_install="${BUN_INSTALL:-$HOME/.bun}"
if ! command -v bun >/dev/null && [[ -x "$bun_install/bin/bun" ]]; then
  export PATH="$bun_install/bin:$PATH"
fi
command -v bun >/dev/null || { echo 'Instala Bun (https://bun.com/docs/installation) y vuelve a ejecutar el instalador.' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'Se necesita systemd con sesión de usuario.' >&2; exit 1; }
missing_dependencies=false
for dependency in curl ffmpeg ffprobe python3 zip unzip; do
  command -v "$dependency" >/dev/null || missing_dependencies=true
done
if command -v apt-get >/dev/null && "$missing_dependencies"; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl ffmpeg python3 zip unzip
fi
for dependency in curl ffmpeg ffprobe python3 zip unzip; do
  command -v "$dependency" >/dev/null || { echo "Falta la dependencia obligatoria: $dependency" >&2; exit 1; }
done
ffmpeg -hide_banner -loglevel error -f lavfi -i color=s=16x16:d=0.1 -f lavfi -i anullsrc -t 0.1 \
  -vf 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited,zscale=transfer=linear,format=gbrpf32le,tonemap=tonemap=hable,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format=yuv420p' \
  -c:v libx264 -c:a aac -f null - || { echo 'FFmpeg debe incluir libx264, AAC, zscale y tonemap.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) yt_asset=yt-dlp_linux; deno_asset=deno-x86_64-unknown-linux-gnu.zip ;;
  aarch64) yt_asset=yt-dlp_linux_aarch64; deno_asset=deno-aarch64-unknown-linux-gnu.zip ;;
  *) echo 'Solo se admiten Debian x86_64 y aarch64.' >&2; exit 1 ;;
esac
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}"
command_dir="${PRESENTATION_MAKER_COMMAND_DIR:-$HOME/.local/bin}"
mkdir -p "$target/apps/backend" "$target/bots/presentation-maker/lib" "$target/bin" "$config_dir/systemd/user" "$command_dir"
target="$(cd "$target" && pwd)"
download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT
download_verified() {
  local url="$1" asset="$2" sums="$3" expected
  curl -fLSs --retry 3 "$url/$asset" -o "$download_dir/$asset"
  curl -fLSs --retry 3 "$url/$sums" -o "$download_dir/$sums"
  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$download_dir/$sums")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "Falta checksum de $asset" >&2; exit 1; }
  (cd "$download_dir" && printf '%s  %s\n' "$expected" "$asset" | sha256sum -c -)
}
latest_tag() {
  curl -fLSs --retry 3 "https://api.github.com/repos/$1/releases/latest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])'
}
yt_version="$(latest_tag yt-dlp/yt-dlp)"
download_verified "https://github.com/yt-dlp/yt-dlp/releases/download/$yt_version" "$yt_asset" SHA2-256SUMS
install -m 0755 "$download_dir/$yt_asset" "$target/bin/.yt-dlp.new"
mv -f "$target/bin/.yt-dlp.new" "$target/bin/yt-dlp"
deno_version="$(latest_tag denoland/deno)"
download_verified "https://github.com/denoland/deno/releases/download/$deno_version" "$deno_asset" "$deno_asset.sha256sum"
unzip -oq "$download_dir/$deno_asset" deno -d "$download_dir"
install -m 0755 "$download_dir/deno" "$target/bin/.deno.new"
mv -f "$target/bin/.deno.new" "$target/bin/deno"
echo "yt-dlp: $("$target/bin/yt-dlp" --version); Deno: $("$target/bin/deno" --version | head -1)"
cp "$source_dir/apps/backend/server.js" "$source_dir/apps/backend/template.pptx" "$source_dir/apps/backend/README.md" "$target/apps/backend/"
cp "$source_dir/bots/presentation-maker/vian.tools.ts" "$source_dir/bots/presentation-maker/README.md" "$target/bots/presentation-maker/"
cp "$source_dir/bots/presentation-maker/lib/"*.ts "$target/bots/presentation-maker/lib/"
for config in vian.json VIAN.md; do
  if [[ ! -e "$target/bots/presentation-maker/$config" ]]; then
    cp "$source_dir/bots/presentation-maker/$config" "$target/bots/presentation-maker/"
  fi
done
install -m 0755 "$source_dir/presentation-maker" "$target/.presentation-maker.new"
mv -f "$target/.presentation-maker.new" "$target/presentation-maker"
ln -sfn "$target/presentation-maker" "$command_dir/presentation-maker"
unit="$config_dir/systemd/user/presentation-maker-vian-backend.service"
if [[ ! -e "$unit" ]]; then
cat > "$unit" <<EOF
[Unit]
Description=Presentation Maker headless backend for Vian

[Service]
Type=simple
Environment=PRESENTATION_MAKER_HEADLESS=1
Environment=PRESENTATION_MAKER_TEMPLATE=$target/apps/backend/template.pptx
Environment=PRESENTATION_MAKER_DATA_DIR=%h/.local/share/presentation-maker-linux
Environment=PATH=$target/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v bun) $target/apps/backend/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
fi
systemctl --user daemon-reload
systemctl --user enable --now presentation-maker-vian-backend.service
systemctl --user restart presentation-maker-vian-backend.service
echo "Backend instalado en $target; bot: $target/bots/presentation-maker"
echo "Actualizar: $command_dir/presentation-maker update"
echo "Para iniciarlo al arrancar sin sesión: sudo loginctl enable-linger $USER"
echo "Registrar bot: vian init '$target/bots/presentation-maker'"
