var Benchmark = require('benchmark'),
    rbush = require('../rbush'),
    genData = require('./gendata');

var N = 10000,
    maxFill = 16;

var data = genData(N, 1);

new Benchmark.Suite()
.add('bulk loading ' + N + ' items (' + maxFill + ' node size)', function () {
    var tree = rbush(maxFill);
    tree.load(data);
})
.on('error', function(event) {
    console.log(event.target.error);
})
.on('cycle', function(event) {
    console.log(String(event.target));
})
.run();
