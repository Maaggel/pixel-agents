// Watches the office live for a few of its days and reports the rhythm.
//
// The lunch and coffee rushes, the coffee queue and the lamps-where-people-are rule are emergent:
// they only show up over time, so this runs the real engine against live relay state and counts
// what happens by the office's own clock.
//   node test/office-day.mjs [officeDays]
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots } from '../native/shims.mjs'

const DAYS = Number(process.argv[2] || 3)
const CYCLE = 300, STEP = 0.1
const token = process.env.PIXEL_AGENTS_RENDERER_TOKEN || JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
installShims()
const print = console.log
console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1 })
const canvas = createCanvas(512, 300)
const ctx = useSnapshots(canvas.getContext('2d'))

const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type !== 'init') return
  ws.close()
  office.handleRelayMessage(msg)
  const internals = office.debug()
  const hourOf = internals.officeHour
  const chars = internals.characters

  const meals = new Array(24).fill(0), drinks = new Array(24).fill(0)
  const prev = new Map()
  let brewClashes = 0, queued = 0, maxLampsOn = 0, minLampsOnAtNight = 99
  const ticks = Math.round((CYCLE * DAYS) / STEP)
  for (let i = 0; i < ticks; i++) {
    office.tick(STEP)
    if (i % 5 !== 0) continue
    const hour = Math.floor(hourOf())
    const brewingAt = new Map()
    for (const ch of chars()) {
      const was = prev.get(ch.id)
      if (ch.idleAction !== was) {
        if (ch.idleAction === 'eating') meals[hour]++
        if (ch.idleAction === 'fetch_item') drinks[hour]++
        prev.set(ch.id, ch.idleAction)
      }
      // only a fetch counts as using a machine; two people eating at one table is fine
      if (ch.fetchOriginUid && ch.idleAction === 'fetch_item') {
        if (ch.conversationPhase === 'talking') {
          brewingAt.set(ch.fetchOriginUid, (brewingAt.get(ch.fetchOriginUid) || 0) + 1)
        } else if (ch.conversationPhase === 'approaching') queued++
      }
    }
    for (const [uid, n] of brewingAt) {
      if (n <= 1) continue
      brewClashes++
      if (brewClashes <= 3) {
        const who = chars().filter((c) => c.fetchOriginUid === uid && c.conversationPhase === 'talking')
        print(`  clash at ${uid}: ${who.map((c) => `${c.nametag || c.id}[${c.idleAction}/${c.conversationPhase}]`).join(' + ')}`)
      }
    }
  }
  const bar = (n, max) => '#'.repeat(Math.round((n / Math.max(1, max)) * 30))
  const mMax = Math.max(...meals), dMax = Math.max(...drinks)
  print(`\n${DAYS} office days (${(CYCLE * DAYS / 60).toFixed(0)} real minutes simulated), ${chars().length} agents\n`)
  print('hour  meals started              drinks started')
  for (let h = 0; h < 24; h++) {
    if (meals[h] === 0 && drinks[h] === 0) continue
    print(`${String(h).padStart(2)}:00  ${String(meals[h]).padStart(3)} ${bar(meals[h], mMax).padEnd(31)}${String(drinks[h]).padStart(3)} ${bar(drinks[h], dMax)}`)
  }
  const dayMeals = meals.slice(11, 14).reduce((a, b) => a + b, 0), nightMeals = [22, 23, 0, 1, 2, 3, 4, 5].reduce((a, h) => a + meals[h], 0)
  const morningDrinks = drinks.slice(7, 10).reduce((a, b) => a + b, 0), nightDrinks = [22, 23, 0, 1, 2, 3, 4, 5].reduce((a, h) => a + drinks[h], 0)
  print(`\nlunch hours (11-14): ${dayMeals} meals vs ${nightMeals} through the night (22-06)`)
  print(`morning (07-10): ${morningDrinks} drinks vs ${nightDrinks} through the night`)
  print(`two agents brewing at one machine at once: ${brewClashes} times (expected 0)`)
  process.exit(brewClashes > 0 ? 1 : 0)
}
