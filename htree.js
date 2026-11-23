// Prototype of a single-tree alternative to the block cascade in index-v5.js: a B+-tree over Hilbert keys where every
// entry also carries a bounding box (a Hilbert R-tree). Flat typed-array arena, fixed nodes of M slots; unused slots
// hold sentinel boxes (never match a query, no-ops in MBRs) and MAX_KEY keys. Leaves are unordered bags covering a
// contiguous key range; internal nodes are ordered by their children's max keys. Not tuned or hardened: ids are not
// reused, nodes are never merged on underflow, and the arena grows by doubling.
const M = 16, H = M / 2, HILBERT_MAX = (1 << 16) - 1, MAX_KEY = 0x3fffffff; // keys are 31-bit, so a key difference fits int32 and its sign bit is the comparison

export default class HTree {
    constructor(domain = [0, 0, 1, 1], cap = 64) {
        const [minX, minY, maxX, maxY] = domain;
        this._minX = minX; this._minY = minY;
        this._scaleX = HILBERT_MAX / (maxX - minX); this._scaleY = HILBERT_MAX / (maxY - minY);
        this.cap = cap;
        this.boxes = new Float64Array(cap * M * 4); // slot → box (leaf: item box, internal: child MBR)
        this.keys = new Int32Array(cap * M);        // slot → Hilbert key (leaf: item key, internal: child's max key)
        this.ptrs = new Uint32Array(cap * M);       // slot → item id (leaf) or child node (internal)
        this.count = new Uint8Array(cap);           // node → used slots
        this.parent = new Uint32Array(cap);         // node → parent node
        this.leafOf = new Uint32Array(1024);        // item id → leaf node holding it
        this.free = [];                             // freed nodes (fully padded), reused by _alloc
        this.numNodes = 0;
        this.nextId = 0;
        this.size = 0;
        this.height = 1;
        this.path = new Uint32Array(16);            // level → slot taken by the last descent
        this.inPlace = 0;                           // stats: updates done without moving the item
        this._a = 0; this._b = 0;
        this.root = this._alloc();
    }
    _alloc() {
        if (this.free.length > 0) return this.free.pop();
        if (this.numNodes === this.cap) {
            const cap = this.cap *= 2;
            const boxes = new Float64Array(cap * M * 4); boxes.set(this.boxes); this.boxes = boxes;
            const keys = new Int32Array(cap * M); keys.set(this.keys); this.keys = keys;
            const ptrs = new Uint32Array(cap * M); ptrs.set(this.ptrs); this.ptrs = ptrs;
            const count = new Uint8Array(cap); count.set(this.count); this.count = count;
            const parent = new Uint32Array(cap); parent.set(this.parent); this.parent = parent;
        }
        const node = this.numNodes++;
        this._pad(node * M, node * M + M);
        return node;
    }
    _pad(from, to) {
        const boxes = this.boxes, keys = this.keys;
        for (let s = from; s < to; s++) {
            const p = s * 4;
            keys[s] = MAX_KEY;
            boxes[p] = Infinity; boxes[p + 1] = Infinity; boxes[p + 2] = -Infinity; boxes[p + 3] = -Infinity;
        }
    }
    _copy(from, to) {
        const boxes = this.boxes, f = from * 4, t = to * 4;
        this.keys[to] = this.keys[from]; this.ptrs[to] = this.ptrs[from];
        boxes[t] = boxes[f]; boxes[t + 1] = boxes[f + 1]; boxes[t + 2] = boxes[f + 2]; boxes[t + 3] = boxes[f + 3];
    }
    _key(minX, minY, maxX, maxY) {
        const x = clamp(this._scaleX * ((minX + maxX) / 2 - this._minX)) | 0;
        const y = clamp(this._scaleY * ((minY + maxY) / 2 - this._minY)) | 0;
        return hilbert(x, y) >> 1;
    }
    add(minX, minY, maxX = minX, maxY = minY) {
        const id = this.nextId++;
        if (id === this.leafOf.length) { const l = new Uint32Array(id * 2); l.set(this.leafOf); this.leafOf = l; }
        this.size++;
        this._insert(id, this._key(minX, minY, maxX, maxY), minX, minY, maxX, maxY);
        return id;
    }
    _insert(id, key, minX, minY, maxX, maxY) {
        let boxes = this.boxes, keys = this.keys, ptrs = this.ptrs;
        const count = this.count, path = this.path;

        // walk down: at each level take the first child whose max key is ≥ the new key, growing its box on the way
        let node = this.root;
        for (let level = this.height - 1; level > 0; level--) {
            const b = node * M, c = count[node];
            // branch-free rank among the child keys (unused slots hold MAX_KEY, so they never count)
            let s = ((keys[b] - key) >>> 31) + ((keys[b + 1] - key) >>> 31) + ((keys[b + 2] - key) >>> 31) + ((keys[b + 3] - key) >>> 31) +
                ((keys[b + 4] - key) >>> 31) + ((keys[b + 5] - key) >>> 31) + ((keys[b + 6] - key) >>> 31) + ((keys[b + 7] - key) >>> 31) +
                ((keys[b + 8] - key) >>> 31) + ((keys[b + 9] - key) >>> 31) + ((keys[b + 10] - key) >>> 31) + ((keys[b + 11] - key) >>> 31) +
                ((keys[b + 12] - key) >>> 31) + ((keys[b + 13] - key) >>> 31) + ((keys[b + 14] - key) >>> 31);
            if (s >= c) s = c - 1;
            s += b;
            path[level] = s;
            const p = s * 4;
            if (minX < boxes[p]) boxes[p] = minX;
            if (minY < boxes[p + 1]) boxes[p + 1] = minY;
            if (maxX > boxes[p + 2]) boxes[p + 2] = maxX;
            if (maxY > boxes[p + 3]) boxes[p + 3] = maxY;
            if (key > keys[s]) keys[s] = key;
            node = ptrs[s];
        }
        const split = count[node] === M;
        if (split) { // may reallocate the arena
            node = this._splitLeaf(node, key);
            boxes = this.boxes; keys = this.keys; ptrs = this.ptrs;
        }
        const s = node * M + this.count[node]++, p = s * 4;
        keys[s] = key; ptrs[s] = id;
        boxes[p] = minX; boxes[p + 1] = minY; boxes[p + 2] = maxX; boxes[p + 3] = maxY;
        this.leafOf[id] = node;
        if (split) this._register(); // parent entries are computed once the item has landed
    }
    // move the upper half (by key) of a full leaf into a new leaf; returns the half the new key belongs to.
    // Leaves are unordered, so nothing is sorted: entries are ranked and each one moves at most once.
    _splitLeaf(node, key) {
        const base = node * M;
        const nn = this._alloc(), nb = nn * M, keys = this.keys, leafOf = this.leafOf, ptrs = this.ptrs;
        // rank of each key among the 16 (ties by slot), as sums of sign bits: no data-dependent branches
        let mask = 0, lowMax = 0, to = nb;
        for (let i = 0; i < M; i++) {
            const k = keys[base + i];
            let rank = i;
            for (let j = 0; j < i; j++) rank -= (k - keys[base + j]) >>> 31;
            for (let j = i + 1; j < M; j++) rank += (keys[base + j] - k) >>> 31;
            if (rank === H - 1) lowMax = k;
            if (rank >= H) mask |= 1 << i;
        }
        for (let i = 0; i < M; i++) {
            if ((mask & (1 << i)) === 0) continue;
            this._copy(base + i, to++);
            leafOf[ptrs[base + i]] = nn;
        }
        for (let h = 0, u = H; h < H; h++) { // fill the holes in the lower slots with the stayers from the upper slots
            if ((mask & (1 << h)) === 0) continue;
            while ((mask & (1 << u)) !== 0) u++;
            this._copy(base + u++, base + h);
        }
        this._pad(base + H, base + M);
        this.count[node] = H; this.count[nn] = H;
        this._a = node; this._b = nn;
        return key <= lowMax ? node : nn;
    }
    // write the entry for `child` (its exact MBR and max key) into slot s
    _setEntry(s, child) {
        const boxes = this.boxes, keys = this.keys, cb = child * M, n = this.count[child];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, k = -0x80000000;
        for (let i = cb; i < cb + n; i++) {
            const p = i * 4;
            minX = Math.min(minX, boxes[p]);
            minY = Math.min(minY, boxes[p + 1]);
            maxX = Math.max(maxX, boxes[p + 2]);
            maxY = Math.max(maxY, boxes[p + 3]);
            k = Math.max(k, keys[i]);
        }
        const p = s * 4;
        boxes[p] = minX; boxes[p + 1] = minY; boxes[p + 2] = maxX; boxes[p + 3] = maxY;
        keys[s] = k; this.ptrs[s] = child;
    }
    // after a child split into (a, b): rewrite a's parent entry and insert b's right after it, splitting upward
    _register() {
        let a = this._a, b = this._b, level = 1;
        while (true) {
            if (level === this.height) {
                const r = this._alloc();
                this._setEntry(r * M, a); this._setEntry(r * M + 1, b);
                this.count[r] = 2; this.parent[a] = r; this.parent[b] = r;
                this.root = r; this.height++;
                return;
            }
            let s = this.path[level];
            const p = s >> 4;
            this._setEntry(s, a);
            let pn = -1;
            if (this.count[p] === M) { // internal nodes are ordered, so the upper half moves as is
                pn = this._alloc();
                const from = p * M + H, to = pn * M, parent = this.parent, ptrs = this.ptrs;
                for (let i = 0; i < H; i++) { this._copy(from + i, to + i); parent[ptrs[to + i]] = pn; }
                this._pad(from, from + H);
                this.count[p] = H; this.count[pn] = H;
                if ((s & 15) >= H) s = to + (s & 15) - H; // a's entry moved along
            }
            const host = s >> 4, end = host * M + this.count[host], at = s + 1;
            for (let i = end; i > at; i--) this._copy(i - 1, i);
            this._setEntry(at, b);
            this.parent[b] = host;
            this.count[host]++;
            if (pn === -1) return;
            a = p; b = pn; level++;
        }
    }
    // take an item out of its leaf (swap-remove) and tighten the boxes above
    _detach(id) {
        const leaf = this.leafOf[id], base = leaf * M, last = base + --this.count[leaf], ptrs = this.ptrs;
        let i = base;
        while (ptrs[i] !== id) i++;
        if (i !== last) this._copy(last, i);
        this._pad(last, last + 1);
        this._refit(leaf);
    }
    // recompute exact parent entries from `node` upward until one is unchanged; empty nodes are unlinked and freed
    _refit(node) {
        const parent = this.parent, count = this.count, boxes = this.boxes, keys = this.keys, ptrs = this.ptrs;
        while (node !== this.root) {
            const par = parent[node];
            let s = par * M;
            while (ptrs[s] !== node) s++;
            if (count[node] === 0) {
                const end = par * M + --count[par];
                for (let i = s; i < end; i++) this._copy(i + 1, i);
                this._pad(end, end + 1);
                this.free.push(node);
                node = par;
                continue;
            }
            const cb = node * M * 4, n = count[node];
            let minX = boxes[cb], minY = boxes[cb + 1], maxX = boxes[cb + 2], maxY = boxes[cb + 3];
            for (let p = cb + 4, e = cb + M * 4; p < e; p += 4) { // unused slots are sentinels
                minX = Math.min(minX, boxes[p]);
                minY = Math.min(minY, boxes[p + 1]);
                maxX = Math.max(maxX, boxes[p + 2]);
                maxY = Math.max(maxY, boxes[p + 3]);
            }
            let k = keys[node * M];
            for (let i = node * M + 1, e = node * M + n; i < e; i++) k = Math.max(k, keys[i]);
            const p = s * 4;
            if (boxes[p] === minX && boxes[p + 1] === minY && boxes[p + 2] === maxX && boxes[p + 3] === maxY && keys[s] === k) return;
            boxes[p] = minX; boxes[p + 1] = minY; boxes[p + 2] = maxX; boxes[p + 3] = maxY;
            keys[s] = k;
            node = par;
        }
        if (count[node] === 0) this.height = 1; // an emptied root is a valid empty leaf (fully padded)
    }
    remove(id) {
        this._detach(id);
        this.size--;
    }
    update(id, minX, minY, maxX = minX, maxY = minY) {
        const key = this._key(minX, minY, maxX, maxY);
        const leaf = this.leafOf[id], keys = this.keys, ptrs = this.ptrs, base = leaf * M;
        // the item can stay put if its new key is still within the key range its leaf covers
        let stay = leaf === this.root, s = -1;
        if (!stay) {
            const pb = this.parent[leaf] * M;
            s = pb;
            while (ptrs[s] !== leaf) s++;
            if (key <= keys[s]) {
                if (s > pb) stay = key > keys[s - 1];
                else { // first child: its lower bound lives further up, so settle for the leaf's own min key
                    let min = keys[base];
                    for (let i = base + 1, e = base + this.count[leaf]; i < e; i++) if (keys[i] < min) min = keys[i];
                    stay = key >= min;
                }
            }
        }
        if (stay) {
            let i = base;
            while (ptrs[i] !== id) i++;
            const boxes = this.boxes, p = i * 4, e = s * 4;
            // the leaf's box and max key can only change if the item was on the border (or held the max key)
            // before the move, or sticks out after it; otherwise nothing above needs a look
            const inner = s >= 0 && keys[i] < keys[s] && key < keys[s] &&
                boxes[p] > boxes[e] && boxes[p + 1] > boxes[e + 1] && boxes[p + 2] < boxes[e + 2] && boxes[p + 3] < boxes[e + 3] &&
                minX > boxes[e] && minY > boxes[e + 1] && maxX < boxes[e + 2] && maxY < boxes[e + 3];
            keys[i] = key;
            boxes[p] = minX; boxes[p + 1] = minY; boxes[p + 2] = maxX; boxes[p + 3] = maxY;
            this.inPlace++;
            if (!inner) this._refit(leaf);
        } else {
            this._detach(id);
            this._insert(id, key, minX, minY, maxX, maxY);
        }
    }
    getBox(id) {
        const ptrs = this.ptrs;
        let i = this.leafOf[id] * M;
        while (ptrs[i] !== id) i++;
        return this.boxes.slice(i * 4, i * 4 + 4);
    }
    search(minX, minY, maxX, maxY) {
        const boxes = this.boxes, ptrs = this.ptrs, results = [], stack = [];
        let node = this.root, level = this.height - 1;
        while (true) {
            const base = node * (M * 4), end = base + M * 4;
            for (let pos = base; pos < end; pos += 4) {
                if (maxX < boxes[pos]) continue;
                if (maxY < boxes[pos + 1]) continue;
                if (minX > boxes[pos + 2]) continue;
                if (minY > boxes[pos + 3]) continue;
                const v = ptrs[pos >> 2];
                if (level > 0) stack.push(v * 16 + level - 1);
                else results.push(v);
            }
            if (stack.length === 0) break;
            const e = /** @type {number} */ (stack.pop());
            node = e >> 4; level = e & 15;
        }
        return results;
    }
    bytes() { return this.numNodes * (M * 32 + M * 4 + M * 4 + 1 + 4) + this.nextId * 4; }
}

function clamp(v) { return v < 0 ? 0 : v > HILBERT_MAX ? HILBERT_MAX : v; }

function hilbert(x, y) {
    let a = x ^ y;
    let b = 0xFFFF ^ a;
    let c = 0xFFFF ^ (x | y);
    let d = x & (y ^ 0xFFFF);

    let A = a | (b >> 1);
    let B = (a >> 1) ^ a;
    let C = c ^ ((c >> 1) ^ (b & (d >> 1)));
    let D = d ^ ((a & (c >> 1)) ^ (d >> 1));

    a = (A & (A >> 2)) ^ (B & (B >> 2));
    b = (A & (B >> 2)) ^ (B & ((A ^ B) >> 2));
    c = C ^ ((A & (C >> 2)) ^ (B & (D >> 2)));
    d = D ^ ((B & (C >> 2)) ^ ((A ^ B) & (D >> 2)));

    A = (a & (a >> 4)) ^ (b & (b >> 4));
    B = (a & (b >> 4)) ^ (b & ((a ^ b) >> 4));
    C = c ^ ((a & (c >> 4)) ^ (b & (d >> 4)));
    D = d ^ ((b & (c >> 4)) ^ ((a ^ b) & (d >> 4)));

    c = C ^ ((A & (C >> 8)) ^ (B & (D >> 8)));
    d = D ^ ((B & (C >> 8)) ^ ((A ^ B) & (D >> 8)));

    c ^= c >> 1;
    d ^= d >> 1;
    a = x ^ y;
    b = d | (0xFFFF ^ (a | c));

    a = (a | (a << 8)) & 0x00FF00FF;
    a = (a | (a << 4)) & 0x0F0F0F0F;
    a = (a | (a << 2)) & 0x33333333;
    a = (a | (a << 1)) & 0x55555555;

    b = (b | (b << 8)) & 0x00FF00FF;
    b = (b | (b << 4)) & 0x0F0F0F0F;
    b = (b | (b << 2)) & 0x33333333;
    b = (b | (b << 1)) & 0x55555555;

    // bias the unsigned 32-bit code into signed [-2^31, 2^31): full precision, and every key is an
    // SMI on 64-bit V8 so the sort/merge hot path compares tagged ints, not float64 (~7% faster inserts).
    // Monotonic, so the Hilbert ordering is unchanged. Stored in an Int32Array (see takeBlock).
    return (((b << 1) | a) >>> 0) - 0x80000000;
}
