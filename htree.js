// A dynamic spatial index as a single B+-tree over Hilbert keys where every entry also carries a bounding box (a
// Hilbert R-tree, Kamel & Faloutsos), stored Flatbush-style in one flat typed-array arena.
//
// The arena is a sequence of fixed nodes of M slots. A slot holds a box, a key and a pointer: in a leaf, an item's
// box, its Hilbert key and its id; in an internal node, a child's MBR, the largest key below it and the child's
// node index. Leaves are unordered bags of items whose keys fall in one contiguous range; internal nodes keep their
// children ordered by key. Unused slots hold sentinel boxes (+∞ min / −∞ max: never match a query, no-ops in MBRs)
// and MAX_KEY, so search scans every node at full width with no counts.
//
// Not hardened yet: ids are not reused or validated, nodes are never merged on underflow, the arena grows by
// doubling, and the Hilbert domain is fixed at construction.

const M = 16;     // slots per node; the child pick in _insert is unrolled for this value
const HALF = M / 2;

const HILBERT_MAX = (1 << 16) - 1;

// Keys are the 32-bit Hilbert code shifted to 31 bits, in [-2^30, 2^30): every key is an SMI even with pointer
// compression, and a difference of two keys fits an int32, so its sign bit is the comparison.
const MAX_KEY = 0x3fffffff;

export default class HTree {
    /**
     * @param {[number, number, number, number]} [domain] Coordinate bounds [minX, minY, maxX, maxY] for the Hilbert grid.
     * @param {number} [initialNodes=64] Initial arena capacity in nodes.
     */
    constructor(domain = [0, 0, 1, 1], initialNodes = 64) {
        this.size = 0;                                   // number of live items
        this.inPlace = 0;                                // stats: updates that kept the item in its leaf

        const [minX, minY, maxX, maxY] = domain;
        this._minX = minX;
        this._minY = minY;
        this._scaleX = HILBERT_MAX / ((maxX - minX) || 1); // center → [0, HILBERT_MAX] grid
        this._scaleY = HILBERT_MAX / ((maxY - minY) || 1);

        this._capacity = initialNodes;
        this._boxes = new Float64Array(initialNodes * M * 4); // slot → item box (leaf) or child MBR (internal)
        this._keys = new Int32Array(initialNodes * M);        // slot → item key (leaf) or child's max key (internal)
        this._ptrs = new Uint32Array(initialNodes * M);       // slot → item id (leaf) or child node (internal)
        this._count = new Uint8Array(initialNodes);           // node → used slots
        this._parent = new Uint32Array(initialNodes);         // node → parent node
        this._numNodes = 0;                                   // nodes ever allocated (arena high-water mark)
        this._freeNodes = [];                                 // freed nodes, fully padded, reused by _alloc

        this._slotOf = new Uint32Array(1024);                 // id → leaf slot holding it (leaf node = slot / M)
        this._nextId = 0;

        this._height = 1;
        this._path = new Uint32Array(16);                     // level → slot taken by the last _insert descent
        this._splitKey = 0;                                   // largest key left in the lower half by _splitLeaf
        this._root = this._alloc();
    }

    /**
     * Add a box, returning its id.
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    add(minX, minY, maxX = minX, maxY = minY) {
        const id = this._nextId++;
        if (id === this._slotOf.length) this._slotOf = grow(this._slotOf, id * 2);
        this.size++;
        this._insert(id, this._key(minX, minY, maxX, maxY), minX, minY, maxX, maxY);
        return id;
    }

    /**
     * Remove an item by id.
     * @param {number} id
     */
    remove(id) {
        this._detach(id);
        this.size--;
    }

    /**
     * Change an item's box, keeping its id. The item stays in its leaf if the new key is still inside the leaf's
     * key range; otherwise it is detached and inserted again.
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    update(id, minX, minY, maxX = minX, maxY = minY) {
        const key = this._key(minX, minY, maxX, maxY);
        const keys = this._keys, ptrs = this._ptrs;
        const s = this._slotOf[id], leaf = Math.floor(s / M), base = leaf * M;

        let stay = leaf === this._root;
        let e = -1; // the leaf's entry in its parent
        if (!stay) {
            const pb = this._parent[leaf] * M;
            e = pb;
            while (ptrs[e] !== leaf) e++;

            if (key <= keys[e]) {
                if (e > pb) {
                    stay = key > keys[e - 1];
                } else { // first child: its lower bound lives further up, so settle for the leaf's own min key
                    let min = keys[base];
                    for (let i = base + 1, end = base + this._count[leaf]; i < end; i++) min = Math.min(min, keys[i]);
                    stay = key >= min;
                }
            }
        }

        if (!stay) {
            this._detach(id);
            this._insert(id, key, minX, minY, maxX, maxY);
            return;
        }

        // the leaf's entry can only change if the item was on its border (or held its max key) before the move,
        // or sticks out after it; otherwise nothing above needs a look
        const boxes = this._boxes, p = s * 4, q = e * 4;
        const inner = e >= 0 && keys[s] < keys[e] && key < keys[e] &&
            boxes[p] > boxes[q] && boxes[p + 1] > boxes[q + 1] && boxes[p + 2] < boxes[q + 2] && boxes[p + 3] < boxes[q + 3] &&
            minX > boxes[q] && minY > boxes[q + 1] && maxX < boxes[q + 2] && maxY < boxes[q + 3];

        keys[s] = key;
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        this.inPlace++;

        if (!inner) this._refit(leaf);
    }

    /**
     * Get an item's box as [minX, minY, maxX, maxY].
     * @param {number} id
     */
    getBox(id) {
        const s = this._slotOf[id];
        return Array.from(this._boxes.subarray(s * 4, s * 4 + 4));
    }

    /**
     * Find the ids of all items whose boxes intersect the query box.
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    search(minX, minY, maxX, maxY) {
        // infinite query bounds would match the sentinel boxes in unused slots
        minX = Math.max(minX, -Number.MAX_VALUE);
        minY = Math.max(minY, -Number.MAX_VALUE);
        maxX = Math.min(maxX, Number.MAX_VALUE);
        maxY = Math.min(maxY, Number.MAX_VALUE);

        const boxes = this._boxes, ptrs = this._ptrs;
        const results = [], queue = [];
        let node = this._root;
        let level = this._height - 1;

        while (true) {
            const end = (node + 1) * M * 4;

            for (let pos = node * M * 4; pos < end; pos += 4) {
                if (maxX < boxes[pos]) continue; // sentinels (minX = +∞) never match
                if (maxY < boxes[pos + 1]) continue;
                if (minX > boxes[pos + 2]) continue;
                if (minY > boxes[pos + 3]) continue;

                const ptr = ptrs[pos >> 2];
                if (level > 0) queue.push(ptr * 16 + level - 1); // child node and its level in one number
                else results.push(ptr);
            }

            if (queue.length === 0) break;
            const next = /** @type {number} */ (queue.pop());
            node = next >> 4;
            level = next & 15;
        }

        return results;
    }

    /** Bytes taken by allocated nodes and the id map (not counting arena slack). */
    bytes() {
        return this._numNodes * (M * (32 + 4 + 4) + 1 + 4) + this._nextId * 4;
    }

    /**
     * Walk down to the leaf whose key range takes `key`, growing boxes and max keys on the way, and append the item
     * there, splitting the leaf (and up the tree) if it's full.
     * @param {number} id
     * @param {number} key
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    _insert(id, key, minX, minY, maxX, maxY) {
        const boxes = this._boxes, keys = this._keys, ptrs = this._ptrs, count = this._count, path = this._path;

        // at each level take the first child whose max key is ≥ the new key: its rank among the child keys,
        // as a branch-free sum of sign bits (unused slots hold MAX_KEY, so they never count)
        let node = this._root;
        for (let level = this._height - 1; level > 0; level--) {
            const b = node * M, n = count[node];
            let s =
                ((keys[b] - key) >>> 31) + ((keys[b + 1] - key) >>> 31) +
                ((keys[b + 2] - key) >>> 31) + ((keys[b + 3] - key) >>> 31) +
                ((keys[b + 4] - key) >>> 31) + ((keys[b + 5] - key) >>> 31) +
                ((keys[b + 6] - key) >>> 31) + ((keys[b + 7] - key) >>> 31) +
                ((keys[b + 8] - key) >>> 31) + ((keys[b + 9] - key) >>> 31) +
                ((keys[b + 10] - key) >>> 31) + ((keys[b + 11] - key) >>> 31) +
                ((keys[b + 12] - key) >>> 31) + ((keys[b + 13] - key) >>> 31) +
                ((keys[b + 14] - key) >>> 31);
            if (s >= n) s = n - 1; // past the last child's max key: extend the last child
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

        let leaf = node, sibling = -1;
        if (count[node] === M) {
            sibling = this._splitLeaf(node);
            if (key > this._splitKey) leaf = sibling;
        }

        // a split may have reallocated the arena
        const s = leaf * M + this._count[leaf]++, p = s * 4, nb = this._boxes;
        this._keys[s] = key;
        this._ptrs[s] = id;
        nb[p] = minX;
        nb[p + 1] = minY;
        nb[p + 2] = maxX;
        nb[p + 3] = maxY;
        this._slotOf[id] = s;

        // parent entries are computed once the item has landed
        if (sibling !== -1) this._addSibling(node, sibling);
    }

    /**
     * Move the upper half (by key) of a full leaf into a new leaf and return it; the largest key left in the lower
     * half goes to _splitKey. Leaves are unordered, so nothing is sorted: each entry is ranked among the M keys
     * (ties by slot) with sign-bit sums, and moves at most once.
     * @param {number} leaf
     */
    _splitLeaf(leaf) {
        const sibling = this._alloc();
        const keys = this._keys, ptrs = this._ptrs, slotOf = this._slotOf;
        const base = leaf * M;

        let upper = 0; // bit i set: slot i moves to the sibling
        for (let i = 0; i < M; i++) {
            const k = keys[base + i];
            let rank = i;
            for (let j = 0; j < i; j++) rank -= (k - keys[base + j]) >>> 31;
            for (let j = i + 1; j < M; j++) rank += (keys[base + j] - k) >>> 31;
            if (rank === HALF - 1) this._splitKey = k;
            if (rank >= HALF) upper |= 1 << i;
        }

        let to = sibling * M;
        for (let i = 0; i < M; i++) {
            if ((upper & (1 << i)) === 0) continue;
            slotOf[ptrs[base + i]] = to;
            this._copy(base + i, to++);
        }

        // fill the holes in the lower slots with the stayers from the upper slots
        for (let i = 0, j = HALF; i < HALF; i++) {
            if ((upper & (1 << i)) === 0) continue;
            while ((upper & (1 << j)) !== 0) j++;
            slotOf[ptrs[base + j]] = base + i;
            this._copy(base + j++, base + i);
        }

        this._pad(base + HALF, base + M);
        this._count[leaf] = HALF;
        this._count[sibling] = HALF;
        return sibling;
    }

    /**
     * After `node` split into (`node`, `sibling`), rewrite node's entry in the parent and insert the sibling's entry
     * right after it, splitting full parents up to a new root. Relies on _path from the descent that led here.
     * @param {number} node
     * @param {number} sibling
     */
    _addSibling(node, sibling) {
        // _alloc may grow the arena, so arrays are read from `this` rather than cached
        for (let level = 1; ; level++) {
            if (level === this._height) { // the root split: grow a new root above both halves
                const root = this._alloc();
                this._setEntry(root * M, node);
                this._setEntry(root * M + 1, sibling);
                this._count[root] = 2;
                this._parent[node] = root;
                this._parent[sibling] = root;
                this._root = root;
                this._height++;
                return;
            }

            let s = this._path[level];
            const p = Math.floor(s / M);
            this._setEntry(s, node);

            // a full parent splits too; internal entries are ordered, so the upper half moves as is
            let split = -1;
            if (this._count[p] === M) {
                split = this._alloc();
                const from = p * M + HALF, to = split * M, ptrs = this._ptrs;
                for (let i = 0; i < HALF; i++) {
                    this._copy(from + i, to + i);
                    this._parent[ptrs[to + i]] = split;
                }
                this._pad(from, p * M + M);
                this._count[p] = HALF;
                this._count[split] = HALF;
                if (s >= from) s += to - from; // node's entry moved along
            }

            // shift the entries after node's one to make room for the sibling's
            const host = Math.floor(s / M), at = s + 1;
            for (let i = host * M + this._count[host]; i > at; i--) this._copy(i - 1, i);
            this._setEntry(at, sibling);
            this._parent[sibling] = host;
            this._count[host]++;

            if (split === -1) return;
            node = p;
            sibling = split;
        }
    }

    /**
     * Take an item out of its leaf (swap-remove) and tighten the entries above.
     * @param {number} id
     */
    _detach(id) {
        const s = this._slotOf[id], leaf = Math.floor(s / M);
        const last = leaf * M + --this._count[leaf];

        if (s !== last) {
            this._slotOf[this._ptrs[last]] = s;
            this._copy(last, s);
        }
        this._pad(last, last + 1);

        this._refit(leaf);
    }

    /**
     * Recompute exact parent entries from `node` upward until one comes out unchanged. Emptied nodes are unlinked
     * from their parents and freed.
     * @param {number} node
     */
    _refit(node) {
        const parent = this._parent, count = this._count, ptrs = this._ptrs;

        while (node !== this._root) {
            const p = parent[node];
            let s = p * M;
            while (ptrs[s] !== node) s++;

            if (count[node] === 0) {
                const last = p * M + --count[p];
                for (let i = s; i < last; i++) this._copy(i + 1, i);
                this._pad(last, last + 1);
                this._freeNodes.push(node);

            } else if (!this._setEntry(s, node)) {
                return;
            }
            node = p;
        }

        if (count[node] === 0) this._height = 1; // an emptied root is a valid empty leaf (fully padded)
    }

    /**
     * Write the entry for `child` (its exact MBR and max key) into slot `s`. Returns false if it was already exact.
     * @param {number} s
     * @param {number} child
     */
    _setEntry(s, child) {
        const boxes = this._boxes, keys = this._keys;
        const start = child * M, end = start + this._count[child];

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxKey = -MAX_KEY - 1;
        for (let i = start; i < end; i++) {
            const p = i * 4;
            minX = Math.min(minX, boxes[p]); // branchy min/max mispredicts here
            minY = Math.min(minY, boxes[p + 1]);
            maxX = Math.max(maxX, boxes[p + 2]);
            maxY = Math.max(maxY, boxes[p + 3]);
            maxKey = Math.max(maxKey, keys[i]);
        }

        this._ptrs[s] = child;
        const p = s * 4;
        if (boxes[p] === minX && boxes[p + 1] === minY && boxes[p + 2] === maxX && boxes[p + 3] === maxY &&
            keys[s] === maxKey) return false;

        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        keys[s] = maxKey;
        return true;
    }

    /**
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    _key(minX, minY, maxX, maxY) {
        // clamp as floats before `| 0`: out-of-range values would wrap around int32
        const x = clamp(this._scaleX * ((minX + maxX) / 2 - this._minX)) | 0;
        const y = clamp(this._scaleY * ((minY + maxY) / 2 - this._minY)) | 0;
        return hilbert(x, y) >> 1;
    }

    /** Take a free node or a new one from the arena (doubling it when full); returns it fully padded. */
    _alloc() {
        if (this._freeNodes.length > 0) return /** @type {number} */ (this._freeNodes.pop());

        if (this._numNodes === this._capacity) {
            const capacity = this._capacity *= 2;
            this._boxes = grow(this._boxes, capacity * M * 4);
            this._keys = grow(this._keys, capacity * M);
            this._ptrs = grow(this._ptrs, capacity * M);
            this._count = grow(this._count, capacity);
            this._parent = grow(this._parent, capacity);
        }

        const node = this._numNodes++;
        this._pad(node * M, node * M + M);
        return node;
    }

    /**
     * Fill slots [start, end) with sentinel boxes and MAX_KEY.
     * @param {number} start
     * @param {number} end
     */
    _pad(start, end) {
        const boxes = this._boxes, keys = this._keys;
        for (let s = start; s < end; s++) {
            const p = s * 4;
            keys[s] = MAX_KEY;
            boxes[p] = Infinity;
            boxes[p + 1] = Infinity;
            boxes[p + 2] = -Infinity;
            boxes[p + 3] = -Infinity;
        }
    }

    /**
     * Copy slot `from` (box, key and pointer) into slot `to`.
     * @param {number} from
     * @param {number} to
     */
    _copy(from, to) {
        const boxes = this._boxes, f = from * 4, t = to * 4;
        this._keys[to] = this._keys[from];
        this._ptrs[to] = this._ptrs[from];
        boxes[t] = boxes[f];
        boxes[t + 1] = boxes[f + 1];
        boxes[t + 2] = boxes[f + 2];
        boxes[t + 3] = boxes[f + 3];
    }
}

/**
 * Copy a typed array into a new one of the same type and the given length.
 * @template {Float64Array | Int32Array | Uint32Array | Uint8Array} T
 * @param {T} arr
 * @param {number} length
 * @returns {T}
 */
function grow(arr, length) {
    const result = /** @type {T} */ (new /** @type {any} */ (arr.constructor)(length));
    result.set(arr);
    return result;
}

/** @param {number} v */
function clamp(v) {
    return v < 0 ? 0 : v > HILBERT_MAX ? HILBERT_MAX : v;
}

/**
 * Fast Hilbert curve algorithm by http://threadlocalmutex.com/
 * Ported from C++ https://github.com/rawrunprotected/hilbert_curves (public domain)
 * @param {number} x
 * @param {number} y
 */
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

    // biased into signed int32 order: an unsigned code above 2^31 would be a heap number, ~5% slower inserts
    return ((b << 1) | a) ^ 0x80000000;
}
