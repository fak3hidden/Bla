'use strict';
/**
 * Minimal, dependency-light PE (Windows executable) toolkit used by the
 * builder. Everything here is plain JavaScript — no WebAssembly, no native
 * modules — so packaging a Windows binary works on any machine that can run
 * the builder itself.
 *
 * It does three jobs:
 *
 *   1. `stripCertificateTable()` removes the Authenticode signature from a
 *      copied node.exe. Node's own documentation recommends this before
 *      injection, and leaving it in place is what produces postject's
 *      "The signature seems corrupted!" warning (the injected resource
 *      overwrites the signature blob).
 *   2. `flipFuse()` flips the Node SEA fuse from `:0` to `:1`, the switch
 *      Node checks at startup to decide that a blob was injected.
 *   3. `injectResource()` adds the blob as an `RT_RCDATA` resource named
 *      `NODE_SEA_BLOB` — exactly what Node looks up on Windows with
 *      `FindResourceA(NULL, "NODE_SEA_BLOB", MAKEINTRESOURCEA(10))`.
 *
 * `readResourceTree()` is an independent reader (it does not share code with
 * the writer) and is used to verify the result before calling a build
 * successful.
 */

const RT_RCDATA = 10; // MAKEINTRESOURCEA(10) — where the SEA blob lives.

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */

const DOS_SIGNATURE = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"

function isPe(buffer) {
  return buffer.length > 0x40 && buffer.readUInt16LE(0) === DOS_SIGNATURE;
}

/** Parsed view over the headers we care about. */
function parseHeaders(buffer) {
  if (!isPe(buffer)) throw new Error('Not a Windows executable (missing MZ header).');
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error('Not a Windows executable (missing PE header).');
  }
  const numSections = buffer.readUInt16LE(peOffset + 6);
  const sizeOfOptionalHeader = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalOffset);
  const pe32Plus = magic === 0x20b;
  if (!pe32Plus && magic !== 0x10b) {
    throw new Error(`Unsupported optional header magic 0x${magic.toString(16)}.`);
  }
  const dataDirOffset = optionalOffset + (pe32Plus ? 112 : 96);
  const sectionsOffset = optionalOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const at = sectionsOffset + i * 40;
    sections.push({
      name: buffer.subarray(at, at + 8).toString('ascii').replace(/\0.*$/, ''),
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      rawSize: buffer.readUInt32LE(at + 16),
      rawOffset: buffer.readUInt32LE(at + 20),
    });
  }
  return {
    peOffset,
    pe32Plus,
    optionalOffset,
    dataDirOffset,
    sectionsOffset,
    numSections,
    sections,
    sizeOfImageOffset: optionalOffset + 56,
    checksumOffset: optionalOffset + 64,
    numDataDirectories: buffer.readUInt32LE(optionalOffset + (pe32Plus ? 108 : 92)),
  };
}

/** Map a relative virtual address to a file offset. */
function rvaToOffset(headers, rva) {
  for (const section of headers.sections) {
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
      return section.rawOffset + (rva - section.virtualAddress);
    }
  }
  return -1;
}

/** Read data directory `index` (4 = the Authenticode certificate table). */
function readDataDirectory(buffer, headers, index) {
  if (index >= headers.numDataDirectories) return { address: 0, size: 0 };
  const at = headers.dataDirOffset + index * 8;
  return { address: buffer.readUInt32LE(at), size: buffer.readUInt32LE(at + 4) };
}

/** The certificate table directory, or null when the binary is unsigned. */
function certificateTable(buffer) {
  const headers = parseHeaders(buffer);
  const dir = readDataDirectory(buffer, headers, 4);
  if (!dir.size) return null;
  // For the security directory the "address" field is a file offset, not an RVA.
  const offset = dir.address;
  const size = Math.min(dir.size, buffer.length - offset);
  if (offset <= 0 || offset >= buffer.length || size <= 0) return null;
  let declared = size;
  try {
    const winCertLength = buffer.readUInt32LE(offset);
    if (winCertLength > 0 && winCertLength <= buffer.length - offset) declared = winCertLength;
  } catch { /* keep the directory size */ }
  return { offset, size, directoryOffset: headers.dataDirOffset + 4 * 8, declared };
}

/**
 * Remove the Authenticode signature: zero the security directory entry and
 * drop the certificate blob from the end of the file. Returns a new buffer.
 */
function stripCertificateTable(buffer) {
  const cert = certificateTable(buffer);
  if (!cert) return { buffer, stripped: 0 };
  const out = Buffer.from(buffer.subarray(0, cert.offset));
  out.writeUInt32LE(0, cert.directoryOffset);
  out.writeUInt32LE(0, cert.directoryOffset + 4);
  return { buffer: out, stripped: cert.size };
}

/* ------------------------------------------------------------------ *
 * Fuse
 * ------------------------------------------------------------------ */

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Flip `NODE_SEA_FUSE_…:0` to `:1`, the flag Node reads at startup. */
function flipFuse(buffer) {
  const needle = Buffer.from(`${FUSE}:0`, 'ascii');
  const first = buffer.indexOf(needle);
  if (first === -1) {
    // Already flipped, or built without SEA support — report which.
    if (buffer.indexOf(Buffer.from(`${FUSE}:1`, 'ascii')) !== -1) return { buffer, already: true };
    throw new Error('Could not find the Node SEA fuse in the runtime — is this a Node 20+ binary?');
  }
  if (buffer.indexOf(needle, first + 1) !== -1) {
    throw new Error('Found more than one Node SEA fuse in the runtime.');
  }
  const out = Buffer.from(buffer);
  out[first + needle.length - 1] = '1'.charCodeAt(0);
  return { buffer: out, already: false };
}

/* ------------------------------------------------------------------ *
 * Resources (independent reader)
 * ------------------------------------------------------------------ */

function readResourceNameString(buffer, base, offset) {
  const at = base + offset;
  const length = buffer.readUInt16LE(at);
  return buffer.subarray(at + 2, at + 2 + length * 2).toString('utf16le');
}

function readResourceDirectory(buffer, base, rootOffset, headers) {
  const entries = [];
  const walk = (dirOffset, depth, type, name, lang) => {
    const at = base + dirOffset;
    const named = buffer.readUInt16LE(at + 12);
    const idCount = buffer.readUInt16LE(at + 14);
    for (let i = 0; i < named + idCount; i += 1) {
      const entry = at + 16 + i * 8;
      const nameOrId = buffer.readUInt32LE(entry);
      const offsetField = buffer.readUInt32LE(entry + 4);
      const isString = (nameOrId & 0x80000000) !== 0;
      const id = isString
        ? readResourceNameString(buffer, base, nameOrId & 0x7fffffff)
        : nameOrId;
      const child = offsetField & 0x7fffffff;
      if (depth === 0) walk(child, 1, id, null, null);
      else if (depth === 1) walk(child, 2, type, id, null);
      else {
        const dataEntry = base + child;
        const dataRva = buffer.readUInt32LE(dataEntry);
        const size = buffer.readUInt32LE(dataEntry + 4);
        const codePage = buffer.readUInt32LE(dataEntry + 8);
        entries.push({ type, name, lang: id, dataRva, size, codePage });
      }
    }
  };
  walk(rootOffset, 0, null, null, null);
  return entries;
}

/** Every resource in the file, resolved to file offsets. */
function readResourceTree(buffer) {
  const headers = parseHeaders(buffer);
  const dir = readDataDirectory(buffer, headers, 2);
  if (!dir.address || !dir.size) return [];
  const base = rvaToOffset(headers, dir.address);
  if (base < 0) return [];
  return readResourceDirectory(buffer, base, 0, headers).map((entry) => {
    const offset = rvaToOffset(headers, entry.dataRva);
    return {
      ...entry,
      offset,
      data: offset >= 0 ? buffer.subarray(offset, offset + entry.size) : null,
    };
  });
}

/** Look a resource up the same way Windows' FindResourceA() does. */
function findResource(buffer, type, name) {
  const wanted = String(name).toUpperCase();
  const entry = readResourceTree(buffer).find(
    (r) => String(r.type) === String(type) && String(r.name).toUpperCase() === wanted,
  );
  return entry ? entry.data : null;
}

/* ------------------------------------------------------------------ *
 * Injection (writer)
 * ------------------------------------------------------------------ */

/**
 * Add `data` as an RT_RCDATA resource called `name`, preserving everything
 * else in the executable. Returns the new file contents.
 */
function injectResource(buffer, name, data) {
  let NtExecutable;
  let NtExecutableResource;
  try {
    // Node >= 20.19.5 can require the ESM entry point directly; older runtimes
    // need the explicit CommonJS build.
    ({ NtExecutable, NtExecutableResource } = require('resedit'));
  } catch {
    try {
      ({ NtExecutable, NtExecutableResource } = require('resedit/cjs'));
    } catch {
      throw new Error('The built-in injector needs the "resedit" package. Run `npm install`.');
    }
  }
  // Clean out the resource we are about to write so re-running is safe.
  const exe = NtExecutable.from(buffer, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  for (const entry of res.entries) {
    if (String(entry.type) === String(RT_RCDATA) && String(entry.id).toUpperCase() === name.toUpperCase()) {
      res.entries.splice(res.entries.indexOf(entry), 1);
    }
  }
  // resedit entries are plain objects: { type, id, lang, bin }.
  res.entries.push({ type: RT_RCDATA, id: name, lang: 0, bin: data });
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

module.exports = {
  RT_RCDATA,
  FUSE,
  isPe,
  parseHeaders,
  rvaToOffset,
  readDataDirectory,
  certificateTable,
  stripCertificateTable,
  flipFuse,
  readResourceTree,
  findResource,
  injectResource,
};
