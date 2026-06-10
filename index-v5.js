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
// `keys` (leaf Hilbert keys, for merging), plus `numItems` and `nodeSize`. Each tree level is
// padded to a full nodeSize multiple (by pack(), on first search) so every node is the same width
// and search needs no level-bound check. Separate arrays make build/merge/replacement trivial. Arrays
// are allocated to a `capacity` size class (B·2^k ≥ numItems), so every block is recycled whole through
// a pool of free lists indexed by level (a clean slab allocator) instead of reallocated from scratch.

const HILBERT_MAX = (1 << 16) - 1;

/**
 * Fill a box range with sentinel boxes (+∞ min / −∞ max): never match a query, no-ops in parent MBRs.
 * @param {Float64Array} boxes
 * @param {number} start
 * @param {number} end
 */
function padSentinels(boxes, start, end) {
    for (let p = start; p < end; p += 4) {
        boxes[p] = Infinity; boxes[p + 1] = Infinity; boxes[p + 2] = -Infinity; boxes[p + 3] = -Infinity;
    }
}

/**
 * One frozen block: a Hilbert-sorted leaf run that packs into a standalone Flatbush-style index and
 * searches on its own. Born as a bare leaf run (`packed` false) by _flush / merge / concat; `pack()`
 * fills the node MBRs on first search. Arrays are sized to the capacity class B·2ᵏ ≥ numItems (not the
 * live numItems), so a recycled block serves any count up to capacity — the leaf portion is [0, numItems).
 */
class RBlock {
    /**
     * @param {number} level Cascade slot and pool index in one (k in B·2ᵏ); capacity === bufferSize << level.
     * @param {number} nodeSize Packed R-tree node size.
     * @param {Int32Array} keys Leaf Hilbert codes, read only by merge.
     * @param {Float64Array} boxes Full packed-tree size: leaf MBRs at the front, pack() fills node MBRs into the tail.
     * @param {Uint32Array} indices Flatbush dual-purpose: leaf → global id, node → first child's box offset (after pack()).
     */
    constructor(level, nodeSize, keys, boxes, indices) {
        this.level = level;      // cascade slot + pool size-class index (capacity === bufferSize << level)
        this.numItems = 0;       // live leaf count, ≤ capacity; set by takeBlock
        this.nodeSize = nodeSize;
        this.keys = keys;
        this.boxes = boxes;
        this.indices = indices;
        this.packed = false;     // node MBRs not yet computed; pack() sets this on first search
        this.rootPos = 0;        // box offset of the root node; set by pack()
    }

    /**
     * Fill in this block's node MBRs bottom-up, in place (arrays are already full size). Deferred until
     * first search: a block merged away before any query never needs its tree (merge reads only leaves),
     * so under insert-heavy load almost all packing is skipped. Guarded by the caller's `packed` flag.
     */
    pack() {
        const {numItems, nodeSize, boxes, indices} = this;

        // Build levels bottom-up: each level is read in nodeSize-wide groups, one parent MBR per
        // group, then padded to full nodes — so every level above the root is whole nodes and
        // search scans fixed-width. Start with the padded leaf level; the root stays unpadded.
        let start = 0;
        let count = Math.ceil(numItems / nodeSize) * nodeSize;
        padSentinels(boxes, numItems * 4, count * 4);
        let wp = count * 4; // where the next level up is written

        while (count > 1) {
            const parentStart = wp;
            for (let pos = start, end = start + count * 4; pos < end;) {
                const node = pos;
                let minX = boxes[pos++], minY = boxes[pos++], maxX = boxes[pos++], maxY = boxes[pos++];
                for (let j = 1; j < nodeSize; j++) {
                    if (boxes[pos] < minX) minX = boxes[pos]; pos++;
                    if (boxes[pos] < minY) minY = boxes[pos]; pos++;
                    if (boxes[pos] > maxX) maxX = boxes[pos]; pos++;
                    if (boxes[pos] > maxY) maxY = boxes[pos]; pos++;
                }
                indices[wp >> 2] = node;
                boxes[wp++] = minX; boxes[wp++] = minY; boxes[wp++] = maxX; boxes[wp++] = maxY;
            }
            const numParents = count / nodeSize;
            if (numParents === 1) { this.rootPos = wp - 4; break; } // just wrote the root box

            count = Math.ceil(numParents / nodeSize) * nodeSize; // pad this new level and move up to it
            padSentinels(boxes, wp, parentStart + count * 4);
            wp = parentStart + count * 4;
            start = parentStart;
        }

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
        const boxes = this.boxes, indices = this.indices;
        // every node below the root is exactly nodeSize wide, so the child scan needs no clamp; and
        // since no node group starts in the padded gap, numItems * 4 is the leaf/internal boundary
        const nodeSize4 = this.nodeSize * 4, leafEnd = this.numItems * 4;

        // test the lone (unpadded) root box, then descend from its children
        const r = this.rootPos;
        if (maxX < boxes[r] || maxY < boxes[r + 1] || minX > boxes[r + 2] || minY > boxes[r + 3]) return;
        let nodeIndex = indices[r >> 2];
        const queue = [];

        while (nodeIndex !== undefined) {
            const end = nodeIndex + nodeSize4;

            for (let pos = nodeIndex; pos < end; pos += 4) {
                const x0 = boxes[pos];
                if (maxX < x0) continue; // sentinel boxes (x0 = +∞) never match
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
 * Take a block holding `numItems` from the pool, or allocate one. Arrays are sized to the capacity class
 * B·2ᵏ ≥ numItems, not numItems itself: insert-path blocks are exactly B·2ᵏ so the two coincide, while
 * load/compaction produce odd sizes — rounding up to the fixed class set makes the pool a clean slab
 * allocator, every freed block reusable by construction. The pool is free lists indexed by level (the
 * cascade frees same-size pairs, so one slot per level wouldn't suffice). Recycled blocks come back dirty:
 * no zero-fill, since freeze/merge overwrites the leaf portion and pack() the node tail before any search.
 * @param {RBlock[][]} pool free lists indexed by level
 * @param {number} numItems
 * @param {number} nodeSize
 * @param {number} bufferSize Base size B; the smallest capacity class (level 0).
 */
function takeBlock(pool, numItems, nodeSize, bufferSize) {
    let capacity = bufferSize, level = 0;
    while (capacity < numItems) { capacity <<= 1; level++; } // smallest class B·2ᵏ ≥ numItems

    const free = pool[level];
    let block;
    if (free !== undefined && free.length > 0) {
        block = free.pop();
        block.packed = false;     // node MBRs will be rebuilt by pack(); leaf portion gets overwritten now
    } else {
        // total node count of a padded packed tree over `capacity` leaves (Flatbush layout): leaves
        // plus bottom-up parents, every non-root level padded to a full nodeSize multiple (see pack()).
        let e = capacity, numNodes = 1;
        while (e !== 1) { e = Math.ceil(e / nodeSize); numNodes += e * nodeSize; }
        block = new RBlock(level, nodeSize, new Int32Array(capacity), new Float64Array(numNodes * 4), new Uint32Array(numNodes));
    }
    block.numItems = numItems;
    return block;
}

/**
 * Return a relieved block to its free list for reuse by the next block of the same level (capacity class).
 * @param {RBlock[][]} pool
 * @param {RBlock} block
 */
function putBlock(pool, block) {
    const free = pool[block.level];
    if (free === undefined) pool[block.level] = [block];
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

        this._pool = [];                                 // level → free list of relieved blocks for reuse
        this._n = 0;                                     // items currently in the buffer
        this._blocks = [];                               // _blocks[i] = packed block at level i (or undefined)
        // The mutable buffer is itself a pool block holding the newest ≤ bufferSize items: `add` fills
        // its leaf portion in place, search scans it linearly, and freezing it is zero-copy (see _flush).
        this._buffer = takeBlock(this._pool, bufferSize, nodeSize, bufferSize);
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
        const boxes = this._buffer.boxes;
        const p = this._n * 4;
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        this._buffer.indices[this._n] = id;
        if (++this._n === this.bufferSize) this._flush();
        return id;
    }

    /** Freeze the full buffer into a Hilbert-sorted level-0 block and carry it up through the levels. */
    _flush() {
        const pool = this._pool;
        const n = this._n;

        // The buffer is already a level-0 block, so freezing is an in-place sort: compute Hilbert keys,
        // sort keys/boxes/indices together, hand the block to the cascade, borrow a fresh one. Node MBRs
        // are left for lazy packing on first search — carry blocks get re-merged before any query.
        let run = this._buffer;
        const boxes = run.boxes, keys = run.keys;
        for (let i = 0; i < n; i++) {
            const p = i * 4;
            // clamp the scaled float *before* truncating: a far-out-of-domain coordinate
            // overflows int32 if `| 0` runs first, wrapping to the wrong grid cell instead of
            // pinning to the edge (quality-only, but arbitrarily bad ordering — see clamp).
            const x = clamp(this._scaleX * ((boxes[p] + boxes[p + 2]) / 2 - this._minX)) | 0;
            const y = clamp(this._scaleY * ((boxes[p + 1] + boxes[p + 3]) / 2 - this._minY)) | 0;
            keys[i] = hilbert(x, y);
        }
        sort(keys, boxes, run.indices, 0, n - 1); // sort by Hilbert key, boxes + ids follow
        this._n = 0;
        this._buffer = takeBlock(pool, this.bufferSize, this.nodeSize, this.bufferSize); // borrow a fresh buffer block

        for (let level = 0; ; level++) {
            const existing = this._blocks[level];
            if (!existing) {
                this._blocks[level] = run; // empty slot — settle here as an unpacked leaf run
                break;
            }
            run = merge(existing, run, pool, this.bufferSize); // collision — merge leaves and carry to the next level
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

        // linear scan of the still-mutable buffer block (leaf portion, up to _n)
        const boxes = this._buffer.boxes, ids = this._buffer.indices;
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
 * 2-way merge of two Hilbert-sorted leaf runs (or packed blocks — only their leaf portion
 * is read) into a fresh leaf run. Node MBRs, if any, are ignored and not regenerated here;
 * RBlock.pack() rebuilds the tree once the run finally settles and is first searched.
 * @param {RBlock} a
 * @param {RBlock} b
 * @param {RBlock[][]} pool
 * @param {number} bufferSize Base size B, for the output's capacity class.
 */
function merge(a, b, pool, bufferSize) {
    const al = a.numItems, bl = b.numItems, n = al + bl;
    // output sized for the full packed tree (recycled whole from the pool); fill only the leaf portion [0, n)
    const out = takeBlock(pool, n, a.nodeSize, bufferSize);
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
    // every array is allocated to capacity ≥ numItems (and boxes/indices may also carry node MBRs from a
    // prior pack()), so bound each copy to the live leaf portion [0, numItems).
    keys.set(lo.keys.subarray(0, ll)); keys.set(hi.keys.subarray(0, hl), ll);
    ids.set(lo.indices.subarray(0, ll)); ids.set(hi.indices.subarray(0, hl), ll);
    boxes.set(lo.boxes.subarray(0, ll * 4)); boxes.set(hi.boxes.subarray(0, hl * 4), ll * 4);
}

const SORT_STACK = new Uint32Array(64); // safe for quicksort over Uint32Array looping into the smaller side

/**
 * In-place quicksort of keys[left..right], keeping boxes (4 per item) and ids parallel.
 * @param {Int32Array} keys
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

/** @param {Int32Array} keys @param {Float64Array} boxes @param {Uint32Array} ids @param {number} i @param {number} j */
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

    // bias the unsigned 32-bit code into signed [-2^31, 2^31): full precision, and every key is an
    // SMI on 64-bit V8 so the sort/merge hot path compares tagged ints, not float64 (~7% faster inserts).
    // Monotonic, so the Hilbert ordering is unchanged. Stored in an Int32Array (see takeBlock).
    return (((b << 1) | a) >>> 0) - 0x80000000;
}
