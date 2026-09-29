# Sets up the Emscripten toolchain bundled with the .NET wasm-tools workload (must match the runtime's emscripten version).
P="$HOME/.dotnet/packs"
EMSDK_ROOT="$(echo $P/Microsoft.NET.Runtime.Emscripten.3.1.56.Sdk.osx-arm64/*/tools)"
EM_NODE="$(echo $P/Microsoft.NET.Runtime.Emscripten.3.1.56.Node.osx-arm64/*/tools/bin/node)"
EM_PY="$(echo $P/Microsoft.NET.Runtime.Emscripten.3.1.56.Python.osx-arm64/*/tools/bin)"
export EMSDK="$EMSDK_ROOT"
export EM_CONFIG="$HOME/.osu-web-emscripten-config"
export EM_CACHE="$HOME/.osu-web-emcache"
cat > "$EM_CONFIG" <<CFG
LLVM_ROOT = '$EMSDK_ROOT/bin'
BINARYEN_ROOT = '$EMSDK_ROOT'
NODE_JS = '$EM_NODE'
CFG
export PATH="$EMSDK_ROOT/emscripten:$EM_PY:$HOME/.dotnet:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
