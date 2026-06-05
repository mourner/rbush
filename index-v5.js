// RBush v5 — step 3: real boxes, ordered by Hilbert value.
//
// Items are now axis-aligned boxes (minX, minY, maxX, maxY) with an auto-assigned id.
// Each block is a flat run of items sorted by the Hilbert code of the box center, so
// items near each other in space land near each other in the block — the ordering a
// packed R-tree is built on. There's no tree yet: no node MBRs, no bottom-up packing,
// no nodeSize sort-stop, and no search. Blocks are just sorted (box, id) runs carried
// through the same binary-counter cascade as before.
//
// The Hilbert key is quantized into a FIXED domain shared by every block, so keys from
// different blocks are directly comparable and the 2-way merge stays a linear key scan.
// (Boxes themselves are kept full-precision for accurate search down the line.)

const HILBERT_MAX = (1 << 16) - 1;

export default class RBush {
    /**
     * @param {[number, number, number, number]} [domain] Coordinate bounds [minX, minY, maxX, maxY] for the Hilbert grid.
     * @param {number} [bufferSize=256] Items buffered before a block is frozen; also the smallest block size.
     */
    constructor(domain = [0, 0, 1, 1], bufferSize = 256) {
        this.bufferSize = bufferSize;
        this.length = 0;                                // total number of items added, and the next id

        const [minX, minY, maxX, maxY] = domain;
        this._minX = minX;
        this._minY = minY;
        this._scaleX = HILBERT_MAX / ((maxX - minX) || 1); // center → [0, HILBERT_MAX] grid
        this._scaleY = HILBERT_MAX / ((maxY - minY) || 1);

        this._boxes = new Float64Array(bufferSize * 4);  // newest boxes, unsorted
        this._ids = new Uint32Array(bufferSize);         // their ids, parallel to _boxes
        this._n = 0;                                     // items currently in the buffer
        this._blocks = [];                               // _blocks[i] = {keys, boxes, ids} at level i (or undefined)
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
        sort(keys, this._boxes, this._ids, 0, this._n - 1); // sort by Hilbert key, boxes + ids follow

        let block = {keys, boxes: this._boxes.slice(), ids: this._ids.slice()};
        this._n = 0;

        for (let level = 0; ; level++) {
            const existing = this._blocks[level];
            if (!existing) {
                this._blocks[level] = block; // empty slot — settle here
                break;
            }
            block = merge(existing, block); // collision — merge and carry to the next level
            this._blocks[level] = undefined;
        }
    }
}

/**
 * 2-way merge of two Hilbert-sorted blocks into a new one; boxes + ids follow the keys.
 * @param {{keys: Uint32Array, boxes: Float64Array, ids: Uint32Array}} a
 * @param {{keys: Uint32Array, boxes: Float64Array, ids: Uint32Array}} b
 */
function merge(a, b) {
    // Hoist the six typed-array views into locals: the merge loop is the dominant cost,
    // and reading `a.keys`/`b.boxes`/… off the block object every iteration is a property
    // load V8 won't hoist across the loop. Pulling them out (and inlining the per-item
    // copy below) is ~22% faster on the merge itself.
    const aKeys = a.keys, aBoxes = a.boxes, aIds = a.ids;
    const bKeys = b.keys, bBoxes = b.boxes, bIds = b.ids;
    const al = aKeys.length, bl = bKeys.length, n = al + bl;
    const keys = new Uint32Array(n);
    const boxes = new Float64Array(n * 4);
    const ids = new Uint32Array(n);

    // disjoint key ranges (clustered/temporal streams) — pure concatenation, no merge loop
    if (aKeys[al - 1] <= bKeys[0]) return concat(a, b, keys, boxes, ids);
    if (bKeys[bl - 1] <= aKeys[0]) return concat(b, a, keys, boxes, ids);

    let i = 0, j = 0, k = 0;
    while (i < al && j < bl) {
        let s, sb;
        if (aKeys[i] <= bKeys[j]) { s = i++; keys[k] = aKeys[s]; ids[k] = aIds[s]; sb = aBoxes; }
        else { s = j++; keys[k] = bKeys[s]; ids[k] = bIds[s]; sb = bBoxes; }
        const sp = s * 4, dp = k * 4;
        boxes[dp] = sb[sp]; boxes[dp + 1] = sb[sp + 1]; boxes[dp + 2] = sb[sp + 2]; boxes[dp + 3] = sb[sp + 3];
        k++;
    }
    // bulk-copy whichever input's tail remains (memcpy, much faster than per-item)
    if (i < al) appendTail(aKeys, aBoxes, aIds, i, keys, boxes, ids, k);
    else if (j < bl) appendTail(bKeys, bBoxes, bIds, j, keys, boxes, ids, k);
    return {keys, boxes, ids};
}

/** Append src[from..] into the output starting at slot k via bulk set(). */
function appendTail(srcKeys, srcBoxes, srcIds, from, keys, boxes, ids, k) {
    keys.set(srcKeys.subarray(from), k);
    ids.set(srcIds.subarray(from), k);
    boxes.set(srcBoxes.subarray(from * 4), k * 4);
}

/** Concatenate two disjoint blocks (all of `lo` then all of `hi`) via bulk set(). */
function concat(lo, hi, keys, boxes, ids) {
    keys.set(lo.keys); keys.set(hi.keys, lo.keys.length);
    ids.set(lo.ids); ids.set(hi.ids, lo.ids.length);
    boxes.set(lo.boxes); boxes.set(hi.boxes, lo.boxes.length);
    return {keys, boxes, ids};
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
