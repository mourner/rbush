// RBush v5 insert benchmark — throughput, cascade spikes, and a sort ceiling for context.
//
//   node bench-v5.mjs [N] [bufferSize]

import RBush from './index-v5.js';

const N = +process.argv[2] || 1_000_000;
const B = +process.argv[3] || 256;

// pre-generate random small boxes in a 0..1000 domain so the RNG isn't in any timed loop
const W = 1000;
const data = new Float64Array(N * 4);
for (let i = 0; i < N; i++) {
    const x = Math.random() * W, y = Math.random() * W, w = Math.random() * 5, h = Math.random() * 5;
    data[i*4] = x; data[i*4+1] = y; data[i*4+2] = x + w; data[i*4+3] = y + h;
}

// --- the cascade: N incremental adds, watching per-insert latency ---
// one run = build a fresh tree from all N boxes, tracking per-insert spikes.
// With bufSize = B (default) it's the full incremental cascade; with bufSize = N
// it's a single buffer freeze + one quicksort, no merges — a Flatbush-equivalent
// static build (the closest apples-to-apples ceiling we have without the dep).
function run(bufSize = B) {
    const t = new RBush([0, 0, W, W], bufSize);
    let over1ms = 0;
    const spikes = [];
    const t0 = performance.now();

    // A spike can only occur on the add that fills the buffer and triggers a flush
    // (every B-th add). Timing only those keeps performance.now() out of the hot path
    // — at 2 calls/add it was ~10% of the profile and pure measurement noise.
    let sinceFlush = 0;
    for (let i = 0; i < N; i++) {
        if (++sinceFlush < bufSize) {
            t.add(data[i*4], data[i*4+1], data[i*4+2], data[i*4+3]);
        } else {
            sinceFlush = 0;
            const a = performance.now();
            t.add(data[i*4], data[i*4+1], data[i*4+2], data[i*4+3]);
            const dt = performance.now() - a;
            if (dt > 1) { over1ms++; spikes.push(Math.round(100 * dt) / 100); }
        }
    }
    return {tree: t, total: performance.now() - t0, over1ms, spikes};
}

const RUNS = 5;
// best total of `RUNS` measured runs after one discarded warmup
function bestOf(bufSize) {
    run(bufSize);
    let best = null;
    for (let r = 0; r < RUNS; r++) {
        const res = run(bufSize);
        if (!best || res.total < best.total) best = res;
    }
    return best;
}

console.log(`N = ${N.toLocaleString()}, bufferSize = ${B}  (best of ${RUNS} runs + 1 warmup)`);

const best = bestOf(B);
const {tree: t, total, maxSpike, over1ms, spikes} = best;

console.log(`inserted in ${total.toFixed(1)} ms (${(N / total / 1000).toFixed(2)} M ops/s)`);
console.log(`inserts > 1ms: ${over1ms}, biggest spikes: ${spikes.sort((a, b) => b - a).slice(0, 5).join(', ')}`);
console.log(`${t._blocks.length} levels, ${t._blocks.filter(Boolean).length} blocks`);

// static-build ceiling: bufSize = N → one quicksort, no merges (Flatbush-equivalent)
// const staticBest = bestOf(N).total;

// console.log(`static-build ceiling: ${staticBest.toFixed(1)} ms`);
// console.log(`incremental takes ~${(total / staticBest).toFixed(2)}× the static build`);
