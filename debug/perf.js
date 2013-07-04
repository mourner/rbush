var rbush = typeof require !== 'undefined' ? require('../rbush.js') : rbush;

var data = [],
    x, y;

var N = 1000000,
    bbox = [49,72,51,74],
    bbox2 = [23.5, 43.5, 23.6, 43.6];

for (var i = 0; i < N; i++) {
    x = Math.random() * 99;
    y = Math.random() * 99;
    data[i] = [x, y, x + 1, y + 1];
}

console.log('number: ' + N);

console.time('load');
var tree = rbush().load(data);
console.timeEnd('load');

console.time('search 2x2 of 100x100');
var result = tree.search(bbox);
console.timeEnd('search 2x2 of 100x100');

console.time('search 0.1x0.1 of 100x100');
var result = tree.search(bbox2);
console.timeEnd('search 0.1x0.1 of 100x100');


console.time('naive search');
var result = [];
for (var i = 0; i < N; i++) {
 if (tree._contains(bbox, data[i])) {
     result.push(data[i]);
 }
}
console.timeEnd('naive search');


// var RTree = typeof require !== 'undefined' ? require('rtree') : RTree;

// var tree2 = new RTree();

// var data2 = [];
// for (var i = 0; i < N; i++) {
//     data2.push({x: data[i][0], y: data[i][1], w: 0, h: 0});
// }

// console.time('load 2');
// for (var i = 0; i < N; i++) {
//     tree2.insert(data2[i]);
// }
// console.timeEnd('load 2');

// console.time('search 2');
// var result = tree2.search({x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1]});
// console.timeEnd('search 2');
