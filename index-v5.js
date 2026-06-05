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
// Per-block storage layout (held until serialization): each block owns separate typed
// arrays — `boxes` (leaf MBRs then node MBRs, bottom-up), `indices` (leaf → global id,
// node → child box offset), `keys` (leaf Hilbert keys, for merging), plus `numItems`,
// `nodeSize`, `levelBounds`. Separate arrays make build/merge/replacement trivial.

const HILBERT_MAX = (1 << 16) - 1;

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
        const keys = new Uint32Array(this._n);
        for (let i = 0; i < this._n; i++) {
            const p = i * 4;
            const x = (this._scaleX * ((boxes[p] + boxes[p + 2]) / 2 - this._minX)) | 0;
            const y = (this._scaleY * ((boxes[p + 1] + boxes[p + 3]) / 2 - this._minY)) | 0;
            keys[i] = hilbert(clamp(x), clamp(y));
        }
        const n = this._n;
        sort(keys, this._boxes, this._ids, 0, n - 1); // sort by Hilbert key, boxes + ids follow

        // The carried value is a cheap leaf-only run (keys + leaf boxes + ids), packed into a
        // full tree only once it settles. Intermediate carry blocks are immediately re-merged,
        // so packing their node MBRs would be wasted work.
        let run = {numItems: n, nodeSize: this.nodeSize, keys, boxes: this._boxes.slice(0, n * 4), indices: this._ids.slice(0, n)};
        this._n = 0;

        for (let level = 0; ; level++) {
            const existing = this._blocks[level];
            if (!existing) {
                this._blocks[level] = run; // empty slot — settle here as an unpacked leaf run
                break;
            }
            run = merge(existing, run); // collision — merge leaves and carry to the next level
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
            if (block.levelBounds === undefined) pack(block); // lazily build node MBRs on first search
            searchBlock(block, minX, minY, maxX, maxY, filterFn, results);
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
 * Lazily pack a settled leaf run into a full Flatbush-style block by generating its node
 * MBRs bottom-up. This is deferred until the block is first searched: a block that gets
 * merged away before any query never needs its tree (merge reads only leaves), so under an
 * insert-heavy workload almost all packing is skipped. Mutates `block` in place (adds the
 * node MBRs to `boxes`/`indices` and sets `levelBounds`); idempotent via the caller's guard.
 * @param {{numItems: number, nodeSize: number, keys: Uint32Array, boxes: Float64Array, indices: Uint32Array, levelBounds?: number[]}} block
 */
function pack(block) {
    const {numItems, nodeSize} = block;

    // count nodes per level (Flatbush layout) and the box-offset bound of each level
    let n = numItems, numNodes = n;
    const levelBounds = [n * 4];
    do {
        n = Math.ceil(n / nodeSize);
        numNodes += n;
        levelBounds.push(numNodes * 4);
    } while (n !== 1);

    // grow the leaf arrays to hold node MBRs (the leaf portion stays valid for future merges)
    const boxes = new Float64Array(numNodes * 4);
    const indices = new Uint32Array(numNodes);
    boxes.set(block.boxes.subarray(0, numItems * 4));
    indices.set(block.indices.subarray(0, numItems));

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

    block.boxes = boxes;
    block.indices = indices;
    block.levelBounds = levelBounds;
}

/**
 * Standard Flatbush range descent over one packed block; pushes matching global ids into `results`.
 * @param {{numItems: number, nodeSize: number, boxes: Float64Array, indices: Uint32Array, levelBounds: number[]}} block
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @param {((id: number, minX: number, minY: number, maxX: number, maxY: number) => boolean) | undefined} filterFn
 * @param {number[]} results
 */
function searchBlock(block, minX, minY, maxX, maxY, filterFn, results) {
    const boxes = block.boxes, indices = block.indices, levelBounds = block.levelBounds;
    const nodeSize = block.nodeSize, leafEnd = block.numItems * 4;

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
 * build() packs the tree once the run finally settles.
 * @param {{numItems: number, nodeSize: number, keys: Uint32Array, boxes: Float64Array, indices: Uint32Array}} a
 * @param {{numItems: number, nodeSize: number, keys: Uint32Array, boxes: Float64Array, indices: Uint32Array}} b
 */
function merge(a, b) {
    // Hoist the six typed-array views into locals: the merge loop is the dominant cost,
    // and reading `a.keys`/`b.boxes`/… off the block object every iteration is a property
    // load V8 won't hoist across the loop. Pulling them out (and inlining the per-item
    // copy below) is ~22% faster on the merge itself.
    const aKeys = a.keys, aBoxes = a.boxes, aIds = a.indices;
    const bKeys = b.keys, bBoxes = b.boxes, bIds = b.indices;
    const al = a.numItems, bl = b.numItems, n = al + bl;
    const keys = new Uint32Array(n);
    const boxes = new Float64Array(n * 4);
    const ids = new Uint32Array(n);

    // disjoint key ranges (clustered/temporal streams) — pure concatenation, no merge loop
    if (aKeys[al - 1] <= bKeys[0]) return concat(a, b, keys, boxes, ids);
    if (bKeys[bl - 1] <= aKeys[0]) return concat(b, a, keys, boxes, ids);

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
    return {numItems: n, nodeSize: a.nodeSize, keys, boxes, indices: ids};
}

/** Append the leaf run src[from..numItems) into the output starting at slot k via bulk set(). */
function appendTail(srcKeys, srcBoxes, srcIds, from, numItems, keys, boxes, ids, k) {
    keys.set(srcKeys.subarray(from, numItems), k);
    ids.set(srcIds.subarray(from, numItems), k);
    boxes.set(srcBoxes.subarray(from * 4, numItems * 4), k * 4);
}

/** Concatenate two disjoint leaf runs (all of `lo` then all of `hi`) into a new run. */
function concat(lo, hi, keys, boxes, ids) {
    const ll = lo.numItems, hl = hi.numItems;
    keys.set(lo.keys.subarray(0, ll)); keys.set(hi.keys.subarray(0, hl), ll);
    ids.set(lo.indices.subarray(0, ll)); ids.set(hi.indices.subarray(0, hl), ll);
    boxes.set(lo.boxes.subarray(0, ll * 4)); boxes.set(hi.boxes.subarray(0, hl * 4), ll * 4);
    return {numItems: ll + hl, nodeSize: lo.nodeSize, keys, boxes, indices: ids};
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

/** Clamp a quantized coordinate into the Hilbert grid. */
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
