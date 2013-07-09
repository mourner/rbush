var W = 700,
    canvas = document.getElementById('canvas'),
    ctx = canvas.getContext('2d');

function randBox(size) {
    var x = Math.random() * (W - size),
        y = Math.random() * (W - size);
    return [
        x, y,
        x + size * Math.random(),
        y + size * Math.random()
    ];
}

function randPoint() {
    var x = Math.random() * W,
        y = Math.random() * W;
    return [x, y];
}

function randClusterPoint(dist) {
    var x = dist + Math.random() * (W - dist * 2),
        y = dist + Math.random() * (W - dist * 2);
    return [x, y];
}

function randClusterBox(cluster, dist, size) {
    var d = Math.random() * dist;
    var angle = Math.random() * Math.PI * 2;

    var x = cluster[0] + d * Math.cos(d),
        y = cluster[1] + d * Math.sin(d);

    return [
        x, y,
        x + size * Math.random(),
        y + size * Math.random()
    ];
}

var colors = ['red', 'blue', 'green'],
    rects;

function drawTree(node, level) {
    var rect = [];

    if (level) {
        rect.push(colors[(level - 1) % colors.length]);
        rect.push(1 / level);
        rect.push([
            Math.round(node.bbox[0]) + 0.5,
            Math.round(node.bbox[1]) + 0.5,
            Math.round(node.bbox[2] - node.bbox[0]),
            Math.round(node.bbox[3] - node.bbox[1])
        ]);
    }

    rects.push(rect);

    if (node.leaf) return;
    //if (level === 8) { return; }

    for (var i = 0; i < node.children.length; i++) {
        drawTree(node.children[i], level + 1);
    }
}

function draw() {
    rects = [];
    drawTree(tree.data, 0);

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W + 1, W + 1);

    for (var i = rects.length - 1; i >= 0; i--) {
        ctx.strokeStyle = rects[i][0];
        ctx.globalAlpha = rects[i][1];
        ctx.strokeRect.apply(ctx, rects[i][2]);
    }
}
