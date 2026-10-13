/**
 * Single-executable helpers.
 *
 * `npm run build` packs Bla into one self-contained binary with Node's SEA
 * support (see scripts/build.js). The websocket/HTTP server code stays the
 * same; the only difference is where the static front-end lives:
 *
 *   source checkout  →  <repo>/public
 *   packaged binary  →  embedded SEA assets, unpacked to a cache directory
 *                       on first boot, then served from disk
 *
 * `assetRoot()` performs that unpack once (and returns it) so the rest of the
 * app never has to care. `has()`, `text()` and `json()` give code a uniform
 * way to read a file that may live either in the repo or inside the binary.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let sea = null;
try {
  // Built into Node 20+; absent on very old runtimes.
  sea = require('node:sea');
} catch { /* not a packaged binary */ }

function isPackaged() {
  try {
    return Boolean(sea && sea.isSea && sea.isSea());
  } catch {
    return false;
  }
}

/** Cached front-end root for this process (source tree or unpacked assets). */
let cachedRoot = null;

/** Directory the embedded assets get unpacked into. */
function cacheDir() {
  const override = process.env.BLA_ASSET_DIR;
  if (override) return path.resolve(override);
  const version = process.env.BLA_VERSION || 'dev';
  const tag = 'bla-assets-' + version;
  try {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), tag + '-')), 'public');
  } catch {
    return path.join(os.tmpdir(), tag + '-shared', 'public');
  }
}

/** Unpack every embedded asset into `dir`. Returns the number written. */
function unpack(dir) {
  if (!isPackaged() || typeof sea.getAssetKeys !== 'function') return 0;
  let written = 0;
  for (const key of sea.getAssetKeys()) {
    if (!key.startsWith('public/')) continue;
    const target = path.join(dir, key.slice('public/'.length));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = Buffer.from(sea.getAsset(key));
    // Skip files that are already unpacked and unchanged (shared cache dir).
    try {
      const stat = fs.statSync(target);
      if (stat.size === buf.length && stat.mtimeMs >= 0) continue;
    } catch { /* not written yet */ }
    fs.writeFileSync(target, buf);
    written += 1;
  }
  return written;
}

/**
 * Root directory that holds `index.html`, `css/`, `js/`, ... — the source
 * `public/` folder, or the unpacked copy of the embedded assets.
 */
function assetRoot() {
  if (cachedRoot) return cachedRoot;
  if (!isPackaged()) {
    cachedRoot = path.join(require('./config').root, 'public');
    return cachedRoot;
  }
  const dir = cacheDir();
  try {
    unpack(dir);
    cachedRoot = dir;
  } catch (err) {
    // Fall back to the checkout next to the binary if unpacking is blocked.
    process.emitWarning(`Could not unpack embedded assets: ${err.message}`);
    cachedRoot = path.join(require('./config').root, 'public');
  }
  return cachedRoot;
}

/** Read an embedded asset as a Buffer, or null when it isn't embedded. */
function buffer(key) {
  if (!isPackaged() || typeof sea.getAsset !== 'function') return null;
  const startsWith = key.startsWith('public/') ? key : `public/${key}`;
  try {
    if (typeof sea.getAssetKeys === 'function' && !sea.getAssetKeys().includes(startsWith)) return null;
    return Buffer.from(sea.getAsset(startsWith));
  } catch {
    return null;
  }
}

function read(relPath, encoding) {
  const buf = buffer(relPath);
  if (buf) return encoding ? buf.toString(encoding) : buf;
  const local = path.join(assetRoot(), relPath);
  if (!fs.existsSync(local)) return null;
  return fs.readFileSync(local, encoding || undefined);
}

function text(relPath) {
  const value = read(relPath, 'utf8');
  return value == null ? null : value.toString();
}

function json(relPath) {
  const value = text(relPath);
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = { isPackaged, assetRoot, unpack, cacheDir, has: (p) => buffer(p) != null, buffer, read, text, json };
