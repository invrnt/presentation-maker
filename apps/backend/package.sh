#!/usr/bin/env bash
set -euo pipefail

# Run from any directory in the source checkout. The tarball contains only runtime files.
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:-$repo/presentation-maker-vian-debian.tar.gz}"
command -v bun >/dev/null || { echo 'Se necesita Bun para compilar el backend.' >&2; exit 1; }
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/apps/backend" "$stage/bots/presentation-maker/lib"
bun build "$repo/apps/linux/server.ts" --target=bun --outfile "$stage/apps/backend/server.js"
cp "$repo/apps/local/template.pptx" "$stage/apps/backend/template.pptx"
cp "$repo/apps/backend/README.md" "$stage/apps/backend/README.md"
cp "$repo/bots/presentation-maker/vian.tools.ts" "$repo/bots/presentation-maker/VIAN.md" "$repo/bots/presentation-maker/vian.json" "$repo/bots/presentation-maker/README.md" "$stage/bots/presentation-maker/"
cp "$repo/bots/presentation-maker/lib/"*.ts "$stage/bots/presentation-maker/lib/"
cp "$repo/apps/backend/install.sh" "$stage/install.sh"
tar -czf "$output" -C "$stage" .
echo "Paquete mínimo: $output"
