var rbush = require('../rbush.js'),
    assert = require('assert');

describe('rbush', function () { 'use strict';

    function assertSortedEqual(a, b, compare) {
        assert.deepEqual(a.sort(compare), b.sort(compare));
    }

    var data = [[0,0,0,0],[10,10,10,10],[20,20,20,20],[25,0,25,0],[35,10,35,10],[45,20,45,20],[0,25,0,25],[10,35,10,35],
        [20,45,20,45],[25,25,25,25],[35,35,35,35],[45,45,45,45],[50,0,50,0],[60,10,60,10],[70,20,70,20],[75,0,75,0],
        [85,10,85,10],[95,20,95,20],[50,25,50,25],[60,35,60,35],[70,45,70,45],[75,25,75,25],[85,35,85,35],[95,45,95,45],
        [0,50,0,50],[10,60,10,60],[20,70,20,70],[25,50,25,50],[35,60,35,60],[45,70,45,70],[0,75,0,75],[10,85,10,85],
        [20,95,20,95],[25,75,25,75],[35,85,35,85],[45,95,45,95],[50,50,50,50],[60,60,60,60],[70,70,70,70],[75,50,75,50],
        [85,60,85,60],[95,70,95,70],[50,75,50,75],[60,85,60,85],[70,95,70,95],[75,75,75,75],[85,85,85,85],[95,95,95,95]];

    var testTree = {'children':[{
        'children':[
            {'children':[[0,0,0,0],[10,10,10,10],[20,20,20,20],[25,0,25,0]],      'leaf':true,'bbox':[0,0,25,20],  'height': 1},
            {'children':[[35,10,35,10],[45,20,45,20],[50,0,50,0],[60,10,60,10]],  'leaf':true,'bbox':[35,0,60,20], 'height': 1},
            {'children':[[0,25,0,25],[10,35,10,35],[20,45,20,45],[25,25,25,25]],  'leaf':true,'bbox':[0,25,25,45], 'height': 1},
            {'children':[[35,35,35,35],[45,45,45,45],[50,25,50,25],[60,35,60,35]],'leaf':true,'bbox':[35,25,60,45],'height': 1}
        ], 'bbox':[0,0,60,45], 'height': 2
    }, {
        'children': [
            {'children':[[0,50,0,50],[10,60,10,60],[20,70,20,70],[25,50,25,50]],  'leaf':true,'bbox':[0,50,25,70], 'height': 1},
            {'children':[[35,60,35,60],[45,70,45,70],[50,50,50,50],[60,60,60,60]],'leaf':true,'bbox':[35,50,60,70],'height': 1},
            {'children':[[0,75,0,75],[10,85,10,85],[20,95,20,95],[25,75,25,75]],  'leaf':true,'bbox':[0,75,25,95], 'height': 1},
            {'children':[[35,85,35,85],[45,95,45,95],[50,75,50,75],[60,85,60,85]],'leaf':true,'bbox':[35,75,60,95],'height': 1}
        ], 'bbox':[0,50,60,95], 'height': 2
    }, {
        'children': [
            {'children':[[70,20,70,20],[70,45,70,45],[75,0,75,0],[75,25,75,25]],  'leaf':true,'bbox':[70,0,75,45], 'height': 1},
            {'children':[[85,10,85,10],[85,35,85,35],[95,20,95,20],[95,45,95,45]],'leaf':true,'bbox':[85,10,95,45],'height': 1},
            {'children':[[70,70,70,70],[70,95,70,95],[75,50,75,50],[75,75,75,75]],'leaf':true,'bbox':[70,50,75,95],'height': 1},
            {'children':[[85,60,85,60],[85,85,85,85],[95,70,95,70],[95,95,95,95]],'leaf':true,'bbox':[85,60,95,95],'height': 1}
        ], 'bbox':[70,0,95,95], 'height': 2
    }], 'bbox':[0,0,95,95], 'height': 3};


    describe('constructor', function () {
        it('accepts a format argument to customize the data format', function () {

            var tree = rbush(4, ['.minLng', '.minLat', '.maxLng', '.maxLat']);
            assert.deepEqual(tree.toBBox({minLng: 1, minLat: 2, maxLng: 3, maxLat: 4}), [1, 2, 3, 4]);
        });
    });

    describe('toBBox, compareMinX, compareMinY', function () {
        it('can be overriden to allow custom data structures', function () {

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

            function byLngLat (a, b) {
                return a.minLng - b.minLng || a.minLat - b.minLat;
            }

            assertSortedEqual(tree.search([-180, -90, 180, 90]), [
                {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
                {minLng:  105, minLat:  45, maxLng:  115, maxLat:  55},
                {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
                {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
            ], byLngLat);

            assertSortedEqual(tree.search([-180, -90, 0, 90]), [
                {minLng: -115, minLat:  45, maxLng: -105, maxLat:  55},
                {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
            ], byLngLat);

            assertSortedEqual(tree.search([0, -90, 180, 90]), [
                {minLng: 105, minLat:  45, maxLng: 115, maxLat:  55},
                {minLng: 105, minLat: -55, maxLng: 115, maxLat: -45}
            ], byLngLat);

            assertSortedEqual(tree.search([-180, 0, 180, 90]), [
                {minLng: -115, minLat: 45, maxLng: -105, maxLat: 55},
                {minLng:  105, minLat: 45, maxLng:  115, maxLat: 55}
            ], byLngLat);

            assertSortedEqual(tree.search([-180, -90, 180, 0]), [
                {minLng:  105, minLat: -55, maxLng:  115, maxLat: -45},
                {minLng: -115, minLat: -55, maxLng: -105, maxLat: -45}
            ], byLngLat);

        });
    });

    describe('load', function () {
        it('bulk-loads the given data given max node entries and forms a proper search tree', function () {

            var tree = rbush(4).load(data);
            assert.deepEqual(tree.toJSON(), testTree);
        });
        it('uses standard insertion when given a low number of items', function () {

            var tree = rbush(8)
                .load(data)
                .load(data.slice(0, 3));

            var tree2 = rbush(8)
                .load(data)
                .insert(data[0])
                .insert(data[1])
                .insert(data[2]);

            assert.deepEqual(tree.toJSON(), tree2.toJSON());
        });
    });

    describe('search', function () {
        it('finds matching points in the tree given a bbox', function () {

            var tree = rbush(4).load(data);
            var result = tree.search([40, 20, 80, 70]);

            assertSortedEqual(result, [
                [70,20,70,20],[75,25,75,25],[45,45,45,45],[50,50,50,50],[60,60,60,60],[70,70,70,70],
                [45,20,45,20],[45,70,45,70],[75,50,75,50],[50,25,50,25],[60,35,60,35],[70,45,70,45]
            ]);
        });
    });

    describe('all', function() {
        it('returns all points in the tree', function() {

            var tree = rbush(4).load(data);
            var result = tree.all();

            assertSortedEqual(result, data);
        });
    });

    describe('toJSON & fromJSON', function () {
        it('exports and imports search tree in JSON format', function () {

            var tree = rbush(4);
            tree.fromJSON(testTree);

            var tree2 = rbush(4).load(data);

            assert.deepEqual(tree.toJSON(), tree2.toJSON());
        });
    });

    describe('insert', function () {
        it('adds an item to an existing tree correctly', function () {
            var tree = rbush(4).load([
                [0, 0, 0, 0],
                [1, 1, 1, 1],
                [2, 2, 2, 2]
            ]);
            tree.insert([3, 3, 3, 3]);

            assert.deepEqual(tree.toJSON(), {
                'children':[[0,0,0,0],[1,1,1,1],[2,2,2,2],[3,3,3,3]],
                'leaf':true,
                'height':1,
                'bbox':[0,0,3,3]
            });

            tree.insert([1, 1, 2, 2]);

            assert.deepEqual(tree.toJSON(), {
                'children':[
                    {'children':[[0,0,0,0],[1,1,1,1]],'leaf':true,'height':1,'bbox':[0,0,1,1]},
                    {'children':[[1,1,2,2],[2,2,2,2],[3,3,3,3]],'height':1,'leaf':true,'bbox':[1,1,3,3]}
                ],
                'height':2,
                'bbox':[0,0,3,3]
            });
        });
    });
});
