#!/usr/bin/env bash
# Builds the browser client on Vercel. The normal repository does not track the
# local osu-framework checkout, so fetch the pinned revision and apply the web backend patch first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMEWORK_DIR="$ROOT/external/osu-framework"
FRAMEWORK_REVISION="247dee9888c51606b939f027bce54504f8ca26fa"
FRAMEWORK_PATCH="$ROOT/osu.Web/patches/osu-framework-web.patch"
DOTNET_VERSION="10.0.401"

if [ ! -f "$FRAMEWORK_DIR/osu.Framework/osu.Framework.csproj" ]; then
    rm -rf "$FRAMEWORK_DIR"
    mkdir -p "$(dirname "$FRAMEWORK_DIR")"
    git clone --filter=blob:none --no-checkout https://github.com/ppy/osu-framework.git "$FRAMEWORK_DIR"
    git -C "$FRAMEWORK_DIR" fetch --depth 1 origin "$FRAMEWORK_REVISION"
    git -C "$FRAMEWORK_DIR" checkout --detach "$FRAMEWORK_REVISION"
    git -C "$FRAMEWORK_DIR" apply "$FRAMEWORK_PATCH"
fi

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

if ! command -v dotnet >/dev/null 2>&1 || [ "$(dotnet --version)" != "$DOTNET_VERSION" ]; then
    mkdir -p "$DOTNET_ROOT"
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
    bash /tmp/dotnet-install.sh --version "$DOTNET_VERSION" --install-dir "$DOTNET_ROOT"
fi

dotnet workload install wasm-tools
bash "$ROOT/osu.Web/build.sh"

# Vercel's CDN performs content negotiation/compression itself. Publishing all
# three raw/gzip/brotli variants would make the deployment roughly three times larger.
find "$ROOT/osu.Web/dist/wwwroot" -type f \( -name '*.br' -o -name '*.gz' \) -delete

echo "Vercel output prepared at osu.Web/dist/wwwroot"
