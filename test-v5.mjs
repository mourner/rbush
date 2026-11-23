// Seeded model-based fuzz for RBush v5: run random add/remove/update mixes across many buffer/node size
// combinations, mirroring them in a plain array, and compare search results against its linear scan.
import RBush from './index-v5.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const W = 1000;
const BUFFER_SIZES = [2, 3, 7, 16, 17, 64, 255, 256, 257];
const NODE_SIZES = [2, 3, 7, 16, 31];
const NUM_OPS = 4000;
const CHECK_EVERY = 37;
const QUERIES_PER_CHECK = 8;

let seed = 0;
function rnd() { // LCG, so each config replays exactly from its seed
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
}

function randItem(n) {
    // a run of identical boxes: equal Hilbert keys exercise duplicates and the disjoint-range concat merge
    if (n >= 400 && n < 700) return [123.5, 456.5, 130, 460];
    const out = rnd() < 0.1; // some items outside the Hilbert domain (keys clamp to its edge)
    const x = out ? (rnd() * 3 - 1) * W : rnd() * W;
    const y = out ? (rnd() * 3 - 1) * W : rnd() * W;
    if (rnd() < 0.5) return [x, y, x, y];
    return [x, y, x + rnd() * 30, y + rnd() * 30];
}

function randQuery(i, items, live) {
    if (i === 0) return [-Infinity, -Infinity, Infinity, Infinity];
    if (i === 1) return [-Infinity, rnd() * W, rnd() * W, Infinity]; // half-infinite
    if ((i === 2 || i === 3) && live.length > 0) { // touch an item exactly: edges count as intersecting
        const b = items[live[Math.floor(rnd() * live.length)]], s = rnd() * 50;
        return i === 2 ? [b[2], b[3], b[2] + s, b[3] + s] : [b[0] - s, b[1] - s, b[0], b[1]];
    }
    const x = (rnd() * 1.4 - 0.2) * W, y = (rnd() * 1.4 - 0.2) * W, s = rnd() * 200;
    return [x, y, x + s, y + s];
}

function intersects(b, q) {
    return !(q[2] < b[0] || q[3] < b[1] || q[0] > b[2] || q[1] > b[3]);
}

const filterFn = id => id % 3 === 0;

function check(tree, items, live, n) {
    assert.equal(tree.size, live.length, `size after ${n} ops`);

    // white-box: each block's dead count must match its stale copies exactly — an undercount lets a
    // merge or search treat a stale copy (possibly of a since-reused id) as live
    let prev;
    for (const block of tree._blocks) {
        assert.ok(block.numItems > 0, `empty block settled after ${n} ops`);
        assert.ok(block.firstBatch <= block.lastBatch && block.lastBatch < tree._batch, `batch range after ${n} ops`);
        if (prev) assert.ok(prev.lastBatch < block.firstBatch, `blocks out of age order after ${n} ops`);
        prev = block;
        let stale = 0;
        for (let i = 0; i < block.numItems; i++) {
            const batch = tree._batchOf[block.indices[i]];
            if (batch < block.firstBatch || batch > block.lastBatch) stale++;
        }
        assert.equal(block.dead, stale, `dead count after ${n} ops`);
        assert.ok(stale * 2 <= block.numItems, `block over half dead after ${n} ops`);
    }

    for (let i = 0; i < QUERIES_PER_CHECK; i++) {
        const q = randQuery(i, items, live);
        const filter = i % 2 === 1 ? filterFn : undefined;
        const got = tree.search(q[0], q[1], q[2], q[3], filter).sort((a, b) => a - b);
        const want = [];
        for (let id = 0; id < items.length; id++) {
            if (items[id] && intersects(items[id], q) && (!filter || filter(id))) want.push(id);
        }
        const k = got.findIndex((v, k) => v !== want[k]);
        if (got.length !== want.length || k !== -1) {
            assert.fail(`after ${n} ops, query [${q}]${filter ? ' (filtered)' : ''}: got ${got.length} ids, ` +
                `want ${want.length}` + (k !== -1 ? `, first diff at ${k}: ${got[k]} vs ${want[k]}` : ''));
        }
    }
}

// Op mix [add, remove] probabilities (update takes the rest) by phase: grow, churn, drain to empty (so whole
// blocks die and merges drop everything), then regrow on reused ids.
function opMix(n) {
    if (n <= 1000) return [0.8, 0.1];
    if (n <= 2000) return [0.35, 0.3];
    if (n <= 2800) return [0.03, 0.9];
    return [0.6, 0.15];
}

function fuzz(bufferSize, nodeSize) {
    seed = bufferSize * 1000 + nodeSize;
    const tree = new RBush([0, 0, W, W], bufferSize, nodeSize);
    const items = []; // id → box, undefined once removed
    const live = [];  // live ids, in no particular order
    const freeIds = [];

    for (let n = 1; n <= NUM_OPS; n++) {
        const [pAdd, pRemove] = opMix(n);
        const r = live.length === 0 ? 0 : rnd();

        if (r < pAdd) {
            const b = randItem(n);
            const id = tree.add(b[0], b[1], b[2], b[3]);
            assert.equal(id, freeIds.length > 0 ? freeIds.pop() : items.length, `id of add at op ${n}`);
            items[id] = b;
            live.push(id);
        } else {
            const k = Math.floor(rnd() * live.length), id = live[k];
            if (r < pAdd + pRemove) {
                tree.remove(id);
                items[id] = undefined;
                live[k] = live[live.length - 1];
                live.pop();
                freeIds.push(id);
                assert.throws(() => tree.remove(id), Error, `double remove of ${id}`);
                assert.throws(() => tree.update(id, 0, 0), Error, `update of removed ${id}`);
            } else {
                const b = randItem(n);
                tree.update(id, b[0], b[1], b[2], b[3]);
                items[id] = b;
            }
        }

        if (rnd() < 0.003) tree.compact();
        if (n % CHECK_EVERY === 0 || n === NUM_OPS) check(tree, items, live, n);
    }
}

test('rejects unknown ids', () => {
    const tree = new RBush([0, 0, W, W], 4);
    for (let i = 0; i < 10; i++) tree.add(i, i);
    for (const id of [-1, 10, 1000, 2.5, NaN]) {
        assert.throws(() => tree.remove(id), Error, `remove(${id})`);
        assert.throws(() => tree.update(id, 0, 0), Error, `update(${id})`);
    }
});

test('rejects invalid config', () => {
    for (const [bufferSize, nodeSize] of [[1, 16], [256, 1], [256, 0], [2.5, 16], [256, NaN]]) {
        assert.throws(() => new RBush([0, 0, W, W], bufferSize, nodeSize), Error, `${bufferSize}, ${nodeSize}`);
    }
});

test('compact merges everything into one block', () => {
    const tree = new RBush([0, 0, W, W], 16, 4);
    const ids = [];
    for (let i = 0; i < 1000; i++) ids.push(tree.add(i % W, (i * 7) % W));
    for (let i = 0; i < 1000; i += 3) tree.remove(ids[i]);
    tree.compact();
    assert.equal(tree._blocks.length, 1);
    assert.equal(tree._n, 0);
    assert.equal(tree._blocks[0].numItems, tree.size);
    assert.equal(tree.search(-Infinity, -Infinity, Infinity, Infinity).length, tree.size);

    for (const id of ids) if (id % 3 !== 0) tree.remove(id); // drain: compaction vacates every level
    assert.equal(tree._blocks.length, 0);
    tree.compact();
    assert.equal(tree.search(-Infinity, -Infinity, Infinity, Infinity).length, 0);
});

test('blocks too big to pool get exact-size arrays and shrink when half dead', () => {
    const tree = new RBush([0, 0, W, W], 256, 16);
    const n = 200_000, ids = [];
    for (let i = 0; i < n; i++) ids.push(tree.add(i % W, (i * 7) % W));
    tree.compact();
    let block = tree._blocks[0];
    assert.equal(block.poolClass, -1);
    assert.equal(block.keys.length, n);

    const removed = 110_000; // past half dead, rebuilt from the live half (still too big to pool), then 5% more
    for (let i = 0; i < removed; i++) tree.remove(ids[i]);
    block = tree._blocks[0];
    assert.equal(tree._blocks.length, 1);
    assert.equal(block.poolClass, -1);
    assert.equal(block.keys.length, n / 2 - 1);
    assert.equal(block.dead, removed - (n / 2 + 1));
    assert.equal(tree.search(-Infinity, -Infinity, Infinity, Infinity).length, n - removed);
    assert.deepEqual(tree.search(0, 0, 0, 0).sort((a, b) => a - b), ids.filter((id, i) => i >= removed && i % W === 0));
});

for (const bufferSize of BUFFER_SIZES) {
    for (const nodeSize of NODE_SIZES) {
        test(`fuzz bufferSize=${bufferSize} nodeSize=${nodeSize}`, () => fuzz(bufferSize, nodeSize));
    }
}
