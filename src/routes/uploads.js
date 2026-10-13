'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const serialize = require('../serialize');
const settings = require('../settings');
const { randomId, now } = require('../util');
const { rateLimit } = require('../ratelimit');

const router = express.Router();

const KIND_LIMITS = () => ({
  attachment: settings.get('max_upload_mb') * 1024 * 1024,
  avatar: config.maxAvatarBytes,
  banner: config.maxAvatarBytes,
  guild_icon: config.maxAvatarBytes,
  guild_banner: config.maxAvatarBytes,
  guild_splash: config.maxAvatarBytes,
  user_banner: config.maxAvatarBytes,
  emoji: 512 * 1024,
  sticker: 1024 * 1024,
  sound: 1024 * 1024,
});

/** File signatures — we trust magic bytes, never the browser's claim. */
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', kind: 'image', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', kind: 'image', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', kind: 'image', test: (b) => b.length > 5 && b.slice(0, 4).toString('ascii') === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', kind: 'image', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', kind: 'image', test: (b) => b.length > 12 && b.slice(4, 12).toString('ascii').includes('ftypavif') },
  { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', test: (b) => b.length > 3 && (b.slice(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { mime: 'audio/ogg', ext: 'ogg', kind: 'audio', test: (b) => b.length > 4 && b.slice(0, 4).toString('ascii') === 'OggS' },
  { mime: 'audio/wav', ext: 'wav', kind: 'audio', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WAVE' },
  { mime: 'audio/flac', ext: 'flac', kind: 'audio', test: (b) => b.length > 4 && b.slice(0, 4).toString('ascii') === 'fLaC' },
  { mime: 'audio/mp4', ext: 'm4a', kind: 'audio', test: (b) => b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && /M4A|isom|mp42|dash/.test(b.slice(8, 12).toString('ascii')) },
  { mime: 'video/webm', ext: 'webm', kind: 'video', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: 'video/mp4', ext: 'mp4', kind: 'video', test: (b) => b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { mime: 'application/pdf', ext: 'pdf', kind: 'file', test: (b) => b.length > 5 && b.slice(0, 5).toString('ascii') === '%PDF-' },
  { mime: 'application/zip', ext: 'zip', kind: 'file', test: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { mime: 'text/plain', ext: 'txt', kind: 'file', test: (b) => isProbablyText(b) },
];

function isProbablyText(buffer) {
  const sample = buffer.slice(0, 512);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function detect(buffer) {
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return sig;
  }
  return null;
}

const ALLOWED_KINDS = {
  attachment: ['image', 'video', 'audio', 'file'],
  avatar: ['image'],
  user_banner: ['image'],
  banner: ['image'],
  guild_icon: ['image'],
  guild_banner: ['image'],
  guild_splash: ['image'],
  emoji: ['image'],
  sticker: ['image'],
  sound: ['audio'],
};

/**
 * Raw-body reader with a limit that can change at runtime (the admin can raise
 * the upload cap without a restart). Streaming rather than buffering twice.
 */
function readRawBody(req, res, next) {
  const limit = settings.get('max_upload_mb') * 1024 * 1024 + 1024;
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > limit) {
      aborted = true;
      res.status(413).json({
        error: `Uploads are limited to ${settings.get('max_upload_mb')} MB on this instance.`,
        code: 'FILE_TOO_LARGE',
        max_bytes: limit,
      });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    req.body = Buffer.concat(chunks);
    next();
  });
  req.on('error', (err) => {
    if (aborted) return;
    aborted = true;
    next(err);
  });
}

router.post('/', auth.requireUser, rateLimit({ key: 'upload', max: 120, windowMs: 60000 }), readRawBody, (req, res) => {
  const kind = String(req.query.kind || 'attachment');
  if (!ALLOWED_KINDS[kind]) {
    return res.status(400).json({ error: `Unknown upload kind "${kind}".`, code: 'UNKNOWN_KIND' });
  }
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) {
    return res.status(400).json({ error: 'The upload was empty.', code: 'EMPTY_UPLOAD' });
  }
  const limit = KIND_LIMITS()[kind] || settings.get('max_upload_mb') * 1024 * 1024;
  if (buffer.length > limit) {
    return res.status(413).json({
      error: `Files for "${kind}" can be at most ${(limit / 1048576).toFixed(1)} MB.`,
      code: 'FILE_TOO_LARGE',
      max_bytes: limit,
    });
  }

  const sig = detect(buffer);
  if (!sig) {
    return res.status(415).json({ error: 'Unsupported file type. Images, audio, video, PDF, zip and text files are allowed.', code: 'UNSUPPORTED_TYPE' });
  }
  if (!ALLOWED_KINDS[kind].includes(sig.kind)) {
    return res.status(415).json({ error: `"${kind}" uploads must be ${ALLOWED_KINDS[kind].join(' or ')} files.`, code: 'WRONG_FILE_KIND' });
  }

  const requestedName = String(req.query.filename || req.headers['x-filename'] || `upload.${sig.ext}`);
  const displayName = path.basename(requestedName).slice(0, 200).replace(/[\u0000-\u001f]/g, '') || `upload.${sig.ext}`;
  const stored = `${Date.now().toString(36)}-${randomId(10)}.${sig.ext}`;
  const target = path.join(config.uploadDir, stored);
  fs.writeFileSync(target, buffer, { mode: 0o644 });

  const timestamp = now();

  if (kind === 'attachment') {
    const isVoiceMessage = String(req.query.voice_message || '') === '1';
    const id = db.insert('attachments', {
      message_id: null,
      uploader_id: req.user.id,
      filename: displayName,
      stored_name: stored,
      content_type: sig.mime,
      size: buffer.length,
      width: req.query.width ? Number(req.query.width) : null,
      height: req.query.height ? Number(req.query.height) : null,
      voice_message: isVoiceMessage ? 1 : 0,
      duration: req.query.duration ? Number(req.query.duration) : null,
      waveform: req.query.waveform ? String(req.query.waveform).slice(0, 4000) : null,
      created_at: timestamp,
      orphaned: 0,
    });
    const row = db.get('SELECT * FROM attachments WHERE id = ?', [id]);
    return res.status(201).json({ attachment: serialize.serializeAttachment(row), id: String(id) });
  }

  if (kind === 'emoji') {
    const animated = sig.mime === 'image/gif';
    return res.status(201).json({
      url: `/api/uploads/files/${stored}`,
      filename: displayName,
      content_type: sig.mime,
      size: buffer.length,
      animated,
      suggestion: displayName.replace(/\.[a-z0-9]+$/i, '').replace(/\W/g, '_').slice(0, 32) || 'emoji',
    });
  }

  res.status(201).json({
    url: `/api/uploads/files/${stored}`,
    filename: displayName,
    content_type: sig.mime,
    size: buffer.length,
    width: req.query.width ? Number(req.query.width) : undefined,
    height: req.query.height ? Number(req.query.height) : undefined,
  });
});

/** Serve any uploaded file (avatars, emoji, banners) by its stored name. */
router.get('/files/:name', (req, res) => {
  const name = path.basename(String(req.params.name));
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).json({ error: 'Bad filename.', code: 'BAD_FILENAME' });
  const filePath = path.join(config.uploadDir, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.', code: 'NOT_FOUND' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(filePath);
});

module.exports = router;
module.exports.detect = detect;
module.exports.SIGNATURES = SIGNATURES;
