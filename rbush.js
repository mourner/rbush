/*
 (c) 2013, Vladimir Agafonkin
 RBush, a JavaScript library for high-performance 2D spatial indexing of points and rectangles.
 https://github.com/mourner/rbush
*/

(function () { 'use strict';

function rbush(maxEntries, format) {
    // jshint newcap: false, validthis: true, evil: true

    if (!(this instanceof rbush)) {
        // allow constructing RBush trees without "new"
        return new rbush(maxEntries, format);
    }

    if (!maxEntries) {
        // maxEntries is required because it's the most important performance decision when using RBush
        // and depens on the type of data and search queries you perform
        throw new Error("Provide a maxEntries argument to rbush constructor");
    }

    this._maxEntries = Math.max(4, maxEntries);
    this._minFill = Math.max(2, Math.floor(this._maxEntries * 0.4));

    // data format (minX, minY, maxX, maxY accessors),
    // uses eval-type function compilation instead of accepting functions to simplify customization;
    // performance is not affected since this happens only once

    format = format || ['[0]', '[1]', '[2]', '[3]'];

    this._sortMinX = this._createSort(format[0]);
    this._sortMinY = this._createSort(format[1]);
    this._sortMaxX = this._createSort(format[2]);
    this._sortMaxY = this._createSort(format[3]);

    this._sortNodeMinX = this._createSort('.bbox[0]');
    this._sortNodeMinY = this._createSort('.bbox[1]');
    this._sortNodeMaxX = this._createSort('.bbox[2]');
    this._sortNodeMaxY = this._createSort('.bbox[3]');

    this._toBBox = new Function('a', 'return [a' + format.join(', a') + '];');
}

rbush.prototype = {

    search: function (bbox) {
        var result = [];

        // recursively search for items in a given bbox, collecting matches in the result array
        this._search(bbox, this.data, result);

        return result;
    },

    load: function (data) {
        // recursively build the tree with the given data from stratch using OMT algorithm
        this.data = this._build(data.slice(), 0);

        // recursively calculate all bboxes
        this._calcBBoxes(this.data, true);

        return this;
    },

    insert: function (item) {
        // an index of what tree levels overflowed during this single insert
        this._overflowLevels = {};

        this._insert(item);

        return this;
    },

    toJSON: function () {
        // TODO cleanup nodes from area, enlargement, sqDist properties
        return this.data;
    },

    fromJSON: function (data) {
        this.data = data;
        return this;
    },

    _search: function (bbox, node, result) {

        if (!this._intersects(bbox, node.bbox)) { return; }

        for (var i = 0, len = node.children.length, child; i < len; i++) {
            child = node.children[i];

            if (!node.leaf) {
                this._search(bbox, child, result);
            } else if (this._intersects(bbox, this._toBBox(child))) {
                result.push(child);
            }
        }
    },

    _build: function (items, level) {

        var node = {},
            N = items.length,
            M = this._maxEntries;

        if (N <= M) {
            node.children = items;
            node.leaf = true;
            return node;
        }

        node.children = [];

        if (!level) {
            // target number of root entries to maximize storage utilization
            M = Math.ceil(N / Math.pow(M, Math.ceil(Math.log(N) / Math.log(M)) - 1));

            items.sort(this._sortMinX);
        }

        var N1 = Math.ceil(N / M) * Math.ceil(Math.sqrt(M)),
            N2 = Math.ceil(N / M),
            sortFn = level % 2 === 1 ? this._sortMinX : this._sortMinY,
            i, j, slice, sliceLen, childNode;

        // split the items into M mostly square tiles
        for (i = 0; i < N; i += N1) {
            slice = items.slice(i, i + N1).sort(sortFn);

            for (j = 0, sliceLen = slice.length; j < sliceLen; j += N2) {
                // pack each entry recursively
                childNode = this._build(slice.slice(j, j + N2), level + 1);
                node.children.push(childNode);
            }
        }

        return node;
    },

    _chooseSubtree: function (bbox, node, level, path) {

        path.push(node);

        if (node.leaf || path.length - 1 === level) { return node; }

        var i, child, targetNode, area, enlargement, overlap, checkOverlap, minArea, minEnlargement, minOverlap,
            len = node.children.length;

        minArea = minEnlargement = minOverlap = Infinity;

        // calculate area and enlargement for node entries preliminarily for faster sorting
        for (i = 0; i < len; i++) {
            child = node.children[i];

            child.area = this._area(child.bbox);
            child.enlargement = this._enlargedArea(bbox, child.bbox) - child.area;
        }

        if (node.children[0].leaf) {
            // if node children are leaves, narrow our search to 32 rectangles with the least area enlargement
            node.children.sort(this._sortEnlargement);
            len = Math.min(32, len);
            checkOverlap = true;
        }

        for (i = 0; i < len; i++) {
            child = node.children[i];
            area = child.area;
            enlargement = child.enlargement;

            if (checkOverlap) {
                overlap = this._overlapArea(bbox, child, node.children, len);
            }

            // choose entry with the least overlap enlargement
            if (checkOverlap && overlap < minOverlap) {
                minOverlap = overlap;
                minEnlargement = enlargement < minEnlargement ? enlargement : minEnlargement;
                minArea = area < minArea ? area : minArea;
                targetNode = child;

            } else if (!checkOverlap || overlap === minOverlap) {

                // otherwise choose entry with the least area enlargement
                if (enlargement < minEnlargement) {
                    minEnlargement = enlargement;
                    minArea = area < minArea ? area : minArea;
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

        return this._chooseSubtree(bbox, targetNode || child, level, path);
    },

    _insert: function (item, level, isNode, root) {
        var bbox = isNode ? item.bbox : this._toBBox(item),
            insertPath = [];

        // recursively find the best node for accommodating the item, saving all nodes along the path too
        var node = this._chooseSubtree(bbox, root || this.data, level, insertPath),
            splitOccured;

        if (typeof level === 'undefined') {
            level = insertPath.length - 1;
        }

        // put the item into the node
        node.children.push(item);

        this._extend(node.bbox, bbox);

        // deal with node overflow if it happened
        do {
            splitOccured = false;
            if (insertPath[level].children.length > this._maxEntries) {
                splitOccured = this._treatOverflow(insertPath, level);
                level--;
            }
        } while (level >= 0 && splitOccured);

        // adjust bboxes along the insertion path
        this._adjustParentBBoxes(node, insertPath, level);
    },

    _treatOverflow: function (insertPath, level) {
        var firstOverflow = !this._overflowLevels[level];
        this._overflowLevels[level] = true;

        // reinsert a part of node entries if not root and overflowing for the first time on this tree level
        if (level > 0 && firstOverflow) {
            this._reinsert(insertPath[level], level);
            return false;
        } else {
            // otherwise split the node
            this._split(insertPath, level);
            return true;
        }
    },

    _reinsert: function (node, level) {
        var x = (node.bbox[0] + node.bbox[1]) / 2,
            y = (node.bbox[2] + node.bbox[3]) / 2,
            len = node.children.length,
            reinsertLen = Math.round(len * 0.3),
            child, i, dx, dy, bbox;

        // calculate distances from node bbox center to children bbox centers
        for (i = 0; i < len; i++) {
            child = node.children[i];
            bbox = node.leaf ? this._toBBox(child) : child.bbox;
            dx = (bbox[0] + bbox[1]) / 2 - x;
            dy = (bbox[2] + bbox[3]) / 2 - y;
            child.sqDist = dx * dx + dy * dy;
        }

        // remove and reinsert 30% entries that are most far away from the node bbox center
        node.children.sort(this._sortDist);

        var reinserted = node.children.splice(0, reinsertLen);

        this._calcBBoxes(node);
        // TODO adjust along path?

        var root = this.data;

        for (i = 0; i < reinsertLen; i++) {
            this._insert(reinserted[i], level, !node.leaf, root);
            // TODO side effects of not reinserting to other branch of splitted root?
        }
    },

    _split: function (insertPath, level) {
        var node = insertPath[level],
            M = node.children.length,
            m = Math.ceil(M * 0.4);

        this._chooseSplitAxis(node, m, M);

        var k = this._chooseSplitIndex(node, m, M);

        var newNode = {};
        newNode.children = node.children.splice(k);

        if (node.leaf) {
            newNode.leaf = true;
        }

        this._calcBBoxes(node);
        this._calcBBoxes(newNode);

        if (level) {
            insertPath[level - 1].children.push(newNode);
        } else {
            // split root node
            this.data = {};
            this.data.children = [node, newNode];
            this._calcBBoxes(this.data);
        }
    },

    _chooseSplitIndex: function (node, m, M) {

        var overlap, area,
            minOverlap = Infinity,
            minArea = Infinity,
            index, i, bbox1, bbox2;

        for (i = m; i <= M - m; i++) {
            bbox1 = this._distBBox(node, 0, i);
            bbox2 = this._distBBox(node, i, M);

            overlap = this._intersectionArea(bbox1, bbox2);
            area = this._area(bbox1) + this._area(bbox2);

            // choose distribution with minimum overlap
            if (overlap < minOverlap) {
                minOverlap = overlap;
                index = i;

                minArea = area < minArea ? area : minArea;

            } else if (overlap === minOverlap) {
                // otherwise choose distribution with minimum area

                if (area < minArea) {
                    minArea = area;
                    index = i;
                }
            }
        }

        return index;
    },

    _chooseSplitAxis: function (node, m, M) {

        var sortMinX = node.leaf ? this._sortMinX : this._sortNodeMinX,
            sortMaxX = node.leaf ? this._sortMaxX : this._sortNodeMaxX,
            sortMinY = node.leaf ? this._sortMinY : this._sortNodeMinY,
            sortMaxY = node.leaf ? this._sortMaxY : this._sortNodeMaxY,

            xMargin = this._allDistMargin(node, m, M, sortMinX) + this._allDistMargin(node, m, M, sortMaxX),
            yMargin = this._allDistMargin(node, m, M, sortMinY) + this._allDistMargin(node, m, M, sortMaxY);

        // if total distributions margin value is minimal for x, sort by maxX,
        // otherwise it's already sorted by maxY

        if (xMargin < yMargin) {
            node.children.sort(sortMaxX);
        }
    },

    _allDistMargin: function (node, m, M, sort) {

        node.children.sort(sort);

        for (var i = m, margin = 0; i <= M - m; i++) {
            margin += this._margin(this._distBBox(node, 0, i)) +
                      this._margin(this._distBBox(node, i, M));
        }

        return margin;
    },

    _distMargin: function (node, k, p) {
        var bbox = [Infinity, Infinity, -Infinity, -Infinity];

        for (var i = k, child; i < p; i++) {
            child = node.children[i];
            this._extend(bbox, node.leaf ? this._toBBox(child) : child.bbox);
        }

        return (bbox[2] - bbox[0]) + (bbox[3] - bbox[1]);
    },

    _distBBox: function (node, k, p) {
        var bbox = [Infinity, Infinity, -Infinity, -Infinity];

        for (var i = k, child; i < p; i++) {
            child = node.children[i];
            this._extend(bbox, node.leaf ? this._toBBox(child) : child.bbox);
        }

        return bbox;
    },

    _calcBBoxes: function (node, recursive) {

        node.bbox = [Infinity, Infinity, -Infinity, -Infinity];

        for (var i = 0, len = node.children.length, child; i < len; i++) {
            child = node.children[i];

            if (node.leaf) {
                this._extend(node.bbox, this._toBBox(child));
            } else {
                if (recursive) {
                    this._calcBBoxes(child, recursive);
                }
                this._extend(node.bbox, child.bbox);
            }
        }
    },

    _adjustParentBBoxes: function (node, path, level) {
        // adjust bboxes along the given tree path
        for (var i = level; i >= 0; i--) {
            this._extend(path[i].bbox, node.bbox);
        }
    },

    _sortEnlargement: function (a, b) {
        return a.enlargement > b.enlargement ? 1 : -1;
    },

    _sortDist: function (a, b) {
        return a.sqDist > b.sqDist ? 1 : -1;
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
        return bbox;
    },

    _area: function (bbox) {
        return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
    },

    _margin: function (bbox) {
        return (bbox[2] - bbox[0]) + (bbox[3] - bbox[1]);
    },

    _enlargedArea: function (bbox, bbox2) {
        return (Math.max(bbox2[2], bbox[2]) - Math.min(bbox2[0], bbox[0])) *
               (Math.max(bbox2[3], bbox[3]) - Math.min(bbox2[1], bbox[1]));
    },

    _overlapArea: function (bbox, node, nodes, len) {
        var newBox = this._extend(node.bbox.slice(), bbox);

        for (var i = 0, sum = 0, bbox2; i < len; i++) {
            if (node !== nodes[i]) {
                bbox2 = nodes[i].bbox;
                if (this._intersects(newBox, bbox2)) {
                    sum += this._intersectionArea(newBox, bbox2);
                }
            }
        }

        return sum;
    },

    _intersectionArea: function (bbox, bbox2) {
        var minX = Math.max(bbox[0], bbox2[0]),
            maxX = Math.min(bbox[2], bbox2[2]),
            minY = Math.max(bbox[1], bbox2[1]),
            maxY = Math.min(bbox[3], bbox2[3]);

        return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
    },

    _createSort: function (accessor) {
        return new Function('a', 'b', 'return a' + accessor + ' > b' + accessor + ' ? 1 : -1;');
    }
};

if (typeof module !== 'undefined') {
    module.exports = rbush;
} else {
    window.rbush = rbush;
}

})();
