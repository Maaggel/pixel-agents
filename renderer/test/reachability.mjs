// Can the office actually get to the things it is supposed to use?
//
// A plant in a nook, a bin behind a chair, a coffee machine walled in by a desk: the behaviour is
// fine, the layout is not, and the symptom is something quietly never being done. Chair tiles
// block everyone but the agent assigned to that seat, so a single chair can seal a corner off.
//
// Reports every plant and every utensil origin or disposal that no one can walk to.
//   node test/reachability.mjs
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims } from '../native/shims.mjs'

const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')

const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1 })
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.type !== 'init') return
  ws.close()
  office.handleRelayMessage(m)
  const dbg = office.debug()
  const lay = m.layout
  const byId = new Map(m.furniture.catalog.map((c) => [c.id, c]))
  const WALL = 0, VOID = 8

  // the office proper: the biggest patch of floor everyone shares
  const floors = []
  for (let r = 0; r < lay.rows; r++) {
    for (let c = 0; c < lay.cols; c++) {
      const t = lay.tiles[r * lay.cols + c]
      if (t !== WALL && t !== VOID) floors.push([c, r])
    }
  }
  let hub = null, hubSize = -1
  for (const ch of dbg.characters()) {
    const size = floors.filter(([c, r]) => dbg.route(ch.tileCol, ch.tileRow, c, r).length > 0).length
    if (size > hubSize) { hubSize = size; hub = [ch.tileCol, ch.tileRow] }
  }
  if (!hub) { print('no agents in the office to measure from - try again in a moment'); process.exit(1) }
  print(`measuring from ${hub.join(',')}, which reaches ${hubSize} of ${floors.length} floor tiles\n`)

  const canStandBeside = (col, row, w, h) => {
    const sides = []
    for (let dc = 0; dc < w; dc++) { sides.push([col + dc, row - 1], [col + dc, row + h]) }
    for (let dr = 0; dr < h; dr++) { sides.push([col - 1, row + dr], [col + w, row + dr]) }
    return sides.some(([c, r]) => dbg.route(hub[0], hub[1], c, r).length > 0)
  }

  const wanted = (e) => e?.thirstCycle?.length ? 'plant'
    : e?.utensil ? 'utensil'
    : (e?.name && /COFFEE_MACHINE|SINK|WATER_COOLER|PRINTER|BIN|FRIDGE|BOOKSHELF/.test(e.name)) ? 'used by someone'
    : null

  const stranded = { plant: [], utensil: [], 'used by someone': [] }
  for (const f of lay.furniture) {
    const e = byId.get(f.type)
    const why = wanted(e)
    if (!why) continue
    const col = Math.floor(f.col), row = Math.floor(f.row)
    if (canStandBeside(col, row, e.footprintW || 1, e.footprintH || 1)) continue
    stranded[why].push(`  ${e.name.padEnd(28)} at ${col},${row}`)
  }

  const total = Object.values(stranded).reduce((n, l) => n + l.length, 0)
  if (!total) { print('everything can be reached'); process.exit(0) }

  if (stranded.plant.length) {
    print('Plants nobody can water - these will sit parched for ever:')
    for (const line of stranded.plant) print(line)
    print('')
  }
  if (stranded.utensil.length) {
    print('Things nobody can clear away - mugs and paper left on desks in nooks:')
    for (const line of stranded.utensil) print(line)
    print('')
  }
  if (stranded['used by someone'].length) {
    print('Machines nobody can use:')
    for (const line of stranded['used by someone']) print(line)
    print('')
  }
  print('Usually a chair is the cause: a chair tile is blocked for everyone but its own occupant,')
  print('so one chair across a gap seals the corner behind it. Move the chair, or what is behind it.')
  process.exit(0)
}
