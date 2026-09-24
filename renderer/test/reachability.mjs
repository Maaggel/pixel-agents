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
  // Walk the floor as a graph and take its biggest connected piece as "the office proper". Measuring
  // from a character's own tile is not safe: a character sitting on a chair can step off it into a
  // cell nobody else can enter, and everything behind that chair then looks reachable.
  const key = ([c, r]) => `${c},${r}`
  const floorSet = new Set(floors.map(key))
  const step = (a, b) => floorSet.has(key(b)) && dbg.route(a[0], a[1], b[0], b[1]).length > 0
  const seen = new Set()
  let hub = null, hubSize = -1
  for (const start of floors) {
    if (seen.has(key(start))) continue
    const region = []
    const queue = [start]
    seen.add(key(start))
    while (queue.length) {
      const [c, r] = queue.shift()
      region.push([c, r])
      for (const n of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
        if (seen.has(key(n))) continue
        if (!step([c, r], n)) continue
        seen.add(key(n))
        queue.push(n)
      }
    }
    if (region.length > hubSize) { hubSize = region.length; hub = region[0] }
  }
  if (!hub) { print('no floor to measure from'); process.exit(1) }
  const openFloor = new Set()
  {
    const queue = [hub]
    openFloor.add(key(hub))
    while (queue.length) {
      const [c, r] = queue.shift()
      for (const n of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
        if (openFloor.has(key(n)) || !step([c, r], n)) continue
        openFloor.add(key(n))
        queue.push(n)
      }
    }
  }
  // A chair blocks everyone but its own occupant, so tiles behind one are not out of reach - they
  // are reachable by exactly the people who sit there. Flood again allowing a step through a seat
  // to tell "nobody can get there" apart from "only whoever sits here can".
  const seatTiles = new Set()
  for (const f of lay.furniture) {
    const e = byId.get(f.type)
    if (!e?.isSeat) continue
    for (let dr = 0; dr < (e.footprintH || 1); dr++) for (let dc = 0; dc < (e.footprintW || 1); dc++) {
      seatTiles.add(`${Math.floor(f.col) + dc},${Math.floor(f.row) + dr}`)
    }
  }
  const throughSeats = new Set(openFloor)
  {
    const queue = [...openFloor].map((k) => k.split(',').map(Number))
    while (queue.length) {
      const [c, r] = queue.shift()
      for (const n of [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]) {
        const k = key(n)
        if (throughSeats.has(k)) continue
        if (!floorSet.has(k)) continue
        // step onto a seat, or off one onto ordinary floor
        if (!seatTiles.has(k) && !seatTiles.has(key([c, r]))) continue
        throughSeats.add(k)
        queue.push(n)
      }
    }
  }
  const reaches = (c, r) => openFloor.has(`${c},${r}`)
  const reachesViaSeat = (c, r) => throughSeats.has(`${c},${r}`)
  print(`the office proper is ${openFloor.size} of ${floors.length} floor tiles, measured from ${hub.join(',')}\n`)

  const canStandBeside = (col, row, w, h, test = reaches) => {
    const sides = []
    for (let dc = 0; dc < w; dc++) { sides.push([col + dc, row - 1], [col + dc, row + h]) }
    for (let dr = 0; dr < h; dr++) { sides.push([col - 1, row + dr], [col + w, row + dr]) }
    return sides.some(([c, r]) => test(c, r))
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
      .some(([c, r]) => reaches(c, r))
    if (!out) walledIn.push(`  ${e.name.padEnd(28)} at ${col},${row}`)
  }

  const stranded = { plant: [], utensil: [], 'used by someone': [] }
  for (const f of lay.furniture) {
    const e = byId.get(f.type)
    const why = wanted(e)
    if (!why) continue
    const col = Math.floor(f.col), row = Math.floor(f.row)
    if (canStandBeside(col, row, e.footprintW || 1, e.footprintH || 1)) continue
    const viaSeat = canStandBeside(col, row, e.footprintW || 1, e.footprintH || 1, reachesViaSeat)
    stranded[why].push(`  ${e.name.padEnd(28)} at ${col},${row}${viaSeat ? '   (only from someone\'s own chair)' : ''}`)
  }

  const total = Object.values(stranded).reduce((n, l) => n + l.length, 0) + walledIn.length
  if (!total) { print('everything can be reached'); process.exit(0) }

  if (walledIn.length) {
    print('Seats an agent cannot get out of - whoever sits here is stuck in a cell:')
    for (const line of walledIn) print(line)
    print('')
  }

  if (stranded.plant.length) {
    print('Plants not reachable from the open floor:')
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
