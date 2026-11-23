// seeded fuzz: random add / remove / update (jitter + teleport) vs brute force, plus structural invariants
import HTree from './htree.js';
const M = 16;
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function check(t, live) {
    let items = 0;
    const visit = (node, level, loKey) => { // returns [minX, minY, maxX, maxY, maxKey]
        const n = t.count[node];
        if (node !== t.root && n === 0) throw new Error('empty non-root node');
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxKey = -Infinity, prev = loKey;
        for (let i = 0; i < M; i++) {
            const s = node * M + i, p = s * 4;
            if (i >= n) { if (t.boxes[p] !== Infinity || t.boxes[p + 2] !== -Infinity || t.keys[s] !== 0x3fffffff) throw new Error('unpadded slot'); continue; }
            if (level === 0) {
                const id = t.ptrs[s];
                items++;
                if (t.leafOf[id] !== node) throw new Error('leafOf mismatch');
                const b = live.get(id);
                if (!b || b[0] !== t.boxes[p] || b[1] !== t.boxes[p + 1] || b[2] !== t.boxes[p + 2] || b[3] !== t.boxes[p + 3]) throw new Error('stale or wrong box');
                if (t.keys[s] < loKey) throw new Error('leaf key below its range');
            } else {
                const child = t.ptrs[s];
                if (t.parent[child] !== node) throw new Error('parent mismatch');
                const r = visit(child, level - 1, prev);
                if (r[0] !== t.boxes[p] || r[1] !== t.boxes[p + 1] || r[2] !== t.boxes[p + 2] || r[3] !== t.boxes[p + 3]) throw new Error('MBR not tight');
                if (r[4] !== t.keys[s]) throw new Error('max key mismatch');
                if (t.keys[s] < prev) throw new Error('child keys out of order');
                prev = t.keys[s];
            }
            minX = Math.min(minX, t.boxes[p]); minY = Math.min(minY, t.boxes[p + 1]);
            maxX = Math.max(maxX, t.boxes[p + 2]); maxY = Math.max(maxY, t.boxes[p + 3]);
            maxKey = Math.max(maxKey, t.keys[s]);
        }
        return [minX, minY, maxX, maxY, maxKey];
    };
    visit(t.root, t.height - 1, -Infinity);
    if (items !== live.size) throw new Error(`item count ${items} vs ${live.size}`);
}

for (let seed = 1; seed <= 12; seed++) {
    const rnd = mulberry32(seed), t = new HTree([0, 0, 1000, 1000]), live = new Map();
    const clustered = seed % 3 === 0, ops = 12000;
    const box = () => {
        const x = clustered ? 500 + rnd() * 3 : rnd() * 1100 - 50, y = clustered ? 500 + rnd() * 3 : rnd() * 1100 - 50;
        return [x, y, x + rnd() * 5, y + rnd() * 5];
    };
    const ids = [];
    for (let op = 0; op < ops; op++) {
        const r = rnd(), phase = op / ops; // grow, churn, then drain to empty
        const pAdd = phase < 0.4 ? 0.6 : phase < 0.7 ? 0.3 : 0.05, pRemove = phase < 0.4 ? 0.1 : phase < 0.7 ? 0.3 : 0.6;
        if (r < pAdd || ids.length === 0) {
            const b = box(), id = t.add(...b);
            live.set(id, b); ids.push(id);
        } else {
            const k = Math.floor(rnd() * ids.length), id = ids[k];
            if (r < pAdd + pRemove) {
                t.remove(id); live.delete(id);
                ids[k] = ids[ids.length - 1]; ids.pop();
            } else {
                let b;
                if (rnd() < 0.8) {
                    const o = live.get(id), dx = rnd() - 0.5, dy = rnd() - 0.5;
                    b = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy];
                } else {
                    b = box();
                }
                t.update(id, ...b); live.set(id, b);
                const g = t.getBox(id);
                if (g[0] !== b[0] || g[3] !== b[3]) throw new Error('getBox mismatch');
            }
        }
        if (op % 211 === 0 || op === ops - 1) {
            check(t, live);
            for (let q = 0; q < 4; q++) {
                const qx = clustered ? 499 + rnd() * 4 : rnd() * 1000, qy = clustered ? 499 + rnd() * 4 : rnd() * 1000, qs = q === 0 ? Infinity : rnd() * (q < 2 ? 2 : 80);
                const x0 = q === 0 ? -Infinity : qx, y0 = q === 0 ? -Infinity : qy;
                const got = t.search(Math.max(x0, -Number.MAX_VALUE), Math.max(y0, -Number.MAX_VALUE), Math.min(qx + qs, Number.MAX_VALUE), Math.min(qy + qs, Number.MAX_VALUE)).sort((a, b) => a - b);
                const exp = [];
                for (const [id, b] of live) if (!(qx + qs < b[0] || qy + qs < b[1] || x0 > b[2] || y0 > b[3])) exp.push(id);
                exp.sort((a, b) => a - b);
                if (got.length !== exp.length || got.some((v, j) => v !== exp[j])) throw new Error(`search mismatch seed ${seed} op ${op}: ${got.length} vs ${exp.length}`);
            }
        }
    }
    while (ids.length) { const id = ids.pop(); t.remove(id); live.delete(id); }
    check(t, live);
    if (t.search(-1e9, -1e9, 1e9, 1e9).length !== 0) throw new Error('not empty');
    console.log(`seed ${seed} ok (${clustered ? 'clustered' : 'uniform'}; peak nodes ${t.numNodes}, in-place updates ${t.inPlace})`);
}
