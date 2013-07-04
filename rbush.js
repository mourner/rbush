(function () { 'use strict';

var rbush = function (maxFill) {
    if (!(this instanceof rbush)) {
        // jshint newcap: false
        return new rbush(maxFill);
    }
    this._maxFill = maxFill;
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
        this.data = {};
        this.data.children = [];

        if (!this._maxFill) {
            this._maxFill = Math.max(Math.ceil(data.length / 1000), 6);
        }

        this._buildFromTop(data);
        this._calcBBoxes(this.data);

        return this;
    },

    addOne: function (item) {
        var node = this._chooseSubtree(this.toBBox(item), this.data);
        // TODO reinsert, split (choose split axis, choose split index), insert
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
            overlap = child.leaf && this._overlapArea(bbox, child);

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

    _area: function (bbox) {
        return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
    },

    _enlargedArea: function (bbox, bbox2) {
        return (Math.max(bbox2[2], bbox[2]) - Math.min(bbox2[0], bbox[0])) *
               (Math.max(bbox2[3], bbox[3]) - Math.min(bbox2[1], bbox[1]));
    },

    _overlapArea: function (bbox, node) {
        for (var i = 0, sum = 0, len = node.children.length; i < len; i++) {
            sum += this._intersectionArea(this.toBBox(node.children[i]), bbox);
        }
        return sum;
    },

    _intersectionArea: function (bbox, bbox2) {
        var minX = Math.max(bbox[0], bbox2[0]),
            maxX = Math.min(bbox[2], bbox2[2]),
            minY = Math.max(bbox[1], bbox2[1]),
            maxY = Math.min(bbox[3], bbox2[3]);

        return Math.max(maxX - minX, 0) *
               Math.max(maxY - minY, 0);
    },

    // bulk load data with the OMT algorithm
    _buildFromTop: function (data) {

        var N = data.length,           // number of items
            S = this._numTopSlices(N), // number of slices for levels 0 and 1
            N1 = Math.ceil(N / S),     // size of each root node
            N2 = Math.ceil(N1 / S),    // size of each node of the next level after root

            items = data.slice().sort(this.sortX),
            i, j, slice, node;

        // create S x S nodes for the root and build the rest recursively
        for (i = 0; i < N; i += N1) {
            slice = items.slice(i, i + N1).sort(this.sortY);

            for (j = 0; j < N1; j += N2) {
                node = this._build(slice.slice(j, j + N2), 1);
                this.data.children.push(node);
            }
        }
    },

    _build: function (items, level) {

        var node = {},
            len = items.length,
            k = Math.ceil(len / this._maxFill), // size of each child node
            i, childNode;

        if (k < 2) {
            node.children = items;
            node.leaf = true;
            return node;
        }

        // split by different plane each time - x, y, x, y, etc.
        items.sort(level % 2 ? this.sortX : this.sortY);

        node.children = [];

        for (i = 0; i < len; i += k) {
            childNode = this._build(items.slice(i, i + k), level + 1);
            node.children.push(childNode);
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

    _numTopSlices: function (N) {

        var M = this._maxFill,                             // max number of branches in one node
            h = Math.ceil(Math.log(N) / Math.log(M)),      // target height of the tree
            Ns = Math.pow(M, h - 1),                       // max number of tree nodes
            S = Math.floor(Math.sqrt(Math.ceil(N / Ns)));  // target number of level 0-1 branches

        return Math.max(S, 2);
    },

    _search: function (bbox, node, result) {

        if (!this._intersects(bbox, node.bbox)) { return; }

        var i, child,
            len = node.children.length;

        for (i = 0; i < len; i++) {
            child = node.children[i];

            if (!node.leaf) {
                this._search(bbox, child, result);
            } else if (this._contains(bbox, this.toBBox(child))) {
                result.push(child);
            }
        }
    },

    _intersects: function (bbox, bbox2) {
        return bbox2[0] <= bbox[2] &&
               bbox2[1] <= bbox[3] &&
               bbox2[2] >= bbox[0] &&
               bbox2[3] >= bbox[1];
    },

    _contains: function (bbox, bbox2) {
        return bbox2[0] >= bbox[0] &&
               bbox2[1] >= bbox[1] &&
               bbox2[2] <= bbox[2] &&
               bbox2[3] <= bbox[3];
    },

    _extend: function (bbox, bbox2) {
        bbox[0] = Math.min(bbox[0], bbox2[0]);
        bbox[1] = Math.min(bbox[1], bbox2[1]);
        bbox[2] = Math.max(bbox[2], bbox2[2]);
        bbox[3] = Math.max(bbox[3], bbox2[3]);
    }
};

if (typeof module !== 'undefined') {
    module.exports = rbush;
} else {
    window.rbush = rbush;
}

})();
