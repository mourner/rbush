var rbush = typeof require !== 'undefined' ? require('../rbush.js') : rbush;

var data = [],
    x, y;

var N = 1000000,
    maxFill = 500;

function randBox(size) {
    var x = Math.random() * (100 - size),
        y = Math.random() * (100 - size);
    return [x, y,
        x + size * Math.random(),
        y + size * Math.random()];
}

for (var i = 0; i < N; i++) {
    data[i] = randBox(1);
}

console.log('number: ' + N);


console.time('bulk load');
var tree = rbush(maxFill).load(data);
console.timeEnd('bulk load');

console.log('maxFill: ' + tree._maxFill);

console.time('100 searches 1%');
for (i = 0; i < 100; i++) {
    tree.search(randBox(10));
}
console.timeEnd('100 searches 1%');

console.time('100 searches 0.01%');
for (i = 0; i < 100; i++) {
    tree.search(randBox(1));
}
console.timeEnd('100 searches 0.01%');

console.time('100 choose subtree 0.01%');
for (i = 0; i < 100; i++) {
    tree._chooseSubtree(randBox(1), tree.data);
}
console.timeEnd('100 choose subtree 0.01%');

// var result, bbox;

// console.time('100 naive searches 1%');
// for (var j = 0; j < 100; j++) {
//     result = [];
//     bbox = randBox(10);
//     for (i = 0; i < N; i++) {
//         if (tree._intersects(bbox, data[i])) {
//             result.push(data[i]);
//         }
//     }
// }
// console.timeEnd('100 naive searches 1%');

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

// console.time('100 searches 1% 2');
// for (i = 0; i < 100; i++) {
//     bbox = randBox(10);
//     tree2.search({x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1]});
// }
// console.timeEnd('100 searches 1% 2');

// console.time('100 searches 0.01% 2');
// for (i = 0; i < 100; i++) {
//     bbox = randBox(1);
//     tree2.search({x: bbox[0], y: bbox[1], w: bbox[2] - bbox[0], h: bbox[3] - bbox[1]});
// }
// console.timeEnd('100 searches 0.01% 2');
