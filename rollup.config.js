import {terser} from 'rollup-plugin-terser';
import resolve from '@rollup/plugin-node-resolve';
import buble from '@rollup/plugin-buble';
import pkg from './package.json';

const umd = (file, plugins) => ({
    input: 'index.js',
    output: {
        name: 'RBush',
        format: 'umd',
        indent: false,
        file
    },
    plugins
});

const esm = (file, plugins) => ({
    input: 'index.js',
    output: {
        format: 'esm',
        file
    },
    external: Object.keys(pkg.dependencies),
    plugins
});

export default [
    umd('rbush.js', [resolve(), buble()]),
    umd('rbush.min.js', [resolve(), buble(), terser()]),
    esm('rbush.esm.js', [buble()])
];
