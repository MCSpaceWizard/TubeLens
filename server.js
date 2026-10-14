'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const secureCookies = process.env.COOKIE_SECURE === 'true' || isProduction;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const SCOPE = ['https://www.googleapis.com/auth/youtube.readonly'];

if (isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0 }));

const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

// A deliberately ephemeral store for this starter app. OAuth tokens never enter browser JS.
// For a multi-process/production deployment, replace this Map with a proper session store.
const sessions = new Map();
const subscriptionCache = new Map();
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const COOKIE_NAME = 'tubelens_sid';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    let value = part.slice(index + 1);
    try { value = decodeURIComponent(value); } catch { /* Ignore malformed values supplied by a client. */ }
    return [part.slice(0, index), value];
  }));
}
function cookieOptions(maxAge) {
  return { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', maxAge };
}
function oauthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function createOAuthClient() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}
function sessionFor(req) {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const entry = sid ? sessions.get(sid) : null;
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SESSION_MAX_AGE) {
    sessions.delete(sid);
    subscriptionCache.delete(sid);
    return null;
  }
  return { sid, ...entry };
}
function authError(res, message = 'Please connect your YouTube account again.') {
  return res.status(401).json({ error: message, code: 'AUTH_REQUIRED' });
}

app.get('/auth/google', oauthLimiter, (req, res) => {
  if (!oauthConfigured()) return res.redirect('/?error=missing_oauth_config');
  const oauth = createOAuthClient();
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('tubelens_oauth_state', state, cookieOptions(10 * 60 * 1000));
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    include_granted_scopes: true,
    scope: SCOPE,
    state,
    prompt: 'consent select_account'
  });
  return res.redirect(url);
});

app.get('/auth/google/callback', oauthLimiter, async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  res.clearCookie('tubelens_oauth_state', { path: '/', sameSite: 'lax', secure: secureCookies });
  if (!state || !cookies.tubelens_oauth_state || state !== cookies.tubelens_oauth_state) {
    return res.redirect('/?error=oauth_state');
  }
  if (req.query.error) return res.redirect('/?error=oauth_denied');
  if (typeof req.query.code !== 'string') return res.redirect('/?error=oauth_callback');

  try {
    const oauth = createOAuthClient();
    const { tokens } = await oauth.getToken(req.query.code);
    oauth.setCredentials(tokens);
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { oauth, createdAt: Date.now() });
    res.cookie(COOKIE_NAME, sid, cookieOptions(SESSION_MAX_AGE));
    return res.redirect('/?connected=1');
  } catch (error) {
    console.error('OAuth callback failed:', error?.message || error);
    return res.redirect('/?error=oauth_exchange');
  }
});

app.get('/api/status', apiLimiter, (req, res) => {
  const session = sessionFor(req);
  res.set('Cache-Control', 'no-store');
  res.json({ connected: Boolean(session), configured: oauthConfigured() });
});

app.get('/api/subscriptions', apiLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = sessionFor(req);
  if (!session) return authError(res);
  const cached = subscriptionCache.get(session.sid);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return res.json(cached.data);

  try {
    const youtube = google.youtube({ version: 'v3', auth: session.oauth });
    const items = [];
    let pageToken;
    let pages = 0;
    do {
      const response = await youtube.subscriptions.list({
        part: ['snippet', 'contentDetails'],
        mine: true,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {})
      });
      for (const item of response.data.items || []) {
        const snippet = item.snippet || {};
        const channelId = snippet.resourceId?.channelId || '';
        items.push({
          channelId,
          title: snippet.title || 'Unknown channel',
          description: snippet.description || '',
          thumbnails: snippet.thumbnails || {},
          channelUrl: channelId ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}` : '',
          subscribedAt: snippet.publishedAt || null,
          newItemCount: Number(item.contentDetails?.newItemCount || 0),
          totalItemCount: Number(item.contentDetails?.totalItemCount || 0)
        });
      }
      pageToken = response.data.nextPageToken;
      pages += 1;
    } while (pageToken && pages < 200); // Cap at 10,000 subscriptions per request.

    const data = { subscriptions: items, total: items.length, truncated: Boolean(pageToken), fetchedAt: new Date().toISOString() };
    subscriptionCache.set(session.sid, { at: Date.now(), data });
    return res.json(data);
  } catch (error) {
    const status = Number(error?.code || error?.response?.status || 0);
    console.error('Subscription retrieval failed:', status, error?.message || error);
    if (status === 401 || status === 403) {
      if (status === 401) {
        sessions.delete(session.sid);
        subscriptionCache.delete(session.sid);
        res.clearCookie(COOKIE_NAME, { path: '/', sameSite: 'lax', secure: secureCookies });
        return authError(res, 'Google no longer accepts this session. Please reconnect your account.');
      }
      return res.status(403).json({ error: 'Google denied access to subscriptions. Check that YouTube Data API v3 is enabled and the account granted read-only YouTube access.' });
    }
    return res.status(502).json({ error: 'Could not load subscriptions from YouTube. Please try again in a moment.' });
  }
});

app.post('/auth/logout', apiLimiter, async (req, res) => {
  const session = sessionFor(req);
  if (session) {
    // Best-effort revocation; local session is cleared even if Google is unreachable.
    try { await session.oauth.revokeCredentials(); } catch (error) { console.warn('OAuth token revocation did not complete:', error?.message || error); }
    sessions.delete(session.sid);
    subscriptionCache.delete(session.sid);
  }
  res.clearCookie(COOKIE_NAME, { path: '/', sameSite: 'lax', secure: secureCookies });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(404).json({ error: 'Not found' });
  return res.sendFile(path.join(__dirname, 'public', 'index.html'), err => err && next(err));
});

// Expire abandoned OAuth sessions and cached subscription payloads.
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [sid, value] of sessions) {
    if (now - value.createdAt > SESSION_MAX_AGE) {
      sessions.delete(sid);
      subscriptionCache.delete(sid);
    }
  }
  for (const [sid, value] of subscriptionCache) {
    if (now - value.at > 30 * 60 * 1000) subscriptionCache.delete(sid);
  }
}, 10 * 60 * 1000);
cleanup.unref();

app.listen(PORT, () => {
  console.log(`TubeLens running at http://localhost:${PORT}`);
  if (!oauthConfigured()) console.log('Google OAuth is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env to enable subscription sync.');
});
