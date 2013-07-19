RBush
=====

RBush is a high-performance JavaScript library for 2D **spatial indexing** of points and rectangles
by [Vladimir Agafonkin](http://github.com/mourner),
based on an optimized **R-tree** data structure with **bulk loading** support.

*Spatial index* is a special data structure for points and rectangles
that allows you to perform queries like "all items within this bounding box" very efficiently
(e.g. hundreds of times faster than looping over all items).
It's most commonly used in maps and data visualizations.

## Demos

The demos contain visualization of trees generated from 50k bulk-loaded random points.
Open web console to see benchmarks;
click on buttons to insert or remove items;
click to perform search under the cursor.

* [uniformly distributed random data](http://mourner.github.io/rbush/viz/viz-uniform.html)
* [randomly clustered data](http://mourner.github.io/rbush/viz/viz-cluster.html)

## Performance

The following sample performance test was done by generating
random uniformly distributed rectangles of ~0.01% area (see `debug/perf.js` script).
Performed with Node.js on a Retina Macbook Pro mid-2012.

Test                         | RBush  | [old RTree](https://github.com/imbcmdth/RTree)
---------------------------- | ------ | ------
insert 1M items one by one   | 9.25s  | 13.12s
bulk load 1M items           | 4.14s  | n/a
1000 searches of 1% area     | 1.22s  | 7.52s
1000 searches of 0.01% area  | 0.09s  | 4.21s
remove 1000 items one by one | 0.04s  | 2.68s

## Usage

### Creating a Tree

```js
var tree = rbush(9);
```

An optional argument to `rbush` defines the maximum number of entries in a tree node.
It drastically affects the performance, so you should adjust it
considering the type of data and search queries you perform.

### Data Format

By default, RBush assumes the format of data points to be `[minX, minY, maxX, maxY]`.
You can customize this by providing an array with `minX`, `minY`, `maxX`, `maxY` accessor strings
as a second argument to `rbush` like this:

```js
var tree = rbush(4, ['.minLng', '.minLat', '.maxLng', '.maxLat']);
tree.insert({id: 'foo', minLng: 30, minLat: 50, maxLng: 40, maxLat: 60});
```

### Adding and Removing Data

Insert an item:

```js
var item = [20, 40, 30, 50];
tree.insert(item);
```

Remove a previously inserted item:

```js
tree.remove(item);
```

Clear all items:

```js
tree.clear();
```

### Loading Data

Build a tree with the given data from scratch:

```js
tree.load([
	[10, 10, 15, 20],
	[12, 15, 40, 64.5],
	...
]);
```

Bulk loading is usually ~2-3 times faster than inserting items one by one,
and subsequent query performance is also ~20-30% better.

### Search

```js
var result = tree.search([40, 20, 80, 70]);
```

Returns an array of data items (points or rectangles) that the given bounding box (`[minX, minY, maxX, maxY]`) intersects.

### Export and Import

```js
// export data as JSON object
tree.toJSON();

// import previously exported data
var tree = rbush(4).fromJSON(treeData);
```

Importing and exporting as JSON allows you to use RBush on both the server (using Node.js) and the browser combined,
e.g. first indexing the data on the server and and then importing the resulting tree data on the client for searching.

## Algorithms Used

* single insertion: non-recursive R-tree insertion with overlap minimizing split routine from R*-tree (split is very effective in JS, while other R*-tree modifications like reinsertion on overflow and overlap minimizing subtree search are too slow and not worth it)
* single deletion: non-recursive R-tree algorithm using depth-first tree traversal with free-at-empty strategy (entries in underflowed nodes are not reinserted, instead underflowed nodes are kept in the tree and deleted only when empty, which is a good compromise of query vs removal performance)
* bulk loading: OMT algorithm (Overlap Minimizing Top-down Bulk Loading)
* search: standard non-recursive R-tree search

## Roadmap

* ~~tree search~~
* ~~bulk loading~~
* ~~single insertion~~
* ~~single deletion~~
* bulk insertion (STLT or seeded clustering)
* area deletion

## Papers

* [R-trees: a Dynamic Index Structure For Spatial Searching](http://www-db.deis.unibo.it/courses/SI-LS/papers/Gut84.pdf)
* [The R*-tree: An Efficient and Robust Access Method for Points and Rectangles+](http://dbs.mathematik.uni-marburg.de/publications/myPapers/1990/BKSS90.pdf)
* [OMT: Overlap Minimizing Top-down Bulk Loading Algorithm for R-tree](http://ftp.informatik.rwth-aachen.de/Publications/CEUR-WS/Vol-74/files/FORUM_18.pdf)
* [Bulk Insertion for R-trees by Seeded Clustering](http://www.cs.arizona.edu/~bkmoon/papers/dke06-bulk.pdf)
* [R-Trees: Theory and Applications (book)](http://metro-natshar-31-71.brain.net.pk/articles/1852339772.pdf)

## License

This library is licensed under the [MIT License](http://opensource.org/licenses/MIT).<br>
Copyright (c) 2013 Vladimir Agafonkin.
