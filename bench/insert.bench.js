var Benchmark = require('benchmark'),
    rbush = require('../rbush'),
    genData = require('./gendata');

var N = 10000,
    maxFill = 512;

var data = genData(N, 1);

new Benchmark.Suite()
.add('insert ' + N + ' items (' + maxFill + ' node size)', function () {
    var tree = rbush(maxFill);
    for (var i = 0; i < N; i++) {
        tree.insert(data[i]);
    }
})
.on('error', function(event) {
    console.log(event.target.error);
})
.on('cycle', function(event) {
    console.log(String(event.target));
})
.run();
