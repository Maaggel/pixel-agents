import { useEffect } from 'react'

/**
 * Keep the screen on while the page is visible (Screen Wake Lock API).
 * Works on Android Chrome and installed PWAs on iOS 16.4+. Wake locks are
 * released by the OS whenever the page is hidden, so we re-request on
 * visibilitychange; browsers that insist on a user gesture get the request
 * retried on the first touch/click.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } }
    if (!nav.wakeLock) return

    let sentinel: WakeLockSentinel | null = null
    let disposed = false

    const request = async () => {
      if (disposed || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return
      try {
        sentinel = await nav.wakeLock!.request('screen')
        sentinel.addEventListener('release', () => { sentinel = null })
      } catch {
        // Denied (low battery, not visible, needs a gesture) — a later gesture retries
        sentinel = null
      }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') void request() }
    const onGesture = () => { void request() }

    void request()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pointerdown', onGesture, { passive: true })
    window.addEventListener('keydown', onGesture, { passive: true })

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
      if (sentinel && !sentinel.released) void sentinel.release()
      sentinel = null
    }
  }, [enabled])
}
