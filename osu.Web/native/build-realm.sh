#!/bin/bash
# Builds Realm .NET 20.1.0's native "realm-wrappers" (bundling realm-core 20.1.2) as one static WebAssembly archive for the
# multithreaded .NET runtime (-pthread, native wasm exceptions). Re-runnable; CLEAN=1 wipes the build directory first.
#
#   native/build-realm.sh [realm-dotnet checkout]     (default ~/Desktop/realm-dotnet, cloned if missing)
#
# Output: native/lib/realm/realm-wrappers.a and native/lib/realm/exports.txt (every DllImport entry point, all verified present).
set -euo pipefail
cd "$(dirname "$0")"
NATIVE="$(pwd)"
source ./emsdk-env.sh

SRC="${1:-$HOME/Desktop/realm-dotnet}"
OUT="$NATIVE/lib/realm"
PATCH="$NATIVE/patches/realm-core-wasm-mt.patch"
LLVM="$EMSDK/bin"

if [ ! -d "$SRC/wrappers" ]; then
  git clone -q --depth 1 --branch 20.1.0 https://github.com/realm/realm-dotnet.git "$SRC"
fi
git -C "$SRC" submodule update --init --depth 1 wrappers/realm-core
git -C "$SRC/wrappers/realm-core" submodule update --init --depth 1 src/external/sha-1 src/external/sha-2

# realm-core's Emscripten support assumes single-threaded wasm (see the patch for details).
CORE="$SRC/wrappers/realm-core"
if ! git -C "$CORE" apply --reverse --check "$PATCH" 2>/dev/null; then
  git -C "$CORE" apply "$PATCH"
fi

BUILD="$SRC/wrappers/build-wasm"
[ "${CLEAN:-0}" = 1 ] && rm -rf "$BUILD"

emcmake cmake -S "$SRC/wrappers" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-pthread -fwasm-exceptions" \
  -DCMAKE_CXX_FLAGS="-pthread -fwasm-exceptions" \
  -DREALM_BUILD_LIB_ONLY=ON \
  -DREALM_NO_TESTS=ON \
  -DREALM_DOTNET_BUILD_CORE_FROM_SOURCE=ON \
  -DREALM_VERSION=20.1.2 > /tmp/realm-build.log 2>&1
cmake --build "$BUILD" --target realm-wrappers ObjectStore QueryParser Storage >> /tmp/realm-build.log 2>&1

mkdir -p "$OUT"
rm -f "$OUT/realm-wrappers.a"
libs=()
for name in librealm.a librealm-object-store.a librealm-parser.a librealm-wrappers.a; do
  lib="$(find "$BUILD" -name "$name" -print -quit)"
  [ -n "$lib" ] || { echo "missing $name in $BUILD" >&2; exit 1; }
  libs+=("$lib")
done
{
  echo "CREATE $OUT/realm-wrappers.a"
  for lib in "${libs[@]}"; do echo "ADDLIB $lib"; done
  echo "SAVE"
  echo "END"
} | "$LLVM/llvm-ar" -M
"$LLVM/llvm-ar" s "$OUT/realm-wrappers.a"

# Every entry point Realm.dll binds must be defined in the archive.
grep -rhoE 'EntryPoint = "[a-z0-9_]+"' "$SRC/Realm/Realm" --include=*.cs | sed 's/.*"\(.*\)"/\1/' | sort -u > "$OUT/exports.txt"
"$LLVM/llvm-nm" --defined-only "$OUT/realm-wrappers.a" 2>/dev/null | awk '{print $NF}' | sort -u > "$BUILD/defined.txt"
missing="$(comm -23 "$OUT/exports.txt" "$BUILD/defined.txt")"
if [ -n "$missing" ]; then
  echo "Entry points missing from realm-wrappers.a:" >&2
  echo "$missing" >&2
  exit 1
fi

echo "Built $OUT/realm-wrappers.a ($(wc -l < "$OUT/exports.txt" | tr -d ' ') entry points)"
