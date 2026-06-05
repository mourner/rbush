// RBush v5 — step 3: real boxes, ordered by Hilbert value, with range search.
//
// Items are axis-aligned boxes (minX, minY, maxX, maxY) with an auto-assigned id.
// Each block is a flat run of items sorted by the Hilbert code of the box center, so
// items near each other in space land near each other in the block — the ordering a
// packed R-tree is built on. A block is now a full packed Flatbush index: its leaf boxes
// (Hilbert-sorted) followed by bottom-up node MBRs, so it can be searched on its own.
// Blocks are carried through the same binary-counter cascade as before; a merge produces
// a fresh leaf run and repacks the tree on top of it.
//
// search() runs the standard Flatbush range descent on every frozen block, linearly scans
// the still-mutable buffer, and unions the results. Decomposability makes this correct:
// the answer over the whole dataset is the union of the per-block / buffer answers.
//
// The Hilbert key is quantized into a FIXED domain shared by every block, so keys from
// different blocks are directly comparable and the 2-way merge stays a linear key scan.
// (Boxes themselves are kept full-precision for accurate search.)
//
// Per-block storage layout: each block owns separate typed arrays — `boxes` (leaf MBRs then,
// after pack(), node MBRs bottom-up), `indices` (leaf → global id, node → child box offset),
// `keys` (leaf Hilbert keys, for merging), plus `numItems`, `nodeSize`, and `levelBounds`
// (built lazily by pack() on first search, like the node MBRs). Separate arrays make
// build/merge/replacement trivial, and their sizes are a clean B·2^k set, so each block a merge
// relieves is recycled whole through a per-size pool instead of reallocated from scratch.

const HILBERT_MAX = (1 << 16) - 1;

/**
 * Total node count of a packed tree over `numItems` leaves (leaves + bottom-up parent nodes,
 * Flatbush layout). No closed form — the per-level ceil doesn't distribute — but it's a handful
 * of iterations. Used to allocate a block's `boxes`/`indices` at their final packed size up
 * front; the per-level bounds needed for search are built lazily in pack().
 * @param {number} numItems
 * @param {number} nodeSize
 */
function nodeCount(numItems, nodeSize) {
    let n = numItems, count = n;
    do {
        n = Math.ceil(n / nodeSize);
        count += n;
    } while (n !== 1);
    return count;
}

/**
 * One frozen block: a Hilbert-sorted run of leaf items that can be packed into a standalone
 * Flatbush-style index and searched on its own. Created as a bare leaf run (`levelBounds`
 * null) by _flush / merge / concat; `pack()` fills in the node MBRs on first search.
 *
 * `boxes` is sized for the full packed tree from the start: leaf MBRs occupy the front, and
 * pack() fills the bottom-up node MBRs into the tail in place. `indices` is dual-purpose in
 * the Flatbush convention: leaf rows hold the global item id, node rows hold the box offset of
 * their first child. `keys` are the leaf Hilbert codes (leaf-sized), read only by merge.
 */
class RBlock {
    /**
     * @param {number} numItems
     * @param {number} nodeSize Packed R-tree node size.
     * @param {Uint32Array} keys Leaf Hilbert codes (length numItems).
     * @param {Float64Array} boxes Full packed-tree size; only the leaf portion is filled until pack().
     * @param {Uint32Array} indices Same: leaf → global id, then node → child offset after pack().
     */
    constructor(numItems, nodeSize, keys, boxes, indices) {
        this.numItems = numItems;
        this.nodeSize = nodeSize;
        this.keys = keys;
        this.boxes = boxes;
        this.indices = indices;
        this.levelBounds = null; // per-level box-offset bounds; built by pack() on first search
        this.packed = false;     // node MBRs not yet computed; pack() sets this on first search
    }

    /**
     * Fill in this block's node MBRs bottom-up, in place (arrays are already full size), and
     * build the per-level bounds search needs. Deferred until first search: a block merged away
     * before any query never needs its tree (merge reads only leaves), so under insert-heavy
     * load almost all packing is skipped. Idempotent via the caller's `packed` guard.
     */
    pack() {
        const numItems = this.numItems, nodeSize = this.nodeSize;
        const boxes = this.boxes, indices = this.indices;

        // per-level box-offset bounds (Flatbush layout)
        let n = numItems, total = n;
        const levelBounds = [n * 4];
        do {
            n = Math.ceil(n / nodeSize);
            total += n;
            levelBounds.push(total * 4);
        } while (n !== 1);

        // generate parent nodes level by level, bottom-up
        let pos = 0;            // read cursor over the level below
        let wp = numItems * 4;  // write cursor for new parent boxes
        for (let i = 0; i < levelBounds.length - 1; i++) {
            const end = levelBounds[i];
            while (pos < end) {
                const nodeIndex = pos;
                let nodeMinX = boxes[pos++], nodeMinY = boxes[pos++], nodeMaxX = boxes[pos++], nodeMaxY = boxes[pos++];
                for (let j = 1; j < nodeSize && pos < end; j++) {
                    if (boxes[pos] < nodeMinX) nodeMinX = boxes[pos]; pos++;
                    if (boxes[pos] < nodeMinY) nodeMinY = boxes[pos]; pos++;
                    if (boxes[pos] > nodeMaxX) nodeMaxX = boxes[pos]; pos++;
                    if (boxes[pos] > nodeMaxY) nodeMaxY = boxes[pos]; pos++;
                }
                indices[wp >> 2] = nodeIndex;
                boxes[wp++] = nodeMinX; boxes[wp++] = nodeMinY; boxes[wp++] = nodeMaxX; boxes[wp++] = nodeMaxY;
            }
        }

        this.levelBounds = levelBounds;
        this.packed = true;
    }

    /**
     * Standard Flatbush range descent; pushes matching global ids into `results`.
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     * @param {((id: number, minX: number, minY: number, maxX: number, maxY: number) => boolean) | undefined} filterFn
     * @param {number[]} results
     */
    search(minX, minY, maxX, maxY, filterFn, results) {
        const boxes = this.boxes, indices = this.indices, levelBounds = this.levelBounds;
        const nodeSize = this.nodeSize, leafEnd = this.numItems * 4;

        let nodeIndex = boxes.length - 4; // root
        const queue = [];

        while (nodeIndex !== undefined) {
            const end = Math.min(nodeIndex + nodeSize * 4, upperBound(nodeIndex, levelBounds));

            for (let pos = nodeIndex; pos < end; pos += 4) {
                const x0 = boxes[pos];
                if (maxX < x0) continue;
                const y0 = boxes[pos + 1];
                if (maxY < y0) continue;
                const x1 = boxes[pos + 2];
                if (minX > x1) continue;
                const y1 = boxes[pos + 3];
                if (minY > y1) continue;

                const index = indices[pos >> 2];
                if (nodeIndex >= leafEnd) {
                    queue.push(index); // internal node — descend later
                } else if (filterFn === undefined || filterFn(index, x0, y0, x1, y1)) {
                    results.push(index); // leaf — `index` is the global id
                }
            }

            nodeIndex = queue.pop();
        }
    }
}

/**
 * Whole blocks are recycled through a free list keyed by item count rather than reallocated. A
 * merge relieves its two inputs (the carried-away level) and produces a larger output; since block
 * sizes are a small fixed B·2^k set and a block's three arrays are all sized from `numItems`, a
 * relieved level-i block is exactly what the next level-i block needs — so it goes back whole and
 * the next same-size block reuses its arrays in place. They're handed back dirty (`packed`/
 * `levelBounds` reset, contents not) — no zero-fill: the leaf portion is fully overwritten by the
 * merge/freeze copy, and the node tail by pack() before any search reads it, so stale contents are
 * never observed. The cascade frees blocks in same-size pairs, so a level needs up to two free at
 * once — hence a free *list* per size, not a single dormant slot.
 * @param {Map<number, RBlock[]>} pool keyed by numItems
 * @param {number} numItems
 * @param {number} nodeSize
 */
function takeBlock(pool, numItems, nodeSize) {
    const free = pool.get(numItems);
    if (free !== undefined && free.length > 0) {
        const block = free.pop();
        block.packed = false;     // node MBRs will be rebuilt by pack(); leaf portion gets overwritten now
        block.levelBounds = null;
        return block;
    }
    const numNodes = nodeCount(numItems, nodeSize);
    return new RBlock(numItems, nodeSize, new Uint32Array(numItems), new Float64Array(numNodes * 4), new Uint32Array(numNodes));
}

/** Return a relieved block to its free list for reuse by the next same-size block. @param {Map<number, RBlock[]>} pool @param {RBlock} block */
function putBlock(pool, block) {
    const free = pool.get(block.numItems);
    if (free === undefined) pool.set(block.numItems, [block]);
    else free.push(block);
}

export default class RBush {
    /**
     * @param {[number, number, number, number]} [domain] Coordinate bounds [minX, minY, maxX, maxY] for the Hilbert grid.
     * @param {number} [bufferSize=256] Items buffered before a block is frozen; also the smallest block size.
     * @param {number} [nodeSize=16] Packed R-tree node size per block.
     */
    constructor(domain = [0, 0, 1, 1], bufferSize = 256, nodeSize = 16) {
        this.bufferSize = bufferSize;
        this.nodeSize = nodeSize;
        this.length = 0;                                // total number of items added, and the next id

        const [minX, minY, maxX, maxY] = domain;
        this._minX = minX;
        this._minY = minY;
        this._scaleX = HILBERT_MAX / ((maxX - minX) || 1); // center → [0, HILBERT_MAX] grid
        this._scaleY = HILBERT_MAX / ((maxY - minY) || 1);

        this._boxes = new Float64Array(bufferSize * 4);  // newest boxes, unsorted
        this._ids = new Uint32Array(bufferSize);         // their ids, parallel to _boxes
        this._n = 0;                                     // items currently in the buffer
        this._blocks = [];                               // _blocks[i] = packed block at level i (or undefined)
        this._pool = new Map();                          // numItems → free list of relieved blocks for reuse
    }

    /**
     * Add a box, returning its id.
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    add(minX, minY, maxX = minX, maxY = minY) {
        const id = this.length++;
        const p = this._n * 4;
        this._boxes[p] = minX;
        this._boxes[p + 1] = minY;
        this._boxes[p + 2] = maxX;
        this._boxes[p + 3] = maxY;
        this._ids[this._n] = id;
        if (++this._n === this.bufferSize) this._flush();
        return id;
    }

    /** Freeze the full buffer into a Hilbert-sorted level-0 block and carry it up through the levels. */
    _flush() {
        const boxes = this._boxes;
        const pool = this._pool;
        const n = this._n;

        // The level-0 run's arrays are sized for the full packed tree up front (recycled whole from
        // the pool), but only the leaf portion is filled; node MBRs are computed lazily on first
        // search. Intermediate carry blocks are immediately re-merged, so packing them is wasted work.
        let run = takeBlock(pool, n, this.nodeSize);
        const keys = run.keys;
        for (let i = 0; i < n; i++) {
            const p = i * 4;
            // clamp the scaled float *before* truncating: a far-out-of-domain coordinate
            // overflows int32 if `| 0` runs first, wrapping to the wrong grid cell instead of
            // pinning to the edge (quality-only, but arbitrarily bad ordering — see clamp).
            const x = clamp(this._scaleX * ((boxes[p] + boxes[p + 2]) / 2 - this._minX)) | 0;
            const y = clamp(this._scaleY * ((boxes[p + 1] + boxes[p + 3]) / 2 - this._minY)) | 0;
            keys[i] = hilbert(x, y);
        }
        sort(keys, this._boxes, this._ids, 0, n - 1); // sort by Hilbert key, boxes + ids follow
        run.boxes.set(this._boxes.subarray(0, n * 4));
        run.indices.set(this._ids.subarray(0, n));
        this._n = 0;

        for (let level = 0; ; level++) {
            const existing = this._blocks[level];
            if (!existing) {
                this._blocks[level] = run; // empty slot — settle here as an unpacked leaf run
                break;
            }
            run = merge(existing, run, pool); // collision — merge leaves and carry to the next level
            this._blocks[level] = undefined;
        }
    }

    /**
     * Find all item ids whose box intersects (or touches) the query box.
     * Runs the packed search on every frozen block, scans the buffer, and unions the results.
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     * @param {(id: number, minX: number, minY: number, maxX: number, maxY: number) => boolean} [filterFn]
     * @returns {number[]}
     */
    search(minX, minY, maxX, maxY, filterFn) {
        const results = [];

        for (const block of this._blocks) {
            if (!block) continue;
            if (!block.packed) block.pack(); // lazily build node MBRs on first search
            block.search(minX, minY, maxX, maxY, filterFn, results);
        }

        // linear scan of the still-mutable buffer
        const boxes = this._boxes, ids = this._ids;
        for (let i = 0, p = 0; i < this._n; i++, p += 4) {
            const x0 = boxes[p], y0 = boxes[p + 1], x1 = boxes[p + 2], y1 = boxes[p + 3];
            if (maxX < x0 || maxY < y0 || minX > x1 || minY > y1) continue;
            const id = ids[i];
            if (filterFn === undefined || filterFn(id, x0, y0, x1, y1)) results.push(id);
        }

        return results;
    }
}

/**
 * Binary search for the first level bound strictly greater than the given box offset.
 * @param {number} value
 * @param {number[]} arr
 */
function upperBound(value, arr) {
    let i = 0, j = arr.length - 1;
    while (i < j) {
        const m = (i + j) >> 1;
        if (arr[m] > value) j = m;
        else i = m + 1;
    }
    return arr[i];
}

/**
 * 2-way merge of two Hilbert-sorted leaf runs (or packed blocks — only their leaf portion
 * is read) into a fresh leaf run. Node MBRs, if any, are ignored and not regenerated here;
 * RBlock.pack() rebuilds the tree once the run finally settles and is first searched.
 * @param {RBlock} a
 * @param {RBlock} b
 * @param {Map<number, RBlock[]>} pool
 */
function merge(a, b, pool) {
    const al = a.numItems, bl = b.numItems, n = al + bl;
    // output sized for the full packed tree (recycled whole from the pool); fill only the leaf portion [0, n)
    const out = takeBlock(pool, n, a.nodeSize);
    const keys = out.keys, boxes = out.boxes, ids = out.indices;

    if (a.keys[al - 1] <= b.keys[0]) {       // disjoint key ranges (clustered/temporal streams)
        concat(a, b, keys, boxes, ids);      //   — pure concatenation, no merge loop
    } else if (b.keys[bl - 1] <= a.keys[0]) {
        concat(b, a, keys, boxes, ids);
    } else {
        // Hoist the six typed-array views into locals: the merge loop is the dominant cost,
        // and reading `a.keys`/`b.boxes`/… off the block object every iteration is a property
        // load V8 won't hoist across the loop. Pulling them out (and inlining the per-item
        // copy below) is ~22% faster on the merge itself.
        const aKeys = a.keys, aBoxes = a.boxes, aIds = a.indices;
        const bKeys = b.keys, bBoxes = b.boxes, bIds = b.indices;
        let i = 0, j = 0, k = 0;
        while (i < al && j < bl) {
            let s, sb;
            if (aKeys[i] <= bKeys[j]) { s = i++; keys[k] = aKeys[s]; ids[k] = aIds[s]; sb = aBoxes; } else { s = j++; keys[k] = bKeys[s]; ids[k] = bIds[s]; sb = bBoxes; }
            const sp = s * 4, dp = k * 4;
            boxes[dp] = sb[sp]; boxes[dp + 1] = sb[sp + 1]; boxes[dp + 2] = sb[sp + 2]; boxes[dp + 3] = sb[sp + 3];
            k++;
        }
        // bulk-copy whichever input's leaf tail remains (memcpy, much faster than per-item)
        if (i < al) appendTail(aKeys, aBoxes, aIds, i, al, keys, boxes, ids, k);
        else if (j < bl) appendTail(bKeys, bBoxes, bIds, j, bl, keys, boxes, ids, k);
    }

    // both inputs are now fully consumed — recycle them for the next same-size blocks
    putBlock(pool, a);
    putBlock(pool, b);
    return out;
}

/** Append the leaf run src[from..numItems) into the output starting at slot k via bulk set(). */
function appendTail(srcKeys, srcBoxes, srcIds, from, numItems, keys, boxes, ids, k) {
    keys.set(srcKeys.subarray(from, numItems), k);
    ids.set(srcIds.subarray(from, numItems), k);
    boxes.set(srcBoxes.subarray(from * 4, numItems * 4), k * 4);
}

/** Concatenate two disjoint leaf runs (all of `lo` then all of `hi`) into the output arrays. */
function concat(lo, hi, keys, boxes, ids) {
    const ll = lo.numItems, hl = hi.numItems;
    // keys is exactly numItems long, so no subarray needed; boxes/indices may carry
    // node MBRs from a prior pack(), so those are bounded to the leaf portion.
    keys.set(lo.keys); keys.set(hi.keys, ll);
    ids.set(lo.indices.subarray(0, ll)); ids.set(hi.indices.subarray(0, hl), ll);
    boxes.set(lo.boxes.subarray(0, ll * 4)); boxes.set(hi.boxes.subarray(0, hl * 4), ll * 4);
}

const SORT_STACK = new Uint32Array(64); // safe for quicksort over Uint32Array looping into the smaller side

/**
 * In-place quicksort of keys[left..right], keeping boxes (4 per item) and ids parallel.
 * @param {Uint32Array} keys
 * @param {Float64Array} boxes
 * @param {Uint32Array} ids
 * @param {number} left
 * @param {number} right
 */
function sort(keys, boxes, ids, left, right) {
    const stack = SORT_STACK;
    let sp = 0;
    let l = left, r = right;

    while (true) {
        if (l >= r) {
            if (sp === 0) break;
            r = stack[--sp]; l = stack[--sp];
            continue;
        }

        // median-of-three pivot — avoids O(n²) blowup (and deep recursion) on sorted/degenerate input
        const a = keys[l], b = keys[(l + r) >> 1], c = keys[r];
        const pivot = ((a > b) !== (a > c)) ? a : ((b < a) !== (b < c)) ? b : c;

        let i = l - 1, j = r + 1;
        while (true) {
            do i++; while (keys[i] < pivot);
            do j--; while (keys[j] > pivot);
            if (i >= j) break;
            swap(keys, boxes, ids, i, j);
        }

        // loop into the smaller side, stack the larger — bounds stack depth to log2(n)
        if (j - l < r - j - 1) {
            stack[sp++] = j + 1; stack[sp++] = r;
            r = j;
        } else {
            stack[sp++] = l; stack[sp++] = j;
            l = j + 1;
        }
    }
}

/** @param {Uint32Array} keys @param {Float64Array} boxes @param {Uint32Array} ids @param {number} i @param {number} j */
function swap(keys, boxes, ids, i, j) {
    const k = keys[i]; keys[i] = keys[j]; keys[j] = k;
    const d = ids[i]; ids[i] = ids[j]; ids[j] = d;
    const ip = i * 4, jp = j * 4;
    for (let c = 0; c < 4; c++) {
        const v = boxes[ip + c]; boxes[ip + c] = boxes[jp + c]; boxes[jp + c] = v;
    }
}

/** Clamp a scaled coordinate to the Hilbert grid range [0, HILBERT_MAX] before truncation. */
function clamp(v) {
    return v < 0 ? 0 : v > HILBERT_MAX ? HILBERT_MAX : v;
}

/**
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

    return ((b << 1) | a) >>> 0;
}
