rbush
=====

A high-performance JavaScript library for 2D spatial indexing of points and rectangles, based on **R<sup>*</sup>-tree** data structure with **bulk loading** and **bulk insertion** algorithms. Developed by [Vladimir Agafonkin](http://github.com/mourner). _A work in progress_.

## Roadmap

* ~~Bulk loading~~
* ~~Tree search~~
* Single insertion
* Single removal
* Bulk insertion
* Bulk removal

## Basic Usage

```
var tree = rbush().load(data);
var result = tree.search([40, 20, 80, 70]); // bbox in minX, minY, maxX, maxY format
```

### Data Format

By default, rbush assumes the format of data points as `[minX, minY, maxX, maxY]`. However you can customize that by redefining three methods &mdash; `sortX`, `sortY` and `toBBox`:

```
var tree = rbush();

tree.sortX = function (a, b) { return a.bounds.minLng > b.bounds.minLng ? 1 : -1; };
tree.sortY = function (a, b) { return a.bounds.minLat > b.bounds.minLat ? 1 : -1; };

tree.toBBox = function (a) {
	var b = a.bounds;
	return [b.minLng, b.minLat, b.maxLng, b.maxLat];
};

tree.load([{
	id: 'foo',
	bounds: {
		minLng: 30,
		minLat: 50,
		maxLng: 40,
		maxLat: 60
	}
}, ...]);

## Papers

* [R-trees: a Dynamic Index Structure For Spatial Searching](http://www-db.deis.unibo.it/courses/SI-LS/papers/Gut84.pdf)
* [The R<sup>*</sup>-tree: An Efficient and Robust Access Method for Points and Rectangles+](http://dbs.mathematik.uni-marburg.de/publications/myPapers/1990/BKSS90.pdf)
* [OMT: Overlap Minimizing Top-down Bulk Loading Algorithm for R-tree](http://ftp.informatik.rwth-aachen.de/Publications/CEUR-WS/Vol-74/files/FORUM_18.pdf)
* [Bulk Insertion for R-trees by Seeded Clustering](http://www.cs.arizona.edu/~bkmoon/papers/dke06-bulk.pdf)

## License

This library is licensed under the [MIT License](http://opensource.org/licenses/MIT).<br>
Copyright (c) 2013 Vladimir Agafonkin.
