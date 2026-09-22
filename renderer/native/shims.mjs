// Browser shims for the office engine bundle (renderer/native/engine.mjs).
//
// The engine touches the DOM in exactly three places: offscreen canvases for the sprite cache,
// localStorage for per-browser preferences (irrelevant here, kept in memory) and window for the
// device pixel ratio / URL hash. installShims() must run before the bundle is imported.
import { createCanvas, Canvas, Image, GlobalFonts } from '@napi-rs/canvas'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))

// Sprite snapshots. The engine caches every sprite as a small offscreen canvas and blits it with
// drawImage; in Skia a canvas source is snapshotted on every blit, which made a frame of ~600
// sprites cost ~23 ms. An immutable Image source is ~6x cheaper (3.5 ms), so each offscreen
// canvas is turned into an Image the first time it is drawn (PNG round trip, ~0.4 ms once) and
// the Image is used from then on. Drawing into the canvas again drops its snapshot. Images decode
// asynchronously: until one is ready the canvas itself is drawn, so no frame ever misses a sprite.
const snapshots = new WeakMap() // offscreen Canvas -> { img, ready }
let snapshotCount = 0
export const snapshotsMade = () => snapshotCount

function offscreenCanvas() {
  const cv = createCanvas(1, 1)
  const getContext = cv.getContext.bind(cv)
  cv.getContext = (type, opts) => {
    const c = getContext(type, opts)
    return new Proxy(c, {
      get(t, k) {
        const v = t[k]
        if (typeof v !== 'function') return v
        return (...a) => { snapshots.delete(cv); return v.apply(t, a) }
      },
      set(t, k, v) { t[k] = v; return true },
    })
  }
  return cv
}

function snapshotOf(cv) {
  let s = snapshots.get(cv)
  if (!s) {
    const img = new Image()
    s = { img, ready: false }
    img.onload = () => { s.ready = true }
    img.onerror = () => { snapshots.delete(cv) }
    img.src = cv.toBuffer('image/png')
    snapshots.set(cv, s)
    snapshotCount++
  }
  return s.ready ? s.img : cv
}

/** Route a frame context's drawImage through the snapshot cache. */
export function useSnapshots(ctx) {
  const drawImageNative = ctx.drawImage.bind(ctx)
  ctx.drawImage = (src, ...args) => drawImageNative(src instanceof Canvas ? snapshotOf(src) : src, ...args)
  return ctx
}

export function installShims() {
  const memoryStorage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (memoryStorage.has(k) ? memoryStorage.get(k) : null),
    setItem: (k, v) => { memoryStorage.set(k, String(v)) },
    removeItem: (k) => { memoryStorage.delete(k) },
  }
  globalThis.window = { devicePixelRatio: 1, location: { hash: '#kiosk' }, addEventListener() {}, removeEventListener() {} }
  globalThis.document = { createElement: (tag) => { if (tag !== 'canvas') throw new Error(`document.createElement(${tag}) is not available headless`); return offscreenCanvas() } }
  GlobalFonts.registerFromPath(join(here, '..', '..', 'webview-ui', 'src', 'fonts', 'FSPixelSansUnicode-Regular.ttf'), 'FS Pixel Sans Unicode')
}
