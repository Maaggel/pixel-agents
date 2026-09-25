import { PALETTE_COUNT, LOOK_HUE_STEPS, LOOK_HUE_STEP_DEG, LOOK_OVERRIDES_STORAGE_KEY, PART_STYLE_COUNT, PART_HAIR_HUES } from '../constants.js'

/**
 * What a character looks like, by the name on its nametag.
 *
 * A name alone is enough: hashing it gives a hairstyle, a shirt, a pair of legs and a skin, the
 * same on every device and every spawn, with nothing stored. Anything chosen on purpose beats the
 * hash - the relay keeps those in data/looks.json and hands them to every viewer, so a look picked
 * in one browser shows up in the others and on the tablet. localStorage remains underneath it for
 * looks shuffled before there was anywhere better to put them.
 */
export interface CharacterLook {
  /** Which of the six characters lends its skin - and, without parts, its whole body */
  palette: number
  /** Hue shift in degrees applied to the whole character when it has no parts */
  hueShift: number
  /** Hairstyle, top and legs, each from one of the six characters, each with its own hue.
   *  Absent means the old look: one character's sprite, shifted whole. */
  parts?: CharacterParts
}

/** A character assembled from four independent layers, each colourable on its own. */
export interface CharacterParts {
  hair: number
  hairHue: number
  top: number
  topHue: number
  legs: number
  legsHue: number
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
  return { palette, hueShift, parts: partsFromHash(h) }
}

/**
 * Slice the rest of the hash into the parts. Each layer takes its own window of bits, so two names
 * that happen to share a hairstyle are no likelier to share a shirt. The skin is the palette above:
 * hue-rotating skin gives green people, so skin tone only ever comes from picking a character.
 */
function partsFromHash(h: number): CharacterParts {
  const hue = (shift: number) => ((h >>> shift) % LOOK_HUE_STEPS) * LOOK_HUE_STEP_DEG
  return {
    hair: (h >>> 5) % PART_STYLE_COUNT,
    hairHue: PART_HAIR_HUES[(h >>> 9) % PART_HAIR_HUES.length],
    top: (h >>> 13) % PART_STYLE_COUNT,
    topHue: hue(17),
    legs: (h >>> 21) % PART_STYLE_COUNT,
    legsHue: hue(25),
  }
}

/** A cache key that tells one assembled character from another. */
export function lookKey(look: CharacterLook): string {
  const p = look.parts
  if (!p) return `${look.palette}:${look.hueShift}`
  return `${look.palette}:${look.hueShift}:${p.hair}:${p.hairHue}:${p.top}:${p.topHue}:${p.legs}:${p.legsHue}`
}

/** A look built from whole-character values, as older publishers and explicit choices send them. */
export function legacyLook(palette: number, hueShift = 0): CharacterLook {
  return { palette, hueShift }
}

/** Parts picked at random - what Shuffle hands out. */
export function randomParts(): CharacterParts {
  const style = () => Math.floor(Math.random() * PART_STYLE_COUNT)
  const hue = () => Math.floor(Math.random() * LOOK_HUE_STEPS) * LOOK_HUE_STEP_DEG
  return { hair: style(), hairHue: hue(), top: style(), topHue: hue(), legs: style(), legsHue: hue() }
}

/** A look as it is stored and shared: flat, and skin rather than palette. */
export interface StoredLook {
  skin: number
  hair: number
  hairHue: number
  top: number
  topHue: number
  legs: number
  legsHue: number
}

export type LooksTable = Record<string, StoredLook>

let chosenLooks: LooksTable = {}

/** The looks somebody chose, as the relay hands them over. */
export function setLookTable(table: LooksTable | null | undefined): void {
  chosenLooks = table ?? {}
}

export function getLookTable(): LooksTable {
  return chosenLooks
}

export function storedToLook(stored: StoredLook): CharacterLook {
  return {
    palette: stored.skin,
    hueShift: 0,
    parts: {
      hair: stored.hair,
      hairHue: stored.hairHue,
      top: stored.top,
      topHue: stored.topHue,
      legs: stored.legs,
      legsHue: stored.legsHue,
    },
  }
}

export function lookToStored(look: CharacterLook): StoredLook {
  const p = look.parts ?? partsFromHash(0)
  return {
    skin: look.palette,
    hair: p.hair,
    hairHue: p.hairHue,
    top: p.top,
    topHue: p.topHue,
    legs: p.legs,
    legsHue: p.legsHue,
  }
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
  all[name.trim().toLowerCase()] = { palette: look.palette, hueShift: look.hueShift, parts: look.parts }
  try { localStorage.setItem(LOOK_OVERRIDES_STORAGE_KEY, JSON.stringify(all)) } catch { /* ignore */ }
}

/** What was chosen for this name, else what was shuffled for it here, else what it hashes to. */
export function resolveLook(name: string): CharacterLook {
  const chosen = chosenLooks[name.trim().toLowerCase()]
  if (chosen) return storedToLook(chosen)
  return getLookOverride(name) ?? lookFromName(name)
}
