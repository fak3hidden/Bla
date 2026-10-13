'use strict';

/** Dead-simple sliding-window limiter. Self-hosted: no Redis required. */
const buckets = new Map();

function rateLimit({ key = 'default', max = 30, windowMs = 60000, message = 'You are doing that too fast. Slow down a little.' } = {}) {
  return function limiter(req, res, next) {
    const now = Date.now();
    const id = `${key}:${req.user ? req.user.id : req.ip}`;
    let bucket = buckets.get(id);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({ error: message, code: 'RATE_LIMITED', retry_after: Math.max(retryAfter, 1) });
    }
    return next();
  };
}

/** Token-bucket for chat messages so bursts feel instant but floods get cut off. */
function messageLimiter() {
  const state = new Map();
  const config = require('./config');
  const { count, windowMs, burst } = config.messageRateLimit;
  return function limiter(req, res, next) {
    const id = String(req.user ? req.user.id : req.ip);
    const now = Date.now();
    let entry = state.get(id);
    if (!entry) {
      entry = { tokens: count + burst, last: now };
      state.set(id, entry);
    }
    const refill = ((now - entry.last) / windowMs) * count;
    entry.tokens = Math.min(count + burst, entry.tokens + refill);
    entry.last = now;
    if (entry.tokens < 1) {
      return res.status(429).json({
        error: 'You are sending messages too quickly. Take a breath and try again.',
        code: 'MESSAGE_RATE_LIMITED',
        retry_after: Math.ceil(windowMs / count / 1000),
      });
    }
    entry.tokens -= 1;
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of buckets) {
    if (now - bucket.start > 3600000) buckets.delete(id);
  }
}, 600000).unref();

module.exports = { rateLimit, messageLimiter };
