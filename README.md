RBush
=====

RBush is a high-performance JavaScript library for 2D **spatial indexing** of points and rectangles.
It's based on an optimized **R-tree** data structure with **bulk insertion** support.

*Spatial index* is a special data structure for points and rectangles
that allows you to perform queries like "all items within this bounding box" very efficiently
(e.g. hundreds of times faster than looping over all items).
It's most commonly used in maps and data visualizations.

[![Node](https://github.com/mourner/rbush/actions/workflows/node.yml/badge.svg)](https://github.com/mourner/rbush/actions/workflows/node.yml)
[![](https://img.shields.io/badge/simply-awesome-brightgreen.svg)](https://github.com/mourner/projects)
![](https://img.shields.io/bundlephobia/minzip/rbush)

## Demos

The demos contain visualization of trees generated from 50k bulk-loaded random points.
Open web console to see benchmarks;
click on buttons to insert or remove items;
click to perform search under the cursor.

* [randomly clustered data](http://mourner.github.io/rbush/viz/viz-cluster.html)
* [uniformly distributed random data](http://mourner.github.io/rbush/viz/viz-uniform.html)

## Usage

### Installing RBush

Install with NPM: `npm install rbush`, then import as a module:

```js
import RBush from 'rbush';
```

Or use as a module directly in the browser with [jsDelivr](https://www.jsdelivr.com/esm):

```html
<script type="module">
    import RBush from 'https://cdn.jsdelivr.net/npm/rbush/+esm';
</script>
```

Alternatively, there's a browser bundle with an `RBush` global variable:

```html
<script src="https://cdn.jsdelivr.net/npm/rbush"></script>
```

### Creating a Tree

```js
const tree = new RBush();
```

An optional argument to `RBush` defines the maximum number of entries in a tree node.
`9` (used by default) is a reasonable choice for most applications.
Higher value means faster insertion and slower search, and vice versa.

```js
const tree = new RBush(16);
```

### Adding Data

Insert an item:

```js
const item = {
    minX: 20,
    minY: 40,
    maxX: 30,
    maxY: 50,
    foo: 'bar'
};
tree.insert(item);
```

### Removing Data

Remove a previously inserted item:

```js
tree.remove(item);
```

By default, RBush removes objects by reference.
However, you can pass a custom `equals` function to compare by value for removal,
which is useful when you only have a copy of the object you need removed (e.g. loaded from server):

```js
tree.remove(itemCopy, (a, b) => {
    return a.id === b.id;
});
```

Remove all items:

```js
tree.clear();
```

### Data Format

By default, RBush assumes the format of data points to be an object
with `minX`, `minY`, `maxX` and `maxY` properties.
You can customize this by overriding `toBBox`, `compareMinX` and `compareMinY` methods like this:

```js
class MyRBush extends RBush {
    toBBox([x, y]) { return {minX: x, minY: y, maxX: x, maxY: y}; }
    compareMinX(a, b) { return a.x - b.x; }
    compareMinY(a, b) { return a.y - b.y; }
}
const tree = new MyRBush();
tree.insert([20, 50]); // accepts [x, y] points
```

If you're indexing a static list of points (you don't need to add/remove points after indexing), you should use [kdbush](https://github.com/mourner/kdbush) which performs point indexing 5-8x faster than RBush.

### Bulk-Inserting Data

Bulk-insert the given data into the tree:

```js
tree.load([item1, item2, ...]);
```

Bulk insertion is usually ~2-3 times faster than inserting items one by one.
After bulk loading (bulk insertion into an empty tree),
subsequent query performance is also ~20-30% better.

Note that when you do bulk insertion into an existing tree,
it bulk-loads the given data into a separate tree
and inserts the smaller tree into the larger tree.
This means that bulk insertion works very well for clustered data
(where items in one update are close to each other),
but makes query performance worse if the data is scattered.

### Search

```js
const result = tree.search({
    minX: 40,
    minY: 20,
    maxX: 80,
    maxY: 70
});
```

Returns an array of data items (points or rectangles) that the given bounding box intersects.

Note that the `search` method accepts a bounding box in `{minX, minY, maxX, maxY}` format
regardless of the data format.

```js
const allItems = tree.all();
```

Returns all items of the tree.

### Collisions

```js
const result = tree.collides({minX: 40, minY: 20, maxX: 80, maxY: 70});
```

Returns `true` if there are any items intersecting the given bounding box, otherwise `false`.


### Export and Import

```js
// export data as JSON object
const treeData = tree.toJSON();

// import previously exported data
const tree = rbush(9).fromJSON(treeData);
```

Importing and exporting as JSON allows you to use RBush on both the server (using Node.js) and the browser combined,
e.g. first indexing the data on the server and and then importing the resulting tree data on the client for searching.

Note that the `nodeSize` option passed to the constructor must be the same in both trees for export/import to work properly.

### K-Nearest Neighbors

For "_k_ nearest neighbors around a point" type of queries for RBush,
check out [rbush-knn](https://github.com/mourner/rbush-knn).

## Performance

The following sample performance test was done by generating
random uniformly distributed rectangles of ~0.01% area and setting `maxEntries` to `16`
(see `debug/perf.js` script).
Performed with Node.js v6.2.2 on a Retina Macbook Pro 15 (mid-2012).

Test                         | RBush  | [old RTree](https://github.com/imbcmdth/RTree) | Improvement
---------------------------- | ------ | ------ | ----
insert 1M items one by one   | 3.18s  | 7.83s  | 2.5x
1000 searches of 0.01% area  | 0.03s  | 0.93s  | 30x
1000 searches of 1% area     | 0.35s  | 2.27s  | 6.5x
1000 searches of 10% area    | 2.18s  | 9.53s  | 4.4x
remove 1000 items one by one | 0.02s  | 1.18s  | 50x
bulk-insert 1M items         | 1.25s  | n/a    | 6.7x

## Algorithms Used

* single insertion: non-recursive R-tree insertion with overlap minimizing split routine from R\*-tree (split is very effective in JS, while other R\*-tree modifications like reinsertion on overflow and overlap minimizing subtree search are too slow and not worth it)
* single deletion: non-recursive R-tree deletion using depth-first tree traversal with free-at-empty strategy (entries in underflowed nodes are not reinserted, instead underflowed nodes are kept in the tree and deleted only when empty, which is a good compromise of query vs removal performance)
* bulk loading: OMT algorithm (Overlap Minimizing Top-down Bulk Loading) combined with Floyd–Rivest selection algorithm
* bulk insertion: STLT algorithm (Small-Tree-Large-Tree)
* search: standard non-recursive R-tree search

## Papers

* [R-trees: a Dynamic Index Structure For Spatial Searching](http://www-db.deis.unibo.it/courses/SI-LS/papers/Gut84.pdf)
* [The R*-tree: An Efficient and Robust Access Method for Points and Rectangles+](http://dbs.mathematik.uni-marburg.de/publications/myPapers/1990/BKSS90.pdf)
* [OMT: Overlap Minimizing Top-down Bulk Loading Algorithm for R-tree](http://ftp.informatik.rwth-aachen.de/Publications/CEUR-WS/Vol-74/files/FORUM_18.pdf)
* [Bulk Insertions into R-Trees Using the Small-Tree-Large-Tree Approach](http://www.cs.arizona.edu/~bkmoon/papers/dke06-bulk.pdf)
* [R-Trees: Theory and Applications (book)](http://www.apress.com/9781852339777)

## Development

```bash
npm ci       # install dependencies
npm test     # lint the code and run tests
npm run perf # run performance benchmarks
npm run cov  # report test coverage
```

## Compatibility

RBush v4+ is published as a ES module and no longer supports CommonJS environments. It works universally in modern browsers, but you can transpile the code on your end to support IE11.
