// Seeded brute-force fuzz for RBush v5: grow trees across many buffer/node size combinations and
// compare search results against a linear scan at regular checkpoints.
import RBush from './index-v5.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const W = 1000;
const BUFFER_SIZES = [2, 3, 7, 16, 17, 64, 255, 256, 257];
const NODE_SIZES = [2, 3, 7, 16, 31];
const NUM_ADDS = 1500;
const CHECK_EVERY = 37;
const QUERIES_PER_CHECK = 8;

let seed = 0;
function rnd() { // LCG, so each config replays exactly from its seed
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
}

function randItem(n) {
    // a run of identical boxes: equal Hilbert keys exercise duplicates and the disjoint-range concat merge
    if (n >= 600 && n < 900) return [123.5, 456.5, 130, 460];
    const out = rnd() < 0.1; // some items outside the Hilbert domain (keys clamp to its edge)
    const x = out ? (rnd() * 3 - 1) * W : rnd() * W;
    const y = out ? (rnd() * 3 - 1) * W : rnd() * W;
    if (rnd() < 0.5) return [x, y, x, y];
    return [x, y, x + rnd() * 30, y + rnd() * 30];
}

function randQuery(i, items) {
    if (i === 0) return [-Infinity, -Infinity, Infinity, Infinity];
    if (i === 1) return [-Infinity, rnd() * W, rnd() * W, Infinity]; // half-infinite
    if (i === 2 || i === 3) { // touch an item exactly: edges count as intersecting
        const b = items[Math.floor(rnd() * items.length)], s = rnd() * 50;
        return i === 2 ? [b[2], b[3], b[2] + s, b[3] + s] : [b[0] - s, b[1] - s, b[0], b[1]];
    }
    const x = (rnd() * 1.4 - 0.2) * W, y = (rnd() * 1.4 - 0.2) * W, s = rnd() * 200;
    return [x, y, x + s, y + s];
}

function intersects(b, q) {
    return !(q[2] < b[0] || q[3] < b[1] || q[0] > b[2] || q[1] > b[3]);
}

const filterFn = id => id % 3 === 0;

function check(tree, items, n) {
    for (let i = 0; i < QUERIES_PER_CHECK; i++) {
        const q = randQuery(i, items);
        const filter = i % 2 === 1 ? filterFn : undefined;
        const got = tree.search(q[0], q[1], q[2], q[3], filter).sort((a, b) => a - b);
        const want = [];
        for (let id = 0; id < items.length; id++) {
            if (intersects(items[id], q) && (!filter || filter(id))) want.push(id);
        }
        const k = got.findIndex((v, k) => v !== want[k]);
        if (got.length !== want.length || k !== -1) {
            assert.fail(`after ${n} adds, query [${q}]${filter ? ' (filtered)' : ''}: got ${got.length} ids, ` +
                `want ${want.length}` + (k !== -1 ? `, first diff at ${k}: ${got[k]} vs ${want[k]}` : ''));
        }
    }
}

function fuzz(bufferSize, nodeSize) {
    seed = bufferSize * 1000 + nodeSize;
    const tree = new RBush([0, 0, W, W], bufferSize, nodeSize);
    const items = [];

    for (let n = 1; n <= NUM_ADDS; n++) {
        const b = randItem(n);
        const id = tree.add(b[0], b[1], b[2], b[3]);
        assert.equal(id, items.length, `id of add #${n}`);
        items.push(b);

        if (n % CHECK_EVERY === 0 || n === NUM_ADDS) check(tree, items, n);
    }
}

test('rejects invalid config', () => {
    for (const [bufferSize, nodeSize] of [[1, 16], [256, 1], [256, 0], [2.5, 16], [256, NaN]]) {
        assert.throws(() => new RBush([0, 0, W, W], bufferSize, nodeSize), Error, `${bufferSize}, ${nodeSize}`);
    }
});

for (const bufferSize of BUFFER_SIZES) {
    for (const nodeSize of NODE_SIZES) {
        test(`fuzz bufferSize=${bufferSize} nodeSize=${nodeSize}`, () => fuzz(bufferSize, nodeSize));
    }
}
