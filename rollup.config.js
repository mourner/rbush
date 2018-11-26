import {uglify} from 'rollup-plugin-uglify';
import resolve from 'rollup-plugin-node-resolve';

export default [{
    input: 'index.js',
    output: [{
        name: 'rbush',
        format: 'umd',
        file: 'rbush.js',
        indent: false
    }, {
        file: 'rbush.es.js',
        format: 'es'
    }],
    plugins: [resolve()]
},
{
    input: 'index.js',
    output: {
        name: 'rbush',
        format: 'umd',
        file: 'rbush.min.js',
    },
    plugins: [resolve(), uglify()]
}];
