#!/bin/bash
# Builds osu!web into osu.Web/dist (serve dist/wwwroot with cross-origin isolation headers, e.g. `node tools/serve.mjs dist/wwwroot`).
#
#   ./build.sh            Release build (interpreted IL - quick to build)
#   ./build.sh --aot      Release build with AOT compilation to WebAssembly (much faster at runtime, slow to build)
#   ./build.sh --debug    Debug build
#
# Prerequisites: .NET 10 SDK with the wasm-tools workload (`dotnet workload install wasm-tools`), and the prebuilt native
# libraries in native/lib (run native/build-realm.sh and native/build-spirv.sh once).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.dotnet:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1
# Note: do not source native/emsdk-env.sh here - the .NET build uses the workload's own (frozen) emscripten cache/config.

CONFIG=Release
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --aot) EXTRA+=(-p:OsuWebAot=true) ;;
    --debug) CONFIG=Debug ;;
    *) EXTRA+=("$arg") ;;
  esac
done

[ -f native/lib/realm/realm-wrappers.a ] || bash native/build-realm.sh
[ -f native/lib/spirv/libveldrid-spirv.a ] || bash native/build-spirv.sh
[ -f native/lib/sqlite/e_sqlite3.a ] || bash native/build-sqlite.sh

rm -rf dist
dotnet publish osu.Web.csproj -c "$CONFIG" -p:OsuWebBuild=true -o dist ${EXTRA[@]+"${EXTRA[@]}"}
echo "Built to $(pwd)/dist/wwwroot"
