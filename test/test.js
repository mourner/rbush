'use strict';

/*eslint key-spacing: 0, comma-spacing: 0, quotes: 0*/

var rbush = require('../rbush.js'),
    t = require('tape');

function sortedEqual(t, a, b, compare) {
    t.same(a.slice().sort(compare), b.slice().sort(compare));
}

function someData(n) {
    var data = [];

    for (var i = 0; i < n; i++) {
        data.push([i, i, i, i]);
    }
    return data;
}

var data = [[0,0,0,0],[10,10,10,10],[20,20,20,20],[25,0,25,0],[35,10,35,10],[45,20,45,20],[0,25,0,25],[10,35,10,35],
    [20,45,20,45],[25,25,25,25],[35,35,35,35],[45,45,45,45],[50,0,50,0],[60,10,60,10],[70,20,70,20],[75,0,75,0],
    [85,10,85,10],[95,20,95,20],[50,25,50,25],[60,35,60,35],[70,45,70,45],[75,25,75,25],[85,35,85,35],[95,45,95,45],
    [0,50,0,50],[10,60,10,60],[20,70,20,70],[25,50,25,50],[35,60,35,60],[45,70,45,70],[0,75,0,75],[10,85,10,85],
    [20,95,20,95],[25,75,25,75],[35,85,35,85],[45,95,45,95],[50,50,50,50],[60,60,60,60],[70,70,70,70],[75,50,75,50],
    [85,60,85,60],[95,70,95,70],[50,75,50,75],[60,85,60,85],[70,95,70,95],[75,75,75,75],[85,85,85,85],[95,95,95,95]];

var testTree = {"children":[{
    "children":[
        {"children":[[0,0,0,0],[10,10,10,10],[20,20,20,20],[25,0,25,0]],"height":1,"bbox":[0,0,25,20],"leaf":true},
        {"children":[[0,25,0,25],[10,35,10,35],[25,25,25,25],[20,45,20,45]],"height":1,"bbox":[0,25,25,45],"leaf":true},
        {"children":[[50,0,50,0],[35,10,35,10],[60,10,60,10],[45,20,45,20]],"height":1,"bbox":[35,0,60,20],"leaf":true},
        {"children":[[50,25,50,25],[35,35,35,35],[60,35,60,35],[45,45,45,45]],"height":1,"bbox":[35,25,60,45],"leaf":true}
    ],"height":2,"bbox":[0,0,60,45]
},{
    "children":[
        {"children":[[0,50,0,50],[25,50,25,50],[10,60,10,60],[20,70,20,70]],"height":1,"bbox":[0,50,25,70],"leaf":true},
        {"children":[[0,75,0,75],[25,75,25,75],[10,85,10,85],[20,95,20,95]],"height":1,"bbox":[0,75,25,95],"leaf":true},
        {"children":[[35,60,35,60],[50,50,50,50],[60,60,60,60],[45,70,45,70]],"height":1,"bbox":[35,50,60,70],"leaf":true},
        {"children":[[50,75,50,75],[60,85,60,85],[45,95,45,95],[35,85,35,85]],"height":1,"bbox":[35,75,60,95],"leaf":true}
    ],"height":2,"bbox":[0,50,60,95]
},{
    "children":[
        {"children":[[70,20,70,20],[75,0,75,0],[75,25,75,25],[70,45,70,45]],"height":1,"bbox":[70,0,75,45],"leaf":true},
        {"children":[[75,50,75,50],[70,70,70,70],[75,75,75,75],[70,95,70,95]],"height":1,"bbox":[70,50,75,95],"leaf":true},
        {"children":[[85,10,85,10],[95,20,95,20],[85,35,85,35],[95,45,95,45]],"height":1,"bbox":[85,10,95,45],"leaf":true},
        {"children":[[85,60,85,60],[95,70,95,70],[85,85,85,85],[95,95,95,95]],"height":1,"bbox":[85,60,95,95],"leaf":true}
    ],"height":2,"bbox":[70,0,95,95]
}],"height":3,"bbox":[0,0,95,95]};


t('constructor accepts a format argument to customize the data format', function (t) {
    var tree = rbush(4, ['.minLng', '.minLat', '.maxLng', '.maxLat']);
    t.same(tree.toBBox({minLng: 1, minLat: 2, maxLng: 3, maxLat: 4}), [1, 2, 3, 4]);
    t.end();
});

t('constructor uses 9 max entries by default', function (t) {
    var tree = rbush().load(someData(9));
    t.equal(tree.toJSON().height, 1);

    var tree2 = rbush().load(someData(10));
    t.equal(tree2.toJSON().height, 2);
    t.end();
});

t('#toBBox, #compareMinX, #compareMinY can be overriden to allow custom data structures', function (t) {

    var tree = rbush(4);
    tree.toBBox = function (item) {
        return [item.minLng, item.minLat, item.maxLng, item.maxLat];
    };
    tree.compareMinX = function (a, b) {
        return a.minLng - b.minLng;
    };
    tree.compareMinY = function (a, b) {
        return a.minLat - b.minLat;
    };

    var data = [
        {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
        {minLng:  105, minLat:  45, maxLng:  115, maxLat:  55},
        {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ];

    tree.load(data);

    function byLngLat(a, b) {
        return a.minLng - b.minLng || a.minLat - b.minLat;
    }

    sortedEqual(t, tree.search([-180, -90, 180, 90]), [
        {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
        {minLng:  105, minLat:  45, maxLng:  115, maxLat:  55},
        {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ], byLngLat);

    sortedEqual(t, tree.search([-180, -90, 0, 90]), [
        {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ], byLngLat);

    sortedEqual(t, tree.search([0, -90, 180, 90]), [
        {minLng: 105, minLat:  45, maxLng: 115, maxLat:  55},
        {minLng: 105, minLat: -55, maxLng: 115, maxLat: -45}
    ], byLngLat);

    sortedEqual(t, tree.search([-180, 0, 180, 90]), [
        {minLng: -115, minLat: 45, maxLng: -105, maxLat: 55},
        {minLng:  105, minLat: 45, maxLng:  115, maxLat: 55}
    ], byLngLat);

    sortedEqual(t, tree.search([-180, -90, 180, 0]), [
        {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
        {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
    ], byLngLat);

    t.end();
});

t('#load bulk-loads the given data given max node entries and forms a proper search tree', function (t) {

    var tree = rbush(4).load(data);
    sortedEqual(t, tree.all(), rbush(4).fromJSON(testTree).all());

    t.end();
});

t('#load uses standard insertion when given a low number of items', function (t) {

    var tree = rbush(8)
        .load(data)
        .load(data.slice(0, 3));

    var tree2 = rbush(8)
        .load(data)
        .insert(data[0])
        .insert(data[1])
        .insert(data[2]);

    t.same(tree.toJSON(), tree2.toJSON());
    t.end();
});

t('#load does nothing if loading empty data', function (t) {
    var tree = rbush().load([]);

    t.same(tree.toJSON(), rbush().toJSON());
    t.end();
});

t('#load properly splits tree root when merging trees of the same height', function (t) {
    var tree = rbush(4)
        .load(data)
        .load(data);

    t.equal(tree.toJSON().height, 4);
    sortedEqual(t, tree.all(), data.concat(data));

    t.end();
});

t('#load properly merges data of smaller or bigger tree heights', function (t) {
    var smaller = someData(10);

    var tree1 = rbush(4)
        .load(data)
        .load(smaller);

    var tree2 = rbush(4)
        .load(smaller)
        .load(data);

    t.equal(tree1.toJSON().height, tree2.toJSON().height);

    sortedEqual(t, tree1.all(), data.concat(smaller));
    sortedEqual(t, tree2.all(), data.concat(smaller));

    t.end();
});

t('#search finds matching points in the tree given a bbox', function (t) {

    var tree = rbush(4).load(data);
    var result = tree.search([40, 20, 80, 70]);

    sortedEqual(t, result, [
        [70,20,70,20],[75,25,75,25],[45,45,45,45],[50,50,50,50],[60,60,60,60],[70,70,70,70],
        [45,20,45,20],[45,70,45,70],[75,50,75,50],[50,25,50,25],[60,35,60,35],[70,45,70,45]
    ]);

    t.end();
});

t('#search returns an empty array if nothing found', function (t) {
    var result = rbush(4).load(data).search([200, 200, 210, 210]);

    t.same(result, []);
    t.end();
});

t('#all returns all points in the tree', function(t) {

    var tree = rbush(4).load(data);
    var result = tree.all();

    sortedEqual(t, result, data);
    sortedEqual(t, tree.search([0, 0, 100, 100]), data);

    t.end();
});

t('#toJSON & #fromJSON exports and imports search tree in JSON format', function (t) {

    var tree = rbush(4);
    tree.fromJSON(testTree);

    var tree2 = rbush(4).load(data);

    sortedEqual(t, tree.all(), tree2.all());
    t.end();
});

t('#insert adds an item to an existing tree correctly', function (t) {
    var tree = rbush(4).load([
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [2, 2, 2, 2]
    ]);
    tree.insert([3, 3, 3, 3]);

    t.same(tree.toJSON(), {
        'children':[[0,0,0,0],[1,1,1,1],[2,2,2,2],[3,3,3,3]],
        'leaf':true,
        'height':1,
        'bbox':[0,0,3,3]
    });

    tree.insert([1, 1, 2, 2]);

    t.same(tree.toJSON(), {
        'children':[
            {'children':[[0,0,0,0],[1,1,1,1]],'leaf':true,'height':1,'bbox':[0,0,1,1]},
            {'children':[[1,1,2,2],[2,2,2,2],[3,3,3,3]],'height':1,'leaf':true,'bbox':[1,1,3,3]}
        ],
        'height':2,
        'bbox':[0,0,3,3]
    });
    t.end();
});

t('#insert does nothing if given undefined', function (t) {
    t.same(
        rbush().load(data),
        rbush().load(data).insert());
    t.end();
});

t('#insert forms a valid tree if items are inserted one by one', function (t) {
    var tree = rbush(4);

    for (var i = 0; i < data.length; i++) {
        tree.insert(data[i]);
    }

    var tree2 = rbush(4).load(data);

    t.ok(tree.toJSON().height - tree2.toJSON().height <= 1);

    sortedEqual(t, tree.all(), tree2.all());
    t.end();
});

t('#remove removes items correctly', function (t) {
    var tree = rbush(4).load(data);

    var len = data.length;

    tree.remove(data[0]);
    tree.remove(data[1]);
    tree.remove(data[2]);

    tree.remove(data[len - 1]);
    tree.remove(data[len - 2]);
    tree.remove(data[len - 3]);

    sortedEqual(t,
        data.slice(3, len - 3),
        tree.all());
    t.end();
});
t('#remove does nothing if nothing found', function (t) {
    t.same(
        rbush().load(data),
        rbush().load(data).remove([13, 13, 13, 13]));
    t.end();
});
t('#remove does nothing if given undefined', function (t) {
    t.same(
        rbush().load(data),
        rbush().load(data).remove());
    t.end();
});
t('#remove brings the tree to a clear state when removing everything one by one', function (t) {
    var tree = rbush(4).load(data);

    for (var i = 0; i < data.length; i++) {
        tree.remove(data[i]);
    }

    t.same(tree.toJSON(), rbush(4).toJSON());
    t.end();
});

t('#clear should clear all the data in the tree', function (t) {
    t.same(
        rbush(4).load(data).clear().toJSON(),
        rbush(4).toJSON());
    t.end();
});

t('should have chainable API', function (t) {
    t.doesNotThrow(function () {
        rbush()
            .load(data)
            .insert(data[0])
            .remove(data[0])
            .fromJSON(testTree);
    });
    t.end();
});
