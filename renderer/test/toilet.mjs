// Is the toilet a toilet, or just an awkward desk?
//
// A toilet is a chair, which used to mean an agent could be assigned one as their working seat and
// sit on it for the rest of the day. It is now left out of seat assignment entirely and visited by
// the USE_TOILET idle action instead: walk over, sit a short while, wash your hands at a sink, go
// back to your own desk. This checks that, and that the room still locks while it is in use.
//   node test/toilet.mjs
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
  const toiletEntry = cat.find((c) => c.privacySeat)
  const toilet = msg.layout.furniture.find((f) => f.type === toiletEntry?.id)
  if (!toilet) { print('no toilet in the office layout'); process.exit(1) }

  office.handleRelayMessage(msg)
  const dbg = office.debug()
  const start = Date.now()
  while (dbg.characters().length === 0 && Date.now() - start < 8000) {
    office.tick(0.05)
    await new Promise((r) => setTimeout(r, 50))
  }
  ws.close()
  const chars = dbg.characters()
  if (!chars.length) { print('no local agents in the office right now - try again in a moment'); process.exit(1) }
  print(`toilet at ${toilet.col},${toilet.row}, ${chars.length} agents\n`)

  // 1. Nobody is given the toilet as their desk.
  office.tick(0.1)
  const seated = dbg.characters().filter((c) => c.seatId === toilet.uid)
  check(seated.length === 0, 'nobody is assigned the toilet as their seat',
    seated.length ? seated.map((c) => c.nametag).join(', ') : '')

  // 2. Someone can go and use it.
  const visitor = dbg.characters().find((c) => !c.isRemote && !c.isSubagent)
  for (const c of dbg.characters()) if (c.id !== visitor.id) c.isRemote = true
  const ownSeat = visitor.seatId
  const started = dbg.startIdle(visitor.id, 'use_toilet')
  check(started, 'an agent can set off for the toilet')
  if (!started) { print('\\n1 failure(s)'); process.exit(1) }

  // walk there and sit down
  let sat = false
  for (let i = 0; i < 600 && !sat; i++) {
    office.tick(0.1)
    const c = dbg.characters().find((x) => x.id === visitor.id)
    sat = c.tileCol === toilet.col && c.tileRow === toilet.row && String(c.state).startsWith('sit')
  }
  check(sat, 'they walk to it and sit down')

  // the room shuts itself while they are in there
  const doors = dbg.doors()
  if (doors.length) {
    office.tick(0.1)
    const locked = dbg.doors().some((d) => d.locked)
    check(locked, 'the room locks while the toilet is in use', JSON.stringify(dbg.doors()))
  }

  // 3. Then they wash their hands and go back to their own desk.
  let washed = false
  for (let i = 0; i < 1200 && !washed; i++) {
    office.tick(0.1)
    const c = dbg.characters().find((x) => x.id === visitor.id)
    washed = c.bubbleType === 'idle_tidy' && !String(c.state).startsWith('sit')
  }
  check(washed, 'they go to the sink afterwards')

  let done = false
  for (let i = 0; i < 1200 && !done; i++) {
    office.tick(0.1)
    const c = dbg.characters().find((x) => x.id === visitor.id)
    done = c.idleAction === null || c.idleAction === 'wander'
  }
  const after = dbg.characters().find((x) => x.id === visitor.id)
  check(done, 'and the visit ends')
  check(after.seatId === ownSeat, 'their own desk is theirs again', `${after.seatId} vs ${ownSeat}`)
  check(!dbg.doors().some((d) => d.locked), 'and the room is unlocked again')

  print(failures === 0 ? '\nall good' : `\n${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}
