// A dynamic spatial index as a single B+-tree over Hilbert keys where every entry also carries a bounding box (a
// Hilbert R-tree, Kamel & Faloutsos), stored Flatbush-style in one flat typed-array arena.
//
// The arena is a sequence of fixed nodes of M slots. A slot holds a box, a key and a pointer: in a leaf, an item's
// box, its Hilbert key and its id; in an internal node, a child's MBR, the largest key below it and the child's
// node index. Leaves are unordered bags of items whose keys fall in one contiguous range; internal nodes keep their
// children ordered by key. Unused slots hold sentinel boxes (+∞ min / −∞ max: never match a query, no-ops in MBRs)
// and MAX_KEY, so search scans every node at full width with no counts.
//
// An update only writes the box and marks the leaf: before the next search, a flush takes the items that left their
// leaves out and inserts them again, and refits the entries above. While the tree is empty, adds only fill a run of
// slots past the root, and the first search packs them with rebuild.
//
// Not hardened yet: internal nodes are never merged on underflow, the arena grows by doubling, and the Hilbert domain
// is fixed at construction.

const M = 16;     // slots per node; the child pick in _insert is unrolled for this value
const HALF = M / 2;

const HILBERT_MAX = (1 << 16) - 1;

// Keys are the 32-bit Hilbert code shifted to 31 bits, in [-2^30, 2^30): every key is an SMI even with pointer
// compression, and a difference of two keys fits an int32, so its sign bit is the comparison.
const MAX_KEY = 0x3fffffff;

// slotOf bit of an id that isn't live (slots stay below it); a removed id keeps 1 + the next id of the free list in
// the low bits, 0 ending the list
const DEAD = 0x80000000;

const FILL = 14;         // items per leaf and children per internal node written by rebuild, so inserts don't split at once
const MERGE_BELOW = HALF; // a leaf left with fewer items merges into a neighbor...
const MERGE_MAX = FILL;   // ...if the two hold at most this many
const SORT_MIN = 64;      // a flush inserts fewer moved items than this as they come, without sorting them by key

const radixCounts = new Uint32Array(4096); // shared by all trees: counts for key digits of 11, 10 and 10 bits

export default class HTree {
    /**
     * @param {[number, number, number, number]} [domain] Coordinate bounds [minX, minY, maxX, maxY] for the Hilbert grid.
     * @param {number} [capacity=0] Number of items to reserve room for (see reserve).
     */
    constructor(domain = [0, 0, 1, 1], capacity = 0) {
        const initialNodes = Math.max(64, packedNodes(capacity));
        this.size = 0;                                   // number of live items
        this.reinserted = 0;                             // stats: items that updates moved to another leaf

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
        // node → 1 + its level if its entry in the parent awaits a refit in _flush, else 0; between flushes only
        // leaves are marked: those with updated items, whose entries may not cover them yet
        this._dirty = new Uint8Array(initialNodes);
        this._dirtyList = new Uint32Array(initialNodes);      // leaves marked in _dirty (may hold stale or repeat nodes)
        this._numDirty = 0;
        this._dirtyNext = new Uint32Array(initialNodes);      // _flush scratch: parents of the level being refit
        this._numNodes = 0;                                   // nodes ever allocated (arena high-water mark)
        this._freeNodes = [];                                 // freed nodes, fully padded, reused by _alloc

        this._slotOf = new Uint32Array(Math.max(1024, capacity)).fill(DEAD); // id → slot holding it (leaf or pending)
        this._nextId = 0;                                     // ids ever issued
        this._freeId = -1;                                    // the last removed id, reused first by add
        this._scratch = new ArrayBuffer(0);                   // rebuild: sort pairs and box columns, kept between calls

        // _flush: keys and ids of the items it takes out of their leaves (both twice as long, the second half is
        // for sorting), and their boxes, found through _slotOf
        this._movedKeys = new Int32Array(64);
        this._movedIds = new Uint32Array(64);
        this._movedBoxes = new Float64Array(128);

        this._height = 1;
        this._path = new Uint32Array(16);                     // level → slot taken by the last _insert descent
        this._splitKey = 0;                                   // largest key left in the lower half by _splitLeaf
        this._root = this._alloc();

        // an empty tree is pending: its root is node 0, and added items fill the slots right after it (item i of
        // `size` in slot M + i, no keys) until the first search packs them
        this._pending = true;
    }

    /**
     * Add a box, returning its id.
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    add(minX, minY, maxX = minX, maxY = minY) {
        let id = this._freeId;
        if (id !== -1) {
            this._freeId = (this._slotOf[id] & ~DEAD) - 1;
        } else {
            id = this._nextId++;
            if (id === this._slotOf.length) this._growIds(id * 2);
        }

        if (this._pending) {
            const s = M + this.size, p = s * 4;
            if (s === this._capacity * M) this._growArena();
            const boxes = this._boxes;
            boxes[p] = minX;
            boxes[p + 1] = minY;
            boxes[p + 2] = maxX;
            boxes[p + 3] = maxY;
            this._ptrs[s] = id;
            this._slotOf[id] = s;
        } else {
            this._insert(id, this._key(minX, minY, maxX, maxY), minX, minY, maxX, maxY);
        }
        this.size++;
        return id;
    }

    /**
     * Remove an item by id; its id is reused by a later add. Throws if the id isn't live.
     * @param {number} id
     */
    remove(id) {
        const slotOf = this._slotOf, s = this._slot(id);
        if (this._pending) { // the last pending item takes its slot
            const last = M + this.size - 1;
            if (s !== last) {
                slotOf[this._ptrs[last]] = s;
                this._copy(last, s);
            }
        } else {
            const leaf = Math.floor(s / M);
            this._take(s);
            // a marked leaf keeps its entry until the flush (unless it's empty now): an exact one would cover the
            // items that moved out of the leaf, and they would pass for items that never left
            const n = this._count[leaf];
            if ((n === 0 || this._dirty[leaf] === 0) && (n >= MERGE_BELOW || !this._merge(leaf))) this._refit(leaf);
        }
        slotOf[id] = DEAD | (this._freeId + 1);
        this._freeId = id;
        if (--this.size === 0) this.rebuild(); // back to a clean empty root, pending
    }

    /**
     * Change an item's box, keeping its id. This only writes the box: the flush before the next search decides
     * whether the item stays in its leaf (see _evict) and refits the entries above, once per leaf. Throws if the id
     * isn't live.
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    update(id, minX, minY, maxX = minX, maxY = minY) {
        const boxes = this._boxes, s = this._slot(id), p = s * 4;
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        if (this._pending) return;

        const leaf = Math.floor(s / M);
        if (leaf === this._root) { // nothing above to refit, and nowhere else to go
            this._keys[s] = this._key(minX, minY, maxX, maxY);

        } else if (this._dirty[leaf] === 0) {
            this._dirty[leaf] = 1;
            if (this._numDirty === this._dirtyList.length) this._dirtyList = grow(this._dirtyList, this._numDirty * 2);
            this._dirtyList[this._numDirty++] = leaf;
        }
    }

    /**
     * Get an item's box as [minX, minY, maxX, maxY]. Throws if the id isn't live.
     * @param {number} id
     */
    getBox(id) {
        const s = this._slot(id);
        return Array.from(this._boxes.subarray(s * 4, s * 4 + 4));
    }

    /**
     * The slot of a live item (a removed or never issued id, or anything that isn't one, reads DEAD or undefined).
     * @param {number} id
     */
    _slot(id) {
        const s = this._slotOf[id];
        if (!(s < DEAD)) throw new Error(`No item with id ${id}.`);
        return s;
    }

    /**
     * @param {number} length
     */
    _growIds(length) {
        const n = this._slotOf.length;
        this._slotOf = grow(this._slotOf, length);
        this._slotOf.fill(DEAD, n);
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
     * moved, or to restore fill and locality after heavy churn. Also packs the items of a pending tree.
     */
    rebuild() {
        const n = this.size, slotOf = this._slotOf;

        // scratch: (key, source slot) pairs, sorted from its last third into the first; then the sorted ids take
        // the place of the sorted keys, and two box columns at a time that of everything past the sorted slots
        if (this._scratch.byteLength < n * 24) this._scratch = new ArrayBuffer(n * 24);
        const buf = this._scratch;
        const sortKeys = new Int32Array(buf, 0, n * 5), from = new Uint32Array(buf, n * 4, n * 5);
        const ids = new Uint32Array(buf, 0, n), cols = new Float64Array(buf, n * 8, n * 2);

        let boxes = this._boxes, m = n * 4;
        // walk the leaves rather than the ids: one cache miss per leaf instead of one per item
        const stack = this._pending ? [] : [this._root * 16 + this._height - 1];
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
        for (let s = M; m < n * 5; s++, m++) { // a pending tree: the run of slots past the root
            const p = s * 4;
            sortKeys[m] = this._key(boxes[p], boxes[p + 1], boxes[p + 2], boxes[p + 3]);
            from[m] = s;
        }
        if (n > 0) radixSort(sortKeys, from, n * 4, 0, n);

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

        // after a bulk build, free the scratch: a tree that is rebuilt again gets it back and keeps it from then on
        if (this._pending || n === 0) this._scratch = new ArrayBuffer(0);
        this._pending = n === 0;
    }

    /**
     * Make room for `n` items in total without growing the arena or the id map again, in the space a packed tree
     * of `n` items takes. Use it before a large batch of adds.
     * @param {number} n
     */
    reserve(n) {
        const nodes = packedNodes(n), ids = this._nextId + n - this.size;
        if (this._capacity < nodes) this._growArena(nodes);
        if (this._slotOf.length < ids) this._growIds(ids);
    }

    /** Bytes taken by allocated nodes and the id map (not counting arena slack). */
    bytes() {
        const nodes = this._pending ? 1 + Math.ceil(this.size / M) : this._numNodes;
        return nodes * (M * (32 + 4 + 4) + 1 + 4) + this._nextId * 4;
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
            // a split writes exact entries, which mustn't happen to a marked leaf (see remove): flush and start over
            if (this._dirty[node] !== 0) {
                this._flush();
                this._insert(id, key, minX, minY, maxX, maxY);
                return;
            }
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
     * Settle the leaves marked by updates: take out the items that left them, refit their entries and then, level by
     * level, the entries above that changed, each node once; then insert the items taken out.
     *
     * Between flushes, only the entries of marked leaves can be stale: every other entry is exact, and so is every
     * entry of an internal node relative to its child's entries, whatever is below (insert grows them all the way
     * down, the rest writes exact ones). That's why the refit can stop at an entry that comes out unchanged.
     */
    _flush() {
        const dirty = this._dirty, parent = this._parent, count = this._count;
        let list = this._dirtyList, next = this._dirtyNext, n = this._numDirty, moved = 0;

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

                const e = this._entryOf(node);
                if (mark === 1) {
                    moved = this._evict(node, e, moved);
                    if (count[node] < MERGE_BELOW && this._merge(node)) continue;
                }
                if (!this._setEntry(e, node)) continue;

                const p = parent[node];
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

        // in key order, each descent follows the last one and new nodes end up next to their neighbors in the arena
        const keys = this._movedKeys, ids = this._movedIds, boxes = this._movedBoxes, slotOf = this._slotOf;
        const start = moved < SORT_MIN ? 0 : moved;
        if (start > 0) radixSort(keys, ids, 0, start, moved);
        for (let i = start; i < start + moved; i++) {
            const id = ids[i], p = slotOf[id] * 4;
            this._insert(id, keys[i], boxes[p], boxes[p + 1], boxes[p + 2], boxes[p + 3]);
        }
        this.reinserted += moved;
    }

    /**
     * Take out of a marked leaf the items that left it, adding them to the `moved` ones (keys, ids and boxes in
     * _movedKeys and so on); returns their new number. An item stays if its box is inside the leaf's entry `e`,
     * like the box of any item that didn't change: it keeps its key then, as placement only needs a key in the
     * leaf's range, not the key of the current box. It also stays, with a new key, if that key is in the range.
     * @param {number} leaf
     * @param {number} e
     * @param {number} moved
     */
    _evict(leaf, e, moved) {
        const boxes = this._boxes, keys = this._keys;
        const q = e * 4, x0 = boxes[q], y0 = boxes[q + 1], x1 = boxes[q + 2], y1 = boxes[q + 3];
        const base = leaf * M, end = base + this._count[leaf], hi = keys[e];

        // the lowest key to keep: the range starts past the previous child's max key; a first child's lower bound
        // lives further up, so it settles for the leaf's own lowest key
        let lo = MAX_KEY;
        if (e % M !== 0) lo = keys[e - 1] + 1;
        else for (let s = base; s < end; s++) lo = Math.min(lo, keys[s]);

        for (let s = end - 1; s >= base; s--) { // downward: _take fills the slot with the last, already seen one
            const p = s * 4, minX = boxes[p], minY = boxes[p + 1], maxX = boxes[p + 2], maxY = boxes[p + 3];
            if (minX >= x0 && minY >= y0 && maxX <= x1 && maxY <= y1) continue;

            const key = this._key(minX, minY, maxX, maxY);
            if (key >= lo && key <= hi) {
                keys[s] = key;
                continue;
            }
            if (moved * 2 === this._movedKeys.length) {
                this._movedKeys = grow(this._movedKeys, moved * 4);
                this._movedIds = grow(this._movedIds, moved * 4);
                this._movedBoxes = grow(this._movedBoxes, moved * 8);
            }
            const id = this._ptrs[s], b = this._movedBoxes, o = moved * 4;
            this._movedKeys[moved] = key;
            this._movedIds[moved] = id;
            b[o] = minX;
            b[o + 1] = minY;
            b[o + 2] = maxX;
            b[o + 3] = maxY;
            this._slotOf[id] = moved++; // until the item is back in a leaf: where its box is
            this._take(s);
        }
        return moved;
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
     * Move the items of an underfull leaf into the smaller of its neighbors under the same parent, if the two fit
     * in MERGE_MAX, and free the leaf (an empty one right away). Returns false if nothing can take the items.
     * Marked neighbors are left alone: the target gets an exact entry, which they mustn't (see remove).
     * @param {number} leaf
     */
    _merge(leaf) {
        const count = this._count, ptrs = this._ptrs, n = count[leaf];
        if (n > 0) {
            if (leaf === this._root) return false;
            const e = this._entryOf(leaf), first = this._parent[leaf] * M, last = first + count[this._parent[leaf]] - 1;

            let t = -1, room = MERGE_MAX - n;
            for (let s = e - 1; s <= e + 1; s += 2) {
                if (s < first || s > last || count[ptrs[s]] > room || this._dirty[ptrs[s]] !== 0) continue;
                t = s;
                room = count[ptrs[s]] - 1; // the other neighbor has to be smaller
            }
            if (t === -1) return false;

            const target = ptrs[t], slotOf = this._slotOf;
            let to = target * M + count[target];
            for (let i = leaf * M, end = i + n; i < end; i++) {
                slotOf[ptrs[i]] = to;
                this._copy(i, to++);
            }
            count[target] += n;
            count[leaf] = 0;
            this._pad(leaf * M, leaf * M + n);
            this._setEntry(t, target); // at once: a left neighbor takes over the leaf's max key
        }
        this._refit(leaf);
        return true;
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
 * Sort `n` (key, value) pairs by key from index `a` of both arrays to index `b`, with three LSD radix passes (on 11,
 * 10 and 10 bits of the key, biased to be unsigned); the range at `a` is scratch afterwards.
 * @param {Int32Array} keys
 * @param {Uint32Array} values
 * @param {number} a
 * @param {number} b
 * @param {number} n
 */
function radixSort(keys, values, a, b, n) {
    const counts = radixCounts.fill(0), MID = 2048, HI = 3072, BIAS = MAX_KEY + 1;

    for (let i = a; i < a + n; i++) {
        const k = keys[i] + BIAS;
        counts[k & 2047]++;
        counts[MID + ((k >> 11) & 1023)]++;
        counts[HI + (k >> 21)]++;
    }
    for (let i = 0, lo = 0, mid = 0, hi = 0; i < 2048; i++) {
        const c = counts[i];
        counts[i] = lo;
        lo += c;
        if (i < 1024) {
            const d = counts[MID + i], e = counts[HI + i];
            counts[MID + i] = mid;
            counts[HI + i] = hi;
            mid += d;
            hi += e;
        }
    }
    for (let i = a; i < a + n; i++) {
        const k = keys[i], j = b + counts[(k + BIAS) & 2047]++;
        keys[j] = k;
        values[j] = values[i];
    }
    for (let i = b; i < b + n; i++) {
        const k = keys[i], j = a + counts[MID + (((k + BIAS) >> 11) & 1023)]++;
        keys[j] = k;
        values[j] = values[i];
    }
    for (let i = a; i < a + n; i++) {
        const k = keys[i], j = b + counts[HI + ((k + BIAS) >> 21)]++;
        keys[j] = k;
        values[j] = values[i];
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
