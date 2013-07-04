rbush
=====

A high-performance JavaScript library for 2D spatial indexing of points and rectangles, based on **R<sup>*</sup>-tree** data structure with **bulk loading** and **bulk insertion** algorithms. Developed by [Vladimir Agafonkin](http://github.com/mourner). _A work in progress_.

## Roadmap

* ~~Bulk loading~~
* ~~Tree search~~
* Single insertion
* Bulk insertion
* Single removal
* Bulk removal

## Basic Usage

```js
var tree = rbush().load([[10, 10, 15, 20], [12, 15, 40, 64.5], ... ]);
var result = tree.search([40, 20, 80, 70]); // minX, minY, maxX, maxY
```

### Data Format

By default, rbush assumes the format of data points as `[minX, minY, maxX, maxY]`. However you can customize this by redefining `sortX`, `sortY` and `toBBox` methods like this:

```js
var tree = rbush();

tree.sortX  = function (a, b) { return a.minLng > b.minLng ? 1 : -1; };
tree.sortY  = function (a, b) { return a.minLat > b.minLat ? 1 : -1; };
tree.toBBox = function (a)    { return [a.minLng, a.minLat, a.maxLng, a.maxLat]; };

tree.load([{id: 'foo', minLng: 30, minLat: 50, maxLng: 40, maxLat: 60}, ...]);
```

## Papers

* [R-trees: a Dynamic Index Structure For Spatial Searching](http://www-db.deis.unibo.it/courses/SI-LS/papers/Gut84.pdf)
* [The R<sup>*</sup>-tree: An Efficient and Robust Access Method for Points and Rectangles+](http://dbs.mathematik.uni-marburg.de/publications/myPapers/1990/BKSS90.pdf)
* [OMT: Overlap Minimizing Top-down Bulk Loading Algorithm for R-tree](http://ftp.informatik.rwth-aachen.de/Publications/CEUR-WS/Vol-74/files/FORUM_18.pdf)
* [Bulk Insertion for R-trees by Seeded Clustering](http://www.cs.arizona.edu/~bkmoon/papers/dke06-bulk.pdf)

## License

This library is licensed under the [MIT License](http://opensource.org/licenses/MIT).<br>
Copyright (c) 2013 Vladimir Agafonkin.
