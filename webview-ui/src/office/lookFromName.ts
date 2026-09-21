import { PALETTE_COUNT, LOOK_HUE_STEPS, LOOK_HUE_STEP_DEG, LOOK_OVERRIDES_STORAGE_KEY } from '../constants.js'

/**
 * Deterministic character look from the name shown on the nametag.
 *
 * The same name always yields the same palette + hue shift, on every device,
 * with nothing stored - so an agent keeps its look across reloads, relay
 * restarts and browsers. "Shuffle" writes a per-name override to localStorage,
 * which wins over the hash; a look explicitly saved on the backend wins over both
 * (handled by the caller passing a preferred palette).
 */
export interface CharacterLook {
  palette: number
  hueShift: number
}

/** FNV-1a 32-bit - small, stable, well distributed for short strings. */
export function hashName(name: string): number {
  let h = 0x811c9dc5
  const s = name.trim().toLowerCase()
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function lookFromName(name: string): CharacterLook {
  const h = hashName(name)
  const palette = h % PALETTE_COUNT
  // Use higher bits for the hue so palette and hue aren't correlated
  const hueShift = ((h >>> 8) % LOOK_HUE_STEPS) * LOOK_HUE_STEP_DEG
  return { palette, hueShift }
}

type Overrides = Record<string, CharacterLook>

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(LOOK_OVERRIDES_STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Overrides
  } catch { /* ignore */ }
  return {}
}

export function getLookOverride(name: string): CharacterLook | null {
  return loadOverrides()[name.trim().toLowerCase()] ?? null
}

export function setLookOverride(name: string, look: CharacterLook): void {
  const all = loadOverrides()
  all[name.trim().toLowerCase()] = { palette: look.palette, hueShift: look.hueShift }
  try { localStorage.setItem(LOOK_OVERRIDES_STORAGE_KEY, JSON.stringify(all)) } catch { /* ignore */ }
}

/** Override (from Shuffle) if any, else the hashed look. */
export function resolveLook(name: string): CharacterLook {
  return getLookOverride(name) ?? lookFromName(name)
}
