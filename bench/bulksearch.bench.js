import Benchmark from 'benchmark';
import RBush from '../index.js';
import {generate} from './gendata';

const N = 10000;
const maxFill = 16;

const data = generate(N, 100);
const bboxes100 = generate(1000, 100 * Math.sqrt(0.1));
const bboxes10 = generate(1000, 10);
const bboxes1 = generate(1000, 1);

const tree = new RBush(maxFill);
tree.load(data);

new Benchmark.Suite()
    .add(`1000 searches 10% after bulk loading ${N}`, () => {
        for (let i = 0; i < 1000; i++) {
            tree.search(bboxes100[i]);
        }
    })
    .add(`1000 searches 1% after bulk loading ${N}`, () => {
        for (let i = 0; i < 1000; i++) {
            tree.search(bboxes10[i]);
        }
    })
    .add(`1000 searches 0.01% after bulk loading ${N}`, () => {
        for (let i = 0; i < 1000; i++) {
            tree.search(bboxes1[i]);
        }
    })
    .on('error', event => console.log(event.target.error))
    .on('cycle', event => console.log(String(event.target)))
    .run();
