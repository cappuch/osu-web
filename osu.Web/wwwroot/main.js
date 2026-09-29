// osu!web - page host.
//
// Responsibilities (platform glue only - all game logic runs in .NET/WebAssembly):
//  - boots the .NET runtime (dotnet.js),
//  - transfers the display canvas to the game thread (with an ImageBitmap compatibility fallback),
//  - forwards input events to osu!framework (osu.Framework.Platform.Web.WebInput),
//  - provides audio output (AudioWorklet reading the managed mixer's ring buffer, see audio-worklet.js),
//  - persists the virtual filesystem (IndexedDB) and handles file drops.

import { dotnet } from './_framework/dotnet.js';

const STORAGE_ROOT = '/data';
const DROP_ROOT = '/tmp/drop';

const canvas = document.getElementById('game');
const overlay = document.getElementById('overlay');
const statusText = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const startButton = document.getElementById('start');

const setStatus = (text) => { statusText.textContent = text; };
const setProgress = (fraction) => { progressBar.style.width = `${Math.round(fraction * 100)}%`; };

if (!globalThis.crossOriginIsolated) {
  setStatus('This page must be served with cross-origin isolation\n(COOP: same-origin, COEP: require-corp) for WebAssembly threads.');
  throw new Error('not cross-origin isolated');
}

// ---------------------------------------------------------------------------------------------------------------------
// Display
//
// vsync[0] is the animation-frame counter, vsync[1] is 1 while a fallback ImageBitmap is in flight,
// vsync[2] is 1 while the page is visible, and vsync[3] is the game-frame counter.

let display = null;
let directDisplayCanvas = null;

try {
  directDisplayCanvas = canvas.transferControlToOffscreen();
} catch (e) {
  // Older browsers can still use the one-bitmap-in-flight compatibility path.
  console.warn('osu!web: direct OffscreenCanvas display unavailable; using bitmap presentation', e);
  display = canvas.getContext('bitmaprenderer');
}

let vsync = null;
let shownBitmap = null;
let displayErrorReported = false;

function presentFrame(bitmap) {
  try {
    if (!display)
      throw new Error('received an ImageBitmap while direct canvas display is active');

    shownBitmap?.close();
    shownBitmap = bitmap;
    display.transferFromImageBitmap(bitmap);
    displayErrorReported = false;
    onFirstFrame();
  } catch (e) {
    // A detached canvas can make every frame fail. Report it once rather than retaining thousands of errors.
    if (!displayErrorReported) {
      displayErrorReported = true;
      console.error('osu!web: failed to display frame', e);
    }
  } finally {
    // transferFromImageBitmap normally consumes the bitmap. close() is intentionally also called on
    // failure, and the producer is always acknowledged so one bad frame cannot wedge presentation.
    bitmap.close();
    if (shownBitmap === bitmap) shownBitmap = null;

    if (vsync) {
      Atomics.store(vsync, 1, 0);
      Atomics.notify(vsync, 1);
    }
  }
}

function updateVsyncVisibility() {
  if (!vsync) return;

  Atomics.store(vsync, 2, document.hidden ? 0 : 1);
  Atomics.notify(vsync, 2);

  // Wake a worker which was waiting for requestAnimationFrame when the page became hidden.
  Atomics.add(vsync, 0, 1);
  Atomics.notify(vsync, 0);
}

document.addEventListener('visibilitychange', updateVsyncVisibility);

function displayTick(timestamp) {
  if (previousDisplayTick) {
    const duration = timestamp - previousDisplayTick;
    if (duration >= 2 && duration <= 50) {
      displayFrameDurations.push(duration);

      if (displayFrameDurations.length >= 30) {
        // The median rejects startup stalls and occasional dropped compositor frames.
        displayFrameDurations.sort((a, b) => a - b);
        const measured = Math.round(1000 / displayFrameDurations[Math.floor(displayFrameDurations.length / 2)]);
        displayFrameDurations.length = 0;

        if (measured >= 24 && measured <= 1000 && Math.abs(measured - displayRefreshRate) > 1) {
          if (Math.abs(measured - pendingRefreshRate) <= 1)
            pendingRefreshRateSamples++;
          else {
            pendingRefreshRate = measured;
            pendingRefreshRateSamples = 1;
          }

          // Require two consecutive sample windows to avoid repeatedly changing limiter rates due to rAF jitter.
          if (pendingRefreshRateSamples >= 2) {
            displayRefreshRate = pendingRefreshRate;
            pendingRefreshRateSamples = 0;
            reportSize();
          }
        } else {
          pendingRefreshRateSamples = 0;
        }
      }
    }
  }
  previousDisplayTick = timestamp;

  if (vsync) {
    Atomics.add(vsync, 0, 1);
    Atomics.notify(vsync, 0);
  }
  requestAnimationFrame(displayTick);
}
requestAnimationFrame(displayTick);

// ---------------------------------------------------------------------------------------------------------------------
// Audio

const audioContext = new AudioContext({ latencyHint: 'interactive' });
let audioNode = null;
let runtime = null;

function resumeAudio() {
  if (audioContext.state !== 'running')
    audioContext.resume().catch(() => {});
}

async function attachAudio(pointer, capacity, sampleRate) {
  try {
    await audioContext.audioWorklet.addModule('audio-worklet.js');
    // The wasm memory is a SharedArrayBuffer; sharing it with the worklet lets it read the mixer's ring buffer directly.
    const memory = runtime.localHeapViewU8().buffer;
    audioNode?.disconnect();
    audioNode?.port.close();
    audioNode = new AudioWorkletNode(audioContext, 'osu-ring-buffer', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { memory, pointer, capacity },
    });
    audioNode.connect(audioContext.destination);
    console.log(`osu!web: audio output attached (${sampleRate}Hz, ${capacity} frames)`);
  } catch (e) {
    console.error('osu!web: failed to attach audio output', e);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage

let FS = null;
let syncing = false;
let syncQueued = false;

function syncStorage() {
  if (!FS) return;
  if (syncing) { syncQueued = true; return; }
  syncing = true;
  FS.syncfs(false, (err) => {
    syncing = false;
    if (err) console.warn('osu!web: storage sync failed', err);
    if (syncQueued) { syncQueued = false; syncStorage(); }
  });
}

async function mountStorage(module) {
  FS = module.FS;
  try { FS.mkdir(STORAGE_ROOT); } catch { }
  try { FS.mkdir('/tmp'); } catch { }
  try { FS.mkdir(DROP_ROOT); } catch { }

  const IDBFS = FS.filesystems.IDBFS;
  if (!IDBFS) {
    console.warn('osu!web: IDBFS unavailable, storage will not persist.');
    return;
  }

  FS.mount(IDBFS, { autoPersist: false }, STORAGE_ROOT);
  await new Promise((resolve) => FS.syncfs(true, (err) => {
    if (err) console.warn('osu!web: failed to load persisted storage', err);
    resolve();
  }));

  setInterval(syncStorage, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) syncStorage(); });
  window.addEventListener('pagehide', syncStorage);
}

// ---------------------------------------------------------------------------------------------------------------------
// Functions called from .NET (osu.Framework.Platform.Web.WebHostInterop / osu.Framework.Audio.Web.WebAudioInterop)

let clipboardText = '';
let gameReady = false;
// Message port to the game thread's worker (see osuweb_worker_init in native/osuweb.js).
let gamePort = null;

const proxyHosts = new Map([
  ['osu.ppy.sh', 'osu'],
  ['assets.ppy.sh', 'assets'],
  ['a.ppy.sh', 'a'],
  ['i.ppy.sh', 'i'],
]);

globalThis.osuweb = {
  openUrl: (url) => { window.open(url, '_blank', 'noopener'); },
  proxyUrl: (url) => {
    const target = new URL(url, location.href);
    if (target.origin === location.origin) return target.href;

    const route = proxyHosts.get(target.hostname);
    return route && target.protocol === 'https:'
      ? `${location.origin}/__proxy/${route}${target.pathname}${target.search}`
      : target.href;
  },
  setTitle: (title) => { document.title = title || 'osu!'; },
  setCursorVisible: (visible) => { canvas.style.cursor = visible ? 'default' : 'none'; },
  setPointerLock: (locked) => {
    if (locked) canvas.requestPointerLock?.();
    else if (document.pointerLockElement) document.exitPointerLock();
  },
  setFullscreen: (fullscreen) => {
    if (fullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (!fullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  },
  getClipboardText: () => clipboardText,
  setClipboardText: (text) => {
    clipboardText = text;
    navigator.clipboard?.writeText(text).catch(() => {});
  },
  setTextInputActive: (active) => { },
  syncStorage: () => syncStorage(),
  onGameReady: () => onFirstFrame(),
  audioGetSampleRate: () => audioContext.sampleRate,
  audioAttach: (pointer, capacity, sampleRate) => { attachAudio(pointer, capacity, sampleRate); },
  getPerformanceSnapshot: () => ({
    gameFrames: vsync ? Atomics.load(vsync, 3) : 0,
    directDisplay: !display,
    refreshRate: displayRefreshRate,
  }),
};

// ---------------------------------------------------------------------------------------------------------------------
// Input

let input = null; // exports of osu.Framework.Platform.Web.WebInput

function devicePixelRatio() { return window.devicePixelRatio || 1; }

function reportSize() {
  const dpr = devicePixelRatio();
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  // The DOM canvas is controlled by the game worker. Report physical size and measured compositor refresh rate.
  input?.Resize(width, height, dpr, displayRefreshRate);
}

function canvasPosition(e) {
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio();
  return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
}

// Keys which should keep their default browser behaviour.
function isBrowserShortcut(e) {
  if (e.code === 'F5' || e.code === 'F11' || e.code === 'F12') return true;
  if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyR' || (e.shiftKey && e.code === 'KeyI'))) return true;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return true; // allow the paste event (clipboard) to fire.
  return false;
}

let dropSequence = 0;
let displayRefreshRate = 60;
let pendingRefreshRate = 60;
let pendingRefreshRateSamples = 0;
let previousDisplayTick = 0;
const displayFrameDurations = [];

async function writeDroppedFile(file, path) {
  const stream = FS.open(path, 'w');
  let reader = null;
  let position = 0;

  try {
    reader = file.stream().getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      FS.write(stream, value, 0, value.byteLength, position);
      position += value.byteLength;
    }
  } finally {
    reader?.releaseLock();
    FS.close(stream);
  }
}

function attachInput() {
  new ResizeObserver(reportSize).observe(canvas);
  window.addEventListener('resize', reportSize);
  reportSize();

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (document.pointerLockElement === canvas)
      input.MouseMoveRelative(e.movementX * devicePixelRatio(), e.movementY * devicePixelRatio());
    else {
      // The framework consumes the latest absolute position once per game frame. Forwarding every hardware
      // sample only creates interop/queue churn, so retain the newest coalesced sample.
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const latest = events?.length ? events[events.length - 1] : e;
      const [x, y] = canvasPosition(latest);
      input.MouseMove(x, y);
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    resumeAudio();
    canvas.focus();
    if (e.pointerType === 'touch') return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = canvasPosition(e);
    input.MouseMove(x, y);
    input.MouseButton(e.button, true);
    e.preventDefault();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return;
    input.MouseButton(e.button, false);
    e.preventDefault();
  });

  canvas.addEventListener('pointerenter', () => input.MouseInWindow(true));
  canvas.addEventListener('pointerleave', () => input.MouseInWindow(false));

  canvas.addEventListener('wheel', (e) => {
    let dx = e.deltaX, dy = e.deltaY;
    let precise = false;
    switch (e.deltaMode) {
      case 0: // pixels
        precise = Math.abs(dy) % 100 !== 0 || Math.abs(dx) % 100 !== 0;
        dx /= 100; dy /= 100;
        break;
      case 2: // pages
        dx *= 3; dy *= 3;
        break;
    }
    input.MouseWheel(-dx, -dy, precise);
    e.preventDefault();
  }, { passive: false });

  const touch = (phase) => (e) => {
    resumeAudio();
    for (const t of e.changedTouches) {
      const [x, y] = canvasPosition(t);
      input.Touch(t.identifier, x, y, phase);
    }
    e.preventDefault();
  };
  canvas.addEventListener('touchstart', touch(0), { passive: false });
  canvas.addEventListener('touchmove', touch(1), { passive: false });
  canvas.addEventListener('touchend', touch(2), { passive: false });
  canvas.addEventListener('touchcancel', touch(2), { passive: false });

  window.addEventListener('keydown', (e) => {
    resumeAudio();
    if (isBrowserShortcut(e)) return;
    if (!e.repeat) input.Key(e.code, true);
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) input.TextInput(e.key);
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    input.Key(e.code, false);
    if (!isBrowserShortcut(e)) e.preventDefault();
  });

  window.addEventListener('paste', (e) => {
    clipboardText = e.clipboardData?.getData('text') ?? clipboardText;
    gamePort?.postMessage({ clipboardText });
  });

  window.addEventListener('focus', () => input.Focus(true));
  window.addEventListener('blur', () => input.Focus(false));
  document.addEventListener('visibilitychange', () => input.Visibility(!document.hidden));
  document.addEventListener('fullscreenchange', () => input.Fullscreen(!!document.fullscreenElement));
  // Listeners above only observe future changes; synchronise initial state in case startup happened in a hidden tab.
  input.Visibility(!document.hidden);

  // File drops (beatmaps / skins / replays): written into the virtual filesystem, then handed to the game for import.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();

    // Before the first frame the game's DragDrop subscriber may not exist yet. Do not put an
    // unowned file into MEMFS; the user can retry once startup has completed.
    if (!gameReady || !FS) {
      console.warn('osu!web: ignored file drop while the game was still starting');
      return;
    }

    for (const file of e.dataTransfer?.files ?? []) {
      const path = `${DROP_ROOT}/${Date.now()}-${dropSequence++}-${file.name.replace(/[\\/]/g, '_')}`;

      try {
        // Stream into MEMFS instead of retaining a second whole-file ArrayBuffer in the JS heap.
        await writeDroppedFile(file, path);
        input.FileDrop(path);
      } catch (err) {
        try { FS.unlink(path); } catch { }
        console.error(`osu!web: failed to import ${file.name}`, err);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Boot

function onFirstFrame() {
  gameReady = true;
  setStatus('');
  overlay.classList.add('hidden');
}

async function boot() {
  setStatus('Downloading…');

  runtime = await dotnet
    .withModuleConfig({
      osuwebPresent: presentFrame,
      osuwebVsync: (sab) => {
        vsync = new Int32Array(sab);
        updateVsyncVisibility();
      },
      osuwebCall: (name, ...args) => globalThis.osuweb[name](...args),
      osuwebWorkerPort: (port) => {
        gamePort = port;

        if (directDisplayCanvas) {
          gamePort.postMessage({ clipboardText, displayCanvas: directDisplayCanvas }, [directDisplayCanvas]);
          directDisplayCanvas = null;
        } else {
          gamePort.postMessage({ clipboardText, displayCanvas: null });
        }
      },
      onDownloadResourceProgress: (loaded, total) => setProgress(total ? loaded / total : 0),
    })
    .withConfig({
      pthreadPoolInitialSize: 8,
      pthreadPoolUnusedSize: 4,
      // Input events are delivered through synchronous (non-blocking) calls into .NET from the browser's main thread.
      // The game thread is a JSWebWorker that blocks between its event-loop turns (locks, task waits); that is intentional.
      jsThreadBlockingMode: 'DangerousAllowBlockingWait',
    })
    .withEnvironmentVariable('MONO_LOG_LEVEL', 'warning')
    .create();

  setStatus('Preparing storage…');
  await mountStorage(runtime.Module);

  const frameworkExports = await runtime.getAssemblyExports('osu.Framework.dll');
  input = frameworkExports.osu.Framework.Platform.Web.WebInput;
  attachInput();

  setStatus('Starting osu!…');
  await runtime.runMain();
}

// Browsers only allow audio after a user gesture; a click also gives the canvas focus for keyboard input.
startButton.addEventListener('click', () => {
  startButton.hidden = true;
  resumeAudio();
  canvas.focus();
});

boot().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${e?.message ?? e}`);
});

if (audioContext.state !== 'running')
  startButton.hidden = false;
