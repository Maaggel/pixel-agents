// Do doors behave?
//
// Takes the live office, drops a door into the gap below the bathroom and checks the four things
// that matter: that a doorway is still walked through rather than around, that it opens for
// whoever reaches it, that it closes again afterwards, and that sitting on the toilet shuts and
// locks the room. The office has no door placed in it yet, so the door here is inserted into the
// layout message before the engine ever sees it.
//   node test/doors.mjs
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims } from '../native/shims.mjs'

const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')

let failures = 0
const check = (ok, what, detail = '') => {
  print(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '   ' + detail : ''}`)
  if (!ok) failures++
}

const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1 })
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = async (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type !== 'init') return
  const cat = msg.furniture.catalog
  const doorEntry = cat.find((c) => c.name === 'DOOR_FRONT_CLOSED')
  const toilet = cat.find((c) => c.privacySeat)
  if (!doorEntry) { print('no door in the catalog - has it been uploaded and the relay restarted?'); process.exit(1) }
  if (!toilet) { print('no privacy seat in the catalog'); process.exit(1) }

  const lay = msg.layout
  const VOID = 8, WALL = 0
  const tile = (c, r) => (c < 0 || r < 0 || c >= lay.cols || r >= lay.rows) ? VOID : lay.tiles[r * lay.cols + c]
  const placed = lay.furniture.find((f) => f.type === toilet.id)
  if (!placed) { print('no toilet placed in the office layout'); process.exit(1) }

  // The doorway of the room the toilet stands in: a floor tile in a wall run, reachable from it
  const gaps = []
  for (let r = 0; r < lay.rows; r++) for (let c = 0; c < lay.cols; c++) {
    const t = tile(c, r)
    if (t === VOID || t === WALL) continue
    if (tile(c - 1, r) === WALL && tile(c + 1, r) === WALL) gaps.push({ col: c, row: r })
  }
  const near = gaps.sort((a, b) =>
    (Math.abs(a.col - placed.col) + Math.abs(a.row - placed.row)) - (Math.abs(b.col - placed.col) + Math.abs(b.row - placed.row)))[0]
  print(`toilet at ${placed.col},${placed.row}; its doorway at ${near.col},${near.row}`)

  // A door's footprint is three rows: the lowest is walked through, the ones above hang in the wall
  lay.furniture.push({ uid: 'test-door', type: doorEntry.id, col: near.col, row: near.row - (doorEntry.footprintH - 1) })
  office.handleRelayMessage(msg)
  const dbg = office.debug()

  // Agents can still be re-announcing (after a relay restart the init can arrive before the
  // publishers reconnect), so give them a moment rather than bailing out.
  const start = Date.now()
  while (dbg.characters().length === 0 && Date.now() - start < 8000) {
    office.tick(0.05)
    await new Promise((r) => setTimeout(r, 50))
  }
  ws.close()

  // Start from a quiet office: whoever is on the toilet in the real one right now would have the
  // room locked before the first check ran (which is how this test first found the lock working).
  for (const c of dbg.characters()) {
    c.seatId = null
    c.state = 'idle'
    c.path = []
    c.idleAction = null
    c.isActive = false
    c.matrixEffect = null
  }
  office.tick(0.1)

  const doors = dbg.doors()
  check(doors.length === 1, 'the door is indexed', JSON.stringify(doors[0]))
  check(doors[0]?.col === near.col && doors[0]?.row === near.row, 'on the tile people walk through, not the wall row')

  // 1. A doorway is walked through. The route from outside into the room must cross the door tile.
  // Not to the toilet itself: a chair tile is blocked for everyone but whoever is assigned to it.
  const outside = { col: near.col, row: near.row + 2 }
  const inside = { col: near.col, row: near.row - 1 }
  const route = dbg.route(outside.col, outside.row, inside.col, inside.row)
  const crosses = route.some((p) => p.col === near.col && p.row === near.row)
  check(route.length > 0 && crosses, 'a route into the room runs through the doorway', `${route.length} tiles`)

  // 2. It opens for whoever reaches it. Everyone else is frozen for the door tests: the office is
  // live, and a doorway is a route, so passers-by hold it open and the timings become a lottery.
  const ch = dbg.characters().find((c) => !c.isRemote && !c.isSubagent)
  if (!ch) { print('no local agents in the office right now - try again in a moment'); process.exit(1) }
  const frozen = dbg.characters().filter((c) => c.id !== ch.id)
  for (const c of frozen) c.isRemote = true
  // and the one live character is pinned where the test puts it: left to its own devices it
  // wanders back through the doorway, and a door in use never closes
  const pin = (col, row, ticks, until) => {
    for (let i = 0; i < ticks; i++) {
      ch.tileCol = col; ch.tileRow = row
      ch.x = col * 16 + 8; ch.y = row * 16 + 8
      ch.path = []
      ch.idleAction = null
      // parked, not idling: an idle character plans a wander, and if that route crosses the
      // doorway the door is in use again and will not close
      ch.state = 'sit_idle'
      ch.seatTimer = 600
      office.tick(0.1)
      if (until && until()) return true
    }
    return false
  }
  ch.isActive = false
  ch.idleAction = null
  ch.matrixEffect = null
  const stepToDoor = () => {
    ch.tileCol = outside.col; ch.tileRow = outside.row
    ch.path = [{ col: near.col, row: near.row }]
    office.tick(0.1)
  }
  stepToDoor()
  check(dbg.doors()[0].open, 'it opens when someone is a step away')

  // 3. It closes again once they are through and gone - usually. Left open is a real outcome, so
  // this counts over many trips rather than trusting one toss of a weighted coin.
  let closedBehind = 0, leftOpen = 0, passerShut = 0, passerFailed = 0
  for (let trip = 0; trip < 20; trip++) {
    if (!dbg.doors()[0].open) stepToDoor()
    // walked through and away: out of sight, so only the roll can close it
    const closed = pin(outside.col, outside.row + 3, 60, () => !dbg.doors()[0].open)
    closed ? closedBehind++ : leftOpen++
    if (!closed) {
      // left open, so stand someone next to it and see whether they shut it
      const shut = pin(near.col, near.row + 1, 600, () => !dbg.doors()[0].open)
      if (shut) passerShut++; else passerFailed++
    }
  }
  check(closedBehind >= 8 && leftOpen >= 1, 'it is usually closed behind them, not always',
    `${closedBehind} closed, ${leftOpen} left open of 20`)
  check(passerFailed === 0 && passerShut > 0, 'a door left open is shut by someone passing it',
    `${passerShut} shut by a passer-by, ${passerFailed} never shut`)

  // 4. Sitting on the toilet shuts and locks the room.
  const sitter = frozen[0] ?? ch
  sitter.isRemote = false
  // keep everyone else well clear, or the lock politely waits for them to leave
  for (const other of dbg.characters()) {
    if (other.id === sitter.id) continue
    other.tileCol = outside.col
    other.tileRow = outside.row + 4
    other.path = []
  }
  dbg.sit(sitter.id, placed.uid, placed.col, placed.row)
  office.tick(0.1)
  const locked = dbg.doors()[0]
  check(locked.locked && !locked.open, 'the door shuts and locks while the toilet is in use', JSON.stringify(locked))

  const blockedRoute = dbg.route(outside.col, outside.row, inside.col, inside.row)
  check(blockedRoute.length === 0, 'and nobody else can path into the room')

  // 5. Standing up lets it go again.
  sitter.state = 'idle'
  sitter.seatId = null
  office.tick(0.1)
  check(!dbg.doors()[0].locked, 'the lock lifts when they leave the seat')

  print(failures === 0 ? '\nall good' : `\n${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}
