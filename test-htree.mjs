// Seeded fuzz: random add / remove / update (jitter + teleport) against brute force, plus white-box invariants
// (padded unused slots, slotOf and parent links, tight MBRs, exact max keys, key order). Before a flush, the
// entries of leaves marked by updates may be stale (max keys still upper bounds and in order); all others must be
// exact, as must every internal node's entry relative to the entries in the node. rebuild() runs at random points,
// and over a range of sizes around node boundaries; each tree starts pending, and again after draining to empty.
// One kind of data starts in a tight cluster and spreads out by 2^20, so the domain keeps growing.
// Directed cases at the end cover what the fuzz can't see: items that moved away must not stay in their leaf, keys
// must come through domain growth exact, and degenerate domains must work.
import HTree from './htree.js';

const M = 16;
const MAX_KEY = 0x3fffffff;
const DEAD = 0x80000000;
const FILL = 14;

/** @param {number} a */
function mulberry32(a) {
    return function () {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * @param {any} t
 * @param {Map<number, number[]>} live
 * @param {boolean} exact false: allow entries left stale by pending in-place updates
 * @param {boolean} [packed] right after rebuild: nodes at most FILL full, keys fresh from the boxes, every finite
 * center inside the domain
 */
function check(t, live, exact, packed = false) {
    const boxes = t._boxes, keys = t._keys, ptrs = t._ptrs;
    let items = 0;

    // returns the node's actual [minX, minY, maxX, maxY, maxKey]
    const visit = (node, level, loKey) => {
        const n = t._count[node];
        if (node !== t._root && n === 0) throw new Error('empty non-root node');
        if (packed && n > FILL && node !== t._root) throw new Error('packed node over FILL');

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxKey = -Infinity, prev = loKey;
        for (let i = 0; i < M; i++) {
            const s = node * M + i, p = s * 4;

            if (i >= n) {
                if (boxes[p] !== Infinity || boxes[p + 2] !== -Infinity || keys[s] !== MAX_KEY) throw new Error('unpadded slot');
                continue;
            }

            if (level === 0) {
                const id = ptrs[s], b = live.get(id);
                items++;
                if (t._slotOf[id] !== s) throw new Error('slotOf mismatch');
                if (!b || b[0] !== boxes[p] || b[1] !== boxes[p + 1] || b[2] !== boxes[p + 2] || b[3] !== boxes[p + 3]) throw new Error('stale or wrong box');
                if (keys[s] < loKey) throw new Error('leaf key below its range');
                if (packed && keys[s] !== t._key(b[0], b[1], b[2], b[3])) throw new Error('not re-keyed');
                if (packed && t._outside((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) throw new Error('center outside the domain');

            } else {
                const child = ptrs[s];
                if (t._parent[child] !== node) throw new Error('parent mismatch');
                const r = visit(child, level - 1, prev);
                const tight = exact || level > 1 || t._dirty[child] === 0; // only a marked leaf's entry may be stale
                if (tight && (r[0] !== boxes[p] || r[1] !== boxes[p + 1] || r[2] !== boxes[p + 2] || r[3] !== boxes[p + 3])) throw new Error('MBR not tight');
                if (tight ? r[4] !== keys[s] : r[4] > keys[s]) throw new Error('max key mismatch');
                if (keys[s] < prev) throw new Error('child keys out of order');
                prev = keys[s];
            }

            minX = Math.min(minX, boxes[p]);
            minY = Math.min(minY, boxes[p + 1]);
            maxX = Math.max(maxX, boxes[p + 2]);
            maxY = Math.max(maxY, boxes[p + 3]);
            maxKey = Math.max(maxKey, keys[s]);
        }
        return [minX, minY, maxX, maxY, maxKey];
    };

    if (!t._pending) visit(t._root, t._height - 1, -Infinity);
    else if (t._root !== 0 || t._numNodes !== 1 || t._height !== 1) throw new Error('pending tree with nodes');
    if (!t._pending && t._height === 1) throw new Error('built tree of one leaf');
    for (let s = t._pending ? t.size : M; s < M; s++) {
        if (boxes[s * 4] !== Infinity || boxes[s * 4 + 2] !== -Infinity) throw new Error('unpadded pending slot');
    }
    for (let s = 0, end = t._pending ? t.size : 0; s < end; s++) {
        const id = ptrs[s], b = live.get(id), p = s * 4;
        items++;
        if (t._slotOf[id] !== s) throw new Error('pending slotOf mismatch');
        if (!b || b[0] !== boxes[p] || b[1] !== boxes[p + 1] || b[2] !== boxes[p + 2] || b[3] !== boxes[p + 3]) throw new Error('wrong pending box');
    }
    if (items !== live.size) throw new Error(`item count ${items} vs ${live.size}`);
    if (t.size !== live.size) throw new Error(`size ${t.size} vs ${live.size}`);
    // the free list holds exactly the issued ids that aren't live, each once; ids never issued read DEAD
    const free = new Set();
    for (let id = t._freeId; id !== -1; id = (t._slotOf[id] & ~DEAD) - 1) {
        if (live.has(id) || free.has(id) || id >= t._nextId || t._slotOf[id] < DEAD) throw new Error('bad free list');
        free.add(id);
    }
    if (free.size + live.size !== t._nextId) throw new Error('removed ids missing from the free list');
    for (let id = t._nextId; id < t._slotOf.length; id++) if (t._slotOf[id] !== DEAD) throw new Error('unissued id not DEAD');

    if (t.size === 0 && !t._pending) throw new Error('empty tree not reset');

    if (exact) {
        if (t._pending && t.size > M) throw new Error('exact check in pending mode');
        if (t._numDirty !== 0) throw new Error('dirty list not empty');
        for (let i = 0; i < t._numNodes; i++) if (t._dirty[i] !== 0) throw new Error('node left dirty');
    }
}

for (let seed = 1; seed <= 12; seed++) {
    const rnd = mulberry32(seed);
    const t = new HTree();
    const live = new Map();
    const ids = [];
    const clustered = seed % 3 === 0, expanding = seed % 3 === 1;
    const ops = 12000;
    let rebuilds = 0, spread = 1000;

    const box = () => {
        const x = clustered ? 500 + rnd() * 3 : 500 + (rnd() - 0.5) * spread;
        const y = clustered ? 500 + rnd() * 3 : 500 + (rnd() - 0.5) * spread;
        return [x, y, x + rnd() * 5, y + rnd() * 5];
    };

    for (let op = 0; op < ops; op++) {
        if (expanding) spread = 2 ** (op / 600);
        // grow, churn, then drain towards empty
        const phase = op / ops;
        const pAdd = phase < 0.4 ? 0.6 : phase < 0.7 ? 0.3 : 0.05;
        const pRemove = phase < 0.4 ? 0.1 : phase < 0.7 ? 0.3 : 0.6;
        const r = rnd();

        if (r < pAdd || ids.length === 0) {
            const b = box(), id = t.add(b[0], b[1], b[2], b[3]);
            live.set(id, b);
            ids.push(id);

        } else {
            const k = Math.floor(rnd() * ids.length), id = ids[k];

            if (r < pAdd + pRemove) {
                t.remove(id);
                live.delete(id);
                ids[k] = ids[ids.length - 1];
                ids.pop();

            } else {
                let b;
                if (rnd() < 0.8) { // jitter
                    const o = live.get(id), dx = rnd() - 0.5, dy = rnd() - 0.5;
                    b = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy];
                } else { // teleport
                    b = box();
                }
                t.update(id, b[0], b[1], b[2], b[3]);
                live.set(id, b);

                const g = t.getBox(id);
                if (g[0] !== b[0] || g[1] !== b[1] || g[2] !== b[2] || g[3] !== b[3]) throw new Error('getBox mismatch');
            }
        }

        if (rnd() < 1 / 700) { // with in-place updates likely pending
            t.rebuild();
            check(t, live, t.size > M, t.size > M);
            rebuilds++;
        }

        if (op % 211 !== 0 && op !== ops - 1) continue;

        check(t, live, false);
        const packs = t._pending && t.size > M;
        if (!t._pending) {
            t._flush();
            check(t, live, true);
        }

        // query 0 is infinite on both sides, 1 is small, 2–3 are large
        for (let q = 0; q < 4; q++) {
            const qx = clustered ? 499 + rnd() * 4 : 500 + (rnd() - 0.5) * spread;
            const qy = clustered ? 499 + rnd() * 4 : 500 + (rnd() - 0.5) * spread;
            const qs = q === 0 ? Infinity : rnd() * (q < 2 ? 2 : 80) * Math.max(1, spread / 1000);
            const x0 = q === 0 ? -Infinity : qx;
            const y0 = q === 0 ? -Infinity : qy;
            const x1 = qx + qs, y1 = qy + qs;

            const got = t.search(x0, y0, x1, y1).sort((a, b) => a - b);
            const expected = [];
            for (const [id, b] of live) {
                if (x1 >= b[0] && y1 >= b[1] && x0 <= b[2] && y0 <= b[3]) expected.push(id);
            }
            expected.sort((a, b) => a - b);

            if (got.length !== expected.length || got.some((v, j) => v !== expected[j])) {
                throw new Error(`search mismatch seed ${seed} op ${op}: ${got.length} vs ${expected.length}`);
            }
            if (q === 0 && packs) check(t, live, true, true);
        }
    }

    while (ids.length) {
        const id = ids.pop();
        t.remove(id);
        live.delete(id);
    }
    check(t, live, false); // emptied: back in pending mode with a clean root
    if (t.search(-Infinity, -Infinity, Infinity, Infinity).length !== 0) throw new Error('not empty');
    t.rebuild();
    check(t, live, false);

    console.log(`seed ${seed} ok (${clustered ? 'clustered' : expanding ? 'expanding' : 'uniform'}; ` +
        `reinserted ${t.reinserted}, rebuilds ${rebuilds})`);
}

// rebuild at sizes around one leaf, one full internal level and the radix threshold, after removes and with
// in-place updates pending, then keep going on the packed tree
for (const n of [0, 1, 2, 15, 16, 17, 28, 29, 224, 225, 256, 257, 3137, 8191, 8192, 8193, 20000]) {
    const rnd = mulberry32(n + 1);
    const t = new HTree(n % 2 ? n : 0);
    const live = new Map();
    const box = () => {
        const x = rnd() * 1000, y = rnd() * 1000;
        return [x, y, x + rnd() * 5, y + rnd() * 5];
    };
    const query = () => {
        const x0 = rnd() * 1000, y0 = rnd() * 1000, x1 = x0 + rnd() * 80, y1 = y0 + rnd() * 80;
        const got = t.search(x0, y0, x1, y1).sort((a, b) => a - b);
        const expected = [];
        for (const [id, b] of live) if (x1 >= b[0] && y1 >= b[1] && x0 <= b[2] && y0 <= b[3]) expected.push(id);
        expected.sort((a, b) => a - b);
        if (got.length !== expected.length || got.some((v, j) => v !== expected[j])) throw new Error(`search mismatch at n ${n}`);
    };

    // n + 10% adds, then remove that many, so that some ids are dead; all of it pending (bulk build)
    const extra = Math.ceil(n / 10);
    for (let i = 0; i < n + extra; i++) {
        const b = box();
        live.set(t.add(b[0], b[1], b[2], b[3]), b);
    }
    for (let i = 0; i < extra; i++) {
        const id = Math.floor(rnd() * t._nextId);
        if (!live.has(id)) { i--; continue; }
        t.remove(id);
        live.delete(id);
    }
    for (const [id, o] of live) { // jitter everything, in place where it stays
        const dx = rnd() - 0.5, dy = rnd() - 0.5, b = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy];
        t.update(id, b[0], b[1], b[2], b[3]);
        live.set(id, b);
    }

    check(t, live, false);
    t.rebuild();
    check(t, live, n > 0, n > 0);
    t.rebuild(); // twice in a row, from a packed tree
    check(t, live, n > 0, n > 0);
    for (let q = 0; q < 20; q++) query();

    for (let i = 0; i < 2000; i++) {
        const r = rnd(), ids = [...live.keys()];
        if (r < 0.4 || ids.length === 0) {
            const b = box();
            live.set(t.add(b[0], b[1], b[2], b[3]), b);
        } else if (r < 0.7) {
            const id = ids[Math.floor(rnd() * ids.length)];
            t.remove(id);
            live.delete(id);
        } else {
            const id = ids[Math.floor(rnd() * ids.length)], b = rnd() < 0.5 ? box() : live.get(id).map(v => v + rnd() - 0.5);
            t.update(id, b[0], b[1], b[2], b[3]);
            live.set(id, b);
            const g = t.getBox(id);
            if (g.some((v, j) => v !== b[j])) throw new Error('getBox mismatch');
        }
        if (i === 1000) {
            check(t, live, false);
            query();
            if (t.size > 0) check(t, live, true);
        }
    }
    check(t, live, false);
    for (let q = 0; q < 20; q++) query();
    if (t.size > 0) check(t, live, true);
}
console.log('rebuild sizes ok');

// An item that moved far away must not stay in its leaf because something else wrote the leaf an exact entry first
// (which would cover the item's new box, so the flush would take it for one that never left): a remove from the
// leaf, a split of it, or a merge of a neighbor into it. In each case the flush has to insert the item again,
// which puts it in the leaf whose key range holds its key.
{
    const rnd = mulberry32(7);
    const fresh = () => {
        const t = new HTree();
        for (let i = 0; i < 5000; i++) t.add(rnd() * 100, rnd() * 100);
        t.search(0, 0, 0, 0); // packed: leaves are 14 full
        return t;
    };
    const leafOf = (t, id) => Math.floor(t._slotOf[id] / M);
    const itemsOf = (t, leaf) => Array.from(t._ptrs.subarray(leaf * M, leaf * M + t._count[leaf]));
    const settledFar = (t, id, what) => {
        t.search(0, 0, 0, 0);
        const e = t._entryOf(leafOf(t, id)), key = t._keys[t._slotOf[id]], b = t.getBox(id);
        if (key !== t._key(b[0], b[1], b[2], b[3]) || key > t._keys[e] || (e % M !== 0 && key <= t._keys[e - 1])) {
            throw new Error(`moved item kept in its leaf after ${what}`);
        }
    };
    // a leaf in the middle of its parent, and an item of it sent to the far corner
    const setup = () => {
        const t = fresh();
        let leaf = 0;
        while (t._entryOf(leaf) % M !== 5) leaf++;
        const [id, ...rest] = itemsOf(t, leaf);
        t.update(id, 900, 900);
        return {t, leaf, id, rest};
    };

    let s = setup();
    s.t.remove(s.rest[0]);
    settledFar(s.t, s.id, 'a remove from the leaf');

    s = setup();
    for (let i = 0; leafOf(s.t, s.rest[0]) === s.leaf && i < 4; i++) { // fill the leaf up and split it
        const b = s.t.getBox(s.rest[i % 2]);
        s.t.add(b[0], b[1]);
    }
    settledFar(s.t, s.id, 'a split of the leaf');

    s = setup();
    for (const k of [1, 2, 3, 4, 5, 6]) s.t.remove(s.rest[k]); // by hand below: the leaf can take a neighbor
    const neighbor = s.t._ptrs[s.t._entryOf(s.leaf) + 1];
    for (const id of itemsOf(s.t, neighbor).slice(0, 8)) s.t.remove(id); // the neighbor is underfull and looks for a target
    settledFar(s.t, s.id, 'a merge into the leaf');
    console.log('moved items ok');
}

// Ids: removed ones are reused last-in first-out, also across draining to empty; ids that aren't live throw
{
    const t = new HTree();
    const throws = (fn, what) => {
        try { fn(); } catch { return; }
        throw new Error(`no throw for ${what}`);
    };
    for (let i = 0; i < 100; i++) t.add(i, i);
    t.remove(10);
    t.remove(20);
    throws(() => t.remove(10), 'a removed id');
    throws(() => t.update(20, 0, 0), 'an update of a removed id');
    throws(() => t.getBox(10), 'getBox of a removed id');
    for (const id of [100, 5000, -1, 1.5, NaN, undefined]) throws(() => t.getBox(/** @type {any} */ (id)), `id ${id}`);
    if (t.add(1, 1) !== 20 || t.add(2, 2) !== 10 || t.add(3, 3) !== 100) throw new Error('ids not reused LIFO');
    if (t.search(0, 0, 3, 3).sort((a, b) => a - b).join() !== '0,1,2,3,10,20,100') throw new Error('reused ids misplaced');

    for (let id = 0; id <= 100; id++) t.remove(id); // drained: pending again, and the ids come back
    if (t.size !== 0 || !t._pending) throw new Error('not drained');
    if (t.add(5, 5) !== 100 || t.add(6, 6) !== 99) throw new Error('ids not reused after draining');
    if (t.search(5, 5, 6, 6).sort((a, b) => a - b).join() !== '99,100') throw new Error('reused ids lost');
    console.log('ids ok');
}

/**
 * Brute-force search check and a full structural check after a flush.
 * @param {any} t
 * @param {Map<number, number[]>} live
 * @param {() => number} rnd
 * @param {number} lo
 * @param {number} hi
 */
function verify(t, live, rnd, lo, hi) {
    check(t, live, false);
    for (let q = 0; q < 20; q++) {
        const x0 = lo + rnd() * (hi - lo), y0 = lo + rnd() * (hi - lo), w = rnd() * (hi - lo) / 10;
        const got = t.search(x0, y0, x0 + w, y0 + w).sort((a, b) => a - b);
        const expected = [];
        for (const [id, b] of live) if (x0 + w >= b[0] && y0 + w >= b[1] && x0 <= b[2] && y0 <= b[3]) expected.push(id);
        expected.sort((a, b) => a - b);
        if (got.join() !== expected.join()) throw new Error(`search mismatch in [${lo}, ${hi}]`);
    }
    // an infinite query is clamped to finite bounds, which don't reach boxes that lie entirely at infinity
    const all = [...live.values()].filter(b => b[0] < Infinity && b[1] < Infinity && b[2] > -Infinity && b[3] > -Infinity);
    if (t.search(-Infinity, -Infinity, Infinity, Infinity).length !== all.length) throw new Error('lost items');
    if (!t._pending) check(t, live, true);
}

// Domain growth maps every stored key to exactly the key its box gets in the grown domain, as long as the float math
// is exact: here the domain is held at dyadic bounds (rebuild and root splits don't refit it) and items sit at cell
// centers. Growth comes from adds and from updates through the flush, in all directions, by up to 2^30, so
// also past the 8 steps after which old keys collapse into one. An updated item that stayed in its leaf may keep its
// old key (see _evict), so it's skipped from then on unless the update grew the domain, which always takes it out.
{
    const rnd = mulberry32(11);
    let grown = 0;
    for (let round = 0; round < 24; round++) {
        const t = new HTree();
        t._pending = false;
        t._setDomain = () => {};
        Object.assign(t, {_minX: 0, _minY: 0, _side: 1024, _scale: 64});

        const live = new Map(), ids = [], kept = new Set();
        const cell = () => (Math.floor(rnd() * 65536) + 0.5) / 64;
        const far = () => (rnd() < 0.5 ? -1 : 1) * 1024 * 2 ** Math.floor(rnd() * (round < 12 ? 4 : 30)) + cell();
        const add = (x, y) => {
            const id = t.add(x, y);
            live.set(id, [x, y, x, y]);
            ids.push(id);
        };
        for (let i = 0; i < 2000; i++) add(cell(), cell());

        for (let step = 0; step < 8; step++) {
            const side = t._side, x = rnd() < 0.7 ? far() : cell(), y = rnd() < 0.7 ? far() : cell();
            if (step % 2) {
                add(x, y);
            } else {
                const id = ids[Math.floor(rnd() * ids.length)];
                t.update(id, x, y);
                live.set(id, [x, y, x, y]);
                t.search(0, 0, 0, 0);
                if (t._side === side) kept.add(id);
                else kept.delete(id);
            }
            if (t._side !== side) grown++;
            check(t, live, true);
            for (const [id, b] of live) {
                if (kept.has(id)) continue;
                if (t._keys[t._slotOf[id]] !== t._key(b[0], b[1], b[2], b[3])) throw new Error(`key not exact after growth (round ${round})`);
            }
        }
    }
    if (grown < 60) throw new Error(`domain grew only ${grown} times`);
}

// Degenerate starting domains: all centers in one point (at 0 and far from it), a few points, centers that aren't
// finite and huge coordinates; then data that spreads far beyond. Also a sweep in x, which grows the domain over
// and over while the tree grows.
{
    const rnd = mulberry32(5);
    const run = (name, first, then, lazy) => {
        const t = new HTree(), live = new Map();
        const add = b => live.set(t.add(b[0], b[1], b[2], b[3]), b);
        for (const b of first) {
            add(b);
            if (!lazy) t.search(0, 0, 0, 0);
        }
        t.search(0, 0, 0, 0);
        for (const b of then) add(b);
        let lo = Infinity, hi = -Infinity;
        for (const b of live.values()) for (const v of b) if (Number.isFinite(v)) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
        }
        verify(t, live, rnd, lo, hi);
        for (const [id, b] of live) if (rnd() < 0.3) { // move some back to the middle, through the flush
            const nb = [(lo + hi) / 2, (lo + hi) / 2, (lo + hi) / 2 + 1, (lo + hi) / 2 + 1];
            t.update(id, nb[0], nb[1], nb[2], nb[3]);
            live.set(id, nb);
            if (b[0] === lo) break;
        }
        verify(t, live, rnd, lo, hi);
        t.rebuild();
        verify(t, live, rnd, lo, hi);
        if (!(t._side < Infinity && t._side > 0)) throw new Error(`${name}: bad domain side ${t._side}`);
    };
    const pts = (n, f) => Array.from({length: n}, (_, i) => f(i));
    const spread = (n, r, c = 0) => pts(n, () => {
        const x = c + (rnd() - 0.5) * r, y = c + (rnd() - 0.5) * r;
        return [x, y, x, y];
    });

    for (const lazy of [false, true]) {
        run('one point at 0', pts(40, () => [0, 0, 0, 0]), spread(3000, 1e6), lazy);
        run('one point far from 0', pts(40, () => [1e9, -1e9, 1e9, -1e9]), spread(3000, 1e4, 1e9), lazy);
        run('a few points', spread(3, 1e-3), spread(3000, 1e3), lazy);
        run('two points then far', [[0, 0, 0, 0], [1, 1, 1, 1]], spread(3000, 2 ** 40), lazy);
        run('not finite', [[Infinity, 0, Infinity, 0], [-Infinity, -Infinity, Infinity, Infinity],
            ...spread(30, 10)], [...spread(3000, 1e5), [0, -Infinity, 0, 0], [1e308, 1e308, 1e308, 1e308]], lazy);
        run('huge', pts(20, () => [-1e308, -1e308, -1e308, -1e308]), [...spread(100, 1e300), [1e308, 1e308, 1e308, 1e308],
            ...spread(1000, 1e3)], lazy);
        run('sweep in x', [], pts(20000, i => [i * 0.01, rnd(), i * 0.01, rnd() + 1]), lazy);
    }

    // a pending update far out: the pack has to fit the domain to it too
    const t = new HTree(), live = new Map();
    for (let i = 0; i < 100; i++) {
        const x = rnd(), y = rnd();
        live.set(t.add(x, y), [x, y, x, y]);
    }
    t.update(5, 1e6, -1e6);
    live.set(5, [1e6, -1e6, 1e6, -1e6]);
    t.search(0, 0, 0, 0);
    check(t, live, true, true);
    console.log('domain ok');
}
