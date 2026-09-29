#!/usr/bin/env bash
# Builds the browser client on Vercel. The normal repository does not track the
# local osu-framework checkout, so fetch the pinned revision and apply the web backend patch first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAMEWORK_DIR="$ROOT/external/osu-framework"
FRAMEWORK_REVISION="247dee9888c51606b939f027bce54504f8ca26fa"
FRAMEWORK_PATCH="$ROOT/osu.Web/patches/osu-framework-web.patch"
DOTNET_VERSION="10.0.401"

# Vercel's build image is based on Amazon Linux 2023, whose base image does not ship everything this
# build needs (git, tar, gzip, find), has no ICU, which the .NET host itself requires, and no
# libatomic, which the workload's emscripten node binary requires. Install whatever is missing
# instead of relying on the build image's package set.
required_tools=(git tar gzip find curl)
required_packages=(git tar gzip findutils curl)
missing_packages=()

for index in "${!required_tools[@]}"; do
    command -v "${required_tools[$index]}" >/dev/null 2>&1 || missing_packages+=("${required_packages[$index]}")
done

if command -v dnf >/dev/null 2>&1; then
    compgen -G '/usr/lib64/libicu*' >/dev/null || missing_packages+=(libicu)
    compgen -G '/usr/lib64/libatomic*' >/dev/null || missing_packages+=(libatomic)
fi

if [ "${#missing_packages[@]}" -gt 0 ]; then
    echo "Installing missing build prerequisites: ${missing_packages[*]}"

    if command -v dnf >/dev/null 2>&1; then
        # The Amazon Linux image provides curl-minimal. Do not request the conflicting full curl
        # package when that already supplies the curl executable.
        dnf install -y "${missing_packages[@]}"
    elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq "${missing_packages[@]}"
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache "${missing_packages[@]}"
    fi
fi

for tool in "${required_tools[@]}"; do
    command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required but unavailable" >&2; exit 1; }
done

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
