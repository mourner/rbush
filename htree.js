// A dynamic spatial index as a single B+-tree over Hilbert keys where every entry also carries a bounding box (a
// Hilbert R-tree, Kamel & Faloutsos), stored Flatbush-style in one flat typed-array arena.
//
// The arena is a sequence of fixed nodes of M slots. A slot holds a box, a key and a pointer: in a leaf, an item's
// box, its Hilbert key and its id; in an internal node, a child's MBR, the largest key below it and the child's
// node index. Leaves are unordered bags of items whose keys fall in one contiguous range; internal nodes keep their
// children ordered by key. Unused slots hold sentinel boxes (+∞ min / −∞ max: never match a query, no-ops in MBRs)
// and MAX_KEY, so search scans every node at full width with no counts.
//
// In-place updates refit the entries above lazily, before the next search. While the tree is empty, and in
// pending mode generally, writes skip the tree: adds go to a run of slots past the last node, updates only rewrite
// the box, and the next search packs everything with rebuild.
//
// Not hardened yet: ids are not reused or validated, nodes are never merged on underflow, the arena grows by
// doubling, and the Hilbert domain is fixed at construction.

const M = 16;     // slots per node; the child pick in _insert is unrolled for this value
const HALF = M / 2;

const HILBERT_MAX = (1 << 16) - 1;

// Keys are the 32-bit Hilbert code shifted to 31 bits, in [-2^30, 2^30): every key is an SMI even with pointer
// compression, and a difference of two keys fits an int32, so its sign bit is the comparison.
const MAX_KEY = 0x3fffffff;

const DEAD = 0xffffffff; // slotOf value of a removed id

const FILL = 14;         // items per leaf and children per internal node written by rebuild, so inserts don't split at once
const RADIX_MIN = 8192;  // below this, filling the radix count table costs more than a quicksort

/** @type {Uint32Array | undefined} */
let radixCounts; // shared by all trees: 2^16 counts for the low key digit, 2^15 for the high one

export default class HTree {
    /**
     * @param {[number, number, number, number]} [domain] Coordinate bounds [minX, minY, maxX, maxY] for the Hilbert grid.
     * @param {number} [capacity=0] Number of items to reserve room for (see reserve).
     */
    constructor(domain = [0, 0, 1, 1], capacity = 0) {
        const initialNodes = Math.max(64, packedNodes(capacity));
        this.size = 0;                                   // number of live items
        this.inPlace = 0;                                // stats: updates that kept the item in its leaf

        const [minX, minY, maxX, maxY] = domain;
        this._minX = minX;
        this._minY = minY;
        // center → grid cell; 2^16 cells per axis rather than 2^16 − 1, so that each half of the domain maps
        // exactly to a half of the grid at every level (the max edge clamps into the last cell)
        this._scaleX = (HILBERT_MAX + 1) / ((maxX - minX) || 1);
        this._scaleY = (HILBERT_MAX + 1) / ((maxY - minY) || 1);

        this._capacity = initialNodes;
        this._boxes = new Float64Array(initialNodes * M * 4); // slot → item box (leaf) or child MBR (internal)
        this._keys = new Int32Array(initialNodes * M);        // slot → item key (leaf) or child's max key (internal)
        this._ptrs = new Uint32Array(initialNodes * M);       // slot → item id (leaf) or child node (internal)
        this._count = new Uint8Array(initialNodes);           // node → used slots
        this._parent = new Uint32Array(initialNodes);         // node → parent node
        // node → 1 + its level if its entry in the parent awaits a refit in _flush, else 0
        this._dirty = new Uint8Array(initialNodes);
        this._dirtyList = new Uint32Array(initialNodes);      // leaves marked in _dirty (may hold stale or repeat nodes)
        this._numDirty = 0;
        this._dirtyNext = new Uint32Array(initialNodes);      // _flush scratch: parents of the level being refit
        this._numNodes = 0;                                   // nodes ever allocated (arena high-water mark)
        this._freeNodes = [];                                 // freed nodes, fully padded, reused by _alloc

        this._slotOf = new Uint32Array(Math.max(1024, capacity)); // id → slot holding it (leaf or pending), or DEAD
        this._nextId = 0;
        this._scratch = new ArrayBuffer(0);                   // rebuild: sort pairs and radix buffer, kept between calls

        this._height = 1;
        this._path = new Uint32Array(16);                     // level → slot taken by the last _insert descent
        this._splitKey = 0;                                   // largest key left in the lower half by _splitLeaf
        this._root = this._alloc();

        // pending mode: pending items fill slots from node _pendingStart on, which stays past every allocated node
        this._pending = false;
        this._pendingStart = 0;
        this._numPending = 0;
        this._enterPending();
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
        if (this._pending) this._append(id, minX, minY, maxX, maxY);
        else this._insert(id, this._key(minX, minY, maxX, maxY), minX, minY, maxX, maxY);
        return id;
    }

    /**
     * Remove an item by id.
     * @param {number} id
     */
    remove(id) {
        const slotOf = this._slotOf, s = slotOf[id];
        if (!this._pending) {
            this._take(s);
            this._refit(Math.floor(s / M));
        } else if (s >= this._pendingStart * M) { // a pending item: the last pending one takes its slot
            const last = this._pendingStart * M + --this._numPending;
            if (s !== last) {
                slotOf[this._ptrs[last]] = s;
                this._copy(last, s);
            }
        } else {
            this._take(s); // the pack walks leaves by count and rewrites every entry
        }
        slotOf[id] = DEAD;
        if (--this.size === 0) this.rebuild(); // back to a clean empty root in pending mode
    }

    /**
     * Change an item's box, keeping its id. The item stays in its leaf if the new box fits inside the leaf's MBR
     * (keeping its old key) or the new key is still inside the leaf's key range; otherwise it is detached and
     * inserted again. Entries above a leaf changed in place are refit lazily, once per leaf before the next search.
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    update(id, minX, minY, maxX = minX, maxY = minY) {
        if (!this._pending) {
            this._update(id, minX, minY, maxX, maxY);
            return;
        }
        const boxes = this._boxes, p = this._slotOf[id] * 4; // the pack re-keys from the box, wherever the item is
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
    }

    /**
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    _update(id, minX, minY, maxX, maxY) {
        const keys = this._keys, boxes = this._boxes;
        const s = this._slotOf[id], p = s * 4;
        const leaf = Math.floor(s / M), base = leaf * M;

        let key = keys[s];
        if (leaf === this._root) {
            key = this._key(minX, minY, maxX, maxY);
        } else {
            const e = this._entryOf(leaf);

            // a box that fits inside the leaf's MBR stays with its old key: placement only needs a key inside the
            // leaf's range, not the key of the current box (a marked leaf's MBR may be stale, which only costs quality)
            const q = e * 4;
            let stay = minX >= boxes[q] && minY >= boxes[q + 1] && maxX <= boxes[q + 2] && maxY <= boxes[q + 3];

            if (!stay) {
                key = this._key(minX, minY, maxX, maxY);
                if (key <= keys[e]) {
                    if (e % M !== 0) {
                        stay = key > keys[e - 1];
                    } else { // first child: its lower bound lives further up, so settle for the leaf's own min key
                        let min = keys[base];
                        for (let i = base + 1, end = base + this._count[leaf]; i < end; i++) min = Math.min(min, keys[i]);
                        stay = key >= min;
                    }
                }
                if (!stay) {
                    // the entries above may stay too large until the flush; an emptied leaf is unlinked at once
                    this._take(s);
                    if (this._count[leaf] === 0) this._refit(leaf);
                    else this._mark(leaf);
                    this._insert(id, key, minX, minY, maxX, maxY);
                    return;
                }
            }
            this._mark(leaf);
        }

        keys[s] = key;
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        this.inPlace++;
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

        if (this._pending && this.size > 0) this.rebuild();
        else if (this._numDirty > 0) this._flush();

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

    /**
     * Rewrite the tree packed in key order, with items re-keyed from their current boxes: leaves and internal nodes
     * FILL / M full, laid out level by level from the start of the arena. Use it after a frame where most items
     * moved, or to restore fill and locality after heavy churn. Also packs pending items, ending pending mode
     * unless the tree is empty.
     */
    rebuild() {
        const n = this.size, slotOf = this._slotOf;

        // scratch: (key, source slot) pairs and the radix buffer for them; after the sort, the sorted ids take the
        // place of the keys and the radix buffer (grown to 16 bytes per item) holds two box columns at a time
        if (this._scratch.byteLength < n * 24) this._scratch = new ArrayBuffer(n * 24);
        const buf = this._scratch;
        const sortKeys = new Int32Array(buf, 0, n), from = new Uint32Array(buf, n * 4, n);
        const ids = new Uint32Array(buf, 0, n), cols = new Float64Array(buf, n * 8, n * 2);

        // walk the leaves rather than the ids: one cache miss per leaf instead of one per item
        let boxes = this._boxes, m = 0;
        const stack = [this._root * 16 + this._height - 1];
        while (stack.length > 0) {
            const next = /** @type {number} */ (stack.pop()), node = next >> 4, level = next & 15;
            const start = node * M, end = start + this._count[node];
            if (level > 0) {
                for (let s = start; s < end; s++) stack.push(this._ptrs[s] * 16 + level - 1);
                continue;
            }
            for (let s = start; s < end; s++, m++) {
                const p = s * 4;
                sortKeys[m] = this._key(boxes[p], boxes[p + 1], boxes[p + 2], boxes[p + 3]);
                from[m] = s;
            }
        }
        for (let s = this._pendingStart * M, end = s + this._numPending; s < end; s++, m++) {
            const p = s * 4;
            sortKeys[m] = this._key(boxes[p], boxes[p + 1], boxes[p + 2], boxes[p + 3]);
            from[m] = s;
        }
        if (n >= RADIX_MIN) {
            radixSort(sortKeys, from, new Int32Array(buf, n * 8, n), new Uint32Array(buf, n * 12, n), n);
        } else {
            quickSort(sortKeys, from, 0, n - 1);
        }

        // n ≤ M fits one leaf, which is then the root
        const numLeaves = n <= M ? 1 : Math.ceil(n / FILL), total = packedNodes(n);
        if (this._capacity < total) this._growArena(total); // exact: packed nodes leave room for inserts

        const keys = this._keys, ptrs = this._ptrs, count = this._count, parent = this._parent;
        boxes = this._boxes;

        // leaf i takes sorted items [⌊i·n / numLeaves⌋, ⌊(i + 1)·n / numLeaves⌋); every read of an old slot (ids
        // here, then each box column) goes before the writes of that array, so old and new slots can overlap anywhere
        for (let i = 0, j = 0; i < numLeaves; i++) {
            const end = Math.floor((i + 1) * n / numLeaves);
            for (let s = i * M; j < end; j++, s++) {
                keys[s] = sortKeys[j];
                ids[j] = ptrs[from[j]];
            }
        }
        // two columns per pass: a gathered box is one cache miss whether 8 or 16 bytes of it are read, and all four
        // would double the scratch for little more
        for (let c = 0; c < 4; c += 2) {
            for (let j = 0; j < n; j++) {
                const f = from[j] * 4 + c;
                cols[2 * j] = boxes[f];
                cols[2 * j + 1] = boxes[f + 1];
            }
            for (let i = 0, j = 0; i < numLeaves; i++) {
                const end = Math.floor((i + 1) * n / numLeaves);
                for (let p = i * M * 4 + c; j < end; j++, p += 4) {
                    boxes[p] = cols[2 * j];
                    boxes[p + 1] = cols[2 * j + 1];
                }
            }
        }
        for (let i = 0, j = 0; i < numLeaves; i++) {
            const base = i * M, end = Math.floor((i + 1) * n / numLeaves);
            count[i] = end - j;
            for (let s = base; j < end; j++, s++) {
                const id = ids[j];
                ptrs[s] = id;
                slotOf[id] = s;
            }
            this._pad(base + count[i], base + M);
        }

        // internal levels, each right after the one below
        let lo = 0, num = numLeaves, height = 1;
        while (num > 1) {
            const up = lo + num, numUp = num <= M ? 1 : Math.ceil(num / FILL);
            for (let k = 0, c = 0; k < numUp; k++) {
                const node = up + k, base = node * M, end = Math.floor((k + 1) * num / numUp);
                count[node] = end - c;
                for (let s = base; c < end; c++, s++) {
                    this._setEntry(s, lo + c);
                    parent[lo + c] = node;
                }
                this._pad(base + count[node], base + M);
            }
            lo = up;
            num = numUp;
            height++;
        }

        this._dirty.fill(0, 0, this._numNodes);
        this._numDirty = 0;
        this._numNodes = total;
        this._freeNodes.length = 0;
        this._root = lo;
        this._height = height;

        this._pending = false;
        this._numPending = 0;
        if (n === 0) this._enterPending();
    }

    /**
     * Make room for `n` items in total without growing the arena or the id map again, in the space a packed tree
     * of `n` items takes. Use it before a large batch of adds.
     * @param {number} n
     */
    reserve(n) {
        const nodes = packedNodes(n), ids = this._nextId + n - this.size;
        if (this._capacity < nodes) this._growArena(nodes);
        if (this._slotOf.length < ids) this._slotOf = grow(this._slotOf, ids);
    }

    /** Bytes taken by allocated nodes and the id map (not counting arena slack). */
    bytes() {
        return (this._numNodes + Math.ceil(this._numPending / M)) * (M * (32 + 4 + 4) + 1 + 4) + this._nextId * 4;
    }

    /** Switch to pending mode: until the next search or rebuild, writes skip the tree (see add, update, remove). */
    _enterPending() {
        if (this._pending) return;
        this._pending = true;
        this._pendingStart = this._numNodes;
        this._numPending = 0;
    }

    /**
     * Put an item in the next pending slot.
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    _append(id, minX, minY, maxX, maxY) {
        const s = this._pendingStart * M + this._numPending++;
        if (s === this._capacity * M) this._growArena();
        const p = s * 4, boxes = this._boxes;
        this._ptrs[s] = id;
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        this._slotOf[id] = s;
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
     * Refit the entries of leaves marked by updates (in place, or moving an item out), then the entries of all their
     * ancestors, level by level, each node once.
     *
     * Between flushes the entries above a marked leaf may be stale: its box can be too small or too large and its
     * max key too high (keys stay inside the leaf's range, so a stale max key is still a valid separator). Other
     * writes keep working on such a tree: insert only grows entries, and remove and split compute entries exactly
     * from the children below. Those exact writes can leave an ancestor stale without leaving the leaf's own entry
     * stale (a split recomputes the leaf's entry but not the entries above its parent), which is why every
     * ancestor is refit here, changed or not.
     */
    _flush() {
        const dirty = this._dirty, parent = this._parent;
        let list = this._dirtyList, next = this._dirtyNext, n = this._numDirty;

        // a list entry counts only if the node's mark matches the level: freed nodes are unmarked in _refit, and a
        // freed leaf may come back as an internal node that is marked at its own level; a long list is replaced by a
        // sweep of the arena, which visits the same nodes in memory order instead of random order
        for (let mark = 1; n > 0; mark++) {
            const sweep = n * 8 > this._numNodes;
            const end = sweep ? this._numNodes : n;
            let m = 0;
            for (let i = 0; i < end; i++) {
                const node = sweep ? i : list[i];
                if (dirty[node] !== mark) continue;
                dirty[node] = 0;
                if (node === this._root) continue;

                const p = parent[node];
                this._setEntry(this._entryOf(node), node);

                if (dirty[p] === 0) {
                    dirty[p] = mark + 1;
                    if (m === next.length) next = grow(next, m * 2);
                    next[m++] = p;
                }
            }
            const tmp = list;
            list = next;
            next = tmp;
            n = m;
        }
        this._dirtyList = list;
        this._dirtyNext = next;
        this._numDirty = 0;
    }

    /**
     * Swap-remove the item in leaf slot `s`, leaving the entries above as they are.
     * @param {number} s
     */
    _take(s) {
        const leaf = Math.floor(s / M);
        const last = leaf * M + --this._count[leaf];
        if (s !== last) {
            this._slotOf[this._ptrs[last]] = s;
            this._copy(last, s);
        }
        this._pad(last, last + 1);
    }

    /**
     * Mark a leaf for _flush to refit its entry and those above.
     * @param {number} leaf
     */
    _mark(leaf) {
        if (this._dirty[leaf] !== 0) return;
        this._dirty[leaf] = 1;
        if (this._numDirty === this._dirtyList.length) this._dirtyList = grow(this._dirtyList, this._numDirty * 2);
        this._dirtyList[this._numDirty++] = leaf;
    }

    /**
     * Recompute exact parent entries from `node` upward until one comes out unchanged. Emptied nodes are unlinked
     * from their parents and freed.
     * @param {number} node
     */
    _refit(node) {
        const parent = this._parent, count = this._count;

        while (node !== this._root) {
            const p = parent[node], s = this._entryOf(node);

            if (count[node] === 0) {
                const last = p * M + --count[p];
                for (let i = s; i < last; i++) this._copy(i + 1, i);
                this._pad(last, last + 1);
                this._freeNodes.push(node);
                this._dirty[node] = 0;

            } else if (!this._setEntry(s, node)) {
                return;
            }
            node = p;
        }

        if (count[node] === 0) this._height = 1; // an emptied root is a valid empty leaf (fully padded)
    }

    /**
     * The slot of `node`'s entry in its parent (a linear scan: parents don't track their children's positions).
     * @param {number} node
     */
    _entryOf(node) {
        const ptrs = this._ptrs;
        let s = this._parent[node] * M;
        while (ptrs[s] !== node) s++;
        return s;
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

        if (this._numNodes === this._capacity) this._growArena();

        const node = this._numNodes++;
        this._pad(node * M, node * M + M);
        return node;
    }

    /**
     * Grow the arena's node capacity (doubling by default).
     * @param {number} [capacity]
     */
    _growArena(capacity = this._capacity * 2) {
        this._capacity = capacity;
        this._boxes = grow(this._boxes, capacity * M * 4);
        this._keys = grow(this._keys, capacity * M);
        this._ptrs = grow(this._ptrs, capacity * M);
        this._count = grow(this._count, capacity);
        this._parent = grow(this._parent, capacity);
        this._dirty = grow(this._dirty, capacity);
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
 * Nodes in a tree of n items packed by rebuild: leaves and internal levels FILL full, a single node once ≤ M fit.
 * @param {number} n
 */
function packedNodes(n) {
    let k = n <= M ? 1 : Math.ceil(n / FILL), total = k;
    while (k > 1) {
        k = k <= M ? 1 : Math.ceil(k / FILL);
        total += k;
    }
    return total;
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

/**
 * Sort (key, value) pairs by key with two LSD radix passes, on the low 16 bits and then the high 15 (unsigned once
 * biased); the pairs move together, so both passes read sequentially.
 * @param {Int32Array} keys sorted in place
 * @param {Uint32Array} values moved along with keys
 * @param {Int32Array} keys2 scratch of the same length
 * @param {Uint32Array} values2 scratch of the same length
 * @param {number} n
 */
function radixSort(keys, values, keys2, values2, n) {
    if (!radixCounts) radixCounts = new Uint32Array(0x18000);
    const counts = radixCounts.fill(0), HI = 0x10000;

    for (let i = 0; i < n; i++) {
        const k = keys[i];
        counts[k & 0xffff]++;
        counts[HI + (k >> 16) + 0x4000]++;
    }
    for (let i = 0, lo = 0, hi = 0; i < 0x10000; i++) {
        const c = counts[i];
        counts[i] = lo;
        lo += c;
        if (i < 0x8000) {
            const d = counts[HI + i];
            counts[HI + i] = hi;
            hi += d;
        }
    }
    for (let i = 0; i < n; i++) {
        const k = keys[i], j = counts[k & 0xffff]++;
        keys2[j] = k;
        values2[j] = values[i];
    }
    for (let i = 0; i < n; i++) {
        const k = keys2[i], j = counts[HI + (k >> 16) + 0x4000]++;
        keys[j] = k;
        values[j] = values2[i];
    }
}

/**
 * Sort (key, value) pairs in [left, right] by key: quicksort, with insertion sort for short ranges.
 * @param {Int32Array} keys
 * @param {Uint32Array} values moved along with keys
 * @param {number} left
 * @param {number} right
 */
function quickSort(keys, values, left, right) {
    while (right - left > 16) {
        const a = keys[left], b = keys[(left + right) >> 1], c = keys[right];
        const pivot = (a > b) !== (a > c) ? a : (b < a) !== (b < c) ? b : c;
        let i = left - 1, j = right + 1;
        while (true) {
            do i++; while (keys[i] < pivot);
            do j--; while (keys[j] > pivot);
            if (i >= j) break;
            const k = keys[i], v = values[i];
            keys[i] = keys[j];
            values[i] = values[j];
            keys[j] = k;
            values[j] = v;
        }
        // recurse into the smaller half, loop on the larger
        if (j - left < right - j) {
            quickSort(keys, values, left, j);
            left = j + 1;
        } else {
            quickSort(keys, values, j + 1, right);
            right = j;
        }
    }
    for (let i = left + 1; i <= right; i++) {
        const k = keys[i], v = values[i];
        let j = i - 1;
        while (j >= left && keys[j] > k) {
            keys[j + 1] = keys[j];
            values[j + 1] = values[j];
            j--;
        }
        keys[j + 1] = k;
        values[j + 1] = v;
    }
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
