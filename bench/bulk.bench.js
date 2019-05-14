import Benchmark from 'benchmark';
import RBush from '../index.js';
import {generate} from './gendata';

const N = 10000;
const maxFill = 16;

const data = generate(N, 1);

new Benchmark.Suite()
    .add(`bulk loading ${N} items (${maxFill} node size)`, () => {
        const tree = new RBush(maxFill);
        tree.load(data);
    })
    .on('error', event => console.log(event.target.error))
    .on('cycle', event => console.log(String(event.target)))
    .run();
