'use strict';
const path = require('path');
const express = require('express');
require('express-async-errors'); // Express 4 doesn't forward rejected promises to error middleware on its own -- this patches that in (Express 5 does it natively, but upgrading Express itself is a separate change from this migration)
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { db, loadUser, logAudit, ready } = require('./src/db');
const api = require('./src/api');

// P1 -- a real deployment must not run on the well-known fallback secret.
// Local trial/dev use is unaffected: this only fires when NODE_ENV=production.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('\n  Refusing to start: SESSION_SECRET is not set.');
  console.error('  Set it to a long random string before running in production, e.g.:');
  console.error('    SESSION_SECRET=$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")\n');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // most hosts (Render/Railway/etc.) terminate TLS via a proxy

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'sx',
  keys: [process.env.SESSION_SECRET || 'change-this-secret-in-production'],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  sameSite: 'lax',
  secure: process.env.SECURE_COOKIES === '1', // set to 1 in production (HTTPS); leave unset for localhost
  httpOnly: true,
}));

// attach the logged-in user (if any) to every request
app.use(async (req, res, next) => {
  try {
    req.user = req.session && req.session.uid ? await loadUser(req.session.uid) : null;
    next();
  } catch (e) { next(e); }
});

// P2 -- throttle login attempts. Keyed by IP+username (not IP alone) so one
// person guessing a password can't lock out everyone else on the same
// office/site network trying to sign in to their own accounts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String((req.body && req.body.username) || '').toLowerCase()}`,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

// ---- auth endpoints (public) ----
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const u = await db.prepare('SELECT * FROM users WHERE lower(username)=lower(?)').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  if (!u.active) return res.status(403).json({ error: 'Account disabled' });
  req.session.uid = u.id;
  await logAudit(u, 'Logged in', 'session', u.id, '');
  res.json({ id: u.id, name: u.name, role: u.role });
});
app.post('/api/logout', async (req, res) => {
  if (req.user) await logAudit(req.user, 'Logged out', 'session', req.user.id, '');
  req.session = null;
  res.json({ ok: true });
});

// ---- protected API ----
app.use('/api', api);

// ---- static front-end ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// error handler -- must be last. Anything thrown/rejected in an async route
// (express-async-errors forwards these automatically) lands here instead of
// Express's default HTML error page, which would break the frontend's JSON parsing.
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

ready()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  SiteXpense running ->  http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error('\n  Failed to start: could not initialize the database.');
    console.error(' ', err.message, '\n');
    process.exit(1);
  });
