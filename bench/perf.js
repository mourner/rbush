'use strict';

var N = 1000000,
    maxFill = 16;

console.log('number: ' + N);
console.log('maxFill: ' + maxFill);

function randBox(size) {
    var x = Math.random() * (100 - size),
        y = Math.random() * (100 - size);
    return {
        minX: x,
        minY: y,
        maxX: x + size * Math.random(),
        maxY: y + size * Math.random()
    };
}

function genData(N, size) {
    var data = [];
    for (var i = 0; i < N; i++) {
        data.push(randBox(size));
    }
    return data;
}

var data = genData(N, 1);
var data2 = genData(N, 1);
var bboxes100 = genData(1000, 100 * Math.sqrt(0.1));
var bboxes10 = genData(1000, 10);
var bboxes1 = genData(1000, 1);

var rbush = typeof require !== 'undefined' ? require('..') : rbush;

var tree = rbush(maxFill);

console.time('insert one by one');
for (var i = 0; i < N; i++) {
    tree.insert(data[i]);
}
console.timeEnd('insert one by one');

console.time('1000 searches 10%');
for (i = 0; i < 1000; i++) {
    tree.search(bboxes100[i]);
}
console.timeEnd('1000 searches 10%');

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


console.time('remove 1000 one by one');
for (i = 0; i < 1000; i++) {
    tree.remove(data[i]);
}
console.timeEnd('remove 1000 one by one');

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
