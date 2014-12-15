var Benchmark = require('benchmark'),
    rbush = require('../rbush'),
    genData = require('./gendata');

var N = 10000,
    maxFill = 16;

var data = genData(N, 1);
var bboxes100 = genData(1000, 100 * Math.sqrt(0.1));
var bboxes10 = genData(1000, 10);
var bboxes1 = genData(1000, 1);

var tree = rbush(maxFill);
for (var i = 0; i < N; i++) {
    tree.insert(data[i]);
}

new Benchmark.Suite()
.add('1000 searches 10% after bulk loading ' + N, function () {
    for (i = 0; i < 1000; i++) {
        tree.search(bboxes100[i]);
    }
})
.add('1000 searches 1% after bulk loading ' + N, function () {
    for (i = 0; i < 1000; i++) {
        tree.search(bboxes10[i]);
    }
})
.add('1000 searches 0.01% after bulk loading ' + N, function () {
    for (i = 0; i < 1000; i++) {
        tree.search(bboxes1[i]);
    }
})
.on('error', function(event) {
    console.log(event.target.error);
})
.on('cycle', function(event) {
    console.log(String(event.target));
})
.run();
