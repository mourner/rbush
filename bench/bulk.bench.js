import Benchmark from 'benchmark';
import RBush from '../index.js';
import {generate} from './gendata';

var N = 10000,
    maxFill = 16;

var data = generate(N, 1);

new Benchmark.Suite()
.add('bulk loading ' + N + ' items (' + maxFill + ' node size)', function () {
    var tree = new RBush(maxFill);
    tree.load(data);
})
.on('error', function(event) {
    console.log(event.target.error);
})
.on('cycle', function(event) {
    console.log(String(event.target));
})
.run();
