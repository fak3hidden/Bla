#!/usr/bin/env node
'use strict';
/**
 * Wipe this Bla instance back to a blank slate.
 *
 *   npm run reset-db              # asks for confirmation
 *   npm run reset-db -- --yes     # no questions
 *   npm run reset-db -- --yes --keep-uploads   # keep old files on disk
 *
 * Removes the SQLite database (accounts, servers, messages, ...) and — unless
 * --keep-uploads is passed — everything in data/uploads and data/media.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('../src/config');

const args = process.argv.slice(2);
const assumeYes = args.includes('--yes') || args.includes('-y');
const keepUploads = args.includes('--keep-uploads');

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

async function confirm(question) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    console.error('Refusing to wipe data without a terminal. Re-run with --yes if you are sure.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const dbFile = config.dbFile;
  const uploads = config.uploadDir;
  const media = config.mediaDir;

  const dbExists = fs.existsSync(dbFile);
  const dbBytes = dbExists ? fs.statSync(dbFile).size : 0;
  const uploadStats = dirSize(uploads);
  const mediaStats = dirSize(media);

  console.log('\nThis will permanently delete:');
  console.log(`  database   ${dbFile}${dbExists ? ` (${human(dbBytes)})` : ' (not created yet)'}`);
  if (!keepUploads) {
    console.log(`  uploads    ${uploads} (${uploadStats.files} files, ${human(uploadStats.bytes)})`);
    console.log(`  media      ${media} (${mediaStats.files} files, ${human(mediaStats.bytes)})`);
  } else {
    console.log('  uploads    kept (--keep-uploads)');
  }
  console.log('\nAccounts, servers, channels and messages will be gone for good.');

  const sure = await confirm(`\nWipe ${dbFile}?`);
  if (!sure) {
    console.log('Nothing was deleted.');
    return;
  }

  for (const file of [dbFile, `${dbFile}-journal`, `${dbFile}-wal`, `${dbFile}-shm`]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      console.log(`removed ${file}`);
    }
  }

  if (!keepUploads) {
    for (const dir of [uploads, media]) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`removed ${dir}`);
      }
    }
  }

  console.log('\nDone. Start the server again and the first account you create becomes the instance admin.\n');
}

main().catch((err) => {
  console.error(`Reset failed: ${err.message}`);
  process.exit(1);
});
