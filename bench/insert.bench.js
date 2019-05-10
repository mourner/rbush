import Benchmark from 'benchmark';
import RBush from '../index.js';
import {generate} from './gendata';

var N = 100,
    maxFill = 16;

var data = generate(N, 1);

new Benchmark.Suite()
.add('insert ' + N + ' items (' + maxFill + ' node size)', function () {
    var tree = new RBush(maxFill);
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
