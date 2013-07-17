RBush
=====

A high-performance JavaScript library for 2D spatial indexing of points and rectangles by [Vladimir Agafonkin](http://github.com/mourner),
based on **R<sup>*</sup>-tree** data structure with **bulk loading** and **bulk insertion** algorithms.
_A work in progress_.

A spatial index is a special data structure for points and rectangles that allows you to perform queries like "give me all items within this bounding box" very efficiently (e.g. hundreds of times faster than looping over all items). It's most commonly used in maps and data visualizations.

## Roadmap

* ~~tree search~~
* ~~bulk loading (OMT)~~
* ~~single insertion (R<sup>*</sup>-tree)~~
* bulk insertion (STLT or seeded clustering)
* single deletion
* bulk deletion

## Usage

### Creating a Tree

```js
var tree = rbush(4);
```

The first argument to `rbush` defines the maximum number of entries in a tree node.
It drastically affects the performance, so you should adjust it considering the type of data and search queries you perform.

### Loading Data

```js
tree.load([
	[10, 10, 15, 20],
	[12, 15, 40, 64.5],
	...
]);
```

Builds a tree with the given rectangle data from scratch.
Bulk loading like this is many times faster than inserting data items one by one.

#### Data Format

By default, RBush assumes the format of data points to be `[minX, minY, maxX, maxY]`.
You can customize this by providing an array with `minX`, `minY`, `maxX`, `maxY` accessor strings as a second argument to `rbush` like this:

```js
var tree = rbush(4, ['.minLng', '.minLat', '.maxLng', '.maxLat']);

tree.load([{
	id: 'foo',
	minLng: 30,
	minLat: 50,
	maxLng: 40,
	maxLat: 60
}, ...]);
```

### Adding and Removing Data

```js
tree.insert([20, 40, 30, 50]);
```

Inserting many items one by one is much less efficient than bulk loading and bulk insertion, so avoid it if possible.

Bulk insertion and deletion not yet supported (work in progress).

### Search

```js
var result = tree.search([40, 20, 80, 70]);
```

Returns an array of data items (points or rectangles) that the given bounding box (`[minX, minY, maxX, maxY]`) intersects.

## Export and Import

```
// export data as JSON object
tree.toJSON();

// import previously exported data
var tree = rbush(4).fromJSON(treeData);
```

Importing and exporting as JSON allows you to use RBush on both the server (using Node.js) and the browser combined,
e.g. first indexing the data on the server and and then importing the resulting tree data on the client for searching.

## Papers

* [R-trees: a Dynamic Index Structure For Spatial Searching](http://www-db.deis.unibo.it/courses/SI-LS/papers/Gut84.pdf)
* [The R<sup>*</sup>-tree: An Efficient and Robust Access Method for Points and Rectangles+](http://dbs.mathematik.uni-marburg.de/publications/myPapers/1990/BKSS90.pdf)
* [OMT: Overlap Minimizing Top-down Bulk Loading Algorithm for R-tree](http://ftp.informatik.rwth-aachen.de/Publications/CEUR-WS/Vol-74/files/FORUM_18.pdf)
* [Bulk Insertion for R-trees by Seeded Clustering](http://www.cs.arizona.edu/~bkmoon/papers/dke06-bulk.pdf)
* [R-Trees: Theory and Applications (book)](http://metro-natshar-31-71.brain.net.pk/articles/1852339772.pdf)

## License

This library is licensed under the [MIT License](http://opensource.org/licenses/MIT).<br>
Copyright (c) 2013 Vladimir Agafonkin.
