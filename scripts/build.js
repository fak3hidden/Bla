#!/usr/bin/env node
'use strict';
/**
 * Bla builder — packs the whole application into one standalone executable.
 *
 *   npm run build                       # build for this machine
 *   npm run build -- --target win-x64   # Windows binary (see --node below)
 *   npm run build -- --portable         # portable folder instead of one file
 *
 * How it works (Node's official single-executable flow, so the result needs no
 * Node install, no npm and no dependencies on the host):
 *
 *   1. esbuild bundles server/ + src/ + node_modules into one CJS file.
 *   2. `node --experimental-sea-config` turns that bundle plus every file
 *      under public/ into a blob containing the JS and the web assets.
 *   3. The blob is injected into a copy of the Node runtime:
 *        · Windows  → the built-in pure-JavaScript injector in ./pe.js
 *                     (adds the RT_RCDATA resource Node looks for)
 *        · elsewhere → postject
 *   4. The result is verified — including booting it and asking /api/health —
 *      so a broken build fails loudly instead of silently.
 *
 * Everything here is offline: the only network use in the whole flow is the
 * one-time `npm install` of the dev dependencies (esbuild, postject, resedit).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const pe = require('./pe');

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
  --node <path>              the Node runtime to package. Defaults to the one
                             running this script; point it at a node.exe to
                             build a Windows binary from Linux/macOS.
  --outfile <path>           where to write the executable
                             (default: dist/bla[.exe] inside the project)
  --inject <auto|builtin|postject>
                             how to inject the blob. "builtin" is the pure-JS
                             Windows injector, "postject" is the WASM one.
                             Default: builtin for Windows targets, postject
                             everywhere else.
  --portable                 build a folder (runtime + app + web assets +
                             launcher) instead of a single file. Works even
                             where self-modifying executables are blocked.
  --no-assets                build a binary that serves ./public from disk
                             instead of embedding the front-end
  --no-verify                skip the post-build checks (including the boot test)
  --keep                     keep the intermediate build files in dist/
  --quiet                    only print the final result
  --help                     show this message

Examples:
  npm run build                          # dist/bla, runs anywhere on this OS
  npm run build -- --target win-x64       # dist/bla.exe (needs --node node.exe)
  npm run build -- --outfile /usr/local/bin/bla
  npm run build -- --portable             # dist/Bla-<platform>-<arch>/ folder
`);
  process.exit(0);
}

const QUIET = hasFlag('quiet');
const log = (...args) => { if (!QUIET) console.log(...args); };
const warn = (...args) => console.log(...args); // warnings always show

function die(message, details = '') {
  console.error(`\n✖ ${message}\n`);
  if (details) console.error(details.trim() + '\n');
  process.exit(1);
}

/** Copy/move helpers that explain themselves when the OS says "busy". */
function writeOutputFile(from, to, buffer) {
  try {
    if (buffer) fs.writeFileSync(to, buffer);
    else fs.copyFileSync(from, to);
  } catch (err) {
    if (['ETXTBSY', 'EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
      die(
        `Cannot write ${path.relative(ROOT, to) || to} — the file is in use.`,
        `If an earlier build of Bla is still running, stop it first (on Linux an
executable cannot be overwritten while it is running). Or build somewhere else:

  npm run build -- --outfile dist/bla-$(date +%s)`,
      );
    }
    throw err;
  }
}

function run(command, args, opts = {}) {
  const label = path.basename(command) === 'node' ? 'node' : command;
  if (!QUIET && !opts.silent) log(`  $ ${label} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (result.error) die(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const raw = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const tail = raw.split('\n').slice(-24).join('\n');
    let hint = '';
    if (opts.quiet && raw) {
      try {
        fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
        const logFile = path.join(ROOT, 'dist', 'build-error.log');
        fs.writeFileSync(logFile, raw);
        hint = `\nThe full output was saved to ${path.relative(ROOT, logFile)}.`;
      } catch { /* best effort */ }
    }
    die(`${label} exited with code ${result.status}`, tail + hint);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Target platform
 * ------------------------------------------------------------------ */

const target = option('target', `${process.platform}-${process.arch}`).toLowerCase();
const targetPlatform = target.replace(/^node-/, '').split('-')[0];
const targetArch = target.split('-')[1] || process.arch;

const PLATFORMS = {
  linux: { title: 'Linux', ext: '' },
  win32: { title: 'Windows', ext: '.exe', peFile: true },
  win: { title: 'Windows', ext: '.exe', peFile: true },
  windows: { title: 'Windows', ext: '.exe', peFile: true },
  darwin: { title: 'macOS', ext: '' },
  mac: { title: 'macOS', ext: '' },
  freebsd: { title: 'FreeBSD', ext: '' },
};
const platform = PLATFORMS[targetPlatform];
if (!platform) {
  die(`Unknown target platform "${targetPlatform}". Use one of: ${[...new Set(Object.values(PLATFORMS).map((p) => p.title))].join(', ')}.`);
}

const outFile = path.resolve(ROOT, option('outfile', path.join('dist', `bla${platform.ext}`)));
const portable = hasFlag('portable');
const portableDir = path.resolve(ROOT, option('outfile', path.join('dist', `Bla-${targetPlatform}-${targetArch}`)));
const withAssets = !hasFlag('no-assets');
const keep = hasFlag('keep');
const verify = !hasFlag('no-verify');
const injector = String(option('inject', 'auto')).toLowerCase();
if (!['auto', 'builtin', 'postject'].includes(injector)) {
  die(`Unknown --inject value "${injector}". Use auto, builtin or postject.`);
}

/* ------------------------------------------------------------------ *
 * The Node runtime we package
 * ------------------------------------------------------------------ */

const runtime = path.resolve(option('node', process.execPath));
if (!fs.existsSync(runtime)) die(`No Node runtime at ${runtime}`);
const runtimeIsPe = (() => {
  try {
    const fd = fs.openSync(runtime, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return head.toString('ascii') === 'MZ';
  } catch {
    return false;
  }
})();
const runtimePlatform = runtimeIsPe ? 'win32' : 'unix';

if (platform.peFile && !runtimeIsPe) {
  die(
    `You asked for a Windows binary, but ${path.basename(runtime)} is not a Windows executable.`,
    `Node's single-executable format always packages a copy of the runtime it is
given, so build a Windows binary on Windows — or point the builder at a
Windows node.exe:

  npm run build -- --target win-x64 --node "C:\\path\\to\\node.exe"

(The builder runs offline; any Windows node.exe of version 22.5 or newer works.)`,
  );
}
if (!platform.peFile && runtimeIsPe) {
  die(
    `You asked for a ${platform.title} binary, but ${path.basename(runtime)} is a Windows executable.`,
    `Point --node at the ${platform.title} node runtime, or run the build on ${platform.title}.`,
  );
}

/* ------------------------------------------------------------------ *
 * 1. Bundle the server
 * ------------------------------------------------------------------ */

log(`\nBla builder — packaging Bla into a standalone ${platform.title} ${targetArch} ${portable ? 'folder' : 'executable'}\n`);

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  die(
    'The builder needs esbuild, but it is not installed.',
    `Run this first (it only needs the network once):

  npm install

or use the one-click helper at the project root: build-windows.bat`,
  );
}
try {
  require.resolve('postject/dist/cli.js', { paths: [ROOT] });
} catch {
  if (injector === 'postject' || (!platform.peFile && injector !== 'builtin')) {
    die('The builder needs postject for this target, but it is not installed.', 'Run: npm install');
  }
}

log('▸ Bundling the server (esbuild)...');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bla-build-'));
const bundleFile = path.join(buildDir, 'server.cjs');

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'server', 'index.js')],
  bundle: true,
  outfile: bundleFile,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Optional native add-ons for ws: used only when present, never required.
  external: ['bufferutil', 'utf-8-validate', 'pg-native', 'better-sqlite3'],
  define: { 'process.env.BLA_VERSION': JSON.stringify(pkg.version) },
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
      // A portable folder should work no matter how it is started, so the
      // bundle points the app at its own directory.
      ...(portable ? ["process.env.BLA_ROOT = process.env.BLA_ROOT || __dirname;"] : []),
    ].join('\n'),
  },
  logLevel: 'warning',
});
log(`  bundled ${(fs.statSync(bundleFile).size / 1024).toFixed(0)} KB of JavaScript`);

/* ------------------------------------------------------------------ *
 * 2. Portable folder (no injection at all)
 * ------------------------------------------------------------------ */

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

if (portable) {
  log('▸ Building a portable folder...');
  fs.rmSync(portableDir, { recursive: true, force: true });
  fs.mkdirSync(portableDir, { recursive: true });
  fs.copyFileSync(runtime, path.join(portableDir, `bla${platform.ext}`));
  fs.copyFileSync(bundleFile, path.join(portableDir, 'app.cjs'));
  if (withAssets) copyTree(path.join(ROOT, 'public'), path.join(portableDir, 'public'));
  const launcher = `@echo off\r
rem Bla — starts the server in this folder. Data is stored in .\\data.\r
setlocal\r
set "BLA_ROOT=%~dp0"\r
"%~dp0bla${platform.ext}" "%~dp0app.cjs" %*\r
`;
  if (platform.peFile) fs.writeFileSync(path.join(portableDir, 'Bla.cmd'), launcher.replace(/\n/g, '\n'));
  else {
    fs.writeFileSync(
      path.join(portableDir, 'bla.sh'),
      `#!/bin/sh\n# Bla — starts the server in this folder.\ncd "$(dirname "$0")"\nBLA_ROOT="$(pwd)" ./bla app.cjs "$@"\n`,
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(path.join(portableDir, 'README.txt'), [
    'Bla — portable build',
    '',
    `Run it:  ${platform.peFile ? 'Bla.cmd' : './bla.sh'}     (or: bla app.cjs)`,
    '',
    'Everything is in this folder; accounts, messages and uploads are stored in',
    './data, which is created on first start. The first account you register',
    'becomes the instance admin.',
    '',
    `Server settings come from environment variables, e.g. BLA_PORT=${process.env.BLA_PORT || 3000}.`,
    `Web UI: http://localhost:${process.env.BLA_PORT || 3000}`,
    '',
  ].join('\n'));
  log(`  ${portableDir}`);
  console.log(`\n✔ Built the portable folder ${path.relative(ROOT, portableDir) || portableDir} (${platform.title} ${targetArch})`);
  if (!QUIET) {
    console.log(`
   Run it:
     ${platform.peFile ? `${path.join(path.relative(process.cwd(), portableDir) || portableDir, 'Bla.cmd')}` : `cd ${path.relative(process.cwd(), portableDir) || portableDir} && ./bla.sh`}
`);
    if (targetPlatform !== process.platform && !platform.peFile) {
      console.log('   Copy the folder to the target machine before running it.\n');
    }
  }
  if (!keep) fs.rmSync(buildDir, { recursive: true, force: true });
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 3. Package the app + web assets into a SEA blob
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
const blob = fs.readFileSync(blobFile);

/* ------------------------------------------------------------------ *
 * 4. Create the executable and inject the blob
 * ------------------------------------------------------------------ */

log(`▸ Creating the executable (copies the Node runtime, ${(fs.statSync(runtime).size / 1048576).toFixed(0)} MB)...`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
writeOutputFile(runtime, outFile);
try { fs.chmodSync(outFile, 0o755); } catch { /* Windows */ }

const useBuiltin = injector === 'builtin' || (injector === 'auto' && platform.peFile);

if (useBuiltin) {
  log('▸ Injecting the application (pure-JavaScript injector)...');
  try {
    let buffer = fs.readFileSync(outFile);
    const stripped = pe.stripCertificateTable(buffer);
    buffer = stripped.buffer;
    if (stripped.stripped) log(`  removed the ${stripped.stripped}-byte Authenticode signature`);
    buffer = pe.flipFuse(buffer).buffer;
    buffer = pe.injectResource(buffer, 'NODE_SEA_BLOB', blob);
    writeOutputFile(null, outFile, buffer);
    try { fs.chmodSync(outFile, 0o755); } catch { /* Windows */ }
  } catch (err) {
    if (injector === 'builtin') {
      die(
        `Injection failed: ${err.message}`,
        `${process.env.BLA_DEBUG ? err.stack : ''}
The built-in injector only works on Windows executables. If you did not ask for
that on purpose, build without --inject builtin.`,
      );
    }
    warn(`\n  ! The built-in injector failed (${err.message}); falling back to postject.`);
    writeOutputFile(runtime, outFile);
    injectBlobWithPostject();
  }
} else {
  injectBlobWithPostject();
}

function injectBlobWithPostject() {
  log('▸ Injecting the application (postject)...');
  const postjectCli = require.resolve('postject/dist/cli.js', { paths: [ROOT] });
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const args = [postjectCli, outFile, 'NODE_SEA_BLOB', blobFile, '--sentinel-fuse', fuse, '--overwrite'];
  if (targetPlatform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  const quiet = run(process.execPath, args, { quiet: true }); // postject is noisy on some Linux builds
  void quiet;
}

/* ------------------------------------------------------------------ *
 * 5. Verify the result
 * ------------------------------------------------------------------ */

function verifyBuild() {
  const problems = [];
  const out = fs.readFileSync(outFile);

  if (platform.peFile) {
    // Independent reader: does the file really contain what Windows will look up?
    const embedded = pe.findResource(out, pe.RT_RCDATA, 'NODE_SEA_BLOB');
    if (!embedded) problems.push('the NODE_SEA_BLOB resource is missing');
    else if (!embedded.equals(blob)) problems.push(`the embedded blob is ${embedded.length} bytes, expected ${blob.length}`);
    if (!out.includes(Buffer.from(`${pe.FUSE}:1`))) problems.push('the SEA fuse was not flipped');
    if (pe.certificateTable(out)) problems.push('the Authenticode signature table is still present');
    const headers = pe.parseHeaders(out);
    const sizeOfImage = out.readUInt32LE(headers.sizeOfImageOffset);
    const maxEnd = Math.max(...headers.sections.map((s) => s.virtualAddress + Math.max(s.virtualSize, s.rawSize)));
    if (sizeOfImage < maxEnd) problems.push('SizeOfImage is smaller than the last section — Windows would refuse to load it');
  } else {
    if (!out.includes(Buffer.from(`${pe.FUSE}:1`))) problems.push('the SEA fuse was not flipped');
    if (out.length <= fs.statSync(runtime).size) problems.push('the output is not larger than the runtime, so nothing was injected');
  }

  if (problems.length) {
    die(`The build produced an invalid executable:\n  · ${problems.join('\n  · ')}`, 'This is a bug in the builder — please report it with the command you ran.');
  }
  return true;
}

/** Blocking sleep — keeps the flow linear without top-level await. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start the freshly built binary on a spare port with a throwaway data
 * directory and ask it for /api/health. Only possible when the build targets
 * the machine we are on.
 */
function bootTest() {
  if (targetPlatform !== process.platform || targetArch !== process.arch) return 'skipped';
  const { spawn, spawnSync: sync } = require('child_process');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bla-verify-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const cleanup = () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } };
  const child = spawn(outFile, [], {
    env: { ...process.env, BLA_PORT: String(port), BLA_HOST: '127.0.0.1', BLA_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const probe = `fetch('http://127.0.0.1:${port}/api/health').then(r=>r.json()).then(b=>{console.log(JSON.stringify(b));process.exit(0)}).catch(()=>process.exit(1))`;
  const deadline = Date.now() + 20000;
  sleepSync(400);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { cleanup(); return `the built binary exited immediately (code ${child.exitCode})`; }
    const result = sync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 6000 });
    if (result.status === 0) {
      child.kill();
      cleanup();
      try {
        const body = JSON.parse((result.stdout || '').trim());
        return body && body.status === 'ok' ? 'ok' : `unexpected health response: ${JSON.stringify(body)}`;
      } catch {
        return `unreadable health response: ${(result.stdout || '').trim()}`;
      }
    }
    sleepSync(500);
  }
  child.kill();
  cleanup();
  return 'it did not answer /api/health within 20 seconds';
}

if (verify) {
  log('▸ Verifying the executable...');
  verifyBuild();
  log(platform.peFile || targetPlatform !== process.platform
    ? '  structure is valid (this platform cannot run the result, so the boot test is skipped)'
    : '  structure is valid');
}

/* ------------------------------------------------------------------ *
 * 6. Report
 * ------------------------------------------------------------------ */

const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(0);
const relOut = path.relative(ROOT, outFile) || outFile;

if (verify && (targetPlatform === process.platform && targetArch === process.arch)) {
  const result = bootTest();
  if (result === 'ok') {
    log('  it boots and answers /api/health ✓');
  } else if (result !== 'skipped') {
    die(
      `The built binary did not start: ${result}`,
      `The file itself is intact — the structure check above passed — so this is
either a platform problem or security software refusing to launch a
freshly built, unsigned executable.

  · Run it by hand to see the real error:  ${path.relative(ROOT, outFile) || outFile}
  · On Windows, antivirus/SmartScreen can block a brand-new .exe on its first
    launch: allow it, then run the file again.
  · Rebuild without the boot test:  npm run build -- --no-verify`,
    );
  }
}

console.log(`\n✔ Built ${relOut} — standalone ${platform.title} ${targetArch} binary, ~${sizeMb} MB`);
if (!QUIET) {
  console.log(`
   Run it:
     ${targetPlatform === process.platform ? `./${path.relative(process.cwd(), outFile) || outFile}` : `(copy ${path.basename(outFile)} to a ${platform.title} ${targetArch} machine and run it)`}

   Everything lives in ./data next to where you run it (override with BLA_DATA_DIR).
   The web UI is at http://localhost:${process.env.BLA_PORT || 3000}.
   The first account to register becomes the instance admin.
`);
  if (targetPlatform !== process.platform) {
    console.log(`   Note: this is a ${platform.title} binary built on ${process.platform}. Copy it to a`);
    console.log(`   ${platform.title} ${targetArch} machine to run it.\n`);
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
