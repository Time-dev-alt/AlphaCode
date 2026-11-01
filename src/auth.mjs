/**
 * Authentication: guests get instant anonymous sessions; registered users get
 * password auth with signed, HttpOnly session cookies + CSRF double-submit.
 */
import { config } from './config.mjs';
import { getStore } from './lib/store.mjs';
import { hashPassword, verifyPassword, randomToken, sign, unsign, timingSafeEqual } from './lib/crypto.mjs';
import { bad, unauthorized, forbidden, clientIp, serializeCookie } from './lib/http.mjs';
import { log } from './lib/log.mjs';

export const SESSION_COOKIE = 'ac_sid';
export const CSRF_COOKIE = 'ac_csrf';

/** Resolve (or lazily create) the caller's session. */
export function resolveSession(req, res) {
  const store = getStore();
  const cookies = req.cookies || {};
  let session = store.getSession(cookies[SESSION_COOKIE]);
  let created = false;
  if (!session) {
    const createdSess = store.createSession({
      guest: true,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || ''),
    });
    session = store.getSession(createdSess.id);
    created = true;
    res.setHeader(
      'Set-Cookie',
      [serializeCookie(SESSION_COOKIE, createdSess.id, { maxAge: config.security.sessionDays * 86400 })],
    );
  }
  const user = session?.user_id ? store.getUser(session.user_id) : null;
  if (user && user.disabled) {
    store.destroySession(session.id);
    return { session: null, user: null, created };
  }
  return { session, user, created };
}

export function ensureCsrf(req, res) {
  const cookies = req.cookies || {};
  let token = cookies[CSRF_COOKIE];
  if (!token || token.length < 16) {
    token = randomToken(24);
    const existing = res.getHeader('Set-Cookie');
    const cookie = serializeCookie(CSRF_COOKIE, token, { httpOnly: false, maxAge: config.security.sessionDays * 86400 });
    res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : [cookie]);
  }
  return token;
}

export function verifyCsrf(req) {
  const header = req.headers['x-alphacode-csrf'];
  const cookie = (req.cookies || {})[CSRF_COOKIE];
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (!header || !cookie) return false;
  return timingSafeEqual(String(header), String(cookie));
}

export function signSessionValue(id) {
  return sign(id, 'session', config.security.sessionDays * 86400000);
}
export function verifySessionValue(v) {
  return unsign(v, 'session');
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function register(req, { email, password, name = '' }) {
  const store = getStore();
  if (!config.allowRegistration) throw forbidden('Registration is disabled on this instance');
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  if (password.length > 200) throw bad('Password too long');
  if (store.getUserByEmail(email)) throw bad('An account with that email already exists');
  const user = store.createUser({ email, passwordHash: hashPassword(password), name: String(name || '').slice(0, 60) });
  store.audit({ userId: user.id, action: 'register', ip: clientIp(req) });
  return user;
}

export function login(req, { email, password }) {
  const store = getStore();
  email = String(email || '').trim().toLowerCase();
  const user = store.getUserByEmail(email);
  // Always run a hash comparison to keep timing uniform.
  const stored = user?.password_hash || hashPassword('invalid-password-placeholder');
  const ok = verifyPassword(String(password || ''), stored);
  if (!user || !ok) {
    store.audit({ userId: user?.id || null, action: 'login_failed', detail: email, ip: clientIp(req) });
    throw unauthorized('Incorrect email or password', 'invalid_credentials');
  }
  if (user.disabled) throw forbidden('This account has been disabled');
  store.audit({ userId: user.id, action: 'login', ip: clientIp(req) });
  return user;
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized('Sign in to continue', 'auth_required');
  return ctx.user;
}

export function requirePaidUser(ctx) {
  const user = requireUser(ctx);
  return user;
}

export function attachUserToSession(req, res, userId) {
  const store = getStore();
  const sid = req.session?.id;
  if (!sid) return null;
  store.upgradeSession(sid, userId);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, sid, { maxAge: config.security.sessionDays * 86400 }));
  return store.getSession(sid);
}

export function logout(req, res) {
  const store = getStore();
  if (req.session?.id) store.destroySession(req.session.id);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
  log.debug('session destroyed');
}

/** Owner key for anonymous (guest) resources: the session id. */
export function ownerKey(ctx) {
  return ctx.user ? `user:${ctx.user.id}` : `guest:${ctx.session?.id || 'anon'}`;
}
