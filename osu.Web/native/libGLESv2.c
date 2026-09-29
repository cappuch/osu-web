// WebGL 2 (OpenGL ES 3.0) is implemented by Emscripten (linked with -lGL -sFULL_ES3 -sMAX_WEBGL_VERSION=2).
// This (otherwise empty) translation unit exists so the .NET P/Invoke table generator has a native module named
// "libGLESv2" to bind osu!framework's GL calls (osu.Framework/Graphics/OpenGL/WebGL.cs) against.
void osuweb_libGLESv2_module(void) {}
