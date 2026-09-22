import { MAX_DELTA_TIME_SEC } from '../../constants.js'

export interface GameLoopCallbacks {
  update: (dt: number) => void
  render: (ctx: CanvasRenderingContext2D) => void
}

export function startGameLoop(
  canvas: HTMLCanvasElement,
  callbacks: GameLoopCallbacks,
): () => void {
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  let lastTime = 0
  let rafId = 0
  let stopped = false
  // Optional cap from the URL (#fps=N): kiosk/headless pages only need as many frames as the
  // stream takes, and every extra one is CPU on the box that renders it. Default: every rAF.
  const capMatch = typeof window !== 'undefined' ? /(?:^#|[#&])fps=(\d+)/.exec(window.location.hash) : null
  const minFrameMs = capMatch ? 1000 / Math.max(1, Math.min(60, Number(capMatch[1]))) : 0

  const frame = (time: number) => {
    if (stopped) return
    if (minFrameMs > 0 && lastTime !== 0 && time - lastTime < minFrameMs - 1) {
      rafId = requestAnimationFrame(frame)
      return
    }
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time

    callbacks.update(dt)

    ctx.imageSmoothingEnabled = false
    callbacks.render(ctx)

    rafId = requestAnimationFrame(frame)
  }

  rafId = requestAnimationFrame(frame)

  return () => {
    stopped = true
    cancelAnimationFrame(rafId)
  }
}
