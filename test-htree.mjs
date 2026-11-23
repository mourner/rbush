// Seeded fuzz: random add / remove / update (jitter + teleport) against brute force, plus white-box invariants
// (padded unused slots, leafOf and parent links, tight MBRs, exact max keys, key order).
import HTree from './htree.js';

const M = 16;
const MAX_KEY = 0x3fffffff;

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
 */
function check(t, live) {
    const boxes = t._boxes, keys = t._keys, ptrs = t._ptrs;
    let items = 0;

    // returns the node's actual [minX, minY, maxX, maxY, maxKey]
    const visit = (node, level, loKey) => {
        const n = t._count[node];
        if (node !== t._root && n === 0) throw new Error('empty non-root node');

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
                if (t._leafOf[id] !== node) throw new Error('leafOf mismatch');
                if (!b || b[0] !== boxes[p] || b[1] !== boxes[p + 1] || b[2] !== boxes[p + 2] || b[3] !== boxes[p + 3]) throw new Error('stale or wrong box');
                if (keys[s] < loKey) throw new Error('leaf key below its range');

            } else {
                const child = ptrs[s];
                if (t._parent[child] !== node) throw new Error('parent mismatch');
                const r = visit(child, level - 1, prev);
                if (r[0] !== boxes[p] || r[1] !== boxes[p + 1] || r[2] !== boxes[p + 2] || r[3] !== boxes[p + 3]) throw new Error('MBR not tight');
                if (r[4] !== keys[s]) throw new Error('max key mismatch');
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

    visit(t._root, t._height - 1, -Infinity);
    if (items !== live.size) throw new Error(`item count ${items} vs ${live.size}`);
}

for (let seed = 1; seed <= 12; seed++) {
    const rnd = mulberry32(seed);
    const t = new HTree([0, 0, 1000, 1000]);
    const live = new Map();
    const ids = [];
    const clustered = seed % 3 === 0;
    const ops = 12000;

    // some boxes fall outside the domain
    const box = () => {
        const x = clustered ? 500 + rnd() * 3 : rnd() * 1100 - 50;
        const y = clustered ? 500 + rnd() * 3 : rnd() * 1100 - 50;
        return [x, y, x + rnd() * 5, y + rnd() * 5];
    };

    for (let op = 0; op < ops; op++) {
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

        if (op % 211 !== 0 && op !== ops - 1) continue;

        check(t, live);

        // query 0 is infinite on both sides, 1 is small, 2–3 are large
        for (let q = 0; q < 4; q++) {
            const qx = clustered ? 499 + rnd() * 4 : rnd() * 1000;
            const qy = clustered ? 499 + rnd() * 4 : rnd() * 1000;
            const qs = q === 0 ? Infinity : rnd() * (q < 2 ? 2 : 80);
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
        }
    }

    while (ids.length) {
        const id = ids.pop();
        t.remove(id);
        live.delete(id);
    }
    check(t, live);
    if (t.search(-Infinity, -Infinity, Infinity, Infinity).length !== 0) throw new Error('not empty');

    console.log(`seed ${seed} ok (${clustered ? 'clustered' : 'uniform'}; peak nodes ${t._numNodes}, in-place updates ${t.inPlace})`);
}
