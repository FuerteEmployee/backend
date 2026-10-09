// ─────────────────────────────────────────────────────────────────────────────
// Face kiosk (BOTLens).
//
// The kiosk only RECOGNISES. Everything it used to keep for itself now lives
// here: the faces (FaceProfile), who it is (LensKiosk), and what a sighting
// means -- a sighting is a tap, stored and read exactly like a fingerprint
// machine's (utils/tap_ingest.js), in one day timeline with the app's punches.
// The kiosk shows the answer this file sends back, so the kiosk and the
// attendance record can no longer disagree.
//
// Three kinds of caller:
//   · the admin signing in on a kiosk (their own token) -- creates the kiosk
//     and gets the kiosk's key;
//   · the kiosk itself (its key, protectLens) -- faces, employees, taps;
//   · the admin panel (panelOnly) -- lists and switches off kiosks and faces.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const PunchLog = require('../models/PunchLog');
const Settings = require('../models/Settings');
const FaceProfile = require('../models/FaceProfile');
const LensKiosk = require('../models/LensKiosk');
const { cloudinary } = require('../config/cloudinary');
const { decrypt: decryptSecret } = require('../utils/reversible_crypto');
const { recordTap } = require('../utils/tap_ingest');
const { debounceMs } = require('../utils/punch_reconcile');
const { withEmployeeLock } = require('../utils/employee_lock');
const { istDateKey, istStartOfDay, istHHMM } = require('../utils/attendance_helpers');

const KIOSK_KEY_DAYS = 180;
const ENROLL_GRANT_MINUTES = 15;
const MAX_KIOSKS_PER_COMPANY = 20;

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.isValidObjectId(v);
// Employees that count: of this company, not switched off.
const activeEmployee = (adminId) => ({ adminId: oid(adminId), role: 'employee', status: { $ne: 'inactive' } });

function sendError(res, err, where) {
    if (err && err.name === 'ValidationError') {
        const first = Object.values(err.errors || {})[0];
        return res.status(400).json({ message: first?.message || 'Some details are not valid.' });
    }
    console.error(`[lens] ${where}:`, err && err.message);
    return res.status(500).json({ message: 'Something went wrong. Please try again.' });
}

// ── Kiosk set-up (the admin, on the kiosk) ──────────────────────────────────

/**
 * POST /api/lens/kiosks  (admin's own token)
 * Body: { name }. Creates the kiosk and returns its key. The kiosk keeps only
 * the key and forgets the admin's sign-in.
 */
exports.createKiosk = async (req, res) => {
    try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name || name.length > 60) {
            return res.status(400).json({ message: 'Give this kiosk a name of up to 60 letters, for example "Reception".' });
        }
        const active = await LensKiosk.countDocuments({ adminId: oid(req.adminId), revokedAt: null });
        if (active >= MAX_KIOSKS_PER_COMPANY) {
            return res.status(409).json({ message: `Your company already has ${MAX_KIOSKS_PER_COMPANY} kiosks. Switch one off first.` });
        }
        const kiosk = await LensKiosk.create({ adminId: oid(req.adminId), name, createdBy: req.userId });
        const key = jwt.sign(
            { scope: 'lens', kioskId: String(kiosk._id), adminId: String(req.adminId) },
            process.env.JWT_SECRET,
            { expiresIn: `${KIOSK_KEY_DAYS}d` },
        );
        res.status(201).json({ key, kiosk: { _id: kiosk._id, name: kiosk.name }, expiresInDays: KIOSK_KEY_DAYS });
    } catch (err) {
        sendError(res, err, 'createKiosk');
    }
};

// ── The kiosk itself (its key) ──────────────────────────────────────────────

/** GET /api/lens/me -- who this kiosk is, and whether its faces changed. */
exports.me = async (req, res) => {
    try {
        const [latest, settings] = await Promise.all([
            FaceProfile.findOne({ adminId: oid(req.adminId) }).sort({ updatedAt: -1 }).select('updatedAt').lean(),
            Settings.findOne({ adminId: oid(req.adminId) }).select('attendance.punchDebounceSeconds').lean(),
        ]);
        res.json({
            company: { _id: req.adminId, name: req.kioskAdmin?.companyName || req.kioskAdmin?.name || '' },
            kiosk: { _id: req.kioskId, name: req.kiosk?.name || '' },
            facesVersion: latest ? new Date(latest.updatedAt).toISOString() : null,
            today: istDateKey(new Date()),
            serverTime: new Date().toISOString(),
            repeatSeconds: Math.round(debounceMs(settings) / 1000),
        });
    } catch (err) {
        sendError(res, err, 'me');
    }
};

/**
 * GET /api/lens/employees -- names to register a face for. Id, name and
 * whether a face is already registered; nothing else (no phone, bank or PAN).
 */
exports.listEmployees = async (req, res) => {
    try {
        const [people, faces] = await Promise.all([
            User.find(activeEmployee(req.adminId)).select('name').sort({ name: 1 }).lean(),
            FaceProfile.find({ adminId: oid(req.adminId) }).select('employeeId thumbnailUrl updatedAt').lean(),
        ]);
        const byEmp = new Map(faces.map((f) => [String(f.employeeId), f]));
        res.json(people.map((p) => {
            const f = byEmp.get(String(p._id));
            return { _id: p._id, name: p.name, hasFace: !!f, thumbnailUrl: f?.thumbnailUrl || null, faceUpdatedAt: f?.updatedAt || null };
        }));
    } catch (err) {
        sendError(res, err, 'listEmployees');
    }
};

/**
 * GET /api/lens/faces -- every registered face of THIS company's active
 * employees, for matching. A face whose employee is switched off is left out,
 * so leaving the company stops recognition with no other step.
 */
exports.listFaces = async (req, res) => {
    try {
        const people = await User.find(activeEmployee(req.adminId)).select('name').lean();
        const names = new Map(people.map((p) => [String(p._id), p.name]));
        const faces = await FaceProfile.find({ adminId: oid(req.adminId), employeeId: { $in: people.map((p) => p._id) } })
            .select('employeeId embeddings modelVersion updatedAt')
            .lean();
        const latest = faces.reduce((m, f) => Math.max(m, new Date(f.updatedAt).getTime()), 0);
        res.json({
            version: latest ? new Date(latest).toISOString() : null,
            faces: faces.map((f) => ({
                employeeId: f.employeeId,
                name: names.get(String(f.employeeId)) || '',
                embeddings: f.embeddings,
                modelVersion: f.modelVersion,
            })),
        });
    } catch (err) {
        sendError(res, err, 'listFaces');
    }
};

// Wrong BOTLens passwords per kiosk: a shared tablet must not be a place to
// guess the admin's password at leisure. In memory, like the sign-in limits.
const grantFailures = new Map();
const GRANT_WINDOW_MS = 15 * 60 * 1000;
const GRANT_MAX_FAILURES = 5;

/**
 * POST /api/lens/enroll-grant  { email, password }
 * The admin proves they are at the kiosk before faces can be changed. Returns
 * a short grant (15 min) the kiosk sends with each face change, checked here.
 * Replaces a flag the kiosk page used to keep in the browser, which anyone
 * could set.
 */
exports.enrollGrant = async (req, res) => {
    try {
        const now = Date.now();
        const rec = grantFailures.get(req.kioskId);
        if (rec && now - rec.since < GRANT_WINDOW_MS && rec.count >= GRANT_MAX_FAILURES) {
            return res.status(429).json({ message: 'Too many wrong tries. Wait 15 minutes and try again.' });
        }
        const fail = () => {
            const r = rec && now - rec.since < GRANT_WINDOW_MS ? rec : { since: now, count: 0 };
            r.count += 1;
            grantFailures.set(req.kioskId, r);
            return res.status(401).json({ message: 'Incorrect email or password' });
        };

        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const admin = await User.findOne({ _id: oid(req.adminId), role: 'admin' }).select('botlensEmail botlensPasswordEnc').lean();
        if (!admin?.botlensEmail || !admin?.botlensPasswordEnc) {
            return res.status(403).json({ message: 'No BOTLens email and password are set for your company. Ask B.O.T support to set them.' });
        }
        if (!email || admin.botlensEmail.toLowerCase() !== email) return fail();
        const actual = decryptSecret(admin.botlensPasswordEnc) || '';
        const ok = actual.length === password.length
            && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(password));
        if (!ok) return fail();

        grantFailures.delete(req.kioskId);
        const grant = jwt.sign(
            { scope: 'lens-enroll', kioskId: req.kioskId, adminId: req.adminId },
            process.env.JWT_SECRET,
            { expiresIn: `${ENROLL_GRANT_MINUTES}m` },
        );
        res.json({ grant, expiresInSec: ENROLL_GRANT_MINUTES * 60 });
    } catch (err) {
        sendError(res, err, 'enrollGrant');
    }
};

/** Middleware: a valid enroll grant for THIS kiosk, in `x-enroll-grant`. */
exports.requireEnrollGrant = (req, res, next) => {
    try {
        const g = jwt.verify(String(req.headers['x-enroll-grant'] || ''), process.env.JWT_SECRET);
        if (g.scope === 'lens-enroll' && g.kioskId === req.kioskId && g.adminId === req.adminId) return next();
    } catch { /* falls through */ }
    return res.status(401).json({ code: 'enroll_grant_needed', message: 'Enter the BOTLens email and password again to change faces.' });
};

// One small picture of who is registered, so the admin can see it. 240 px,
// never the full scan.
async function uploadThumbnail(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 1024 * 1024
        || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return null;
    const result = await cloudinary.uploader.upload(dataUrl, {
        folder: 'lens/faces',
        resource_type: 'image',
        transformation: [{ width: 240, height: 240, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
    });
    return result.secure_url;
}

/**
 * PUT /api/lens/faces/:employeeId  (kiosk key + enroll grant)
 * Body: { embeddings: [[128 numbers], ...], thumbnail?: data URL }
 */
exports.saveFace = async (req, res) => {
    try {
        const { employeeId } = req.params;
        if (!isId(employeeId)) return res.status(400).json({ message: 'Pick an employee.' });
        const person = await User.findOne({ _id: oid(employeeId), ...activeEmployee(req.adminId) }).select('name').lean();
        if (!person) return res.status(404).json({ message: 'That employee is not in your company, or is switched off.' });

        const embeddings = req.body?.embeddings;
        const valid = Array.isArray(embeddings) && embeddings.length >= 1 && embeddings.length <= 12
            && embeddings.every((v) => Array.isArray(v) && v.length === 128 && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
        if (!valid) return res.status(400).json({ message: 'The face scan did not come through. Scan again.' });

        let thumbnailUrl;
        try {
            thumbnailUrl = await uploadThumbnail(req.body?.thumbnail);
        } catch (e) {
            console.error('[lens] thumbnail upload failed:', e.message);
            thumbnailUrl = null; // the face still works without its picture
        }

        const set = {
            embeddings,
            modelVersion: typeof req.body?.modelVersion === 'string' ? req.body.modelVersion.slice(0, 40) : 'sface_2021dec',
            createdBy: req.kiosk?.createdBy || null,
            kioskId: oid(req.kioskId),
        };
        if (thumbnailUrl) set.thumbnailUrl = thumbnailUrl;

        const face = await FaceProfile.findOneAndUpdate(
            { adminId: oid(req.adminId), employeeId: oid(employeeId) },
            { $set: set },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
        ).select('employeeId thumbnailUrl updatedAt').lean();
        res.json({ ok: true, employee: { _id: person._id, name: person.name }, face });
    } catch (err) {
        sendError(res, err, 'saveFace');
    }
};

/** DELETE /api/lens/faces/:employeeId  (kiosk key + enroll grant) */
exports.deleteFace = async (req, res) => {
    try {
        const { employeeId } = req.params;
        if (!isId(employeeId)) return res.status(400).json({ message: 'Pick an employee.' });
        const r = await FaceProfile.deleteOne({ adminId: oid(req.adminId), employeeId: oid(employeeId) });
        res.json({ ok: true, removed: r.deletedCount });
    } catch (err) {
        sendError(res, err, 'deleteFace');
    }
};

// Plain words for what a tap did, shown on the kiosk.
function tapMessage(action, at, day, reason) {
    const t = istHHMM(at);
    if (reason === 'debounced') return 'Already recorded. Please wait a moment.';
    if (reason === 'duplicate') return 'Already recorded.';
    switch (action) {
        case 'punch-in': return `Punched in at ${t}`;
        case 'punch-out': return `Punched out at ${t}`;
        case 'lunch-in': return `Lunch started at ${t}`;
        case 'lunch-out': return `Back from lunch at ${t}`;
        default:
            return day?.punchIn ? `Seen at ${t}. Punched in at ${istHHMM(day.punchIn)}.` : `Seen at ${t}`;
    }
}

/**
 * POST /api/lens/taps  (kiosk key)
 * Body: { employeeId, tapTime?, score? }
 *
 * A sighting is a tap. It is stored and the day rebuilt exactly as a
 * fingerprint machine's would be, and the answer -- what it meant, and the
 * day as it now stands -- is what the kiosk shows.
 *
 * `tapTime` is when the kiosk saw the face (its retry of the same sighting
 * sends the same time, so the unique tap index makes it count once). A time
 * that is not plausible -- in the future, or more than a day old -- is
 * replaced by now.
 */
exports.recordSighting = async (req, res) => {
    try {
        const { employeeId } = req.body || {};
        if (!isId(employeeId)) return res.status(400).json({ message: 'Unknown person.' });
        const person = await User.findOne({ _id: oid(employeeId), ...activeEmployee(req.adminId) }).select('name').lean();
        if (!person) return res.status(404).json({ message: 'This person is not an active employee of this company.' });

        const now = Date.now();
        const sent = req.body?.tapTime ? new Date(req.body.tapTime) : null;
        const tapTime = sent && !Number.isNaN(sent.getTime()) && sent.getTime() <= now + 60 * 1000 && sent.getTime() >= now - 24 * 3600 * 1000
            ? sent
            : new Date(now);
        const score = Number.isFinite(Number(req.body?.score)) ? Math.max(0, Math.min(1, Number(req.body.score))) : null;

        const settings = await Settings.findOne({ adminId: oid(req.adminId) }).select('attendance').lean();
        const serialNumber = `LENS-${req.kioskId}`;
        const pin = String(employeeId);

        const outcome = await withEmployeeLock(`punch:${employeeId}`, () => recordTap({
            adminId: oid(req.adminId), employeeId: oid(employeeId), tapTime,
            source: 'lens', serialNumber, pin, settings, score,
        }));

        const [y, m, d] = outcome.dayKey.split('-').map(Number);
        const dayStart = istStartOfDay(new Date(Date.UTC(y, m - 1, d, 12)));
        const [day, mine] = await Promise.all([
            Attendance.findOne({ adminId: oid(req.adminId), employeeId: oid(employeeId), date: dayStart })
                .select('punchIn punchOut lunchInTime lunchOutTime shifts punchOutIsProvisional').lean(),
            PunchLog.findOne({ serialNumber, pin, deviceTime: tapTime }).select('derivedAction').lean(),
        ]);

        const action = outcome.recorded ? (mine?.derivedAction || null) : null;
        let retryAfterSec = 0;
        if (outcome.reason === 'debounced' && outcome.lastTapTime) {
            retryAfterSec = Math.max(1, Math.ceil((new Date(outcome.lastTapTime).getTime() + debounceMs(settings) - now) / 1000));
        }
        const open = !!(day && day.punchIn && (!day.punchOut || day.punchOutIsProvisional));

        res.status(outcome.recorded ? 201 : 200).json({
            recorded: !!outcome.recorded,
            reason: outcome.reason || null,
            action,
            at: tapTime,
            employee: { _id: person._id, name: person.name },
            day: day ? {
                punchIn: day.punchIn || null,
                punchOut: day.punchOut || null,
                lunchInTime: day.lunchInTime || null,
                lunchOutTime: day.lunchOutTime || null,
                sessions: (day.shifts || []).length,
                onDuty: open,
            } : null,
            retryAfterSec,
            message: tapMessage(action, tapTime, day, outcome.recorded ? null : outcome.reason),
        });
    } catch (err) {
        sendError(res, err, 'recordSighting');
    }
};

/**
 * GET /api/lens/activity -- today's face-kiosk taps for this company, newest
 * first, for the kiosk's "recent" list. Read from the taps themselves, so it
 * shows what the server recorded, not what the kiosk assumed.
 */
exports.activity = async (req, res) => {
    try {
        const since = istStartOfDay(new Date());
        const taps = await PunchLog.find({ adminId: oid(req.adminId), source: 'lens', deviceTime: { $gte: since } })
            .sort({ deviceTime: -1 }).limit(50)
            .select('employeeId deviceTime derivedAction discarded discardReason')
            .lean();
        const people = await User.find({ _id: { $in: [...new Set(taps.map((t) => String(t.employeeId)))].map(oid) } }).select('name').lean();
        const names = new Map(people.map((p) => [String(p._id), p.name]));
        res.json(taps.map((t) => ({
            employeeId: t.employeeId,
            name: names.get(String(t.employeeId)) || '',
            at: t.deviceTime,
            action: t.discarded ? null : t.derivedAction,
            repeat: !!t.discarded,
        })));
    } catch (err) {
        sendError(res, err, 'activity');
    }
};

// ── Admin panel ─────────────────────────────────────────────────────────────

/** GET /api/lens/admin/kiosks */
exports.adminListKiosks = async (req, res) => {
    try {
        const kiosks = await LensKiosk.find({ adminId: oid(req.adminId) }).sort({ revokedAt: 1, createdAt: -1 }).lean();
        const people = await User.find({ _id: { $in: kiosks.map((k) => k.createdBy).filter(Boolean) } }).select('name').lean();
        const names = new Map(people.map((p) => [String(p._id), p.name]));
        res.json(kiosks.map((k) => ({
            _id: k._id, name: k.name, createdAt: k.createdAt, lastSeenAt: k.lastSeenAt,
            revokedAt: k.revokedAt, createdBy: names.get(String(k.createdBy)) || null,
        })));
    } catch (err) {
        sendError(res, err, 'adminListKiosks');
    }
};

/** DELETE /api/lens/admin/kiosks/:id -- switch a kiosk off. Its key stops at once. */
exports.adminRevokeKiosk = async (req, res) => {
    try {
        if (!isId(req.params.id)) return res.status(400).json({ message: 'Unknown kiosk.' });
        const k = await LensKiosk.findOneAndUpdate(
            { _id: oid(req.params.id), adminId: oid(req.adminId), revokedAt: null },
            { $set: { revokedAt: new Date() } },
            { new: true },
        ).lean();
        if (!k) return res.status(404).json({ message: 'That kiosk is not found, or is already switched off.' });
        res.json({ ok: true, kiosk: { _id: k._id, name: k.name, revokedAt: k.revokedAt } });
    } catch (err) {
        sendError(res, err, 'adminRevokeKiosk');
    }
};

/** GET /api/lens/admin/faces -- who is registered, when, from which kiosk. */
exports.adminListFaces = async (req, res) => {
    try {
        const faces = await FaceProfile.find({ adminId: oid(req.adminId) })
            .select('employeeId thumbnailUrl createdAt updatedAt kioskId createdBy')
            .sort({ updatedAt: -1 }).lean();
        const [people, kiosks] = await Promise.all([
            User.find({ _id: { $in: faces.map((f) => f.employeeId) } }).select('name status').lean(),
            LensKiosk.find({ _id: { $in: faces.map((f) => f.kioskId).filter(Boolean) } }).select('name').lean(),
        ]);
        const pmap = new Map(people.map((p) => [String(p._id), p]));
        const kmap = new Map(kiosks.map((k) => [String(k._id), k.name]));
        res.json(faces.map((f) => ({
            employeeId: f.employeeId,
            name: pmap.get(String(f.employeeId))?.name || '(removed employee)',
            active: pmap.get(String(f.employeeId))?.status !== 'inactive',
            thumbnailUrl: f.thumbnailUrl || null,
            registeredAt: f.createdAt,
            updatedAt: f.updatedAt,
            kiosk: kmap.get(String(f.kioskId)) || null,
        })));
    } catch (err) {
        sendError(res, err, 'adminListFaces');
    }
};

/** DELETE /api/lens/admin/faces/:employeeId -- remove someone's face. */
exports.adminDeleteFace = async (req, res) => {
    try {
        if (!isId(req.params.employeeId)) return res.status(400).json({ message: 'Unknown employee.' });
        const r = await FaceProfile.deleteOne({ adminId: oid(req.adminId), employeeId: oid(req.params.employeeId) });
        if (!r.deletedCount) return res.status(404).json({ message: 'No face is registered for that employee.' });
        res.json({ ok: true });
    } catch (err) {
        sendError(res, err, 'adminDeleteFace');
    }
};
