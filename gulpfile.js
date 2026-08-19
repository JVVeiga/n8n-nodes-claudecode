const path = require('path');
const { task, src, dest } = require('gulp');

task('build:icons', copyAssets);

// Icons and codex files: tsc emits neither, and a codex left behind means the node loads without
// its search aliases or its docs link.
function copyAssets() {
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg,json}');
	const nodeDestination = path.resolve('dist', 'nodes');

	return src(nodeSource).pipe(dest(nodeDestination));
}

