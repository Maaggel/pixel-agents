// What a background service costs the owner's interactive work on this box.
//
// Throughput benchmarks (one long CPU-bound job) miss it: what an agent session does is short
// bursts of work, and what hurts is how long a burst waits to get on a core. This runs bursts
// of a fixed size on a fixed rhythm and reports how much longer than their ideal they took.
//   node test/latency-bench.mjs [bursts] [burstMs] [gapMs]
import { createHash } from 'crypto'

const bursts = Number(process.argv[2] || 60)
const burstMs = Number(process.argv[3] || 25)
const gapMs = Number(process.argv[4] || 100)

/** Calibrate: how many hash rounds is burstMs of work on an idle core? */
function work(rounds) {
  let h = Buffer.alloc(32)
  for (let i = 0; i < rounds; i++) h = createHash('sha256').update(h).digest()
  return h
}
let rounds = 20000
for (let i = 0; i < 6; i++) {
  const t = performance.now()
  work(rounds)
  const ms = performance.now() - t
  rounds = Math.max(1000, Math.round(rounds * (burstMs / ms)))
}

const took = []
for (let i = 0; i < bursts; i++) {
  const t = performance.now()
  work(rounds)
  took.push(performance.now() - t)
  await new Promise((r) => setTimeout(r, gapMs))
}
took.sort((a, b) => a - b)
const pct = (p) => took[Math.min(took.length - 1, Math.floor(took.length * p))]
const mean = took.reduce((a, b) => a + b, 0) / took.length
console.log(`${bursts} bursts of ~${burstMs}ms: mean ${mean.toFixed(1)}  p50 ${pct(0.5).toFixed(1)}  p95 ${pct(0.95).toFixed(1)}  max ${took[took.length - 1].toFixed(1)} ms`)
