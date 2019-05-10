
function randBox(size) {
    var x = Math.random() * (100 - size),
        y = Math.random() * (100 - size);
    return [x, y,
        x + size * Math.random(),
        y + size * Math.random()];
}

export function generate(N, size) {
    var data = [];
    for (var i = 0; i < N; i++) {
        data.push(randBox(size));
    }
    return data;
};

export function convert(data) {
    var result = [];
    for (var i = 0; i < data.length; i++) {
        result.push({x: data[i][0], y: data[i][1], w: data[i][2] - data[i][0], h: data[i][3] - data[i][1]});
    }
    return result;
}
