const mongoose = require('mongoose');
const ClientDevice = require('../models/ClientDevice');
const ClientError = require('../models/ClientError');
const TrackerEvent = require('../models/TrackerEvent');
const LoginSession = require('../models/LoginSession');

const { PERMISSION_STATES } = ClientDevice;

// ── input hygiene ─────────────────────────────────────────────────────────────
// Everything below arrives from an employee's phone. The route is authenticated
// but otherwise unprivileged, so treat every field as hostile: truncate instead
// of rejecting (a dropped crash report is worse than a shortened one), and
// whitelist anything that reaches an enum.

const str = (v, max) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
};

const permissionState = (v) => (PERMISSION_STATES.includes(v) ? v : 'unknown');

const PLATFORMS = ['android', 'ios', 'web'];
const platform = (v) => (PLATFORMS.includes(v) ? v : null);

/**
 * POST /api/client/report
 *
 * Called by the app on login and on resume. Upserts the row for this install
 * rather than inserting, so an employee who opens the app 40 times a day
 * produces one row with a moving lastSeenAt — not 40 rows.
 */
exports.reportClient = async (req, res) => {
    try {
        const installId = str(req.body.installId, 64);
        if (!installId) {
            return res.status(400).json({ message: 'installId is required' });
        }

        const perms = req.body.permissions || {};
        const now = new Date();

        const device = await ClientDevice.findOneAndUpdate(
            {
                adminId: new mongoose.Types.ObjectId(req.adminId),
                employeeId: new mongoose.Types.ObjectId(req.userId),
                installId,
            },
            {
                $set: {
                    appVersion: str(req.body.appVersion, 32),
                    appBuild: str(req.body.appBuild, 32),
                    platform: platform(req.body.platform),
                    osVersion: str(req.body.osVersion, 64),
                    deviceModel: str(req.body.deviceModel, 128),
                    manufacturer: str(req.body.manufacturer, 64),
                    isNative: req.body.isNative === true,
                    'permissions.location': permissionState(perms.location),
                    'permissions.coarseLocation': permissionState(perms.coarseLocation),
                    'permissions.camera': permissionState(perms.camera),
                    'permissions.notifications': permissionState(perms.notifications),
                    // Background-tracking readiness. Each has its own fix, so
                    // support needs them individually rather than one rolled-up
                    // "location is broken".
                    'permissions.backgroundLocation': permissionState(perms.backgroundLocation),
                    'permissions.preciseLocation': permissionState(perms.preciseLocation),
                    'permissions.batteryUnrestricted': permissionState(perms.batteryUnrestricted),
                    'permissions.autoStart': permissionState(perms.autoStart),
                    oemHint: str(req.body.manufacturer, 64),
                    lastSeenAt: now,
                },
                // Only on insert, so the true first sighting is never overwritten
                // by a later report.
                $setOnInsert: { firstSeenAt: now },
                $inc: { appOpenCount: 1 },
                // Latch only. A report saying setup is complete sets it; a later
                // report can never clear it, because "never completed setup" and
                // "completed it, then a permission was revoked" need different
                // help and the second must stay distinguishable.
                ...(req.body.trackingSetupComplete === true
                    ? { $max: { trackingSetupCompletedAt: now } }
                    : {}),
                // Latched for the same reason as the setup flag: having once
                // survived a reboot is a fact about the handset's configuration,
                // and a later report from a device that has not rebooted since
                // must not read as the permission having gone away.
                ...(req.body.autoStartProven === true
                    ? { $set: { autoStartProven: true } }
                    : {}),
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );

        // The boolean mirrors the timestamp so a reader never has to know that
        // the latch is implemented as a $max on a date.
        if (req.body.trackingSetupComplete === true && !device.trackingSetupComplete) {
            device.trackingSetupComplete = true;
            await device.save();
        }

        res.json({ ok: true, installId: device.installId, firstSeenAt: device.firstSeenAt });
    } catch (error) {
        // A duplicate-key here means two reports raced the upsert; the row the
        // other one wrote is equally good, so this isn't worth surfacing as a
        // failure to the app (which would just retry and race again).
        if (error.code === 11000) {
            return res.json({ ok: true, deduped: true });
        }
        res.status(500).json({ message: error.message });
    }
};

// Per-employee write budget for error reports. A crash loop on one handset
// would otherwise write until it filled the collection — the TTL index bounds
// how long rows live, not how fast they arrive. Same in-memory-with-TTL shape
// as the ATTLOG dedupe in utils/device_registry.js.
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const ERROR_MAX_PER_WINDOW = 30;
const errorBudget = new Map(); // employeeId -> { count, windowStart }

function overErrorBudget(employeeId) {
    const key = String(employeeId);
    const now = Date.now();
    const entry = errorBudget.get(key);

    if (!entry || now - entry.windowStart > ERROR_WINDOW_MS) {
        errorBudget.set(key, { count: 1, windowStart: now });
        // Opportunistic sweep so the map can't grow with every employee that
        // ever reported — cheap relative to how rarely this route is hit.
        if (errorBudget.size > 5000) {
            for (const [k, v] of errorBudget) {
                if (now - v.windowStart > ERROR_WINDOW_MS) errorBudget.delete(k);
            }
        }
        return false;
    }

    entry.count += 1;
    return entry.count > ERROR_MAX_PER_WINDOW;
}

/**
 * POST /api/client/error
 *
 * One error the employee actually saw. Returns 202 when the report is dropped
 * for exceeding the budget — the app should not treat that as a failure worth
 * retrying, or it compounds the loop that triggered it.
 */
exports.reportClientError = async (req, res) => {
    try {
        const message = str(req.body.message, 2000);
        if (!message) {
            return res.status(400).json({ message: 'message is required' });
        }

        if (overErrorBudget(req.userId)) {
            return res.status(202).json({ ok: true, dropped: 'rate_limited' });
        }

        const KINDS = ['ui', 'network', 'unhandled', 'tracker'];
        const occurredAtRaw = req.body.occurredAt ? new Date(req.body.occurredAt) : null;
        const statusCode = Number(req.body.statusCode);

        await ClientError.create({
            adminId: req.adminId,
            employeeId: req.userId,
            installId: str(req.body.installId, 64),
            appVersion: str(req.body.appVersion, 32),
            appBuild: str(req.body.appBuild, 32),
            platform: platform(req.body.platform),
            message,
            kind: KINDS.includes(req.body.kind) ? req.body.kind : 'unhandled',
            stack: str(req.body.stack, 8000),
            route: str(req.body.route, 256),
            requestUrl: str(req.body.requestUrl, 512),
            statusCode: Number.isFinite(statusCode) ? statusCode : null,
            // Ignore an unparseable or absurd client clock rather than storing it.
            occurredAt: occurredAtRaw && !Number.isNaN(occurredAtRaw.getTime()) ? occurredAtRaw : new Date(),
        });

        res.status(201).json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── tracker events ───────────────────────────────────────────────

const EVENT_TYPES = TrackerEvent.schema.path('type').enumValues;

// Arrive in batches, so the budget counts EVENTS rather than requests — one
// request carrying 200 rows costs the same as 200 requests carrying one. The
// window is wider and the allowance larger than the error budget because a
// device coming back from a day offline legitimately flushes a lot at once.
const EVENT_WINDOW_MS = 10 * 60 * 1000;
const EVENT_MAX_PER_WINDOW = 400;
const eventBudget = new Map(); // employeeId -> { count, windowStart }

function takeEventBudget(employeeId, wanted) {
    const key = String(employeeId);
    const now = Date.now();
    const entry = eventBudget.get(key);

    if (!entry || now - entry.windowStart > EVENT_WINDOW_MS) {
        eventBudget.set(key, { count: wanted, windowStart: now });
        if (eventBudget.size > 5000) {
            for (const [k, v] of eventBudget) {
                if (now - v.windowStart > EVENT_WINDOW_MS) eventBudget.delete(k);
            }
        }
        return wanted;
    }

    // Partial grants rather than all-or-nothing: dropping a whole flush because
    // it overshot by two rows loses the transition that explains the outage.
    const room = Math.max(0, EVENT_MAX_PER_WINDOW - entry.count);
    const granted = Math.min(room, wanted);
    entry.count += granted;
    return granted;
}

/**
 * POST /api/client/events
 *
 * A batch of device-state transitions from one install. Written by the phone on
 * an unprivileged route, so every field is re-derived or whitelisted here and
 * nothing the client sends decides who the row belongs to.
 *
 * Always 2xx. The app posts this from a background sync loop and deletes its
 * local copy on success; a 4xx for one malformed row would make it retry the
 * whole batch forever. Unrecognised rows are counted and dropped, and the count
 * comes back so a bad build is visible without a server log.
 */
exports.reportTrackerEvents = async (req, res) => {
    try {
        const incoming = Array.isArray(req.body.events) ? req.body.events : [];
        if (incoming.length === 0) return res.json({ ok: true, accepted: 0 });

        // Hard ceiling before anything else, so an absurd payload cannot make us
        // allocate its size in memory.
        const capped = incoming.slice(0, 500);
        const installId = str(req.body.installId, 64);
        const appVersion = str(req.body.appVersion, 32);

        const now = Date.now();
        const rows = [];
        let rejected = 0;

        for (const raw of capped) {
            if (!raw || typeof raw !== 'object') { rejected += 1; continue; }
            if (!EVENT_TYPES.includes(raw.type)) { rejected += 1; continue; }

            // A phone's clock can be wrong in both directions. Anything more
            // than a day in the future is nonsense and would sort above real
            // events forever; more than 30 days old outlives the TTL anyway.
            const at = new Date(raw.at);
            if (Number.isNaN(at.getTime())) { rejected += 1; continue; }
            const age = now - at.getTime();
            if (age < -24 * 60 * 60 * 1000 || age > 30 * 24 * 60 * 60 * 1000) {
                rejected += 1;
                continue;
            }

            const battery = Number(raw.batteryLevel);

            rows.push({
                adminId: req.adminId,
                employeeId: req.userId,   // never from the body — see tracking_controller
                installId,
                appVersion,
                type: raw.type,
                at,
                // Serialised and re-parsed to strip anything exotic and to bound
                // the size; Mixed would otherwise store whatever arrived.
                meta: sanitiseMeta(raw.meta),
                batteryLevel: Number.isFinite(battery)
                    ? Math.max(0, Math.min(100, Math.round(battery)))
                    : null,
                charging: typeof raw.charging === 'boolean' ? raw.charging : null,
            });
        }

        const granted = takeEventBudget(req.userId, rows.length);
        const toWrite = granted >= rows.length ? rows : rows.slice(0, granted);

        if (toWrite.length > 0) {
            // ordered:false so one bad row cannot discard the rest of the batch.
            await TrackerEvent.insertMany(toWrite, { ordered: false });
        }

        res.status(201).json({
            ok: true,
            accepted: toWrite.length,
            rejected,
            dropped: rows.length - toWrite.length,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/** Bound and flatten client-supplied meta. One level deep, scalars only. */
function sanitiseMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(meta)) {
        if (n >= 12) break;
        if (v === null || v === undefined) continue;
        const t = typeof v;
        if (t === 'number' || t === 'boolean') out[String(k).slice(0, 40)] = v;
        else if (t === 'string') out[String(k).slice(0, 40)] = v.slice(0, 200);
        else continue;
        n += 1;
    }
    return n > 0 ? out : null;
}

/**
 * GET /api/client/events?employeeId=&from=&to=&limit=&types=
 *
 * One employee's device timeline. `employeeId` is required: a tenant-wide feed
 * of every phone's GPS toggles is thousands of rows answering no question
 * anyone asks, and the UI that reads this is always looking at one person.
 */
exports.getTrackerEvents = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.query.employeeId || '')) {
            return res.status(400).json({ message: 'employeeId is required' });
        }

        const filter = {
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(req.query.employeeId),
        };

        const from = req.query.from ? new Date(req.query.from) : null;
        const to = req.query.to ? new Date(req.query.to) : null;
        if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
            filter.at = {};
            if (from && !Number.isNaN(from.getTime())) filter.at.$gte = from;
            if (to && !Number.isNaN(to.getTime())) filter.at.$lte = to;
        }

        if (req.query.types) {
            const wanted = String(req.query.types).split(',').filter((t) => EVENT_TYPES.includes(t));
            if (wanted.length > 0) filter.type = { $in: wanted };
        }

        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        const events = await TrackerEvent.find(filter)
            .sort({ at: -1 })
            .limit(limit)
            .lean();

        res.json(events);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/client/devices[?employeeId=]
 *
 * Without employeeId: every reporting install for the tenant, which is what the
 * employees-list version column reads. With it: just that employee's installs.
 */
exports.getClientDevices = async (req, res) => {
    try {
        const filter = { adminId: new mongoose.Types.ObjectId(req.adminId) };
        if (req.query.employeeId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.employeeId)) {
                return res.status(400).json({ message: 'Invalid employeeId' });
            }
            filter.employeeId = new mongoose.Types.ObjectId(req.query.employeeId);
        }

        const devices = await ClientDevice.find(filter)
            .populate('employeeId', 'name phone')
            .sort({ lastSeenAt: -1 })
            .lean();

        res.json(devices);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/client/errors[?employeeId=&limit=]
 */
exports.getClientErrors = async (req, res) => {
    try {
        const filter = { adminId: new mongoose.Types.ObjectId(req.adminId) };
        if (req.query.employeeId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.employeeId)) {
                return res.status(400).json({ message: 'Invalid employeeId' });
            }
            filter.employeeId = new mongoose.Types.ObjectId(req.query.employeeId);
        }

        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const errors = await ClientError.find(filter)
            .populate('employeeId', 'name phone')
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json(errors);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/client/sessions[?userId=&limit=]
 *
 * Real login/logout history for the Settings access-log table.
 */
exports.getLoginSessions = async (req, res) => {
    try {
        const filter = { adminId: new mongoose.Types.ObjectId(req.adminId) };
        if (req.query.userId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.userId)) {
                return res.status(400).json({ message: 'Invalid userId' });
            }
            filter.userId = new mongoose.Types.ObjectId(req.query.userId);
        }

        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const sessions = await LoginSession.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
