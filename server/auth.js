import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_COOKIE = 'freestream_session';
const SESSION_MS = (parseInt(process.env.FREESTREAM_SESSION_DAYS, 10) || 7) * 24 * 60 * 60 * 1000;
const REMEMBER_MS = (parseInt(process.env.FREESTREAM_REMEMBER_DAYS, 10) || 90) * 24 * 60 * 60 * 1000;
const DATA_DIR = process.env.FREESTREAM_DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const sessions = new Map();
let saveTimer = null;

function readCredential(envKey, fileKey, defaultValue) {
    const filePath = process.env[fileKey];
    if (filePath) {
        try {
            const fromFile = fs.readFileSync(filePath, 'utf8').trim();
            if (fromFile) return fromFile;
        } catch (e) {
            console.warn(`[auth] Could not read ${fileKey}:`, e.message);
        }
    }
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv.trim();
    return defaultValue;
}

function loadUsers() {
    const usersFile = process.env.FREESTREAM_USERS_FILE;
    if (usersFile) {
        try {
            const parsed = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return normalizeUsers(parsed);
            }
            console.warn('[auth] FREESTREAM_USERS_FILE must be a JSON object { "user": "password" }');
        } catch (e) {
            console.warn('[auth] Could not read FREESTREAM_USERS_FILE:', e.message);
        }
    }

    const usersJson = process.env.FREESTREAM_USERS;
    if (usersJson) {
        try {
            const parsed = JSON.parse(usersJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return normalizeUsers(parsed);
            }
            console.warn('[auth] FREESTREAM_USERS must be JSON object { "user": "password" }');
        } catch (e) {
            console.warn('[auth] Could not parse FREESTREAM_USERS:', e.message);
        }
    }

    const user = readCredential('FREESTREAM_USER', 'FREESTREAM_USER_FILE', 'admin');
    const pass = readCredential('FREESTREAM_PASSWORD', 'FREESTREAM_PASSWORD_FILE', 'admin');
    return { [user]: pass };
}

function normalizeUsers(obj) {
    const users = {};
    for (const [name, pass] of Object.entries(obj)) {
        const key = String(name).trim();
        if (key && pass != null && String(pass) !== '') {
            users[key] = String(pass);
        }
    }
    return users;
}

const USERS = loadUsers();
const USER_NAMES = Object.keys(USERS);

if (!USER_NAMES.length) {
    console.error('[auth] No users configured — set FREESTREAM_USERS, FREESTREAM_USERS_FILE, or FREESTREAM_USER/PASSWORD');
    USERS.admin = 'admin';
    USER_NAMES.push('admin');
}

console.log(`[auth] ${USER_NAMES.length} user(s): ${USER_NAMES.join(', ')}`);
console.log(`[auth] Sessions stored in ${SESSIONS_FILE}`);

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSessionsFromDisk() {
    ensureDataDir();
    if (!fs.existsSync(SESSIONS_FILE)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        const now = Date.now();
        let loaded = 0;
        for (const [token, session] of Object.entries(raw)) {
            if (!session?.user || !session?.expires) continue;
            if (session.expires <= now) continue;
            sessions.set(token, {
                user: session.user,
                expires: session.expires,
                remember: Boolean(session.remember),
                created: session.created || now,
            });
            loaded++;
        }
        console.log(`[auth] Restored ${loaded} active session(s)`);
        if (loaded < Object.keys(raw).length) scheduleSave();
    } catch (e) {
        console.warn('[auth] Could not load sessions file:', e.message);
    }
}

function saveSessionsToDisk() {
    ensureDataDir();
    const now = Date.now();
    const out = {};
    for (const [token, session] of sessions.entries()) {
        if (session.expires <= now) continue;
        out[token] = {
            user: session.user,
            expires: session.expires,
            remember: session.remember,
            created: session.created,
        };
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out, null, 2));
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSessionsToDisk, 400);
}

loadSessionsFromDisk();

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

function findUser(username, password) {
    const user = String(username ?? '').trim();
    const pass = String(password ?? '');
    if (!user || !USERS[user]) return null;
    if (!safeEqual(pass, USERS[user])) return null;
    return user;
}

export function validateCredentials(username, password) {
    return findUser(username, password) !== null;
}

export function createSession(username, remember = false) {
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = remember ? REMEMBER_MS : SESSION_MS;
    const now = Date.now();
    sessions.set(token, {
        user: username,
        expires: now + ttl,
        remember,
        created: now,
    });
    scheduleSave();
    return { token, maxAgeSec: Math.floor(ttl / 1000) };
}

export function getSession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expires) {
        sessions.delete(token);
        scheduleSave();
        return null;
    }
    return session;
}

export function validateSession(token) {
    return getSession(token) !== null;
}

export function destroySession(token) {
    if (token && sessions.delete(token)) scheduleSave();
}

function setSessionCookie(res, token, maxAgeSec) {
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
}

// --- Media tokens ---
// iOS/Safari's native video player fetches HLS playlists, segments, and MP4s
// via a separate media process that does NOT send the page's cookies. Media
// routes therefore accept a short-lived token in the URL instead.
const MEDIA_TOKEN_MS = 12 * 60 * 60 * 1000;
const mediaTokens = new Map();

export function createMediaToken() {
    const now = Date.now();
    if (mediaTokens.size > 500) {
        for (const [t, exp] of mediaTokens) {
            if (exp <= now) mediaTokens.delete(t);
        }
    }
    const token = crypto.randomBytes(24).toString('hex');
    mediaTokens.set(token, now + MEDIA_TOKEN_MS);
    return token;
}

export function validateMediaToken(token) {
    if (!token) return false;
    const expires = mediaTokens.get(token);
    if (!expires) return false;
    if (Date.now() > expires) {
        mediaTokens.delete(token);
        return false;
    }
    return true;
}

function isMediaPath(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    return req.path.startsWith('/hls/')
        || req.path.startsWith('/stream-cache/')
        || req.path.startsWith('/tv-media/')
        || req.path.startsWith('/media/')
        || req.path === '/stream-mp4'
        || req.path === '/stream-remux'
        || req.path === '/download';
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
    if (isMediaPath(req) && validateMediaToken(req.query.token)) return next();
    if (isStaticAsset(req)) return next();

    if (req.path.startsWith('/api/') || req.accepts('json')) {
        return res.status(401).json({ error: 'Unauthorized', authenticated: false });
    }
    return res.status(401).send('Unauthorized');
}

export function handleLogin(req, res) {
    const { username, password, remember } = req.body || {};
    const user = findUser(username, password);
    if (!user) {
        return res.status(401).json({ error: 'Invalid username or password', authenticated: false });
    }
    const { token, maxAgeSec } = createSession(user, Boolean(remember));
    setSessionCookie(res, token, maxAgeSec);
    res.json({ ok: true, authenticated: true, user, remember: Boolean(remember) });
}

export function handleLogout(req, res) {
    destroySession(getSessionToken(req));
    clearSessionCookie(res);
    res.json({ ok: true, authenticated: false });
}

export function handleAuthStatus(req, res) {
    const session = getSession(getSessionToken(req));
    res.json({
        authenticated: Boolean(session),
        user: session?.user ?? null,
        remember: session?.remember ?? false,
    });
}
