var W = 700,
    canvas = document.getElementById('canvas'),
    ctx = canvas.getContext('2d');

if (window.devicePixelRatio > 1) {
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.width = canvas.width * 2;
    canvas.height = canvas.height * 2;
    ctx.scale(2, 2);
}

function randBox(size) {
    var x = Math.random() * (W - size),
        y = Math.random() * (W - size);
    return {
        minX: x,
        minY: y,
        maxX: x + size * Math.random(),
        maxY: y + size * Math.random()
    };
}

function randClusterPoint(dist) {
    var x = dist + Math.random() * (W - dist * 2),
        y = dist + Math.random() * (W - dist * 2);
    return {x: x, y: y};
}

function randClusterBox(cluster, dist, size) {
    var x = cluster.x - dist + 2 * dist * (Math.random() + Math.random() + Math.random()) / 3,
        y = cluster.y - dist + 2 * dist * (Math.random() + Math.random() + Math.random()) / 3;

    return {
        minX: x,
        minY: y,
        maxX: x + size * Math.random(),
        maxY: y + size * Math.random(),
        item: true
    };
}

var colors = ['#f40', '#0b0', '#37f'],
    rects;

function drawTree(node, level) {
    if (!node) { return; }

    var rect = [];

    rect.push(level ? colors[(node.height - 1) % colors.length] : 'grey');
    rect.push(level ? 1 / Math.pow(level, 1.2) : 0.2);
    rect.push([
        Math.round(node.minX),
        Math.round(node.minY),
        Math.round(node.maxX - node.minX),
        Math.round(node.maxY - node.minY)
    ]);

    rects.push(rect);

    if (node.leaf) return;
    if (level === 6) { return; }

    for (var i = 0; i < node.children.length; i++) {
        drawTree(node.children[i], level + 1);
    }
}

function draw() {
    rects = [];
    drawTree(tree.data, 0);

    ctx.clearRect(0, 0, W + 1, W + 1);

    for (var i = rects.length - 1; i >= 0; i--) {
        ctx.strokeStyle = rects[i][0];
        ctx.globalAlpha = rects[i][1];
        ctx.strokeRect.apply(ctx, rects[i][2]);
    }
}

function search(e) {
    console.time('1 pixel search');
    tree.search({
        minX: e.clientX,
        minY: e.clientY,
        maxX: e.clientX + 1,
        maxY: e.clientY + 1
    });
    console.timeEnd('1 pixel search');
}

function remove() {
    data.sort(tree.compareMinX);
    console.time('remove 10000');
    for (var i = 0; i < 10000; i++) {
        tree.remove(data[i]);
    }
    console.timeEnd('remove 10000');

    data.splice(0, 10000);

    draw();
};
