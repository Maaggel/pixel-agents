// Busy agents work at a desk, not standing in the middle of the floor.
//
// Takes the live office, empties it of activity, then runs two office hours in which every agent
// is flipped busy and idle at random every few seconds, and counts the time agents spend working
// on a tile that is no seat at all. It was 19% on 2026-10-12: a double window hung where a corridor
// turned sealed the top-left office, and an agent who got busy in there - or found its desk cut off,
// or was sitting on a sofa at the time - started work wherever it was. Since the fix runs land
// between 0.1% and about 2% (the office rolls its own dice), so it fails above 5%: well clear of
// the noise, and far below what the bug did.
//   node test/busy-seats.mjs
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims } from '../native/shims.mjs'
const LIMIT = 0.05
const token = process.env.PIXEL_AGENTS_RENDERER_TOKEN || JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const relayWs = process.env.PIXEL_AGENTS_RENDERER_RELAY_WS || 'wss://apps.blommemix.dk/pixelagents/ws'
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1, background: '#000', nametagOverlay: false })
const ws = new WebSocket(`${relayWs}?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type !== 'init') return
  ws.close()
  const windows = JSON.parse(JSON.stringify(msg.windows))
  for (const w of windows) for (const a of w.agents) { a.isActive = false; a.currentTool = null }
  office.handleRelayMessage({ ...msg, windows })
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const d = office.debug()
  let working = 0, standing = 0
  const who = new Map()
  for (let step = 0; step < 2 * 3600 * 10; step++) {
    if (step % 50 === 0) {
      for (const w of windows) for (const a of w.agents) if (rnd() < 0.16) { a.isActive = !a.isActive; a.currentTool = a.isActive ? 'Edit' : null }
      office.handleRelayMessage({ type: 'sync', windows })
    }
    office.tick(0.1)
    if (step % 10) continue
    const seatTiles = new Set(d.seats().map((s) => `${s.col},${s.row}`))
    for (const ch of d.characters()) {
      if (ch.isSubagent || !(ch.state === 'type' || ch.state === 'build')) continue
      working++
      if (!seatTiles.has(`${Math.floor(ch.x / 16)},${Math.floor(ch.y / 16)}`)) { standing++; who.set(ch.nametag, (who.get(ch.nametag) ?? 0) + 1) }
    }
  }
  const share = working ? standing / working : 0
  print(`two office hours: ${working} agent-seconds of work, ${standing} of them standing on no seat (${(100 * share).toFixed(1)}%)`)
  if (standing) print('  ' + [...who].map(([n, k]) => `${n}: ${k}s`).join(', '))
  if (share > LIMIT) { print(`FAIL: more than ${100 * LIMIT}% of work done standing`); process.exit(1) }
  print('OK')
  process.exit(0)
}
