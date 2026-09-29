#!/bin/bash
# Builds SQLite (the "e_sqlite3" native library used by SQLitePCLRaw / Microsoft.Data.Sqlite) as a static WebAssembly archive
# compiled with -pthread, as the prebuilt browser-wasm archive shipped on NuGet isn't compatible with the multithreaded runtime.
set -euo pipefail
cd "$(dirname "$0")"
source ./emsdk-env.sh

VERSION=3530400
YEAR=2026
OUT=lib/sqlite
WORK=build/sqlite

mkdir -p "$OUT" "$WORK"
if [ ! -f "$WORK/sqlite-amalgamation-$VERSION/sqlite3.c" ]; then
  curl -sSfL "https://sqlite.org/$YEAR/sqlite-amalgamation-$VERSION.zip" -o "$WORK/sqlite.zip"
  (cd "$WORK" && unzip -qo sqlite.zip)
fi

# Flags follow SQLitePCLRaw's e_sqlite3 build.
emcc -c -O2 -pthread -fwasm-exceptions \
  -DSQLITE_DEFAULT_FOREIGN_KEYS=1 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS4 \
  -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_JSON1 -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_SNAPSHOT \
  -DSQLITE_DQS=0 -DSQLITE_THREADSAFE=1 -DSQLITE_USE_URI=1 \
  "$WORK/sqlite-amalgamation-$VERSION/sqlite3.c" -o "$WORK/sqlite3.o"

# SQLitePCLRaw also binds the SQLCipher key functions; provide stubs (encryption isn't supported).
cat > "$WORK/sqlcipher_stubs.c" <<'STUB'
#define SQLITE_ERROR 1
int sqlite3_key(void* db, const void* key, int n) { return SQLITE_ERROR; }
int sqlite3_key_v2(void* db, const char* name, const void* key, int n) { return SQLITE_ERROR; }
int sqlite3_rekey(void* db, const void* key, int n) { return SQLITE_ERROR; }
int sqlite3_rekey_v2(void* db, const char* name, const void* key, int n) { return SQLITE_ERROR; }
STUB
emcc -c -O2 -pthread "$WORK/sqlcipher_stubs.c" -o "$WORK/sqlcipher_stubs.o"

rm -f "$OUT/e_sqlite3.a"
emar rcs "$OUT/e_sqlite3.a" "$WORK/sqlite3.o" "$WORK/sqlcipher_stubs.o"
echo "Built $OUT/e_sqlite3.a"
