'use strict';
const express = require('express');
const db = require('../db');
const messages = require('../messages');
const { rateLimit } = require('../ratelimit');
const { safeEqual } = require('../util');

const router = express.Router();

const webhookBody = [
  express.json({ limit: '256kb' }),
  express.urlencoded({ extended: false, limit: '256kb' }),
  express.text({ type: ['text/*'], limit: '256kb' }),
];

function loadWebhook(id, token) {
  const hook = db.get('SELECT * FROM webhooks WHERE id = ?', [Number(id)]);
  if (!hook) return null;
  if (!safeEqual(hook.token, token)) return null;
  return hook;
}

router.get('/:webhookId/:token', (req, res) => {
  const hook = loadWebhook(req.params.webhookId, req.params.token);
  if (!hook) return res.status(401).json({ error: 'Invalid webhook token.', code: 'INVALID_WEBHOOK' });
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [hook.channel_id]);
  res.json({
    id: String(hook.id),
    type: 1,
    name: hook.name,
    avatar: hook.avatar,
    channel_id: String(hook.channel_id),
    guild_id: hook.guild_id ? String(hook.guild_id) : null,
    channel_name: channel ? channel.name : null,
    token: hook.token,
  });
});

/**
 * Execute a webhook with a plain HTTP POST — no bot framework required:
 *   curl -H 'Content-Type: application/json' \
 *        -d '{"content":"deploy finished!"}' \
 *        http://localhost:3000/api/webhooks/1/<token>
 */
router.post('/:webhookId/:token', rateLimit({ key: 'webhook', max: 60, windowMs: 60000 }), ...webhookBody, (req, res) => {
  const hook = loadWebhook(req.params.webhookId, req.params.token);
  if (!hook) return res.status(401).json({ error: 'Invalid webhook token.', code: 'INVALID_WEBHOOK' });
  const channel = db.get('SELECT * FROM channels WHERE id = ?', [hook.channel_id]);
  if (!channel) return res.status(404).json({ error: 'The webhook channel is gone.', code: 'UNKNOWN_CHANNEL' });

  const body = typeof req.body === 'string' ? { content: req.body } : (req.body || {});
  const content = body.content ?? req.query.content ?? '';
  const displayName = body.username || req.query.username || hook.name;
  const avatar = body.avatar_url || req.query.avatar_url || hook.avatar;

  // Per-message overrides are stored on the message row's interaction field so
  // the serializer can render the webhook identity faithfully.
  let message;
  try {
    message = messages.createMessage({
      channelId: channel.id,
      webhookId: hook.id,
      content,
      attachmentIds: [],
      embeds: Array.isArray(body.embeds) ? body.embeds.slice(0, 10) : [],
      tts: !!body.tts,
      webhookName: displayName,
      webhookAvatar: avatar,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code || 'WEBHOOK_FAILED' });
  }
  if (body.wait) return res.status(200).json(message);
  res.status(204).end();
});

module.exports = router;
