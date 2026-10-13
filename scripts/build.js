#!/usr/bin/env node
'use strict';
/**
 * Bla builder — packs the whole application into one standalone executable.
 *
 *   npm run build                 # build for this machine
 *   npm run build -- --target linux-x64
 *   npm run build -- --target win-x64
 *   npm run build -- --outfile dist/bla-nightly
 *
 * How it works (Node's official Single Executable Application flow, so the
 * result needs no Node install, no npm, and no dependencies on the host):
 *
 *   1. esbuild bundles server/ + src/ + node_modules into one CJS file.
 *   2. `node --experimental-sea-config` turns that bundle plus every file
 *      under public/ into a blob that contains the JS and the web assets.
 *   3. postject injects the blob into a copy of the Node runtime.
 *   4. The binary is named `bla` (or `bla.exe` on Windows) and made
 *      executable. Running it starts the server exactly like `npm start`.
 *
 * The build itself needs Node 20+ and works offline apart from the one-time
 * `npm install` of the dev dependencies (esbuild, postject).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

/* ------------------------------------------------------------------ *
 * Tiny CLI
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
function option(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}
const hasFlag = (name) => argv.includes(`--${name}`);

if (hasFlag('help') || hasFlag('h')) {
  console.log(`
Bla builder — pack this chat server into one standalone executable.

Usage:
  npm run build [-- options]

Options:
  --target <platform-arch>   node, node-x64, linux-arm64, win-x64, darwin-arm64, ...
                             (default: this machine)
  --outfile <path>           where to write the executable
                             (default: dist/bla[.exe] inside the project)
  --no-assets                build a binary that serves ./public from disk
                             instead of embedding the front-end
  --keep                     keep the intermediate build files in dist/
  --quiet                    only print the final result
  --help                     show this message

Examples:
  npm run build                        # dist/bla, runs anywhere on this OS
  npm run build -- --target win-x64     # dist/bla.exe for Windows x64
  npm run build -- --outfile /usr/local/bin/bla
`);
  process.exit(0);
}

const QUIET = hasFlag('quiet');
const log = (...args) => { if (!QUIET) console.log(...args); };

function die(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function run(command, args, opts = {}) {
  const label = path.basename(command) === 'node' ? 'node' : command;
  log(`  $ ${label} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) die(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split('\n').slice(-6).join('\n');
    die(`${label} exited with code ${result.status}${detail ? `\n\n${detail}` : ''}`);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Target platform
 * ------------------------------------------------------------------ */

// postject-style target spec, e.g. "linux-x64" or "darwin-arm64".
const target = option('target', `${process.platform}-${process.arch}`).toLowerCase();
const targetPlatform = target.replace(/^node-/, '').split('-')[0];
const targetArch = target.split('-')[1] || process.arch;

const PLATFORMS = {
  linux: { title: 'Linux', ext: '' },
  win32: { title: 'Windows', ext: '.exe', esbuildFlag: 'win' },
  win: { title: 'Windows', ext: '.exe', esbuildFlag: 'win' },
  darwin: { title: 'macOS', ext: '' },
  mac: { title: 'macOS', ext: '' },
  freebsd: { title: 'FreeBSD', ext: '' },
};
const platform = PLATFORMS[targetPlatform];
if (!platform) {
  die(`Unknown target platform "${targetPlatform}". Use one of: ${[...new Set(Object.values(PLATFORMS).map((p) => p.title))].join(', ')}.`);
}

const outFile = path.resolve(ROOT, option('outfile', path.join('dist', `bla${platform.ext}`)));
const withAssets = !hasFlag('no-assets');
const keep = hasFlag('keep');

/* ------------------------------------------------------------------ *
 * 1. Bundle the server
 * ------------------------------------------------------------------ */

log(`\nBla builder — packaging Bla into a standalone ${platform.title} ${targetArch} executable\n`);

log('▸ Bundling the server (esbuild)...');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bla-build-'));
const bundleFile = path.join(buildDir, 'server.cjs');
let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  die('The builder needs esbuild. Run `npm install` first.');
}

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'server', 'index.js')],
  bundle: true,
  outfile: bundleFile,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Optional native add-ons for ws: used only when present, never required.
  external: ['bufferutil', 'utf-8-validate', 'pg-native', 'better-sqlite3'],
  define: {
    'process.env.BLA_VERSION': JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      '// Bla — self-hosted chat. Bundled by scripts/build.js.',
      '// Keep the single-executable startup output clean: node:sqlite reports',
      '// an experimental warning that is not actionable for end users.',
      'const __blaEmitWarning = process.emitWarning;',
      'process.emitWarning = (warning, ...rest) => {',
      "  if (String((warning && warning.message) || warning).includes('SQLite is an experimental feature')) return;",
      '  return __blaEmitWarning.call(process, warning, ...rest);',
      '};',
    ].join('\n'),
  },
  logLevel: 'warning',
});

const bundleKb = (fs.statSync(bundleFile).size / 1024).toFixed(0);
log(`  bundled ${bundleKb} KB of JavaScript`);

/* ------------------------------------------------------------------ *
 * 2. Package the app + web assets into a SEA blob
 * ------------------------------------------------------------------ */

log('▸ Preparing the executable blob...');
const assets = {};
if (withAssets) {
  const publicDir = path.join(ROOT, 'public');
  if (!fs.existsSync(publicDir)) die('No public/ folder found — nothing to embed.');
  let count = 0;
  for (const rel of walk(publicDir)) {
    assets[`public/${rel.split(path.sep).join('/')}`] = path.join(publicDir, rel);
    count += 1;
  }
  log(`  embedding ${count} web asset(s) from public/`);
} else {
  log('  --no-assets: the binary will serve ./public from disk next to it');
}

const seaConfigFile = path.join(buildDir, 'sea-config.json');
fs.writeFileSync(seaConfigFile, JSON.stringify({
  main: bundleFile,
  output: path.join(buildDir, 'bla.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));

run(process.execPath, ['--experimental-sea-config', seaConfigFile]);
const blobFile = path.join(buildDir, 'bla.blob');

/* ------------------------------------------------------------------ *
 * 3. Copy the Node runtime and inject the blob
 * ------------------------------------------------------------------ */

log('▸ Creating the executable (this copies the Node runtime, ~100 MB)...');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.copyFileSync(process.execPath, outFile);
try {
  fs.chmodSync(outFile, 0o755);
} catch { /* Windows */ }

log('▸ Injecting the application...');
const postjectCli = require.resolve('postject/dist/cli.js', { paths: [ROOT] });
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const postjectArgs = [
  postjectCli, outFile, 'NODE_SEA_BLOB', blobFile,
  '--sentinel-fuse', fuse,
  '--overwrite',
];
// Mach-O binaries need an explicit segment name; ELF and PE do not.
if (targetPlatform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
// postject is chatty about ELF section names on some Linux builds; only its
// failures matter, and run() already surfaces those.
run(process.execPath, postjectArgs, { quiet: true });

/* ------------------------------------------------------------------ *
 * 4. Report
 * ------------------------------------------------------------------ */

const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(0);
const rel = path.relative(ROOT, outFile) || outFile;

console.log(`\n✔ Built ${rel} — standalone ${platform.title} ${targetArch} binary, ~${sizeMb} MB`);
if (!QUIET) {
  console.log(`
   Run it:
     ${targetPlatform === process.platform ? `./${path.relative(process.cwd(), outFile) || outFile}` : `(copy dist/${path.basename(outFile)} to a ${platform.title} ${targetArch} machine and run it)`}

   Everything lives in ./data next to where you run it (override with BLA_DATA_DIR).
   The web UI is at http://localhost:${process.env.BLA_PORT || 3000}.
   The first account to register becomes the instance admin.
`);
  if (targetPlatform !== process.platform) {
    console.log(`   Note: you asked for a ${platform.title} binary from a ${process.platform} machine. Node's SEA`);
    console.log('   format only produces binaries for the platform whose runtime you copy, so');
    console.log(`   build on ${platform.title} (or in a ${platform.title} container) to get a native binary.\n`);
  }
}

if (!keep) {
  try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(ROOT, 'dist', 'sea-test'), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(ROOT, 'dist', 'proto'), { recursive: true, force: true }); } catch { /* best effort */ }
} else {
  log(`▸ Intermediate files kept in ${buildDir}`);
}

/** Recursively list files (relative paths) under `dir`. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full).map((rel) => path.join(entry.name, rel)));
    else out.push(entry.name);
  }
  return out;
}
