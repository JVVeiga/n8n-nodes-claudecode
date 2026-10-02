#!/bin/sh
# Installs a packed community node the way n8n's own installer does (community-packages.service.js):
# extract the tarball, drop devDependencies, peerDependencies and optionalDependencies from its
# package.json, then `npm install` inside the package directory with n8n's flags. Runs in the
# container, as root.
#
# A plain `npm install <tgz>` keeps optionalDependencies. That is how 2.8.0 shipped a "bundled"
# ffmpeg that no n8n install ever received: the rig installed it, n8n strips it.
set -e
TARBALL="$1"
NODES=/home/node/.n8n/nodes

mkdir -p "$NODES"
cd "$NODES"
[ -f package.json ] || npm init -y >/dev/null

set -- $(tar -xzOf "$TARBALL" package/package.json | node -e '
let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
	const p = JSON.parse(d); console.log(p.name, p.version);
});')
PKG="$1"
VERSION="$2"

DIR="$NODES/node_modules/$PKG"
rm -rf "$DIR"
mkdir -p "$DIR"
tar -xzf "$TARBALL" -C "$DIR" --strip-components=1
node -e '
const fs = require("fs");
const file = process.argv[1];
const { devDependencies, peerDependencies, optionalDependencies, ...rest } = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(file, JSON.stringify(rest, null, 2));
' "$DIR/package.json"

(cd "$DIR" && npm install --audit=false --fund=false --bin-links=false --install-strategy=shallow \
	--ignore-scripts=true --package-lock=false 2>&1 | tail -3)
npm pkg set "dependencies.$PKG=$VERSION"
echo "installed $PKG@$VERSION the way n8n does"
