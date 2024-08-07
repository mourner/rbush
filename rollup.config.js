import terser from '@rollup/plugin-terser';
import resolve from '@rollup/plugin-node-resolve';

const output = (file, plugins) => ({
    input: 'index.js',
    output: {
        name: 'RBush',
        format: 'umd',
        indent: false,
        file
    },
    plugins
});

export default [
    output('rbush.js', [resolve()]),
    output('rbush.min.js', [resolve(), terser()])
];
