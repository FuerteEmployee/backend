const mongoose = require('mongoose');
const ClientDevice = require('../models/ClientDevice');
const ClientError = require('../models/ClientError');
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
                    lastSeenAt: now,
                },
                // Only on insert, so the true first sighting is never overwritten
                // by a later report.
                $setOnInsert: { firstSeenAt: now },
                $inc: { appOpenCount: 1 },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );

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

        const KINDS = ['ui', 'network', 'unhandled'];
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
