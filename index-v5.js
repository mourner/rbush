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
// of small blocks are allocated to a `capacity` size class (B·2^k ≥ numItems) and recycled whole through a
// pool of free lists indexed by that class (a clean slab allocator); big blocks are allocated to exact size.

const HILBERT_MAX = (1 << 16) - 1;

// Largest block capacity kept in the pool. Class k is needed only once per 2ᵏ flushes, so pooling big blocks
// saves nearly nothing, while freed ones would pile up to ~2× the live tree; above this they're left to GC.
const MAX_POOLED_ITEMS = 1 << 16;

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
     * @param {number} poolClass Allocation size class k (capacity B·2ᵏ), or -1 for an exact-size block never pooled.
     * @param {number} nodeSize Packed R-tree node size.
     * @param {Int32Array} keys Leaf Hilbert codes, read only by merge.
     * @param {Float64Array} boxes Full packed-tree size: leaf MBRs at the front, pack() fills node MBRs into the tail.
     * @param {Uint32Array} indices Flatbush dual-purpose: leaf → global id, node → first child's box offset (after pack()).
     */
    constructor(poolClass, nodeSize, keys, boxes, indices) {
        this.poolClass = poolClass; // size class for the pool, or -1 if not pooled
        this.numItems = 0;       // live leaf count, ≤ capacity; set by takeBlock
        this.nodeSize = nodeSize;
        this.keys = keys;
        this.boxes = boxes;
        this.indices = indices;
        this.packed = false;     // node MBRs not yet computed; pack() sets this on first search
        this.rootPos = 0;        // box offset of the root node; set by pack()
        this.firstBatch = 0;     // range of flush batches this block covers: a leaf copy of id i is live
        this.lastBatch = 0;      // iff batchOf[i] falls within it (set by _flush / merge)
        this.dead = 0;           // number of stale copies among the leaves; 0 guarantees there are none
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
     * @param {Uint32Array} [batchOf] Passed only when the block holds dead copies, to skip them.
     */
    search(minX, minY, maxX, maxY, filterFn, results, batchOf) {
        const boxes = this.boxes, indices = this.indices, firstBatch = this.firstBatch, lastBatch = this.lastBatch;
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
                    continue;
                }
                if (batchOf !== undefined) { // leaf — `index` is the global id; skip it if stale
                    const batch = batchOf[index];
                    if (batch < firstBatch || batch > lastBatch) continue;
                }
                if (filterFn === undefined || filterFn(index, x0, y0, x1, y1)) results.push(index);
            }

            nodeIndex = queue.pop();
        }
    }
}

/**
 * Take a block holding `numItems` from the pool, or allocate one. Pooled arrays are sized to the capacity class
 * B·2ᵏ ≥ numItems, not numItems itself: insert-path blocks are exactly B·2ᵏ so the two coincide, while removals
 * and compaction produce odd sizes — rounding up to the fixed class set makes the pool a clean slab allocator,
 * every freed block reusable by construction. Classes above MAX_POOLED_ITEMS are never reused, so those blocks
 * get exact-size arrays instead (up to ~2× less memory for odd sizes). The pool is free lists indexed by class
 * (the cascade frees same-size pairs, so one slot per class wouldn't suffice). Recycled blocks come back dirty:
 * no zero-fill, since freeze/merge overwrites the leaf portion and pack() the node tail before any search.
 * @param {RBlock[][]} pool free lists indexed by pool class
 * @param {number} numItems
 * @param {number} nodeSize
 * @param {number} bufferSize Base size B; the smallest capacity class (class 0).
 */
function takeBlock(pool, numItems, nodeSize, bufferSize) {
    let poolClass = classOf(numItems, bufferSize), capacity = bufferSize * 2 ** poolClass;
    if (poolClass > 0 && capacity > MAX_POOLED_ITEMS) { poolClass = -1; capacity = numItems; } // never reused: no slack
    const free = pool[poolClass];
    let block;
    if (poolClass >= 0 && free !== undefined && free.length > 0) {
        block = free.pop();
        block.packed = false;     // node MBRs will be rebuilt by pack(); leaf portion gets overwritten now
    } else {
        // total node count of a padded packed tree over `capacity` leaves (Flatbush layout): leaves
        // plus bottom-up parents, every non-root level padded to a full nodeSize multiple (see pack()).
        let e = capacity, numNodes = 1;
        while (e !== 1) { e = Math.ceil(e / nodeSize); numNodes += e * nodeSize; }
        block = new RBlock(poolClass, nodeSize, new Int32Array(capacity), new Float64Array(numNodes * 4), new Uint32Array(numNodes));
    }
    block.numItems = numItems;
    block.dead = 0;
    return block;
}

/**
 * Smallest pool class k with capacity B·2ᵏ ≥ numItems.
 * @param {number} numItems
 * @param {number} bufferSize
 */
function classOf(numItems, bufferSize) {
    let capacity = bufferSize, poolClass = 0;
    while (capacity < numItems) { capacity *= 2; poolClass++; }
    return poolClass;
}

/**
 * Return a relieved block to its free list for reuse by the next block of the same capacity class. Exact-size
 * blocks (above MAX_POOLED_ITEMS; never class 0, which the buffer swap on every flush needs) are left to GC.
 * @param {RBlock[][]} pool
 * @param {RBlock} block
 */
function putBlock(pool, block) {
    if (block.poolClass < 0) return;
    const free = pool[block.poolClass];
    if (free === undefined) pool[block.poolClass] = [block];
    else free.push(block);
}

export default class RBush {
    /**
     * @param {[number, number, number, number]} [domain] Coordinate bounds [minX, minY, maxX, maxY] for the Hilbert grid.
     * @param {number} [bufferSize=256] Items buffered before a block is frozen; also the smallest block size.
     * @param {number} [nodeSize=16] Packed R-tree node size per block.
     */
    constructor(domain = [0, 0, 1, 1], bufferSize = 256, nodeSize = 16) {
        // nodeSize 1 never reduces a level to a single root; a 1-item class is smaller than its padded leaf node
        if (!Number.isInteger(nodeSize) || nodeSize < 2) throw new Error(`nodeSize must be an integer ≥ 2, got ${nodeSize}.`);
        if (!Number.isInteger(bufferSize) || bufferSize < 2) throw new Error(`bufferSize must be an integer ≥ 2, got ${bufferSize}.`);

        this.bufferSize = bufferSize;
        this.nodeSize = nodeSize;
        this.size = 0;                                  // number of live items

        this._nextId = 0;                                // next never-used id
        this._freeIds = [];                              // removed ids, reused LIFO by add
        this._batch = 1;                                 // current flush batch: the buffer's items belong to it
        this._batchOf = new Uint32Array(bufferSize);     // id → batch of its live copy, 0 if not live

        const [minX, minY, maxX, maxY] = domain;
        this._minX = minX;
        this._minY = minY;
        this._scaleX = HILBERT_MAX / ((maxX - minX) || 1); // center → [0, HILBERT_MAX] grid
        this._scaleY = HILBERT_MAX / ((maxY - minY) || 1);

        this._pool = [];                                 // pool class → free list of relieved blocks for reuse
        this._n = 0;                                     // items currently in the buffer
        this._blocks = [];                               // frozen blocks in age order, oldest first
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
        let id;
        if (this._freeIds.length > 0) id = /** @type {number} */ (this._freeIds.pop());
        else {
            id = this._nextId++;
            if (id === this._batchOf.length) { // grow by doubling; new entries are 0 (not live)
                const batchOf = new Uint32Array(id * 2);
                batchOf.set(this._batchOf);
                this._batchOf = batchOf;
            }
        }
        this.size++;
        this._append(id, minX, minY, maxX, maxY);
        return id;
    }

    /**
     * Remove an item by id. Its id becomes free for reuse by a later add.
     * @param {number} id
     */
    remove(id) {
        const batch = this._liveBatch(id);
        this._batchOf[id] = 0;
        if (batch === this._batch) { // still in the buffer: swap the last buffered item into its slot
            const buffer = this._buffer, boxes = buffer.boxes, ids = buffer.indices;
            const i = this._bufferSlot(id), last = --this._n;
            ids[i] = ids[last];
            boxes.copyWithin(i * 4, last * 4, last * 4 + 4);
        } else {
            this._markDead(this._indexOf(batch));
        }
        this._freeIds.push(id);
        this.size--;
    }

    /**
     * Change an item's box, keeping its id.
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} [maxX=minX]
     * @param {number} [maxY=minY]
     */
    update(id, minX, minY, maxX = minX, maxY = minY) {
        const batch = this._liveBatch(id);
        if (batch === this._batch) { // still in the buffer: overwrite in place
            const boxes = this._buffer.boxes, p = this._bufferSlot(id) * 4;
            boxes[p] = minX; boxes[p + 1] = minY; boxes[p + 2] = maxX; boxes[p + 3] = maxY;
        } else { // the block copy goes stale and a fresh one enters the buffer under the same id
            const index = this._indexOf(batch);
            this._batchOf[id] = this._batch;
            this._markDead(index);
            this._append(id, minX, minY, maxX, maxY);
        }
    }

    /** @param {number} id */
    _liveBatch(id) {
        const batch = this._batchOf[id];
        if (!(batch > 0)) throw new Error(`Item ${id} is not in the tree.`);
        return batch;
    }

    /** @param {number} id */
    _bufferSlot(id) {
        const ids = this._buffer.indices;
        for (let i = 0; i < this._n; i++) if (ids[i] === id) return i;
        throw new Error(`Item ${id} is missing from the buffer.`); // unreachable while batchOf is consistent
    }

    /** @param {number} batch */
    _indexOf(batch) {
        const blocks = this._blocks;
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (batch >= blocks[i].firstBatch && batch <= blocks[i].lastBatch) return i;
        }
        throw new Error(`No block holds batch ${batch}.`); // unreachable while batchOf is consistent
    }

    /**
     * Count one more stale copy in block `i` (its id's batchOf must already be changed). Once more than half the
     * block is stale, rebuild it from its live leaves: O(m) against ≥ m/2 removals, amortized O(1) each.
     * @param {number} i
     */
    _markDead(i) {
        const block = this._blocks[i];
        if (++block.dead * 2 > block.numItems) this._mergeRange(i, i);
    }

    /**
     * Replace blocks lo..hi (adjacent in age) with one merged block, dropping dead copies; remove them altogether
     * if nothing in them is live (a 0-item block can't be packed).
     * @param {number} lo
     * @param {number} hi
     */
    _mergeRange(lo, hi) {
        const blocks = this._blocks;
        let run = blocks[hi];
        for (let i = hi - 1; i >= lo; i--) run = merge(blocks[i], run, this._pool, this.bufferSize, this._batchOf);
        if (run.dead > 0) { // a lone block never went through merge
            dropDead(run, this._batchOf);
            run = shrink(run, this._pool, this.bufferSize);
        }
        if (run.numItems > 0) {
            blocks.splice(lo, hi - lo + 1, run);
        } else {
            putBlock(this._pool, run);
            blocks.splice(lo, hi - lo + 1);
        }
    }

    /**
     * Merge the buffer and all blocks into a single block, dropping dead copies. Worth calling once an incremental
     * build is done and the tree is mostly queried: up to ~log₂(n/B) block descents per search become one.
     */
    compact() {
        if (this._n > 0) this._flush();
        if (this._blocks.length > 0) this._mergeRange(0, this._blocks.length - 1);
    }

    /**
     * @param {number} id
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    _append(id, minX, minY, maxX, maxY) {
        this._batchOf[id] = this._batch;
        const boxes = this._buffer.boxes;
        const p = this._n * 4;
        boxes[p] = minX;
        boxes[p + 1] = minY;
        boxes[p + 2] = maxX;
        boxes[p + 3] = maxY;
        this._buffer.indices[this._n] = id;
        if (++this._n === this.bufferSize) this._flush();
    }

    /**
     * Freeze the full buffer into a Hilbert-sorted block and merge it down the stack while the newest block is less
     * than twice the carry. With fixed-size flushes this is exactly the binary counter (sizes B·2ⁱ); with the odd
     * sizes left by compact() and dropped dead items, each block still ends up more than twice the size of the next
     * newer one, so there are O(log n) blocks. (Merging only while newest ≤ carry would let a slightly oversized
     * block stop every carry just short of it, piling up near-equal blocks.)
     */
    _flush() {
        const pool = this._pool;
        const n = this._n;

        // The buffer is already a class-0 block, so freezing is an in-place sort: compute Hilbert keys,
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
        run.numItems = n; // less than bufferSize only when compact() freezes a partial buffer
        run.firstBatch = run.lastBatch = this._batch++;
        this._n = 0;
        this._buffer = takeBlock(pool, this.bufferSize, this.nodeSize, this.bufferSize); // borrow a fresh buffer block

        const blocks = this._blocks;
        while (blocks.length > 0 && blocks[blocks.length - 1].numItems < 2 * run.numItems) {
            run = merge(/** @type {RBlock} */ (blocks.pop()), run, pool, this.bufferSize, this._batchOf);
        }
        blocks.push(run); // settles as an unpacked leaf run
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
        // padding sentinels (+∞ min, −∞ max) pass the overlap test against infinite query bounds
        if (minX < -Number.MAX_VALUE) minX = -Number.MAX_VALUE;
        if (minY < -Number.MAX_VALUE) minY = -Number.MAX_VALUE;
        if (maxX > Number.MAX_VALUE) maxX = Number.MAX_VALUE;
        if (maxY > Number.MAX_VALUE) maxY = Number.MAX_VALUE;

        const results = [];

        // indexed, not for…of: once V8 inlines the block search here, the iterator's implicit try-block makes
        // it ~20% slower
        const blocks = this._blocks;
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            if (!block.packed) block.pack(); // lazily build node MBRs on first search
            block.search(minX, minY, maxX, maxY, filterFn, results, block.dead > 0 ? this._batchOf : undefined);
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
 * Dead copies are dropped; the output is empty only if both inputs hold nothing live.
 * @param {RBlock} a The older block.
 * @param {RBlock} b The newer block (in the flush cascade, the carry: never dirty or empty).
 * @param {RBlock[][]} pool
 * @param {number} bufferSize Base size B, for the output's capacity class.
 * @param {Uint32Array} batchOf
 */
function merge(a, b, pool, bufferSize, batchOf) {
    const firstBatch = a.firstBatch, lastBatch = b.lastBatch;

    // filter in place up front (inputs are consumed anyway), so the merge loop below stays branch-free
    if (a.dead > 0) dropDead(a, batchOf);
    if (b.dead > 0) dropDead(b, batchOf);
    if (a.numItems === 0 || b.numItems === 0) { // one side all dead: the other goes on, covering both ranges
        const keep = a.numItems === 0 ? b : a;
        putBlock(pool, keep === a ? b : a);
        keep.firstBatch = firstBatch;
        keep.lastBatch = lastBatch;
        return shrink(keep, pool, bufferSize);
    }

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
    out.firstBatch = firstBatch;
    out.lastBatch = lastBatch;
    return out;
}

/**
 * Compact a block's leaf run in place, keeping only live copies (batchOf within the block's batch range).
 * @param {RBlock} block
 * @param {Uint32Array} batchOf
 */
function dropDead(block, batchOf) {
    const {keys, boxes, indices, firstBatch, lastBatch, numItems} = block;
    let k = 0;
    for (let i = 0; i < numItems; i++) {
        const batch = batchOf[indices[i]];
        if (batch < firstBatch || batch > lastBatch) continue;
        if (k !== i) {
            keys[k] = keys[i];
            indices[k] = indices[i];
            const sp = i * 4, dp = k * 4;
            boxes[dp] = boxes[sp]; boxes[dp + 1] = boxes[sp + 1]; boxes[dp + 2] = boxes[sp + 2]; boxes[dp + 3] = boxes[sp + 3];
        }
        k++;
    }
    block.numItems = k;
    block.dead = 0;
    block.packed = false;
}

/**
 * Move a block's leaves into a fresh block if that would at least halve its allocation (the next smaller class
 * for a pooled block; for an exact-size one, once its live items fit in half its capacity).
 * @param {RBlock} block
 * @param {RBlock[][]} pool
 * @param {number} bufferSize
 */
function shrink(block, pool, bufferSize) {
    const n = block.numItems;
    if (n === 0 || block.poolClass === 0 || n * 2 > block.keys.length) return block;
    const out = takeBlock(pool, n, block.nodeSize, bufferSize);
    appendTail(block.keys, block.boxes, block.indices, 0, n, out.keys, out.boxes, out.indices, 0);
    out.firstBatch = block.firstBatch;
    out.lastBatch = block.lastBatch;
    putBlock(pool, block);
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
