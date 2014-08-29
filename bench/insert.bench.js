var Benchmark = require('benchmark'),
    rbush = require('../rbush'),
    genData = require('./gendata');

var RTree = require('rtree');


var N = 10000,
    maxFill = 16;

var data = genData(N, 1);
var data2 = genData.convert(data);

new Benchmark.Suite()
.add('insert ' + N + ' items (' + maxFill + ' node size)', function () {
    var tree = rbush(maxFill);
    for (var i = 0; i < N; i++) {
        tree.insert(data[i]);
    }
})
.add('insert ' + N + ' items (' + maxFill + ' node size), old RTree', function () {
    var tree2 = new RTree(maxFill);
    for (var i = 0; i < N; i++) {
        tree2.insert(data2[i], i);
    }
})
.on('error', function(event) {
    console.log(event.target.error);
})
.on('cycle', function(event) {
    console.log(String(event.target));
})
.run();
