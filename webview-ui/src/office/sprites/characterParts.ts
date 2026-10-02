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
 * a hairstyle leaves a gap, and exactly what fills the gap when one does. Its top two rows are left
 * out, so a hairstyle that sits lower on the skull makes the head shorter instead of showing scalp.
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
  PART_HEAD_BASE_INSET,
  CLOSE_GAPS_MAX_PASSES,
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
      // Measured from where this frame's head actually starts, not from a fixed row: in profile the
      // head sits a row lower, and a base that ignored that poked out above a hairstyle's crown.
      let maskTop = PART_SHOULDER_ROW
      for (let y = PART_HEAD_TOP; y < PART_SHOULDER_ROW; y++) {
        if (mask[y]?.some(Boolean)) { maskTop = y; break }
      }
      for (let i = 0; i < sets.length; i++) {
        const tone = tones[i]
        if (!tone) continue
        const skin = sets[i].skin[dir][f]
        for (let y = maskTop + PART_HEAD_BASE_INSET; y < PART_SHOULDER_ROW; y++) {
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

/** The first row with anything drawn on it, or -1 for an empty sprite */
function topRow(sprite: SpriteData | undefined): number {
  if (!sprite) return -1
  for (let y = 0; y < sprite.length; y++) if (sprite[y].some(Boolean)) return y
  return -1
}

/**
 * How many rows a frame's top sits below the same direction's standing frame: the head's bob. The
 * six characters do not all bob alike - reading, one lifts its head a row where another drops it -
 * so a hairstyle cut from one and a face cut from another part company by up to two rows.
 */
export function frameBob(frames: CharacterFrames, dir: typeof DIRECTIONS[number], frame: number): number {
  const here = topRow(frames[dir][frame])
  const standing = topRow(frames[dir][PART_STANDING_FRAME] ?? frames[dir][0])
  return here < 0 || standing < 0 ? 0 : here - standing
}

/** Move a sprite down by dy rows (up when negative); what is pushed off the edge is dropped */
export function shiftRows(sprite: SpriteData, dy: number): SpriteData {
  if (dy === 0) return sprite
  const blank = () => sprite[0].map(() => '')
  return sprite.map((_, y) => {
    const from = y - dy
    return from >= 0 && from < sprite.length ? [...sprite[from]] : blank()
  })
}

/** The first `count` drawn rows of a sprite alone (keep = true), or the sprite without them */
export function firstRows(sprite: SpriteData, count: number, keep: boolean): SpriteData {
  const top = topRow(sprite)
  if (top < 0) return keep ? blankLike(sprite) : sprite
  return sprite.map((row, y) => {
    const inside = y >= top && y < top + count
    return inside === keep ? [...row] : row.map(() => '')
  })
}

/**
 * Close the gaps that mixing parts opens. The six characters were drawn with slightly different
 * shoulders and heads, so a shirt cut from one, laid over arms and a face cut from another, can
 * leave a pixel of background between them - a hole in the clothes - and a hairstyle that does not
 * cover the back of the head the way the face's own did leaves a notch there. Filled from the
 * neighbouring colour, the garment or the hair simply carries on:
 *  - a hole is anything the outside cannot reach without crossing something drawn;
 *  - a notch is a gap in a head row (above `headBottom`) between two drawn pixels.
 * Either is filled only where the face's own character (`face`) is drawn: where its artwork is open,
 * so is this - the window between an arm and the page it holds up, the space behind a ponytail.
 * `prefer` says whose colour to borrow first: the hair layer in the head, the top below it.
 */
export function closeGaps(sprite: SpriteData, face: SpriteData | undefined, headBottom: number, hairLayer: SpriteData, topLayer: SpriteData): SpriteData {
  // Again until nothing changes: filling a notch can seal a pixel behind it into a hole that the
  // outside could still reach through the notch a moment before
  let out = sprite
  for (let pass = 0; pass < CLOSE_GAPS_MAX_PASSES; pass++) {
    const next = closeGapsOnce(out, face, headBottom, hairLayer, topLayer)
    if (next === out) break
    out = next
  }
  return out
}

/** One pass of closeGaps; returns the same sprite when there was nothing to fill */
function closeGapsOnce(sprite: SpriteData, face: SpriteData | undefined, headBottom: number, hairLayer: SpriteData, topLayer: SpriteData): SpriteData {
  const H = sprite.length
  const W = sprite[0]?.length ?? 0
  const out = sprite.map((row) => [...row])
  const outside = new Set<number>()
  const queue: number[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((y === 0 || x === 0 || y === H - 1 || x === W - 1) && !out[y][x]) { outside.add(y * W + x); queue.push(y * W + x) }
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!
    const x = i % W
    const y = (i - x) / W
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || out[ny][nx]) continue
      const j = ny * W + nx
      if (outside.has(j)) continue
      outside.add(j)
      queue.push(j)
    }
  }

  const gaps: Array<[number, number]> = []
  for (let y = 0; y < H; y++) {
    const drawn = out[y].map(Boolean)
    const first = drawn.indexOf(true)
    const last = drawn.lastIndexOf(true)
    for (let x = 0; x < W; x++) {
      if (out[y][x]) continue
      // Only where the face's own character is drawn: where its artwork is open, so is this
      if (face && !face[y]?.[x]) continue
      const hole = !outside.has(y * W + x)
      const notch = y < headBottom && x > first && x < last && first >= 0
      if (hole || notch) gaps.push([x, y])
    }
  }
  if (gaps.length === 0) return sprite

  // Fill from the edges of each gap inwards, borrowing a sideways neighbour before one above or below
  let pending = gaps
  while (pending.length > 0) {
    const next: Array<[number, number]> = []
    const fills: Array<[number, number, string]> = []
    for (const [x, y] of pending) {
      const prefer = y < headBottom ? hairLayer : topLayer
      const around: Array<[number, number]> = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
      const pick = around.find(([nx, ny]) => out[ny]?.[nx] && prefer[ny]?.[nx]) ?? around.find(([nx, ny]) => out[ny]?.[nx])
      if (pick) fills.push([x, y, out[pick[1]][pick[0]]])
      else next.push([x, y])
    }
    if (fills.length === 0) break
    for (const [x, y, px] of fills) out[y][x] = px
    pending = next
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
