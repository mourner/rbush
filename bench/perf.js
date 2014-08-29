
var N = 1000000,
    maxFill = 16;

console.log('number: ' + N);
console.log('maxFill: ' + maxFill);


function randBox(size) {
    var x = Math.random() * (100 - size),
        y = Math.random() * (100 - size);
    return [x, y,
        x + size * Math.random(),
        y + size * Math.random()];
}

function genData(N, size) {
    var data = [];
    for (var i = 0; i < N; i++) {
        data.push(randBox(size));
    }
    return data;
}


var data = genData(N, 1);

var rbush = typeof require !== 'undefined' ? require('../rbush.js') : rbush;
var tree = rbush(maxFill);


console.time('insert one by one');
for (i = 0; i < N; i++) {
    tree.insert(data[i]);
}
console.timeEnd('insert one by one');


// console.time('bulk load');
// tree.load(data);
// console.timeEnd('bulk load');


var bboxes100 = genData(1000, 100 * Math.sqrt(0.1));

console.time('1000 searches 10%');
for (i = 0; i < 1000; i++) {
    tree.search(bboxes100[i]);
}
console.timeEnd('1000 searches 10%');


var bboxes10 = genData(1000, 10);

console.time('1000 searches 1%');
for (i = 0; i < 1000; i++) {
    tree.search(bboxes10[i]);
}
console.timeEnd('1000 searches 1%');


var bboxes1 = genData(1000, 1);

console.time('1000 searches 0.01%');
for (i = 0; i < 1000; i++) {
    tree.search(bboxes1[i]);
}
console.timeEnd('1000 searches 0.01%');


console.time('remove 1000 one by one');
for (i = 0; i < 1000; i++) {
    tree.remove(data[i]);
}
console.timeEnd('remove 1000 one by one');


var data2 = genData(N, 1);

console.time('bulk-insert 1M more');
tree.load(data2);
console.timeEnd('bulk-insert 1M more');


console.time('1000 searches 1%');
for (i = 0; i < 1000; i++) {
    tree.search(bboxes10[i]);
}
console.timeEnd('1000 searches 1%');


console.time('1000 searches 0.01%');
for (i = 0; i < 1000; i++) {
    tree.search(bboxes1[i]);
}
console.timeEnd('1000 searches 0.01%');


// console.time('100 naive searches 1%');
// var result;
// for (var j = 0; j < 100; j++) {
//     result = [];
//     for (i = 0; i < N; i++) {
//         if (tree._intersects(bboxes10[j], data[i])) {
//             result.push(data[i]);
//         }
//     }
// }
// console.timeEnd('100 naive searches 1%');



var RTree = typeof require !== 'undefined' ? require('rtree') : RTree;

var tree2 = new RTree(maxFill);

function convertData(data) {
    var result = [];
    for (var i = 0; i < data.length; i++) {
        result.push({x: data[i][0], y: data[i][1], w: data[i][2] - data[i][0], h: data[i][3] - data[i][1]});
    }
    return result;
}

var datab = convertData(data);

console.time('old RTree load one by one');
for (var i = 0; i < N; i++) {
    tree2.insert(datab[i], i);
}
console.timeEnd('old RTree load one by one');


var bboxes100b = convertData(bboxes100);

console.time('1000 searches 10% 2');
for (i = 0; i < 1000; i++) {
    tree2.search(bboxes100b[i]);
}
console.timeEnd('1000 searches 10% 2');


var bboxes10b = convertData(bboxes10);

console.time('1000 searches 1% 2');
for (i = 0; i < 1000; i++) {
    tree2.search(bboxes10b[i]);
}
console.timeEnd('1000 searches 1% 2');


var bboxes1b = convertData(bboxes1);

console.time('1000 searches 0.01% 2');
for (i = 0; i < 1000; i++) {
    tree2.search(bboxes1b[i]);
}
console.timeEnd('1000 searches 0.01% 2');

console.time('old RTree remove 1000 one by one');
for (var i = 0; i < 1000; i++) {
    tree2.remove(datab[i], i);
}
console.timeEnd('old RTree remove 1000 one by one');
