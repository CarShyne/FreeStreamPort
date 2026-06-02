import crypto from 'crypto';

const AUTH_USER = process.env.FREESTREAM_USER || 'admin';
const AUTH_PASSWORD = process.env.FREESTREAM_PASSWORD || 'admin';
const SESSION_COOKIE = 'freestream_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map();

function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const [rawKey, ...rest] = part.trim().split('=');
        if (!rawKey) continue;
        cookies[rawKey] = decodeURIComponent(rest.join('='));
    }
    return cookies;
}

export function getSessionToken(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

export function validateCredentials(username, password) {
    return username === AUTH_USER && password === AUTH_PASSWORD;
}

export function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: AUTH_USER, expires: Date.now() + SESSION_MS });
    return token;
}

export function validateSession(token) {
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expires) {
        sessions.delete(token);
        return false;
    }
    return true;
}

export function destroySession(token) {
    if (token) sessions.delete(token);
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(SESSION_MS / 1000);
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
}

function isPublicPath(req) {
    if (req.path === '/api/auth/login' && req.method === 'POST') return true;
    if (req.path === '/api/auth/status' && req.method === 'GET') return true;
    return false;
}

function isStaticAsset(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (req.path === '/' || req.path === '/index.html') return true;
    if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) return true;
    if (req.path.startsWith('/vendor/')) return true;
    return false;
}

export function authMiddleware(req, res, next) {
    if (isPublicPath(req)) return next();
    if (validateSession(getSessionToken(req))) return next();
    if (isStaticAsset(req)) return next();

    if (req.path.startsWith('/api/') || req.accepts('json')) {
        return res.status(401).json({ error: 'Unauthorized', authenticated: false });
    }
    return res.status(401).send('Unauthorized');
}

export function handleLogin(req, res) {
    const { username, password } = req.body || {};
    if (!validateCredentials(username, password)) {
        return res.status(401).json({ error: 'Invalid username or password', authenticated: false });
    }
    const token = createSession();
    setSessionCookie(res, token);
    res.json({ ok: true, authenticated: true, user: AUTH_USER });
}

export function handleLogout(req, res) {
    destroySession(getSessionToken(req));
    clearSessionCookie(res);
    res.json({ ok: true, authenticated: false });
}

export function handleAuthStatus(req, res) {
    const authenticated = validateSession(getSessionToken(req));
    res.json({ authenticated, user: authenticated ? AUTH_USER : null });
}
