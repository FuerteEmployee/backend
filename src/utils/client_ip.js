// The caller's network address, shared by the access log (user_controller) and
// the IP-based approximate location (ip_tracking).

/**
 * Node reports IPv4 clients as IPv4-mapped IPv6 on a dual-stack socket, so a
 * real address arrives as "::ffff:203.0.113.9" — the prefix is noise an admin
 * shouldn't have to mentally strip. Loopback likewise arrives as "::1", which
 * reads as garbage in the UI; store the canonical 127.0.0.1 instead. Loopback
 * means the request reached the API on the same host: local development, or a
 * production request that arrived without X-Forwarded-For.
 */
const normalizeIp = (ip) => {
    if (!ip) return null;
    const stripped = String(ip).replace(/^::ffff:/i, '').trim();
    if (!stripped) return null;
    return stripped === '::1' ? '127.0.0.1' : stripped;
};

const isLoopbackOrPrivate = (ip) =>
    !!ip && (ip === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i.test(ip));

/**
 * The client's address, or null when it cannot be told apart from other clients.
 *
 * In production the API sits behind Nginx, so the socket peer is loopback and
 * the client is in X-Forwarded-For. Only the LAST entry of that header is
 * trustworthy: it is the one the nearest proxy appended. The first entry is
 * whatever the client itself sent, so reading it (as this file used to) let
 * anyone write any address into the access log -- or dodge a per-address limit
 * by sending a new one on every request.
 *
 * A loopback peer with no forwarding header (local development) returns null:
 * every request looks identical, so a per-address limit must not apply.
 */
const clientIp = (req) => {
    const peer = normalizeIp(req.socket?.remoteAddress || req.ip);
    if (peer && !isLoopbackOrPrivate(peer)) return peer;
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return hops.length ? normalizeIp(hops[hops.length - 1]) : null;
};

module.exports = { normalizeIp, isLoopbackOrPrivate, clientIp };
