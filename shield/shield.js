// Security shield for the FROZEN previous release at api.beontimeofficial.com.
//
// Production runs the previous release (commit 5cc1fac + its 26 Sept server
// hotfix) for a company that was promised no change at all, so that code is
// never edited. It has holes the current code closed: a phone sent as
// {"$regex": ...} matched someone's account, verify-otp with no code signed in
// to any account with no code pending, and employee tokens could reach the
// user-management routes (including making someone a super admin).
//
// This process sits between nginx and that backend and refuses ONLY those
// attack shapes. Everything a genuine screen sends passes through untouched,
// byte for byte, so the people on that release see no difference.
//
// It has no dependencies and no database access. It reads JWT_SECRET only to
// trust the role claim inside a token (forging one needs that secret anyway).
//
//   SHIELD_PORT=5010 SHIELD_UPSTREAM=http://127.0.0.1:5000 JWT_SECRET=... node shield/shield.js
//
// Every refusal is logged as one line: time, ip, method, path, reason.

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.SHIELD_PORT || 5010);
const UPSTREAM = new URL(process.env.SHIELD_UPSTREAM || 'http://127.0.0.1:5000');
const SECRET = process.env.JWT_SECRET || '';
const MAX_BODY = 25 * 1024 * 1024; // nginx's client_max_body_size for this site
const WINDOW_MS = 15 * 60 * 1000;
const MAX_CODES_PER_PHONE = Number(process.env.SHIELD_MAX_CODES_PER_PHONE || 6);
const MAX_FAILS_PER_PHONE = Number(process.env.SHIELD_MAX_FAILS_PER_PHONE || 5);
const MAX_FAILS_PER_IP = Number(process.env.SHIELD_MAX_FAILS_PER_IP || 30);

// ── small helpers ────────────────────────────────────────────────────────────

function clientIp(req) {
    // nginx appends the caller's address last; earlier hops can be forged.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || '');
}

function log(req, reason) {
    const path = String(req.url || '').split('?')[0];
    console.log(`[shield] ${new Date().toISOString()} ${clientIp(req)} ${req.method} ${path} BLOCKED ${reason}`);
}

function refuse(res, status, message) {
    const body = JSON.stringify({ message });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

// Windowed counters (same shape as the backend's in-memory login limits).
const counters = new Map();
function count(key) {
    const c = counters.get(key);
    if (!c || Date.now() - c.start > WINDOW_MS) return 0;
    return c.n;
}
function bump(key) {
    const c = counters.get(key);
    if (!c || Date.now() - c.start > WINDOW_MS) counters.set(key, { n: 1, start: Date.now() });
    else c.n++;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, c] of counters) if (now - c.start > WINDOW_MS) counters.delete(k);
}, 60 * 1000).unref();

function b64urlJson(part) {
    return JSON.parse(Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

// HS256 only, which is what the backend signs with. Unverifiable -> null, and
// the request passes on to the backend, which rejects it itself.
function tokenClaims(req) {
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : h;
    const parts = token.split('.');
    if (parts.length !== 3 || !SECRET) return null;
    try {
        const expected = crypto.createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest();
        const given = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        const claims = b64urlJson(parts[1]);
        if (claims.exp && claims.exp * 1000 < Date.now()) return null;
        return claims;
    } catch {
        return null;
    }
}

function hasOperatorKey(value, depth = 0) {
    if (depth > 20 || value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((v) => hasOperatorKey(v, depth + 1));
    return Object.keys(value).some((k) => k.startsWith('$') || hasOperatorKey(value[k], depth + 1));
}

// ?phone[$regex]=… is parsed into {phone: {$regex: …}} by the backend.
function queryHasOperator(url) {
    const q = String(url || '').split('?')[1];
    if (!q) return false;
    let decoded = q;
    try { decoded = decodeURIComponent(q.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    return /(^|&|\[)\$/.test(decoded) || /\[\s*\$/.test(decoded);
}

// Field names a multipart body may not carry to the user routes.
const PROTECTED_FIELDS = ['role', 'adminId', 'permissions', 'otp', 'otpExpiry', 'activeToken'];
function multipartFieldValue(text, field) {
    const m = text.match(new RegExp(`name="${field}"\\r\\n\\r\\n([^\\r]*)`));
    return m ? m[1] : null;
}

const isPhone = (v) => typeof v === 'string' && /^\+?[0-9]{10,13}$/.test(v.trim());
const isOtp = (v) => (typeof v === 'string' || typeof v === 'number') && /^[0-9]{6}$/.test(String(v));

// ── the rules ────────────────────────────────────────────────────────────────
// Returns null (let it through) or { status, message, reason }.
function judge(req, path, claims, json, rawText) {
    const method = req.method;
    const role = claims?.role || null;

    if (queryHasOperator(req.url)) return { status: 400, message: 'Invalid request.', reason: 'query_operator' };
    if (json !== undefined && hasOperatorKey(json)) return { status: 400, message: 'Invalid request.', reason: 'body_operator' };

    // Sign-in: the phone must be a plain number, and a code must be sent.
    if (method === 'POST' && path === '/api/users/login-request') {
        if (!json || !isPhone(json.phone)) return { status: 400, message: 'Please enter your 10-digit mobile number.', reason: 'login_bad_phone' };
        const phone = json.phone.trim();
        if (count(`code:${phone}`) >= MAX_CODES_PER_PHONE) return { status: 429, message: 'Too many codes asked for this number. Please wait 15 minutes and try again.', reason: 'login_too_many_codes' };
        if (count(`ipfail:${clientIp(req)}`) >= MAX_FAILS_PER_IP) return { status: 429, message: 'Too many attempts. Please wait 15 minutes and try again.', reason: 'login_ip_limit' };
    }
    if (method === 'POST' && path === '/api/users/verify-otp') {
        if (!json || !isPhone(json.phone)) return { status: 400, message: 'Please enter your 10-digit mobile number.', reason: 'verify_bad_phone' };
        if (!isOtp(json.otp)) return { status: 400, message: 'Invalid or expired OTP', reason: 'verify_no_code' };
        const phone = json.phone.trim();
        if (count(`fail:${phone}`) >= MAX_FAILS_PER_PHONE) return { status: 429, message: 'Too many wrong codes. Please ask for a new code.', reason: 'verify_phone_limit' };
        if (count(`ipfail:${clientIp(req)}`) >= MAX_FAILS_PER_IP) return { status: 429, message: 'Too many attempts. Please wait 15 minutes and try again.', reason: 'verify_ip_limit' };
    }

    // Nobody but a super admin may give anyone the admin or super admin role.
    const wantedRole = json && typeof json === 'object' ? json.role : (rawText ? multipartFieldValue(rawText, 'role') : null);
    if (wantedRole && /^(superadmin|admin)$/i.test(String(wantedRole).trim()) && role !== 'superadmin'
        && !(path === '/api/users/login-request' || path === '/api/users/verify-otp')) {
        return { status: 403, message: 'Access denied.', reason: `role_escalation_${String(wantedRole).toLowerCase()}` };
    }

    // An employee's own profile edit may not carry account-control fields.
    if (path === '/api/users/profile' && (method === 'PUT' || method === 'PATCH')) {
        const bad = PROTECTED_FIELDS.find((f) => (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, f))
            || (rawText && multipartFieldValue(rawText, f) !== null));
        if (bad) return { status: 403, message: 'Access denied.', reason: `profile_field_${bad}` };
    }

    // Employee tokens never need the people-management or platform routes
    // (checked against every API call the previous release's employee screens make).
    if (role === 'employee') {
        const p = path.replace(/\/+$/, '');
        if (p === '/api/users' && method === 'GET') return { status: 403, message: 'Access denied.', reason: 'employee_user_list' };
        if (p === '/api/users/employees' || p.startsWith('/api/users/employees/')) return { status: 403, message: 'Access denied.', reason: 'employee_user_admin' };
        if (p === '/api/users/admin-users' || p.startsWith('/api/users/admin-users/')) return { status: 403, message: 'Access denied.', reason: 'employee_admin_users' };
        if (p === '/api/superadmin' || p.startsWith('/api/superadmin/')) return { status: 403, message: 'Access denied.', reason: 'employee_superadmin' };
        if ((p === '/api/settings' || p.startsWith('/api/settings/')) && method !== 'GET') return { status: 403, message: 'Access denied.', reason: 'employee_settings_write' };
    }
    return null;
}

// ── proxy ────────────────────────────────────────────────────────────────────

function forward(req, res, body, onResponse) {
    const headers = { ...req.headers };
    const up = http.request({
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        method: req.method,
        path: req.url,
        headers,
    }, (upRes) => {
        if (onResponse) onResponse(upRes.statusCode);
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.rawHeaders);
        upRes.pipe(res);
    });
    up.on('error', (err) => {
        console.error(`[shield] upstream error ${req.method} ${req.url}: ${err.message}`);
        if (!res.headersSent) refuse(res, 502, 'Service temporarily unavailable. Please try again.');
        else res.destroy();
    });
    if (body) up.end(body);
    else req.pipe(up);
}

function needsInspection(req, path) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
    if (path.startsWith('/iclock')) return false; // device protocol: plain text, passed untouched
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    return ct.includes('application/json') || ct.includes('multipart/form-data') || ct.includes('urlencoded');
}

const server = http.createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];
    if (path === '/__shield/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
    }
    const claims = tokenClaims(req);

    if (!needsInspection(req, path)) {
        const verdict = judge(req, path, claims, undefined, null);
        if (verdict) { log(req, verdict.reason); return refuse(res, verdict.status, verdict.message); }
        return forward(req, res, null);
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
            aborted = true;
            log(req, 'too_large');
            refuse(res, 413, 'The file is too large.');
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks);
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        let json;
        let rawText = null;
        if (ct.includes('application/json') && body.length) {
            try { json = JSON.parse(body.toString('utf8')); } catch { json = undefined; }
        } else if (ct.includes('multipart/form-data')) {
            rawText = body.toString('latin1');
        } else if (ct.includes('urlencoded')) {
            json = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
            if (/(^|&)[^=&]*%5B%24|(^|&)[^=&]*\[\$/i.test(body.toString('utf8'))) json = { $op: true };
        }
        const verdict = judge(req, path, claims, json, rawText);
        if (verdict) { log(req, verdict.reason); return refuse(res, verdict.status, verdict.message); }

        let onResponse = null;
        if (req.method === 'POST' && (path === '/api/users/login-request' || path === '/api/users/verify-otp') && json && isPhone(json.phone)) {
            const phone = json.phone.trim();
            const ipKey = `ipfail:${clientIp(req)}`;
            onResponse = (status) => {
                if (path === '/api/users/login-request') {
                    if (status === 200) bump(`code:${phone}`);
                    else if (status === 404) bump(ipKey);
                } else if (status >= 400) {
                    bump(`fail:${phone}`);
                    bump(ipKey);
                }
            };
        }
        forward(req, res, body, onResponse);
    });
    req.on('error', () => { /* client went away */ });
});

server.keepAliveTimeout = 65 * 1000;
if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[shield] listening on 127.0.0.1:${PORT}, forwarding to ${UPSTREAM.origin}${SECRET ? '' : ' (no JWT_SECRET: token roles not read)'}`);
    });
}

module.exports = { server, judge, hasOperatorKey, queryHasOperator, isPhone, isOtp };
