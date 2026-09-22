// Frame-cost benchmark for the native renderer: connects to the relay as a viewer, takes the
// real office state, then times tick / render / readback / RGB565 with display flags toggled.
//   node test/bench-native.mjs            (token from ~/.pixel-agents/daemon.json)
import { createCanvas } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { installShims, useSnapshots, snapshotsMade } from '../native/shims.mjs'

const relayWs = process.env.PIXEL_AGENTS_RENDERER_RELAY_WS || 'wss://apps.blommemix.dk/pixelagents/ws'
const token = process.env.PIXEL_AGENTS_RENDERER_TOKEN || JSON.parse(readFileSync(homedir() + '/.pixel-agents/daemon.json', 'utf8')).relayToken
const UP = Number(process.env.UPSCALE || 1)
const W = 1024 / UP, H = 600 / UP
installShims()
const print = console.log
console.log = () => {} // the engine is chatty
const { createHeadlessOffice } = await import('../native/engine.mjs')
const office = createHeadlessOffice({ width: W, height: H, zoom: 2 / UP })
const canvas = createCanvas(W, H)
const ctx = useSnapshots(canvas.getContext('2d'))
ctx.imageSmoothingEnabled = false
const out = Buffer.allocUnsafe(W * H * 2)
let BG = 'none'
let verified = false

function frame(t) {
  let a = performance.now(); office.tick(1 / 15); let b = performance.now(); t.tick += b - a
  a = b; office.render(ctx); b = performance.now(); t.render += b - a
  if (BG === 'destination-over') { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over' }
  a = b; const rgba = canvas.data(); b = performance.now(); t.readback += b - a
  a = b
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H)
  const dst = new Uint16Array(out.buffer, out.byteOffset, W * H)
  for (let i = 0; i < W * H; i++) { const p = src[i]; dst[i] = ((p & 0xF8) << 8) | ((p & 0xFC00) >> 5) | ((p & 0xF80000) >> 19) }
  b = performance.now(); t.rgb565 += b - a
  if (!verified) {
    verified = true
    for (let i = 0, o = 0; o < out.length; i += 4, o += 2) {
      const v = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3)
      if (out[o] !== (v & 0xFF) || out[o + 1] !== (v >> 8)) { print(`RGB565 mismatch at pixel ${o / 2}`); process.exit(1) }
    }
    print('RGB565 u32 conversion matches the byte loop')
  }
}
function run(label, flags, n = 90) {
  office.setFlags(flags)
  for (let i = 0; i < 15; i++) frame({ tick: 0, render: 0, readback: 0, rgb565: 0 }) // warm sprite snapshots
  const t = { tick: 0, render: 0, readback: 0, rgb565: 0 }
  const s0 = process.cpuUsage()
  for (let i = 0; i < n; i++) frame(t)
  const cpu = process.cpuUsage(s0)
  const total = (t.tick + t.render + t.readback + t.rgb565) / n
  print(`${label.padEnd(30)} tick ${(t.tick / n).toFixed(1).padStart(5)}  render ${(t.render / n).toFixed(1).padStart(5)}  readback ${(t.readback / n).toFixed(1).padStart(5)}  rgb565 ${(t.rgb565 / n).toFixed(1).padStart(4)}  = ${total.toFixed(1).padStart(5)} ms/frame  (${((cpu.user + cpu.system) / 1000 / n).toFixed(1)} ms cpu, ${snapshotsMade()} snapshots)`)
}

const ws = new WebSocket(`${relayWs}?role=viewer&token=${encodeURIComponent(token)}`)
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  office.handleRelayMessage(msg)
  if (msg.type !== 'init') return
  ws.close()
  for (let i = 0; i < 100; i++) office.tick(0.05) // let spawn effects finish
  print(`${office.agentCount()} agents`)
  run('all on', { showSunlight: true, showNametags: true, dynamicItems: true, debugLampLights: false })
  run('no sunlight', { showSunlight: false, showNametags: true })
  run('no nametags', { showSunlight: true, showNametags: false })
  run('nothing optional', { showSunlight: false, showNametags: false })
  BG = 'destination-over'
  run('all on + bg destination-over', { showSunlight: true, showNametags: true })
  BG = 'none'
  run('all on (again)', { showSunlight: true, showNametags: true })
  process.exit(0)
}
ws.onclose = (e) => { if (e.code === 4001) { print('invalid token'); process.exit(1) } }
