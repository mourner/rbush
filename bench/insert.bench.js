import Benchmark from 'benchmark';
import RBush from '../index.js';
import {generate} from './gendata';

const N = 100,
    maxFill = 16;

const data = generate(N, 1);

new Benchmark.Suite()
    .add(`insert ${N} items (${maxFill} node size)`, () => {
        const tree = new RBush(maxFill);
        for (let i = 0; i < N; i++) {
            tree.insert(data[i]);
        }
    })
    .on('error', event => console.log(event.target.error))
    .on('cycle', event => console.log(String(event.target)))
    .run();
