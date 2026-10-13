'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const gate = require('./gate');
const sea = require('./sea');

const { flag } = gate;

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // Security headers for self-hosting. No external origins are ever needed:
  // fonts, icons and scripts are all served from this same process.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: data:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws: wss: https:",
      "font-src 'self' data:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  // Cookies are parsed for every request so uploads (which carry a raw body)
  // and normal API calls behave the same way.
  app.use(auth.attachUser);

  // Upload endpoints read a raw binary body themselves; they are mounted
  // before the JSON parser so big file bodies are never JSON-decoded.
  app.use('/api/uploads', require('./routes/uploads'));

  app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));

  // API responses are never cached by browsers or proxies.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/guilds', require('./routes/guilds'));
  app.use('/api/channels', require('./routes/channels'));
  app.use('/api/messages', require('./routes/messages'));
  app.use('/api/dms', require('./routes/dms'));
  app.use('/api/invites', require('./routes/invites'));
  app.use('/api/relationships', require('./routes/relationships'));
  app.use('/api/voice', require('./routes/voice'));
  app.use('/api/discovery', require('./routes/discovery'));
  app.use('/api/webhooks', require('./routes/webhooks'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/attachments', require('./routes/attachments'));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), version: config.version || '1.0.0' });
  });

  app.get('/invite/:code', (req, res) => {
    res.redirect(`/#/invite/${encodeURIComponent(req.params.code)}`);
  });

  // In a packaged binary the front-end ships as embedded SEA assets that get
  // unpacked next to the binary; in a source checkout this is just ./public.
  const webRoot = sea.assetRoot();
  app.use(express.static(webRoot, {
    index: 'index.html',
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // Client-side routing: anything that isn't an API call or a static file falls
  // back to the app shell — but a request that clearly expects a file (it has an
  // extension) gets an honest 404 instead of HTML pretending to be that file.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (path.extname(req.path)) return next();
    return res.sendFile(path.join(webRoot, 'index.html'));
  });

  // 404 for unknown API routes.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown endpoint ${req.method} ${req.originalUrl}`, code: 'UNKNOWN_ENDPOINT' });
  });

  // Central error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      console.error('[bla]', req.method, req.originalUrl, err);
    }
    if (res.headersSent) return;
    const payload = {
      error: status >= 500 ? 'Something went wrong on the server.' : err.message,
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
    };
    if (err.details) payload.details = err.details;
    res.status(status).json(payload);
  });

  return app;
}

/**
 * Uploads authenticate with a session token (cookie or bearer) and read the
 * file bytes from the raw request stream.
 */
module.exports = { createApp, flag };
