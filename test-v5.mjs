// Quick correctness check for RBush v5 range search vs a brute-force loop.
import RBush from './index-v5.js';

const W = 1000;
function randBox() {
    const x = Math.random() * W, y = Math.random() * W, w = Math.random() * 20, h = Math.random() * 20;
    return [x, y, x + w, y + h];
}
function intersects(b, q) {
    return !(q[2] < b[0] || q[3] < b[1] || q[0] > b[2] || q[1] > b[3]);
}

function run(N, B) {
    const tree = new RBush([0, 0, W, W], B);
    const items = [];
    for (let i = 0; i < N; i++) {
        const b = randBox();
        const id = tree.add(b[0], b[1], b[2], b[3]);
        if (id !== i) throw new Error(`id mismatch: ${id} !== ${i}`);
        items.push(b);
    }

    let fails = 0;
    for (let t = 0; t < 200; t++) {
        const q = randBox();
        const got = tree.search(q[0], q[1], q[2], q[3]).sort((a, b) => a - b);
        const want = [];
        for (let i = 0; i < N; i++) if (intersects(items[i], q)) want.push(i);
        if (got.length !== want.length || got.some((v, k) => v !== want[k])) {
            fails++;
            if (fails <= 3) console.log(`  FAIL q=${q} got ${got.length} want ${want.length}`);
        }
    }
    const blocks = tree._blocks.filter(Boolean).length;
    console.log(`N=${N} B=${B}: ${fails === 0 ? 'OK' : fails + ' FAILS'} (${blocks} blocks, buffer ${tree._n})`);
}

run(50, 256);     // buffer-only, no blocks
run(256, 256);    // exactly one flush
run(1000, 256);   // cascade + buffer remainder
run(5000, 64);    // several levels
run(10000, 16);   // many levels, small nodeSize edge
console.log('done');
