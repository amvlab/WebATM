/*
 * Copies third-party CSS + font assets from node_modules into
 * WebATM/static/vendor/ so index.html can load them without reaching
 * the public internet. Runs automatically before `npm run build` via
 * the "prebuild" hook in package.json.
 */

const fs = require('fs');
const path = require('path');

const frontendDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendDir, '..');
const staticDir = path.join(repoRoot, 'WebATM', 'static');
const vendorDir = path.join(staticDir, 'vendor');

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else if (entry.isFile()) fs.copyFileSync(s, d);
    }
}

const jobs = [
    {
        name: 'maplibre-gl css',
        src: path.join(frontendDir, 'node_modules/maplibre-gl/dist/maplibre-gl.css'),
        dest: path.join(vendorDir, 'maplibre-gl/maplibre-gl.css'),
        kind: 'file',
    },
    {
        name: 'fontawesome css',
        src: path.join(frontendDir, 'node_modules/@fortawesome/fontawesome-free/css/all.min.css'),
        dest: path.join(vendorDir, 'fontawesome/css/all.min.css'),
        kind: 'file',
    },
    {
        name: 'fontawesome webfonts',
        src: path.join(frontendDir, 'node_modules/@fortawesome/fontawesome-free/webfonts'),
        dest: path.join(vendorDir, 'fontawesome/webfonts'),
        kind: 'dir',
    },
];

let missing = [];
for (const job of jobs) {
    if (!fs.existsSync(job.src)) {
        missing.push(`${job.name}: ${job.src}`);
        continue;
    }
    if (job.kind === 'file') copyFile(job.src, job.dest);
    else copyDir(job.src, job.dest);
    console.log(`  vendored ${job.name} -> ${path.relative(staticDir, job.dest)}`);
}

if (missing.length) {
    console.error('vendor-assets: missing source files. Did you run `npm install`?');
    for (const m of missing) console.error('  - ' + m);
    process.exit(1);
}
