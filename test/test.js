
/*eslint @stylistic/js/key-spacing: 0, @stylistic/js/comma-spacing: 0 */

import RBush from '../index.js';
import test from 'node:test';
import assert from 'node:assert/strict';

function sortedEqual(a, b, compare = defaultCompare) {
    assert.deepEqual(a.slice().sort(compare), b.slice().sort(compare));
}

function defaultCompare(a, b) {
    return (a.minX - b.minX) || (a.minY - b.minY) || (a.maxX - b.maxX) || (a.maxY - b.maxY);
}

function someData(n) {
    const data = [];
    for (let i = 0; i < n; i++) {
        data.push({minX: i, minY: i, maxX: i, maxY: i});
    }
    return data;
}

function arrToBBox([minX, minY, maxX, maxY]) {
    return {minX, minY, maxX, maxY};
}

const data = [[0,0,0,0],[10,10,10,10],[20,20,20,20],[25,0,25,0],[35,10,35,10],[45,20,45,20],[0,25,0,25],[10,35,10,35],
    [20,45,20,45],[25,25,25,25],[35,35,35,35],[45,45,45,45],[50,0,50,0],[60,10,60,10],[70,20,70,20],[75,0,75,0],
    [85,10,85,10],[95,20,95,20],[50,25,50,25],[60,35,60,35],[70,45,70,45],[75,25,75,25],[85,35,85,35],[95,45,95,45],
    [0,50,0,50],[10,60,10,60],[20,70,20,70],[25,50,25,50],[35,60,35,60],[45,70,45,70],[0,75,0,75],[10,85,10,85],
    [20,95,20,95],[25,75,25,75],[35,85,35,85],[45,95,45,95],[50,50,50,50],[60,60,60,60],[70,70,70,70],[75,50,75,50],
    [85,60,85,60],[95,70,95,70],[50,75,50,75],[60,85,60,85],[70,95,70,95],[75,75,75,75],[85,85,85,85],[95,95,95,95]]
    .map(arrToBBox);

const emptyData = [[-Infinity, -Infinity, Infinity, Infinity],[-Infinity, -Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, Infinity, Infinity],[-Infinity, -Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, Infinity, Infinity],[-Infinity, -Infinity, Infinity, Infinity]].map(arrToBBox);

test('allows custom formats by overriding some methods', () => {
    class MyRBush extends RBush {
        toBBox(a) {
            return {
                minX: a.minLng,
                minY: a.minLat,
                maxX: a.maxLng,
                maxY: a.maxLat
            };
        }
        compareMinX(a, b) {
            return a.minLng - b.minLng;
        }
        compareMinY(a, b) {
            return a.minLat - b.minLat;
        }
    }
    const tree = new MyRBush(4);
    assert.deepEqual(tree.toBBox({minLng: 1, minLat: 2, maxLng: 3, maxLat: 4}),
        {minX: 1, minY: 2, maxX: 3, maxY: 4});
});

test('constructor uses 9 max entries by default', () => {
    const tree = new RBush().load(someData(9));
    assert.equal(tree.toJSON().height, 1);

    const tree2 = new RBush().load(someData(10));
    assert.equal(tree2.toJSON().height, 2);
});

test('#toBBox, #compareMinX, #compareMinY can be overriden to allow custom data structures', () => {

    const tree = new RBush(4);
    tree.toBBox = item => ({
        minX: item.minLng,
        minY: item.minLat,
        maxX: item.maxLng,
        maxY: item.maxLat
    });
    tree.compareMinX = (a, b) => a.minLng - b.minLng;
    tree.compareMinY = (a, b) => a.minLat - b.minLat;

    const data = [
        {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
        {minLng:  105, minLat:  45, maxLng:  115, maxLat:  55},
        {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ];

    tree.load(data);

    function byLngLat(a, b) {
        return a.minLng - b.minLng || a.minLat - b.minLat;
    }

    sortedEqual(tree.search({minX: -180, minY: -90, maxX: 180, maxY: 90}), [
        {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
        {minLng:  105, minLat:  45, maxLng:  115, maxLat:  55},
        {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ], byLngLat);

    sortedEqual(tree.search({minX: -180, minY: -90, maxX: 0, maxY: 90}), [
        {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ], byLngLat);

    sortedEqual(tree.search({minX: 0, minY: -90, maxX: 180, maxY: 90}), [
        {minLng: 105, minLat:  45, maxLng: 115, maxLat:  55},
        {minLng: 105, minLat: -55, maxLng: 115, maxLat: -45}
    ], byLngLat);

    sortedEqual(tree.search({minX: -180, minY: 0, maxX: 180, maxY: 90}), [
        {minLng: -115, minLat: 45, maxLng: -105, maxLat: 55},
        {minLng:  105, minLat: 45, maxLng:  115, maxLat: 55}
    ], byLngLat);

    sortedEqual(tree.search({minX: -180, minY: -90, maxX: 180, maxY: 0}), [
        {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ], byLngLat);

});

test('#load bulk-loads the given data given max node entries and forms a proper search tree', () => {

    const tree = new RBush(4).load(data);
    sortedEqual(tree.all(), data);

});

test('#load uses standard insertion when given a low number of items', () => {

    const tree = new RBush(8)
        .load(data)
        .load(data.slice(0, 3));

    const tree2 = new RBush(8)
        .load(data)
        .insert(data[0])
        .insert(data[1])
        .insert(data[2]);

    assert.deepEqual(tree.toJSON(), tree2.toJSON());
});

test('#load does nothing if loading empty data', () => {
    const tree = new RBush().load([]);

    assert.deepEqual(tree.toJSON(), new RBush().toJSON());
});

test('#load handles the insertion of maxEntries + 2 empty bboxes', () => {
    const tree = new RBush(4)
        .load(emptyData);

    assert.equal(tree.toJSON().height, 2);
    sortedEqual(tree.all(), emptyData);

});

test('#insert handles the insertion of maxEntries + 2 empty bboxes', () => {
    const tree = new RBush(4);

    emptyData.forEach((datum) => {
        tree.insert(datum);
    });

    assert.equal(tree.toJSON().height, 2);
    sortedEqual(tree.all(), emptyData);
    assert.equal(tree.data.children[0].children.length, 4);
    assert.equal(tree.data.children[1].children.length, 2);

});

test('#load properly splits tree root when merging trees of the same height', () => {
    const tree = new RBush(4)
        .load(data)
        .load(data);

    assert.equal(tree.toJSON().height, 4);
    sortedEqual(tree.all(), data.concat(data));

});

test('#load properly merges data of smaller or bigger tree heights', () => {
    const smaller = someData(10);

    const tree1 = new RBush(4)
        .load(data)
        .load(smaller);

    const tree2 = new RBush(4)
        .load(smaller)
        .load(data);

    assert.equal(tree1.toJSON().height, tree2.toJSON().height);

    sortedEqual(tree1.all(), data.concat(smaller));
    sortedEqual(tree2.all(), data.concat(smaller));

});

test('#search finds matching points in the tree given a bbox', () => {

    const tree = new RBush(4).load(data);
    const result = tree.search({minX: 40, minY: 20, maxX: 80, maxY: 70});

    sortedEqual(result, [
        [70,20,70,20],[75,25,75,25],[45,45,45,45],[50,50,50,50],[60,60,60,60],[70,70,70,70],
        [45,20,45,20],[45,70,45,70],[75,50,75,50],[50,25,50,25],[60,35,60,35],[70,45,70,45]
    ].map(arrToBBox));

});

test('#collides returns true when search finds matching points', () => {

    const tree = new RBush(4).load(data);
    const result = tree.collides({minX: 40, minY: 20, maxX: 80, maxY: 70});

    assert.deepEqual(result, true);

});

test('#search returns an empty array if nothing found', () => {
    const result = new RBush(4).load(data).search(arrToBBox([200, 200, 210, 210]));

    assert.deepEqual(result, []);
});

test('#collides returns false if nothing found', () => {
    const result = new RBush(4).load(data).collides(arrToBBox([200, 200, 210, 210]));

    assert.deepEqual(result, false);
});

test('#all returns all points in the tree', () => {

    const tree = new RBush(4).load(data);
    const result = tree.all();

    sortedEqual(result, data);
    sortedEqual(tree.search({minX: 0, minY: 0, maxX: 100, maxY: 100}), data);

});

test('#toJSON & #fromJSON exports and imports search tree in JSON format', () => {

    const tree = new RBush(4).load(data);
    const tree2 = new RBush(4).fromJSON(tree.data);

    sortedEqual(tree.all(), tree2.all());
});

test('#insert adds an item to an existing tree correctly', () => {
    const items = [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [2, 2, 2, 2],
        [3, 3, 3, 3],
        [1, 1, 2, 2]
    ].map(arrToBBox);

    const tree = new RBush(4).load(items.slice(0, 3));

    tree.insert(items[3]);
    assert.equal(tree.toJSON().height, 1);
    sortedEqual(tree.all(), items.slice(0, 4));

    tree.insert(items[4]);
    assert.equal(tree.toJSON().height, 2);
    sortedEqual(tree.all(), items);

});

test('#insert does nothing if given undefined', () => {
    assert.deepEqual(
        new RBush().load(data),
        new RBush().load(data).insert());
});

test('#insert forms a valid tree if items are inserted one by one', () => {
    const tree = new RBush(4);

    for (let i = 0; i < data.length; i++) {
        tree.insert(data[i]);
    }

    const tree2 = new RBush(4).load(data);

    assert.ok(tree.toJSON().height - tree2.toJSON().height <= 1);

    sortedEqual(tree.all(), tree2.all());
});

test('#remove removes items correctly', () => {
    const tree = new RBush(4).load(data);

    const len = data.length;

    tree.remove(data[0]);
    tree.remove(data[1]);
    tree.remove(data[2]);

    tree.remove(data[len - 1]);
    tree.remove(data[len - 2]);
    tree.remove(data[len - 3]);

    sortedEqual(data.slice(3, len - 3), tree.all());
});
test('#remove does nothing if nothing found', () => {
    assert.deepEqual(
        new RBush().load(data),
        new RBush().load(data).remove(arrToBBox([13, 13, 13, 13])));
});
test('#remove does nothing if given undefined', () => {
    assert.deepEqual(
        new RBush().load(data),
        new RBush().load(data).remove());
});
test('#remove brings the tree to a clear state when removing everything one by one', () => {
    const tree = new RBush(4).load(data);

    for (let i = 0; i < data.length; i++) {
        tree.remove(data[i]);
    }

    assert.deepEqual(tree.toJSON(), new RBush(4).toJSON());
});
test('#remove accepts an equals function', () => {
    const tree = new RBush(4).load(data);

    const item = {minX: 20, minY: 70, maxX: 20, maxY: 70, foo: 'bar'};

    tree.insert(item);
    tree.remove(JSON.parse(JSON.stringify(item)), (a, b) => a.foo === b.foo);

    sortedEqual(tree.all(), data);
});

test('#clear should clear all the data in the tree', () => {
    assert.deepEqual(
        new RBush(4).load(data).clear().toJSON(),
        new RBush(4).toJSON());
});

test('should have chainable API', () => {
    assert.doesNotThrow(() => {
        new RBush()
            .load(data)
            .insert(data[0])
            .remove(data[0]);
    });
});
