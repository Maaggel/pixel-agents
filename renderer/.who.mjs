import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims } from './native/shims.mjs'
const token = JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
installShims(); const print = console.log; console.log = () => {}
const { createHeadlessOffice } = await import('./native/engine.mjs')
const office = createHeadlessOffice({ width: 512, height: 300, zoom: 1, background: '#000', nametagOverlay: false })
const ws = new WebSocket(`wss://apps.blommemix.dk/pixelagents/ws?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => { const msg = JSON.parse(e.data); office.handleRelayMessage(msg); if (msg.type !== 'init') return; ws.close()
  for (let i = 0; i < 40; i++) office.tick(0.05)
  for (const ch of office.debug().characters()) print(String(ch.id).padStart(4), (ch.folderName || ch.label || ch.name || '').padEnd(46), `tile ${Math.round(ch.x / 16)},${Math.round(ch.y / 16)}`, ch.matrixEffect ?? '', ch.isActive ? 'active' : 'idle')
  process.exit(0) }
