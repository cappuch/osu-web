// osu!web - Emscripten JS library for the "osuweb" native module.
//
// The page's canvas is transferred to the game worker when supported, avoiding a full-canvas ImageBitmap handoff
// on every displayed frame. The bitmap path remains as a compatibility fallback.

addToLibrary({
  $osuweb: {
    canvas: null,
    gl: null,
    context: 0,
    vsync: null,
    directDisplay: false,
    displayReady: null,
    resolveDisplayReady: null,
    readyReported: false,
    presentErrorReported: false,
  },

  osuweb_gl_create__deps: ['$GL', '$osuweb'],
  osuweb_gl_create: function (width, height) {
    if (typeof OffscreenCanvas === 'undefined') {
      err('osu!web: OffscreenCanvas is not supported by this browser.');
      return 0;
    }

    // Prefer the DOM canvas transferred by the page. Rendering to it is composited directly and avoids the costly
    // transferToImageBitmap() + postMessage() + bitmaprenderer path. A standalone canvas is the fallback.
    const directDisplay = !!osuweb.canvas;
    const canvas = osuweb.canvas || new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;

    const attributes = {
      alpha: false,
      depth: true,
      stencil: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    };

    const ctx = canvas.getContext('webgl2', attributes);
    if (!ctx) {
      err('osu!web: failed to create a WebGL2 context.');
      return 0;
    }

    const handle = GL.registerContext(ctx, { majorVersion: 2, minorVersion: 0, enableExtensionsByDefault: 1 });
    GL.makeContextCurrent(handle);

    const vsyncSab = new SharedArrayBuffer(16);
    osuweb.canvas = canvas;
    osuweb.gl = ctx;
    osuweb.context = handle;
    osuweb.directDisplay = directDisplay;
    osuweb.vsync = new Int32Array(vsyncSab);
    Atomics.store(osuweb.vsync, 2, 1);
    postMessage({ cmd: 'callHandler', handler: 'osuwebVsync', args: [vsyncSab] });

    return handle;
  },

  osuweb_gl_resize__deps: ['$osuweb'],
  osuweb_gl_resize: function (width, height) {
    if (!osuweb.canvas) return;
    osuweb.canvas.width = width;
    osuweb.canvas.height = height;
  },

  osuweb_gl_destroy__deps: ['$GL', '$osuweb'],
  osuweb_gl_destroy: function () {
    if (osuweb.context) {
      GL.makeContextCurrent(0);
      GL.deleteContext(osuweb.context);
    }

    // Resizing releases the canvas' backing store even on browsers which defer WebGL context collection.
    if (osuweb.canvas) {
      osuweb.canvas.width = 1;
      osuweb.canvas.height = 1;
    }

    if (osuweb.vsync) {
      Atomics.store(osuweb.vsync, 1, 0);
      Atomics.notify(osuweb.vsync, 1);
    }

    osuweb.canvas = null;
    osuweb.gl = null;
    osuweb.context = 0;
    osuweb.vsync = null;
    osuweb.directDisplay = false;
    osuweb.readyReported = false;
    osuweb.presentErrorReported = false;
  },

  osuweb_gl_present__deps: ['$osuweb'],
  osuweb_gl_present: function () {
    if (!osuweb.canvas || !osuweb.vsync) return;

    // Used by the local profiler without introducing a per-frame message or allocation.
    Atomics.add(osuweb.vsync, 3, 1);

    // A transferred DOM canvas is already visible to the compositor. Returning to the worker event loop after
    // each frame publishes it without allocating or copying a full-canvas ImageBitmap.
    if (osuweb.directDisplay) {
      osuweb.gl.flush();

      if (!osuweb.readyReported) {
        osuweb.readyReported = true;
        postMessage({ cmd: 'callHandler', handler: 'osuwebCall', args: ['onGameReady'] });
      }

      return;
    }

    // Do not allocate GPU-backed ImageBitmaps for hidden pages. The frame loop is also throttled below.
    if (Atomics.load(osuweb.vsync, 2) === 0) return;

    // One bitmap in flight. Creating another before the page closes the last one is what exhausted memory.
    if (Atomics.load(osuweb.vsync, 1) !== 0) return;

    let bitmap = null;

    try {
      bitmap = osuweb.canvas.transferToImageBitmap();
      Atomics.store(osuweb.vsync, 1, 1);

      postMessage({ cmd: 'callHandler', handler: 'osuwebPresent', args: [bitmap] }, [bitmap]);
      bitmap = null; // ownership was transferred to the page.
      osuweb.presentErrorReported = false;
    } catch (e) {
      bitmap?.close();
      Atomics.store(osuweb.vsync, 1, 0);
      Atomics.notify(osuweb.vsync, 1);

      // Context loss can make every subsequent frame fail. Do not turn that into an unbounded console log.
      if (!osuweb.presentErrorReported) {
        osuweb.presentErrorReported = true;
        err(`osu!web: failed to present frame: ${e}`);
      }
    }
  },

  // The game thread is a JSWebWorker: JS imports it calls resolve against this worker's globalThis, not the page's.
  // Calls that need the page are forwarded to it; the two that return values are answered here.
  osuweb_worker_init__deps: ['$osuweb'],
  osuweb_worker_init: function (sampleRate) {
    const forward = (name) => (...args) => postMessage({ cmd: 'callHandler', handler: 'osuwebCall', args: [name, ...args] });
    const proxyHosts = { 'osu.ppy.sh': 'osu', 'assets.ppy.sh': 'assets', 'a.ppy.sh': 'a', 'i.ppy.sh': 'i' };
    let clipboardText = '';

    osuweb.displayReady = new Promise((resolve) => { osuweb.resolveDisplayReady = resolve; });

    // setTimeout(0) is clamped to roughly 4ms after a few nested calls, which alone can cap a WebGL game near
    // 100fps. MessageChannel yields to a fresh worker task without that timer floor.
    const yieldChannel = new MessageChannel();
    const yieldQueue = [];
    yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
    const yieldToEventLoop = () => new Promise((resolve) => {
      yieldQueue.push(resolve);
      yieldChannel.port2.postMessage(0);
    });

    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      if (e.data.clipboardText !== undefined) clipboardText = e.data.clipboardText;
      if (Object.hasOwn(e.data, 'displayCanvas')) {
        osuweb.canvas = e.data.displayCanvas;
        osuweb.resolveDisplayReady?.();
        osuweb.resolveDisplayReady = null;
      }
    };
    postMessage({ cmd: 'callHandler', handler: 'osuwebWorkerPort', args: [channel.port2] }, [channel.port2]);

    globalThis.osuweb = {
      openUrl: forward('openUrl'),
      proxyUrl: (url) => {
        const target = new URL(url, location.href);
        if (target.origin === location.origin) return target.href;
        const route = proxyHosts[target.hostname];
        return route && target.protocol === 'https:'
          ? `${location.origin}/__proxy/${route}${target.pathname}${target.search}`
          : target.href;
      },
      setTitle: forward('setTitle'),
      setCursorVisible: forward('setCursorVisible'),
      setPointerLock: forward('setPointerLock'),
      setFullscreen: forward('setFullscreen'),
      getClipboardText: () => clipboardText,
      setClipboardText: (text) => { clipboardText = text; forward('setClipboardText')(text); },
      setTextInputActive: forward('setTextInputActive'),
      syncStorage: forward('syncStorage'),
      onGameReady: forward('onGameReady'),
      audioGetSampleRate: () => sampleRate,
      audioAttach: forward('audioAttach'),
      waitForDisplay: () => osuweb.displayReady,

      // Resolves after yielding to the worker event loop. With direct display the framework's own limiter controls
      // game/update frequency; the browser compositor independently displays the latest completed frame.
      // Always resolves from a new task, so the worker's event loop runs between frames.
      nextFrame: () => {
        const vsync = osuweb.vsync;
        const hidden = vsync && Atomics.load(vsync, 2) === 0;

        if (hidden)
          return new Promise((resolve) => setTimeout(resolve, 250));

        // Direct rendering has no per-frame transferable resource to backpressure. Yielding as a new task lets
        // the browser publish the OffscreenCanvas while preserving osu!framework's configured frame limiter.
        if (osuweb.directDisplay)
          return yieldToEventLoop();

        // Never use an unbounded fallback for bitmap presentation.
        if (!vsync || !Atomics.waitAsync)
          return new Promise((resolve) => setTimeout(resolve, 16));

        const waitFor = (index, value, timeout) => {
          const r = Atomics.waitAsync(vsync, index, value, timeout);
          // A synchronous "not-equal" result means the wake already happened. Still use a new task
          // so browser-owned per-frame resources can be released before managed rendering resumes.
          return r.async ? r.value : new Promise((resolve) => setTimeout(resolve, 0));
        };

        return waitFor(0, Atomics.load(vsync, 0), 34).then(() => (Atomics.load(vsync, 1) !== 0 ? waitFor(1, 1, 34) : undefined));
      },
    };
  },

  osuweb_wait_vsync__deps: ['$osuweb'],
  osuweb_wait_vsync: function () {
    if (!osuweb.vsync) return;

    if (Atomics.load(osuweb.vsync, 2) === 0) {
      Atomics.wait(osuweb.vsync, 2, 0, 250);
      return;
    }

    const seen = Atomics.load(osuweb.vsync, 0);
    Atomics.wait(osuweb.vsync, 0, seen, 34);
    // Also wait out a bitmap the page has not displayed yet, so presents stay at the display rate.
    if (Atomics.load(osuweb.vsync, 1) !== 0)
      Atomics.wait(osuweb.vsync, 1, 1, 34);
  },
});
