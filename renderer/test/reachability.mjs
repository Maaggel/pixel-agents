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

  // Seats an agent cannot get out of. A chair tile is blocked for everyone but its own occupant,
  // so a row of chairs walls a room into cells - and whoever spawns in one is stuck there, unable
  // to reach a water source, the coffee machine or anything else. That is the usual reason a
  // plant beside such a seat is never watered: the only person who can reach it cannot fetch a can.
  const walledIn = []
  for (const f of lay.furniture) {
    const e = byId.get(f.type)
    if (!e?.isSeat) continue
    const col = Math.floor(f.col), row = Math.floor(f.row)
    const out = [[col, row - 1], [col, row + 1], [col - 1, row], [col + 1, row]]
      .some(([c, r]) => dbg.route(hub[0], hub[1], c, r).length > 0)
    if (!out) walledIn.push(`  ${e.name.padEnd(28)} at ${col},${row}`)
  }

  const stranded = { plant: [], utensil: [], 'used by someone': [] }
  for (const f of lay.furniture) {
    const e = byId.get(f.type)
    const why = wanted(e)
    if (!why) continue
    const col = Math.floor(f.col), row = Math.floor(f.row)
    if (canStandBeside(col, row, e.footprintW || 1, e.footprintH || 1)) continue
    stranded[why].push(`  ${e.name.padEnd(28)} at ${col},${row}`)
  }

  const total = Object.values(stranded).reduce((n, l) => n + l.length, 0) + walledIn.length
  if (!total) { print('everything can be reached'); process.exit(0) }

  if (walledIn.length) {
    print('Seats an agent cannot get out of - whoever sits here is stuck in a cell:')
    for (const line of walledIn) print(line)
    print('')
  }

  if (stranded.plant.length) {
    print('Plants nobody can reach from the office proper - they will sit parched:')
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
  print('so a row of chairs walls a room into cells. Note that a plant listed above may still have')
  print('someone standing next to it - the agent walled in beside it. They cannot water it, because')
  print('the watering can is filled at a sink or cooler and they cannot get out to reach one.')
  process.exit(0)
}
