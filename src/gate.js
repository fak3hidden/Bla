'use strict';

/** Small helpers shared by all REST routes. */

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function optInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function intOr(value, fallback) {
  const n = optInt(value);
  return n === null ? fallback : n;
}

function isValidUrl(value) {
  if (!value) return false;
  if (typeof value !== 'string') return false;
  if (value.startsWith('/api/attachments/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when the request wants JSON back (API defaults to JSON anyway). */
function wantsJson(req) {
  if (req.query && req.query.format === 'html') return false;
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html') && !accept.includes('application/json')) return false;
  return true;
}

function expectsHtml(req) {
  const accept = String(req.headers.accept || '');
  if (accept.includes('application/json')) return false;
  return req.method === 'GET' && accept.includes('text/html');
}

module.exports = { flag, optInt, intOr, isValidUrl, wantsJson, expectsHtml };
