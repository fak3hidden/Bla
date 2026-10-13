'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const serialize = require('../serialize');
const bus = require('../bus');
const { now } = require('../util');
const { rateLimit } = require('../ratelimit');

const router = express.Router();
router.use(auth.requireUser);

const FRIEND = 1;
const INCOMING = 2;
const OUTGOING = 3;
const BLOCKED = 4;

function listFor(userId) {
  const outgoing = db.all(
    `SELECT r.type AS type, r.target_id, u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
     FROM relationships r JOIN users u ON u.id = r.target_id WHERE r.user_id = ?`, [userId]);
  const incoming = db.all(
    `SELECT r.user_id, u.id, u.username, u.discriminator, u.display_name, u.avatar, u.banner, u.accent_color, u.is_bot
     FROM relationships r JOIN users u ON u.id = r.user_id WHERE r.target_id = ? AND r.type = ?`, [userId, OUTGOING]);

  const friends = [];
  const out = [];
  const blocked = [];
  for (const row of outgoing) {
    if (row.type === FRIEND) friends.push(serialize.userBrief(row));
    else if (row.type === OUTGOING) out.push(serialize.userBrief(row));
    else if (row.type === BLOCKED) blocked.push(serialize.userBrief(row));
  }
  return {
    friends,
    incoming_requests: incoming.map((r) => serialize.userBrief(r)),
    outgoing_requests: out,
    blocked,
  };
}

router.get('/', (req, res) => {
  res.json(listFor(req.user.id));
});

/** Send a friend request by id or username. */
router.post('/', rateLimit({ key: 'friend-req', max: 60, windowMs: 3600000 }), (req, res) => {
  const body = req.body || {};
  let target = null;
  if (body.user_id) target = db.get('SELECT * FROM users WHERE id = ?', [Number(body.user_id)]);
  else if (body.username) {
    const [name] = String(body.username).split('#');
    target = db.get('SELECT * FROM users WHERE username_lc = ?', [name.replace(/^@/, '').toLowerCase()]);
  }
  if (!target) return res.status(404).json({ error: 'No such user on this server.', code: 'UNKNOWN_USER' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself.', code: 'SELF_FRIEND' });
  if (target.disabled) return res.status(403).json({ error: 'That account is disabled.', code: 'ACCOUNT_DISABLED' });

  const mine = db.get('SELECT * FROM relationships WHERE user_id = ? AND target_id = ?', [req.user.id, target.id]);
  if (mine?.type === BLOCKED) return res.status(400).json({ error: 'Unblock them first.', code: 'BLOCKED' });
  if (mine?.type === FRIEND) return res.status(400).json({ error: 'You are already friends.', code: 'ALREADY_FRIENDS' });
  if (mine?.type === OUTGOING) return res.status(400).json({ error: 'You already sent them a request.', code: 'REQUEST_PENDING' });

  const theirs = db.get('SELECT * FROM relationships WHERE user_id = ? AND target_id = ?', [target.id, req.user.id]);
  if (theirs?.type === BLOCKED) {
    return res.status(403).json({ error: 'You cannot send a request to that person.', code: 'BLOCKED' });
  }
  if (theirs?.type === OUTGOING) {
    // They already asked us — accept instead of stacking requests.
    db.run('UPDATE relationships SET type = ? WHERE user_id = ? AND target_id = ?', [FRIEND, target.id, req.user.id]);
    db.run('UPDATE relationships SET type = ? WHERE user_id = ? AND target_id = ?', [FRIEND, req.user.id, target.id]);
    notify(req.user.id, target.id);
    return res.json({ status: 'friends', user: serialize.userBrief(target) });
  }

  db.run(
    `INSERT INTO relationships (user_id, target_id, type, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, target_id) DO UPDATE SET type = excluded.type`,
    [req.user.id, target.id, OUTGOING, now()]);
  bus.toUser(String(target.id), {
    type: 'RELATIONSHIP_ADD',
    data: { type: INCOMING, user: serialize.userBrief(req.user), pending: true },
  });
  bus.toUser(String(req.user.id), { type: 'RELATIONSHIP_ADD', data: { type: OUTGOING, user: serialize.userBrief(target) } });
  res.status(201).json({ status: 'pending', user: serialize.userBrief(target) });
});

/** Accept an incoming request. */
router.put('/:userId', (req, res) => {
  const targetId = Number(req.params.userId);
  const incoming = db.get('SELECT * FROM relationships WHERE user_id = ? AND target_id = ? AND type = ?', [targetId, req.user.id, OUTGOING]);
  if (!incoming) return res.status(404).json({ error: 'No pending request from that person.', code: 'NO_REQUEST' });
  db.tx(() => {
    db.run('UPDATE relationships SET type = ? WHERE user_id = ? AND target_id = ?', [FRIEND, targetId, req.user.id]);
    const mine = db.get('SELECT * FROM relationships WHERE user_id = ? AND target_id = ?', [req.user.id, targetId]);
    if (mine) db.run('UPDATE relationships SET type = ? WHERE user_id = ? AND target_id = ?', [FRIEND, req.user.id, targetId]);
    else db.run('INSERT INTO relationships (user_id, target_id, type, created_at) VALUES (?, ?, ?, ?)', [req.user.id, targetId, FRIEND, now()]);
  });
  notify(req.user.id, targetId);
  res.json({ status: 'friends' });
});

/** Remove a friend, cancel a request, or unblock. */
router.delete('/:userId', (req, res) => {
  const targetId = Number(req.params.userId);
  const kind = String(req.query.type || 'friend');
  if (kind === 'block') {
    db.run(
      `INSERT INTO relationships (user_id, target_id, type, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, target_id) DO UPDATE SET type = excluded.type`,
      [req.user.id, targetId, BLOCKED, now()]);
    db.run('DELETE FROM relationships WHERE user_id = ? AND target_id = ? AND type IN (?, ?)', [targetId, req.user.id, FRIEND, OUTGOING]);
    bus.toUser(String(req.user.id), { type: 'RELATIONSHIP_ADD', data: { type: BLOCKED, user: serialize.userBrief(db.get('SELECT * FROM users WHERE id = ?', [targetId])) } });
    return res.json({ status: 'blocked' });
  }
  if (kind === 'unblock') {
    db.run('DELETE FROM relationships WHERE user_id = ? AND target_id = ? AND type = ?', [req.user.id, targetId, BLOCKED]);
    return res.json({ status: 'none' });
  }
  // friend removal / cancel outgoing / decline incoming
  db.run('DELETE FROM relationships WHERE user_id = ? AND target_id = ?', [req.user.id, targetId]);
  db.run('DELETE FROM relationships WHERE user_id = ? AND target_id = ? AND type IN (?, ?)', [targetId, req.user.id, FRIEND, OUTGOING]);
  bus.toUser(String(req.user.id), { type: 'RELATIONSHIP_REMOVE', data: { user_id: String(targetId) } });
  bus.toUser(String(targetId), { type: 'RELATIONSHIP_REMOVE', data: { user_id: String(req.user.id) } });
  res.json({ status: 'none' });
});

function notify(a, b) {
  const userA = db.get('SELECT * FROM users WHERE id = ?', [a]);
  const userB = db.get('SELECT * FROM users WHERE id = ?', [b]);
  bus.toUser(String(a), { type: 'RELATIONSHIP_ADD', data: { type: FRIEND, user: serialize.userBrief(userB) } });
  bus.toUser(String(b), { type: 'RELATIONSHIP_ADD', data: { type: FRIEND, user: serialize.userBrief(userA) } });
  bus.presence(String(a), { type: 'PRESENCE_UPDATE', data: { user_id: String(a) } });
  bus.presence(String(b), { type: 'PRESENCE_UPDATE', data: { user_id: String(b) } });
}

module.exports = router;
