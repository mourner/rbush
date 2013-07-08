/*
 (c) 2013, Vladimir Agafonkin
 RBush, a JavaScript library for high-performance 2D spatial indexing of points and rectangles.
 https://github.com/mourner/rbush
*/

(function () { 'use strict';

function rbush(maxFill, minFill) {
    if (!(this instanceof rbush)) {
        // jshint newcap: false
        return new rbush(maxFill, minFill);
    }

    if (!maxFill) {
        throw new Error("Provide a maxFill argument to rbush constructor");
    }
    this._maxFill = Math.max(4, maxFill);

    if (!this._minFill) {
        this._minFill = Math.max(2, Math.floor(this._maxFill * 0.4));
    }
    this._minFill = minFill;
};

rbush.prototype = {

    // redefine the next 3 methods to suit your data format

    // compare functions for sorting by x and y coordinate
    sortX: function (a, b) { return a[0] > b[0] ? 1 : -1; },
    sortY: function (a, b) { return a[1] > b[1] ? 1 : -1; },

    // get bounding box in the form of [minX, minY, maxX, maxY] given a data item
    toBBox: function (a) { return a; },

    // recursively search for objects in a given bbox
    search: function (bbox) {
        var result = [];
        this._search(bbox, this.data, result);
        return result;
    },

    // bulk load all data and recursively build the tree from stratch
    load: function (data) {
        this.data = this._build(data.slice(), 0);
        this._calcBBoxes(this.data);

        return this;
    },

    addOne: function (item) {
        var node = this._chooseSubtree(this.toBBox(item), this.data);
        // TODO reinsert, split (choose split axis, choose split index), insert
    },

    toJSON: function () {
        return this.data;
    },

    fromJSON: function (data) {
        this.data = data;
        return this;
    },

    _search: function (bbox, node, result) {

        if (!this._intersects(bbox, node.bbox)) { return; }

        var i, child,
            len = node.children.length;

        for (i = 0; i < len; i++) {
            child = node.children[i];

            if (!node.leaf) {
                this._search(bbox, child, result);
            } else if (this._intersects(bbox, this.toBBox(child))) {
                result.push(child);
            }
        }
    },

    // bulk load data with the OMT algorithm
    _build: function (items, level) {

        var node = {},
            N = items.length,
            M = this._maxFill;

        if (N <= M) {
            node.children = items;
            node.leaf = true;
            return node;
        }

        node.children = [];

        if (!level) {
            // target number of root entries
            M = Math.ceil(N / Math.pow(M, Math.ceil(Math.log(N) / Math.log(M)) - 1));

            items.sort(this.sortX);
        }

        var N1 = Math.ceil(N / M) * Math.ceil(Math.sqrt(M)),
            N2 = Math.ceil(N / M),
            sortFn = level % 2 === 1 ? this.sortX : this.sortY,
            i, j, slice, sliceLen, childNode;

        // create S x S entries for the node and build from there recursively
        for (i = 0; i < N; i += N1) {
            slice = items.slice(i, i + N1).sort(sortFn);

            for (j = 0, sliceLen = slice.length; j < sliceLen; j += N2) {
                childNode = this._build(slice.slice(j, j + N2), level + 1);
                node.children.push(childNode);
            }
        }

        return node;
    },

    // recursively calculate all node bboxes in the tree
    _calcBBoxes: function (node) {

        node.bbox = [Infinity, Infinity, -Infinity, -Infinity];

        for (var i = 0, len = node.children.length, child; i < len; i++) {
            child = node.children[i];

            if (node.leaf) {
                this._extend(node.bbox, this.toBBox(child));
            } else {
                this._calcBBoxes(child);
                this._extend(node.bbox, child.bbox);
            }
        }
    },

    _chooseSubtree: function (bbox, node) {

        if (node.leaf) { return node; }

        var i, len, child, targetNode,
            area, enlargement, overlap, minArea, minEnlargement, minOverlap;

        minArea = minEnlargement = minOverlap = Infinity;

        for (var i = 0, len = node.children.length; i < len; i++) {
            child = node.children[i];

            area = this._area(child.bbox);
            enlargement = this._enlargedArea(bbox, child.bbox) - area;
            // overlap = child.leaf && this._overlapArea(bbox, child);

            // choose the node with the least overlap
            if (overlap < minOverlap) {
                minOverlap = overlap;
                targetNode = child;

            } else if (!overlap || overlap === minOverlap) {
                // otherwise choose one with the least area enlargement
                if (enlargement < minEnlargement) {
                    minEnlargement = enlargement;
                    targetNode = child;

                } else if (enlargement === minEnlargement) {
                    // otherwise choose one with the smallest area
                    if (area < minArea) {
                        minArea = area;
                        targetNode = child;
                    }
                }
            }
        }

        return this._chooseSubtree(bbox, targetNode);
    },

    _intersects: function (bbox, bbox2) {
        return bbox2[0] <= bbox[2] &&
               bbox2[1] <= bbox[3] &&
               bbox2[2] >= bbox[0] &&
               bbox2[3] >= bbox[1];
    },

    _extend: function (bbox, bbox2) {
        bbox[0] = Math.min(bbox[0], bbox2[0]);
        bbox[1] = Math.min(bbox[1], bbox2[1]);
        bbox[2] = Math.max(bbox[2], bbox2[2]);
        bbox[3] = Math.max(bbox[3], bbox2[3]);
    },

    _area: function (bbox) {
        return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
    },

    _enlargedArea: function (bbox, bbox2) {
        return (Math.max(bbox2[2], bbox[2]) - Math.min(bbox2[0], bbox[0])) *
               (Math.max(bbox2[3], bbox[3]) - Math.min(bbox2[1], bbox[1]));
    },

    _overlapArea: function (bbox, node) {
        for (var i = 0, sum = 0, len = node.children.length, bbox2; i < len; i++) {
            bbox2 = this.toBBox(node.children[i]);
            sum += this._intersects(bbox, bbox2) ? this._intersectionArea(bbox, bbox2) : 0;
        }
        return sum;
    },

    _intersectionArea: function (bbox, bbox2) {
        var minX = Math.max(bbox[0], bbox2[0]),
            maxX = Math.min(bbox[2], bbox2[2]),
            minY = Math.max(bbox[1], bbox2[1]),
            maxY = Math.min(bbox[3], bbox2[3]);

        return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
    }
};

if (typeof module !== 'undefined') {
    module.exports = rbush;
} else {
    window.rbush = rbush;
}

})();
