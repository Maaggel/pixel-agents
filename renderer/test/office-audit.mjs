// What is the office actually doing?
//
// Runs the real engine against live relay state for thirty office days and reports the mix: which
// idle actions agents chose, what they fetched and tidied, how the plants fared, whether drinks
// steamed. Balance questions ("nobody ever fetches a glass of water") are answered here rather
// than by watching and guessing - every weight in idleActions.ts shows up in these counts.
//   node test/office-audit.mjs
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims } from '../native/shims.mjs'
const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('../native/engine.mjs')
const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1 })
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data); if (msg.type !== 'init') return; ws.close()
  const cat = msg.furniture.catalog
  const byId = new Map(cat.map((c) => [c.id, c]))
  print('--- catalog as the relay serves it ---')
  for (const name of ['COFFEE_MUG', 'GLASS_WATER', 'PAPER_SHEET', 'BOOK', 'WATERING_CAN']) {
    const e2 = cat.find((c) => c.name === name)
    if (!e2) { print(`${name}: MISSING`); continue }
    print(`${name.padEnd(13)} utensil=${!!e2.utensil} use=${e2.utensilUse ?? '-'} steams=${e2.steams === true} origin=${e2.utensilOrigin ?? '-'} disposal=${e2.utensilDisposal ?? '-'} sprite=${!!msg.furniture.sprites[e2.id]}`)
  }
  // what is actually in the office to fetch from
  const names = (spec) => spec ? spec.split(',').map((x) => x.trim()) : []
  const placedNames = new Set(msg.layout.furniture.map((f) => byId.get(f.type)?.name).filter(Boolean))
  for (const name of ['COFFEE_MUG', 'GLASS_WATER']) {
    const e2 = cat.find((c) => c.name === name)
    const origins = names(e2?.utensilOrigin).filter((o) => [...placedNames].some((p) => p.startsWith(o.replace(/\*/g, ''))))
    print(`${name}: origins present in the layout -> ${origins.join(', ') || 'NONE'}`)
  }

  office.handleRelayMessage(msg)
  const dbg = office.debug()
  const fetched = {}, tidied = {}, actions = {}
  const lastAction = new Map()
  const held = new Map()
  let steamSeen = 0, maxSteam = 0, plantSamples = 0, freshTotal = 0, parchedTotal = 0
  for (let i = 0; i < 300 * 30 * 10; i++) {
    office.tick(0.1)
    if (i % 10) continue
    for (const ch of dbg.characters()) {
      const was = held.get(ch.id) ?? null
      if (ch.heldItem && ch.heldItem !== was) {
        const label = byId.get(ch.heldItem)?.name ?? ch.heldItem
        const bucket = ch.idleAction === 'tidy_up' ? tidied : fetched
        bucket[label] = (bucket[label] || 0) + 1
      }
      held.set(ch.id, ch.heldItem ?? null)
      const prevAction = lastAction.get(ch.id)
      if (ch.idleAction && ch.idleAction !== prevAction) actions[ch.idleAction] = (actions[ch.idleAction] || 0) + 1
      lastAction.set(ch.id, ch.idleAction)
    }
    for (const f of dbg.furniture()) {
      if (f.steam) { steamSeen++; maxSteam = Math.max(maxSteam, f.steam) }
    }
    const ps = dbg.furniture().filter((f) => f.thirstCycleSprites?.length)
    if (ps.length) {
      plantSamples++
      freshTotal += ps.filter((f) => f.thirstCycleSprites.indexOf(f.activeDataSprite) <= 0).length / ps.length
      parchedTotal += ps.filter((f) => f.thirstCycleSprites.indexOf(f.activeDataSprite) === 2).length / ps.length
    }
  }
  print('\n--- over 30 office days ---')
  print('idle actions: ' + Object.entries(actions).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} x${v}`).join(', '))
  print('fetched: ' + (Object.entries(fetched).map(([k, v]) => `${k} x${v}`).join(', ') || 'nothing'))
  print('tidied:  ' + (Object.entries(tidied).map(([k, v]) => `${k} x${v}`).join(', ') || 'nothing'))
  print(`plants averaged ${(freshTotal / plantSamples * 100).toFixed(0)}% freshly watered, ${(parchedTotal / plantSamples * 100).toFixed(0)}% parched`)
  print(`steaming cups seen in ${steamSeen} samples, hottest reading ${maxSteam.toFixed(2)}`)
  process.exit(0)
}
