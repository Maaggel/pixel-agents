/**
 * Cutting the character sheets into parts that can be mixed and coloured on their own:
 * hair, skin, top and legs.
 *
 * The six characters were drawn from one template, so they cut at the same rows - the neck narrows
 * at row 18 and the waist at row 25. Telling hair from skin inside the head needs no hand-labelling
 * and no colour guesswork: the up-facing frames show the back of the head, which is nothing but
 * hair, so the colours found there ARE that character's hair palette, and everything else in the
 * head is skin. Hair is matched down over the shoulders too, so hair that hangs there comes along.
 *
 * Skin then works the same way in reverse. The face of the standing front frame is the one patch of
 * a sheet that is certainly skin, so its colours are the skin palette, and those colours are pulled
 * out of the body as well - otherwise the hands ride along with the shirt and dyeing a shirt dyes
 * the hands with it.
 *
 * One thing has to be invented rather than cut out: a head. Each character's face only covers what
 * its own hair left bare, so putting a smaller hairstyle on it would show holes where the old hair
 * used to be. The head every hairstyle has to cover is the silhouette all six share, so that shape
 * is filled with the character's own skin and laid under the face - a bald head, never seen unless
 * a hairstyle leaves a gap, and exactly what fills the gap when one does.
 *
 * This runs on the sprites the viewer already loads, so nothing about the assets, the relay
 * protocol or the daemon changes: the same six PNGs arrive and are cut up on arrival.
 * `renderer/tools/split-characters.mjs` does the same cut offline, for looking at new art.
 */

import type { SpriteData } from '../types.js'
import {
  PART_HEAD_TOP,
  PART_SHOULDER_ROW,
  PART_HIP_ROW,
  PART_BACK_OF_HEAD_BOTTOM,
  PART_HAIR_MAX_ROW,
  PART_FACE_TOP,
  PART_STANDING_FRAME,
  PART_EYE_GREY_SPREAD,
} from '../../constants.js'

/** The layers a character is built from, in draw order: back to front. */
export const CHARACTER_LAYERS = ['skin', 'legs', 'top', 'hair'] as const
export type CharacterLayer = (typeof CHARACTER_LAYERS)[number]

/** One character's frames, as the loader hands them over. */
export interface CharacterFrames {
  down: SpriteData[]
  up: SpriteData[]
  right: SpriteData[]
}

export type CharacterPartSet = Record<CharacterLayer, CharacterFrames>

const DIRECTIONS = ['down', 'up', 'right'] as const

function isGrey(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return Math.max(r, g, b) - Math.min(r, g, b) <= PART_EYE_GREY_SPREAD
}

/** Skin is warm: more red than blue, and never near-black. */
function isWarm(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return r > b + 15 && r > 60
}

/** Every colour on the back of the head: this character's hair. */
function hairPalette(frames: CharacterFrames): Set<string> {
  const tones = new Set<string>()
  for (const sprite of frames.up) {
    for (let y = PART_HEAD_TOP; y <= PART_BACK_OF_HEAD_BOTTOM; y++) {
      for (const px of sprite[y] ?? []) if (px) tones.add(px)
    }
  }
  return tones
}

/** Every colour on the face of the standing front frame that is not hair or an eye: the skin. */
function skinPalette(frames: CharacterFrames, hair: Set<string>): Set<string> {
  const tones = new Set<string>()
  const sprite = frames.down[PART_STANDING_FRAME] ?? frames.down[0]
  if (!sprite) return tones
  for (let y = PART_FACE_TOP; y < PART_SHOULDER_ROW; y++) {
    for (const px of sprite[y] ?? []) {
      if (!px || hair.has(px) || isGrey(px)) continue
      if (isWarm(px)) tones.add(px)
    }
  }
  return tones
}

function layerFor(y: number, hex: string, hair: Set<string>, skin: Set<string>): CharacterLayer {
  if (y <= PART_HAIR_MAX_ROW && hair.has(hex)) return 'hair'
  if (y < PART_SHOULDER_ROW) return 'skin'
  if (skin.has(hex)) return 'skin'
  if (y < PART_HIP_ROW) return 'top'
  return 'legs'
}

function blankLike(sprite: SpriteData): SpriteData {
  return sprite.map((row) => row.map(() => ''))
}

/** The character's commonest face colour: the flat tone a bald head is filled with. */
function baseSkinTone(frames: CharacterFrames, skin: Set<string>): string {
  const counts = new Map<string, number>()
  const sprite = frames.down[PART_STANDING_FRAME] ?? frames.down[0]
  if (!sprite) return ''
  for (let y = PART_FACE_TOP; y < PART_SHOULDER_ROW; y++) {
    for (const px of sprite[y] ?? []) {
      if (px && skin.has(px)) counts.set(px, (counts.get(px) ?? 0) + 1)
    }
  }
  let best = ''
  let most = 0
  for (const [px, n] of counts) if (n > most) { best = px; most = n }
  return best
}

/**
 * The head shape every hairstyle covers: the frame's silhouette where all six characters agree
 * there is something. Anything outside it belongs to one character's hair alone.
 */
function sharedHeadMask(all: CharacterFrames[], dir: typeof DIRECTIONS[number], frame: number): boolean[][] {
  const first = all[0][dir][frame]
  const mask: boolean[][] = first.map((row) => row.map(() => false))
  for (let y = PART_HEAD_TOP; y < PART_SHOULDER_ROW; y++) {
    for (let x = 0; x < (first[y]?.length ?? 0); x++) {
      mask[y][x] = all.every((frames) => !!frames[dir][frame]?.[y]?.[x])
    }
  }
  return mask
}

/**
 * Cut all six characters into parts. They are done together because the head each one gets under
 * its hair is the shape all six share.
 */
export function splitCharacters(all: CharacterFrames[]): CharacterPartSet[] {
  const sets = all.map(splitCharacter)
  if (all.length === 0) return sets

  const tones = all.map((frames) => {
    const hair = hairPalette(frames)
    return baseSkinTone(frames, skinPalette(frames, hair))
  })

  for (const dir of DIRECTIONS) {
    const frameCount = Math.min(...all.map((frames) => frames[dir].length))
    for (let f = 0; f < frameCount; f++) {
      const mask = sharedHeadMask(all, dir, f)
      for (let i = 0; i < sets.length; i++) {
        const tone = tones[i]
        if (!tone) continue
        const skin = sets[i].skin[dir][f]
        for (let y = PART_HEAD_TOP; y < PART_SHOULDER_ROW; y++) {
          for (let x = 0; x < (mask[y]?.length ?? 0); x++) {
            if (mask[y][x] && !skin[y][x]) skin[y][x] = tone
          }
        }
      }
    }
  }
  return sets
}

/** Cut one character's sprites into its four layers. */
function splitCharacter(frames: CharacterFrames): CharacterPartSet {
  const hair = hairPalette(frames)
  const skin = skinPalette(frames, hair)
  const out = {} as CharacterPartSet
  for (const layer of CHARACTER_LAYERS) out[layer] = { down: [], up: [], right: [] }

  for (const dir of DIRECTIONS) {
    for (const sprite of frames[dir]) {
      const parts: Record<CharacterLayer, SpriteData> = {
        skin: blankLike(sprite),
        legs: blankLike(sprite),
        top: blankLike(sprite),
        hair: blankLike(sprite),
      }
      for (let y = 0; y < sprite.length; y++) {
        for (let x = 0; x < sprite[y].length; x++) {
          const px = sprite[y][x]
          if (px) parts[layerFor(y, px, hair, skin)][y][x] = px
        }
      }
      for (const layer of CHARACTER_LAYERS) out[layer][dir].push(parts[layer])
    }
  }
  return out
}

/** Stack layers back into one sprite. Later layers cover earlier ones. */
export function composeParts(layers: SpriteData[]): SpriteData {
  const base = layers[0]
  const out = base.map((row) => [...row])
  for (let i = 1; i < layers.length; i++) {
    const layer = layers[i]
    for (let y = 0; y < out.length; y++) {
      const src = layer[y]
      if (!src) continue
      for (let x = 0; x < out[y].length; x++) {
        if (src[x]) out[y][x] = src[x]
      }
    }
  }
  return out
}
