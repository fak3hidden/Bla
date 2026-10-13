'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const perms = require('../perms');

const router = express.Router();
router.use(auth.attachUser);

/** Can this viewer see the message this attachment belongs to? */
function canView(userId, isAdmin, attachment) {
  if (!attachment.message_id) return String(attachment.uploader_id) === String(userId) || isAdmin;
  const message = db.get('SELECT * FROM messages WHERE id = ?', [attachment.message_id]);
  if (!message) return false;
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [message.channel_id]);
  if (!channel) return false;
  if (!channel.guild_id) {
    return !!db.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', [channel.id, userId]);
  }
  const member = perms.getMember(channel.guild_id, userId);
  if (!member && !isAdmin) return false;
  const guildPerms = perms.guildPermissions(channel.guild_id, userId, { isAdmin, isOwner: false });
  return perms.canViewChannel(channel, userId, member, guildPerms);
}

router.get('/:attachmentId/:filename?', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to view files.', code: 'UNAUTHORIZED' });
  const attachment = db.get('SELECT * FROM attachments WHERE id = ?', [Number(req.params.attachmentId)]);
  if (!attachment || !attachment.stored_name) {
    return res.status(404).json({ error: 'File not found.', code: 'NOT_FOUND' });
  }
  if (!canView(req.user.id, req.user.is_admin, attachment)) {
    return res.status(403).json({ error: 'You do not have access to that file.', code: 'NO_FILE_ACCESS' });
  }
  const filePath = path.join(config.uploadDir, path.basename(attachment.stored_name));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'The file is gone from disk.', code: 'FILE_MISSING' });
  }

  const stat = fs.statSync(filePath);
  const mime = attachment.content_type || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Accept-Ranges', 'bytes');
  const inline = /^(image|audio|video)\//.test(mime) || mime === 'application/pdf';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(attachment.filename).replace(/["\\]/g, '')}"`);

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (Number.isFinite(start) && start <= end) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
  }
  res.setHeader('Content-Length', String(stat.size));
  return fs.createReadStream(filePath).pipe(res);
});

/** Delete an attachment you uploaded (used to clean up cancelled uploads). */
router.delete('/:attachmentId', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.', code: 'UNAUTHORIZED' });
  const attachment = db.get('SELECT * FROM attachments WHERE id = ?', [Number(req.params.attachmentId)]);
  if (!attachment) return res.status(404).json({ error: 'File not found.', code: 'NOT_FOUND' });
  if (String(attachment.uploader_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'That file is not yours.', code: 'NOT_YOUR_FILE' });
  }
  db.run('DELETE FROM attachments WHERE id = ?', [attachment.id]);
  try { fs.unlinkSync(path.join(config.uploadDir, path.basename(attachment.stored_name))); } catch { /* already gone */ }
  res.json({ ok: true });
});

module.exports = router;
