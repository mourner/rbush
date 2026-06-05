// RBush v5 vs v4 range-search throughput.
//
//   node bench-v5-search.mjs [N] [bufferSize]

import RBushV5 from './index-v5.js';
import RBushV4 from './index.js';

const N = +process.argv[2] || 1_000_000;
const B = +process.argv[3] || 256;
const W = 1000;

const data = new Float64Array(N * 4);
for (let i = 0; i < N; i++) {
    const x = Math.random() * W, y = Math.random() * W, w = Math.random() * 5, h = Math.random() * 5;
    data[i * 4] = x; data[i * 4 + 1] = y; data[i * 4 + 2] = x + w; data[i * 4 + 3] = y + h;
}

// 1000 random small query boxes (~1% of the domain on a side → ~0.01% area)
const QN = 1000, QW = 10;
const queries = new Float64Array(QN * 4);
for (let i = 0; i < QN; i++) {
    const x = Math.random() * W, y = Math.random() * W;
    queries[i * 4] = x; queries[i * 4 + 1] = y; queries[i * 4 + 2] = x + QW; queries[i * 4 + 3] = y + QW;
}

const t5 = new RBushV5([0, 0, W, W], B);
for (let i = 0; i < N; i++) t5.add(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);

const t4 = new RBushV4();
const v4items = [];
for (let i = 0; i < N; i++) v4items.push({minX: data[i * 4], minY: data[i * 4 + 1], maxX: data[i * 4 + 2], maxY: data[i * 4 + 3]});
t4.load(v4items);

function benchV5() {
    let found = 0;
    const t0 = performance.now();
    for (let i = 0; i < QN; i++) found += t5.search(queries[i * 4], queries[i * 4 + 1], queries[i * 4 + 2], queries[i * 4 + 3]).length;
    return {ms: performance.now() - t0, found};
}
function benchV4() {
    let found = 0;
    const t0 = performance.now();
    for (let i = 0; i < QN; i++) found += t4.search({minX: queries[i * 4], minY: queries[i * 4 + 1], maxX: queries[i * 4 + 2], maxY: queries[i * 4 + 3]}).length;
    return {ms: performance.now() - t0, found};
}

function bestOf(fn) {
    fn();
    let best = Infinity, found = 0;
    for (let r = 0; r < 10; r++) { const res = fn(); if (res.ms < best) best = res.ms; found = res.found; }
    return {best, found};
}

console.log(`N = ${N.toLocaleString()}, ${QN} queries, bufferSize = ${B}`);
console.log(`v5 blocks: ${t5._blocks.filter(Boolean).length}, buffer ${t5._n}`);

const v5 = bestOf(benchV5);
const v4 = bestOf(benchV4);
console.log(`v5 search: ${v5.best.toFixed(1)} ms (${(QN / v5.best).toFixed(1)} k queries/s), ${v5.found} hits`);
console.log(`v4 search: ${v4.best.toFixed(1)} ms (${(QN / v4.best).toFixed(1)} k queries/s), ${v4.found} hits`);
console.log(`v5 is ${(v5.best / v4.best).toFixed(2)}× v4${v5.found === v4.found ? '' : '  ⚠ HIT COUNT MISMATCH'}`);
