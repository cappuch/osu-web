#!/bin/bash
# Builds ppy's veldrid-spirv (shaderc + SPIRV-Cross; GLSL -> SPIR-V -> GLSL ES) as one flat static WebAssembly archive for the
# multithreaded .NET runtime (-pthread, native wasm exceptions). Re-runnable; CLEAN=1 wipes the build directory first.
#
#   native/build-spirv.sh [veldrid-spirv checkout]     (default ~/Desktop/veldrid-spirv, cloned if missing)
#
# Output: native/lib/spirv/libveldrid-spirv.a
set -euo pipefail
cd "$(dirname "$0")"
NATIVE="$(pwd)"
source ./emsdk-env.sh

SRC="${1:-$HOME/Desktop/veldrid-spirv}"
OUT="$NATIVE/lib/spirv"
LLVM="$EMSDK/bin"

if [ ! -d "$SRC/src" ]; then
  git clone -q https://github.com/ppy/veldrid-spirv.git "$SRC"
fi
git -C "$SRC" submodule update --init --recursive --depth 1

BUILD="$SRC/build/wasm-mt"
[ "${CLEAN:-0}" = 1 ] && rm -rf "$BUILD"

emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-pthread -fwasm-exceptions -O2" \
  -DCMAKE_CXX_FLAGS="-pthread -fwasm-exceptions -O2" \
  -DENABLE_EXCEPTIONS=ON -DENABLE_RTTI=ON -DENABLE_GLSLANG_BINARIES=OFF -DENABLE_CTEST=OFF \
  -DSPIRV_ALLOW_TIMERS=OFF -DSPIRV_WERROR=OFF -DSPIRV_SKIP_TESTS=ON -DSPIRV_SKIP_EXECUTABLES=ON \
  -DSPIRV_CROSS_WERROR=OFF -DSPIRV_CROSS_ENABLE_TESTS=OFF -DSPIRV_CROSS_CLI=OFF \
  -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_INSTALL=ON -DSHADERC_ENABLE_WERROR_COMPILE=OFF \
  > /tmp/spirv-build.log 2>&1
cmake --build "$BUILD" --target veldrid-spirv >> /tmp/spirv-build.log 2>&1

# Merge libveldrid-spirv and all of its dependency archives into one.
mkdir -p "$OUT"
rm -f "$OUT/libveldrid-spirv.a"
{
  echo "CREATE $OUT/libveldrid-spirv.a"
  for name in veldrid-spirv spirv-cross-core spirv-cross-glsl spirv-cross-hlsl spirv-cross-msl spirv-cross-reflect \
              shaderc shaderc_util glslang MachineIndependent GenericCodeGen OSDependent OGLCompiler HLSL SPIRV \
              SPIRV-Tools SPIRV-Tools-opt; do
    lib="$(find "$BUILD" -name "lib$name.a" -print -quit)"
    [ -n "$lib" ] || { echo "missing lib$name.a in $BUILD" >&2; exit 1; }
    echo "ADDLIB $lib"
  done
  echo "SAVE"
  echo "END"
} | "$LLVM/llvm-ar" -M
"$LLVM/llvm-ranlib" "$OUT/libveldrid-spirv.a"

"$LLVM/llvm-nm" --defined-only "$OUT/libveldrid-spirv.a" 2>/dev/null > "$BUILD/defined.txt"
for sym in CrossCompile CompileGlslToSpirv FreeResult; do
  grep -q " T $sym$" "$BUILD/defined.txt" || { echo "missing export $sym" >&2; exit 1; }
done

echo "Built $OUT/libveldrid-spirv.a"
