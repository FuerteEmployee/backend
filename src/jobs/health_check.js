const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Department = require('../models/Department');
require('../models/Branch'); // registered for the populate below, even when run outside the server
const Settings = require('../models/Settings');
const Tracking = require('../models/Tracking');
const TrackerEvent = require('../models/TrackerEvent');
const ClientError = require('../models/ClientError');
const ClientDevice = require('../models/ClientDevice');
const GeofenceAudit = require('../models/GeofenceAudit');
const OtaCheckin = require('../models/OtaCheckin');
const ApkRelease = require('../models/ApkRelease');
const Regularization = require('../models/Regularization');
const AlertRule = require('../models/AlertRule');
const HealthFinding = require('../models/HealthFinding');
const { calculateDistance, isTrustworthyFix } = require('../utils/distance');
const { MAX_PLAUSIBLE_SPEED_MPS } = require('../utils/geofence_window');
const { istDateKey, istStartOfDay } = require('../utils/attendance_helpers');
const { isFrozenTenant } = require('../utils/frozen_tenants');

// The health check: looks through recent real data for the patterns behind
// every bug real phones found on staging, so they reach the super admin's
// Health page before a user has to report them.
//
// It READS business data and writes only HealthFinding rows. It never changes
// attendance, pay, tracking or settings -- a finding is a pointer for a person.
//
// Wired three ways, like every scheduled job (CLAUDE.md "Scheduled work"):
// jobs/scheduler.js (hourly at :45), GET/POST /api/cron/health-check, and
// vercel.json. The tracking scans (gaps, GPS jumps) read a day of location
// points, so they run once a day (DEEP_HOUR IST) or when asked for.

const ALERT_SLUG = 'health_check';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const LOOKBACK_DAYS = parseInt(process.env.HEALTH_LOOKBACK_DAYS || '31', 10);
const SILENT_MINUTES = parseInt(process.env.HEALTH_SILENT_MINUTES || '30', 10);
const GAP_MINUTES = parseInt(process.env.HEALTH_GAP_MINUTES || '15', 10);
const GAPS_TO_FLAG = parseInt(process.env.HEALTH_GAPS_TO_FLAG || '3', 10);
const JUMPS_TO_FLAG = parseInt(process.env.HEALTH_JUMPS_TO_FLAG || '5', 10);
const ERRORS_TO_FLAG = parseInt(process.env.HEALTH_ERRORS_TO_FLAG || '5', 10);
const AFTER_EXIT_MINUTES = parseInt(process.env.HEALTH_AFTER_EXIT_MINUTES || '20', 10);
const STALE_CORRECTION_DAYS = parseInt(process.env.HEALTH_STALE_CORRECTION_DAYS || '7', 10);
const DEEP_HOUR = parseInt(process.env.HEALTH_DEEP_HOUR_IST || '7', 10);

// Kinds that describe a CURRENT state. When the check no longer sees one, the
// state has gone away and the finding closes itself. The other kinds record
// something that happened (a punch-out, a burst of errors) and stay open until
// a person has looked.
const STATE_KINDS = new Set([
    'tracker_silent_on_duty', 'duplicate_day', 'open_day_past', 'needs_review_day', 'bad_day_shape',
    'stale_device_report', 'tracking_blockers', 'old_apk', 'stale_corrections',
    'location_check_blocked',
]);
// Kinds produced only by the daily deep pass; an hourly run must not close them.
const DEEP_KINDS = new Set(['tracking_gaps', 'gps_jumps']);

// Refusals the app shows on purpose ("Wait at least 60s…", "Already punched
// out today"). The employee needed to see them; they are not faults.
const EXPECTED_REFUSAL = /wait at least|already|choose an|not allowed|too far|outside the|accuracy|location is|is refused|please wait|no attendance record|cannot be|must be|not punched in|not registered|tell your admin/i;

const ist = (d) => new Date(new Date(d).getTime() + 5.5 * HOUR).toISOString().slice(11, 16);

// ── Pure helpers (unit-tested in test/attendance_review.test.js) ─────────────

/**
 * After an auto punch-out, where was the phone? Mostly INSIDE the fence in the
 * following minutes means the closure was probably wrong (2026-10-01: a desk
 * worker's phone jumped 0.8–9 km and back while he never moved).
 */
function insideAfterExit({ fixes, branch, radiusM }) {
    const r = radiusM > 0 ? radiusM : branch?.radius || 100;
    const trusted = (fixes || []).filter((f) => isTrustworthyFix(f.accuracy) && f.latitude != null);
    const inside = trusted.filter((f) => calculateDistance(f.latitude, f.longitude, branch.latitude, branch.longitude) <= r).length;
    return { trusted: trusted.length, inside, share: trusted.length ? inside / trusted.length : 0 };
}

const looksLikeWrongExit = (s) => s.trusted >= 3 && s.share >= 0.6;

/** Gaps longer than `minGapMs` between consecutive timestamps, optionally only those inside `intervals`. */
function findGaps(timestamps, minGapMs, intervals = null) {
    const ts = [...timestamps].map((t) => new Date(t).getTime()).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) {
        const gap = ts[i] - ts[i - 1];
        if (gap <= minGapMs) continue;
        const mid = ts[i - 1] + gap / 2;
        if (intervals && !intervals.some(([a, b]) => mid >= a && mid <= b)) continue;
        gaps.push({ from: new Date(ts[i - 1]), minutes: Math.round(gap / MIN) });
    }
    return gaps;
}

/** Consecutive fix pairs that imply faster-than-possible movement (a GPS jump). */
function countJumps(fixes, maxSpeedMps = MAX_PLAUSIBLE_SPEED_MPS) {
    const fs = (fixes || []).filter((f) => f.latitude != null).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let n = 0;
    for (let i = 1; i < fs.length; i++) {
        const dt = Math.max(1, (new Date(fs[i].timestamp) - new Date(fs[i - 1].timestamp)) / 1000);
        if (calculateDistance(fs[i - 1].latitude, fs[i - 1].longitude, fs[i].latitude, fs[i].longitude) / dt > maxSpeedMps) n++;
    }
    return n;
}

/** An app error worth a person's attention, rather than a refusal shown on purpose. */
function isRealError(e) {
    if ([401, 403].includes(Number(e.statusCode))) return false;
    return !EXPECTED_REFUSAL.test(String(e.message || ''));
}

/** Error text with numbers removed, so "punched in 11s ago" and "…15s ago" group together. */
const errorKey = (msg) => String(msg || '').replace(/\d+/g, '#').trim().slice(0, 160);

// ── The job ──────────────────────────────────────────────────────────────────

async function runHealthCheck(now = new Date(), { dryRun = false, deep } = {}) {
    const istHour = new Date(now.getTime() + 5.5 * HOUR).getUTCHours();
    const runDeep = deep === undefined ? istHour === DEEP_HOUR : !!deep;
    const summary = { found: 0, created: 0, updated: 0, autoResolved: 0, errors: 0, deep: runDeep, byKind: {} };
    const found = [];
    const seen = new Set();

    try {
        // The row is created on first run so the switch appears in Super admin
        // → Alerts without running a seed script. A dry run writes nothing.
        const rule = dryRun
            ? await AlertRule.findOne({ slug: ALERT_SLUG }).lean()
            : await AlertRule.findOneAndUpdate(
                { slug: ALERT_SLUG },
                { $setOnInsert: { slug: ALERT_SLUG, name: 'Health check', description: 'Hourly scan of real data for wrong auto punch-outs, silent trackers, duplicate days and other problems. Results on Super admin → Health.', isEnabled: true } },
                { upsert: true, new: true },
            ).lean();
        if (rule && rule.isEnabled === false) {
            console.log('[health] switched off in Super admin → Alerts; skipped');
            return { ...summary, skipped: true };
        }
    } catch (err) {
        console.error('[health] could not read alert rule:', err.message);
    }

    const add = (f) => {
        found.push(f);
        summary.byKind[f.kind] = (summary.byKind[f.kind] || 0) + 1;
    };
    const run = async (name, fn) => {
        try { await fn(); } catch (err) { summary.errors++; console.error(`[health] ${name} failed:`, err.message); }
    };

    const since48h = new Date(now.getTime() - 48 * HOUR);
    const since24h = new Date(now.getTime() - 24 * HOUR);
    const lookback = new Date(now.getTime() - LOOKBACK_DAYS * 24 * HOUR);
    const todayStart = istStartOfDay(now);
    const yesterdayStart = new Date(todayStart.getTime() - 24 * HOUR);

    // Who is tracked: their own switch or their department's.
    const trackedDepts = new Set((await Department.find({ trackingEnabled: true }).select('_id').lean()).map((d) => String(d._id)));
    const employees = await User.find({ role: 'employee', status: 'active' })
        .select('name adminId trackingEnabled departmentId branchId').populate('branchId', 'branchName latitude longitude radius').lean();
    const empById = new Map(employees.map((e) => [String(e._id), e]));
    const isTracked = (e) => e && (e.trackingEnabled === true || trackedDepts.has(String(e.departmentId)));
    const alwaysTenants = new Set((await Settings.find({ 'attendance.trackingMode': 'always' }).select('adminId').lean()).map((s) => String(s.adminId)));
    // Names for everyone, including people since switched off: a duplicate
    // day from August may belong to someone no longer active.
    const allNames = new Map((await User.find({ role: { $in: ['employee', 'subadmin'] } }).select('name').lean()).map((u) => [String(u._id), u.name]));
    const nameOf = (id) => (allNames.get(String(id)) || 'Employee').trim();

    // 1. Auto punch-outs the phone contradicts afterwards.
    await run('suspect_auto_punchout', async () => {
        const audits = await GeofenceAudit.find({ decision: 'punched_out', shadow: { $ne: true }, createdAt: { $gte: since48h } }).lean();
        for (const a of audits) {
            const emp = empById.get(String(a.employeeId));
            const branch = emp?.branchId;
            if (!branch?.latitude) continue;
            const from = new Date(a.closedAt || a.createdAt);
            const fixes = await Tracking.find({ employeeId: a.employeeId, timestamp: { $gt: from, $lte: new Date(from.getTime() + AFTER_EXIT_MINUTES * MIN) } })
                .select('latitude longitude accuracy timestamp').lean();
            const s = insideAfterExit({ fixes, branch, radiusM: a.radiusM });
            if (!looksLikeWrongExit(s)) continue;
            const att = a.attendanceId ? await Attendance.findById(a.attendanceId).select('autoPunchOut shifts').lean() : null;
            const undone = att && att.autoPunchOut === false && !(att.shifts || []).some((x) => x.closeReason === 'auto_geofence');
            add({
                kind: 'suspect_auto_punchout', severity: 'high', adminId: a.adminId, employeeId: a.employeeId, dayKey: a.dayKey,
                ref: String(a._id),
                title: `${nameOf(a.employeeId)} was punched out automatically at ${ist(from)}, but the phone stayed in the office`,
                detail: `${s.inside} of the ${s.trusted} accurate readings in the ${AFTER_EXIT_MINUTES} minutes after the punch-out were inside ${branch.branchName || 'the branch'}. ` +
                    `The engine measured ${a.distanceM} m. Check the day and undo it if they never left.`,
                evidence: { auditId: a._id, attendanceId: a.attendanceId, distanceM: a.distanceM, insideAfter: s.inside, trustedAfter: s.trusted, closedAt: from },
                ...(undone ? { resolve: 'The auto punch-out has already been undone.' } : {}),
            });
        }
    });

    // 2. Punched in, tracked, and the phone has gone quiet.
    await run('tracker_silent_on_duty', async () => {
        const open = await Attendance.find({ date: { $gte: yesterdayStart }, punchIn: { $ne: null }, $or: [{ punchOut: null }, { 'shifts.punchOut': null }] })
            .select('adminId employeeId punchIn punchOut shifts dayKey date').lean();
        for (const a of open) {
            const emp = empById.get(String(a.employeeId));
            if (!isTracked(emp)) continue;
            const openSession = (a.shifts || []).find((s) => s.punchIn && !s.punchOut);
            // A row without sessions matches the query by having no shifts at all;
            // it is only open if its own punch-out is missing.
            if (!openSession && a.punchOut) continue;
            const since = new Date(openSession?.punchIn || a.punchIn);
            if (now - since < SILENT_MINUTES * MIN) continue;
            const last = await Tracking.findOne({ employeeId: a.employeeId, timestamp: { $gte: since } }).sort({ timestamp: -1 }).select('timestamp').lean();
            const quietMin = Math.round((now - new Date(last?.timestamp || since)) / MIN);
            if (quietMin < SILENT_MINUTES) continue;
            add({
                kind: 'tracker_silent_on_duty', severity: last ? 'high' : 'medium', adminId: a.adminId, employeeId: a.employeeId,
                dayKey: a.dayKey || istDateKey(a.date), ref: 'open',
                title: last
                    ? `${nameOf(a.employeeId)} is punched in but the phone stopped sending location ${quietMin} min ago`
                    : `${nameOf(a.employeeId)} punched in at ${ist(since)} but no location has arrived since`,
                detail: last
                    ? 'The tracker was working and then stopped: usually battery saver, auto-start off, or the app was force-stopped. If the phone is only offline, the saved points arrive when it reconnects and this clears by itself.'
                    : 'Tracking never started on this phone: no permission, an old app, or an iPhone (which cannot track in the background).',
                evidence: { since, lastPointAt: last?.timestamp || null, quietMinutes: quietMin },
            });
        }
    });

    // 3. More than one attendance row for one person-day.
    await run('duplicate_day', async () => {
        const dupes = await Attendance.aggregate([
            { $match: { date: { $gte: new Date(now.getTime() - 365 * 24 * HOUR) }, employeeId: { $ne: null } } },
            { $group: { _id: { a: '$adminId', e: '$employeeId', d: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: '+05:30' } } }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
            { $match: { n: { $gt: 1 } } },
        ]);
        for (const d of dupes) {
            add({
                kind: 'duplicate_day', severity: 'high', adminId: d._id.a, employeeId: d._id.e, dayKey: d._id.d, ref: 'dup',
                title: `${nameOf(d._id.e)} has ${d.n} attendance records for ${d._id.d}`,
                detail: 'Two records for one day double-count in lists and can be paid twice. A person must decide which punches were real and merge them.',
                evidence: { attendanceIds: d.ids },
            });
        }
    });

    // 4–6. Days that cannot be graded or paid as they stand. One finding per
    // company and problem, listing the days, rather than one per day: a restore
    // of old data can hold dozens of the same legacy shape, and a page of 80
    // near-identical rows hides the one new problem among them.
    const dayGroup = async (code, kind, q, words, advice) => {
        const rows = await Attendance.find(q).select('adminId employeeId date dayKey punchIn').sort({ date: 1 }).limit(2000).lean();
        const byTenant = new Map();
        for (const r of rows) {
            const k = String(r.adminId);
            if (!byTenant.has(k)) byTenant.set(k, []);
            byTenant.get(k).push({ name: nameOf(r.employeeId), employeeId: r.employeeId, day: r.dayKey || istDateKey(r.date), attendanceId: r._id });
        }
        for (const [adminId, list] of byTenant) {
            const first = list[0].day, last = list[list.length - 1].day;
            add({
                kind, severity: 'medium', adminId, employeeId: list.length === 1 ? list[0].employeeId : null, dayKey: null, ref: code,
                title: list.length === 1
                    ? `${list[0].name}'s day ${first} ${words.one}`
                    : `${list.length} days ${words.many} (${first === last ? first : `${first} to ${last}`})`,
                detail: `${advice} ${list.slice(0, 6).map((x) => `${x.name} ${x.day}`).join('; ')}${list.length > 6 ? `; and ${list.length - 6} more` : ''}.`,
                evidence: { count: list.length, days: list.slice(0, 100) },
            });
        }
    };

    await run('open_day_past', () => dayGroup('open', 'open_day_past',
        { date: { $gte: lookback, $lt: yesterdayStart }, punchIn: { $ne: null }, punchOut: null },
        { one: 'was never punched out', many: 'were never punched out' },
        'The overnight close did not close these, so they cannot be graded or paid. Edit the punch-out on the Attendance page:'));

    await run('needs_review_day', () => dayGroup('review', 'needs_review_day',
        { date: { $gte: lookback }, status: 'needs_review' },
        { one: 'needs a person to grade it', many: 'need a person to grade them' },
        'Payroll refuses the month until these are resolved:'));

    await run('bad_day_shape', async () => {
        const base = { date: { $gte: lookback } };
        const advice = 'Correct them on the Attendance page; pay for these days is unreliable until then:';
        await dayGroup('out_before_in', 'bad_day_shape', { ...base, punchIn: { $ne: null }, punchOut: { $ne: null }, $expr: { $lt: ['$punchOut', '$punchIn'] } },
            { one: 'has a punch-out earlier than the punch-in', many: 'have a punch-out earlier than the punch-in' }, advice);
        await dayGroup('absent_with_punch', 'bad_day_shape', { ...base, status: 'absent', punchIn: { $ne: null } },
            { one: 'is marked absent although they punched in', many: 'are marked absent although the person punched in' }, advice);
        await dayGroup('future_punch', 'bad_day_shape', { punchIn: { $gt: new Date(now.getTime() + HOUR) } },
            { one: 'has a punch-in in the future', many: 'have a punch-in in the future' }, advice);
        await dayGroup('closed_zero_hours', 'bad_day_shape', { ...base, punchIn: { $ne: null }, punchOut: { $ne: null }, $or: [{ totalWorkMs: null }, { totalWorkMs: 0 }, { totalWorkMs: { $exists: false } }] },
            { one: 'has both punches but no worked time', many: 'have both punches but no worked time' }, advice);
    });

    // 7. Tracker failures the employee cannot see.
    await run('tracker_failures', async () => {
        const rows = await TrackerEvent.aggregate([
            { $match: { at: { $gte: since24h }, type: { $in: ['start_failed', 'fg_denied', 'permission_lost'] } } },
            { $group: { _id: { a: '$adminId', e: '$employeeId' }, n: { $sum: 1 }, types: { $addToSet: '$type' }, last: { $max: '$at' }, app: { $last: '$appVersion' } } },
        ]);
        for (const r of rows) {
            add({
                kind: 'tracker_failures', severity: 'medium', adminId: r._id.a, employeeId: r._id.e, dayKey: istDateKey(r.last), ref: 'tf',
                title: `${nameOf(r._id.e)}'s phone reported ${r.n} tracker failure(s): ${r.types.join(', ')}`,
                detail: `Last at ${ist(r.last)} on app ${r.app || 'unknown'}. Check the phone's location permission, battery setting and auto-start.`,
                evidence: { count: r.n, types: r.types, lastAt: r.last, appVersion: r.app },
            });
        }
    });

    // 8. The same real error, again and again.
    await run('repeated_app_error', async () => {
        const errs = await ClientError.find({ createdAt: { $gte: since24h } }).select('adminId employeeId message statusCode appVersion createdAt').lean();
        const groups = new Map();
        for (const e of errs) {
            if (!isRealError(e)) continue;
            const k = `${e.adminId}|${errorKey(e.message)}`;
            const g = groups.get(k) || { adminId: e.adminId, message: e.message, n: 0, people: new Set(), last: e.createdAt, versions: new Set() };
            g.n++; g.people.add(String(e.employeeId)); g.versions.add(e.appVersion || 'web');
            if (e.createdAt > g.last) g.last = e.createdAt;
            groups.set(k, g);
        }
        for (const [k, g] of groups) {
            if (g.n < ERRORS_TO_FLAG) continue;
            add({
                kind: 'repeated_app_error', severity: 'medium', adminId: g.adminId, employeeId: null, dayKey: istDateKey(g.last), ref: k.split('|')[1],
                title: `"${String(g.message).slice(0, 120)}" shown ${g.n} times to ${g.people.size} person(s) today`,
                detail: `App versions: ${[...g.versions].join(', ')}. Last at ${ist(g.last)}.`,
                evidence: { count: g.n, people: g.people.size, versions: [...g.versions], lastAt: g.last },
            });
        }
    });

    // 9. A phone that is in use but whose device report stopped updating.
    await run('stale_device_report', async () => {
        const active = await Tracking.aggregate([
            { $match: { timestamp: { $gte: since24h } } },
            { $group: { _id: '$employeeId', a: { $first: '$adminId' }, n: { $sum: 1 } } },
        ]);
        for (const r of active) {
            const dev = await ClientDevice.findOne({ employeeId: r._id, isNative: true }).sort({ lastSeenAt: -1 }).select('lastSeenAt appVersion').lean();
            if (!dev || now - new Date(dev.lastSeenAt) < 24 * HOUR) continue;
            add({
                kind: 'stale_device_report', severity: 'low', adminId: r.a, employeeId: r._id, dayKey: null, ref: 'dev',
                title: `${nameOf(r._id)}'s phone is working but its device report is ${Math.round((now - new Date(dev.lastSeenAt)) / (24 * HOUR))} day(s) old`,
                detail: `${r.n} location points arrived in the last day, but the app version and permissions on the Employees page are from ${istDateKey(dev.lastSeenAt)} (app ${dev.appVersion || '?'}). Ask them to open the app once.`,
                evidence: { lastReportAt: dev.lastSeenAt, pointsLast24h: r.n, appVersion: dev.appVersion },
            });
        }
    });

    // 10. Tracked people whose phone reports a setting that stops tracking.
    await run('tracking_blockers', async () => {
        const fresh = new Date(now.getTime() - 3 * 24 * HOUR);
        const devs = await ClientDevice.find({ isNative: true, lastSeenAt: { $gte: fresh } }).select('adminId employeeId permissions lastSeenAt').sort({ lastSeenAt: -1 }).lean();
        const done = new Set();
        for (const d of devs) {
            const k = String(d.employeeId);
            if (done.has(k)) continue; // newest install per person only
            done.add(k);
            if (!isTracked(empById.get(k))) continue;
            const p = d.permissions || {};
            const blocked = [p.backgroundLocation === 'denied' && 'background location', p.batteryUnrestricted === 'denied' && 'battery "No restrictions"'].filter(Boolean);
            if (!blocked.length) continue;
            add({
                kind: 'tracking_blockers', severity: 'low', adminId: d.adminId, employeeId: d.employeeId, dayKey: null, ref: 'perm',
                title: `${nameOf(d.employeeId)}'s phone has ${blocked.join(' and ')} not allowed`,
                detail: `As reported at ${istDateKey(d.lastSeenAt)} ${ist(d.lastSeenAt)}. Tracking may stop when the screen is off until this is allowed.`,
                evidence: { permissions: p, reportedAt: d.lastSeenAt },
            });
        }
    });

    // 11. Phones still on an APK older than the newest mandatory one.
    await run('old_apk', async () => {
        const newest = await ApkRelease.findOne({ enabled: true, mandatory: true, channel: 'production' }).sort({ versionCode: -1 }).select('versionCode versionName').lean();
        if (!newest) return;
        const phones = await OtaCheckin.find({ lastSeenAt: { $gte: new Date(now.getTime() - 7 * 24 * HOUR) }, isEmulator: { $ne: true } }).lean();
        for (const ph of phones) {
            const code = Number(ph.apkCode);
            if (!Number.isFinite(code) || code >= newest.versionCode) continue;
            add({
                kind: 'old_apk', severity: 'low', adminId: ph.adminId || null, employeeId: null, dayKey: null, ref: String(ph.deviceId).slice(0, 12),
                title: `A phone is still on app ${ph.apkVersion || code} (${code}); the required version is ${newest.versionName} (${newest.versionCode})`,
                detail: `Last checked for updates at ${istDateKey(ph.lastSeenAt)} ${ist(ph.lastSeenAt)} (Android ${ph.osVersion || '?'}). It will be asked to update when the app is next opened.`,
                evidence: { deviceId: String(ph.deviceId).slice(0, 8), apkCode: code, required: newest.versionCode },
            });
        }
    });

    // 12. Corrections nobody has decided.
    await run('stale_corrections', async () => {
        const cutoff = new Date(now.getTime() - STALE_CORRECTION_DAYS * 24 * HOUR);
        const rows = await Regularization.aggregate([
            { $match: { status: 'pending', createdAt: { $lt: cutoff } } },
            { $group: { _id: '$adminId', n: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
        ]);
        for (const r of rows) {
            add({
                kind: 'stale_corrections', severity: 'low', adminId: r._id, employeeId: null, dayKey: null, ref: 'regs',
                title: `${r.n} attendance correction(s) waiting more than ${STALE_CORRECTION_DAYS} days`,
                detail: `The oldest was sent on ${istDateKey(r.oldest)}. Until they are decided, those days are paid on the original punches.`,
                evidence: { count: r.n, oldest: r.oldest },
            });
        }
    });

    // 15. Location required, but there is nothing to check it against.
    //     No branch at all: the app refuses every punch-in. Every branch with
    //     its location check switched off: this release lets them punch
    //     unchecked, but the previous release (app 1.2, still in use at some
    //     companies) refuses punch-in, lunch AND punch-out ("G-BRANCH"), so the
    //     person cannot even close their day. Found live on 10 Oct.
    await run('location_check_blocked', async () => {
        const settings = await Settings.find({}).select('adminId attendance.requireLocation').lean();
        const companyRequires = new Map(settings.map((s) => [String(s.adminId), s.attendance?.requireLocation === true]));
        const people = await User.find({ role: 'employee', status: 'active' })
            .select('name adminId branchId branchIds attendanceExceptions')
            .populate('branchId', 'geoFenceEnabled').populate('branchIds', 'geoFenceEnabled').lean();
        const byCompany = new Map();
        for (const p of people) {
            const x = p.attendanceExceptions || {};
            const requires = x.overrideGlobal ? x.requireLocation === true : companyRequires.get(String(p.adminId)) === true;
            if (!requires) continue;
            const assigned = [p.branchId, ...(p.branchIds || [])].filter(Boolean);
            const kind = assigned.length === 0 ? 'none' : (assigned.every((b) => b.geoFenceEnabled === false) ? 'off' : null);
            if (!kind) continue;
            const k = String(p.adminId);
            if (!byCompany.has(k)) byCompany.set(k, { none: [], off: [] });
            byCompany.get(k)[kind].push(p.name ? p.name.trim() : 'Employee');
        }
        for (const [adminId, g] of byCompany) {
            const list = (names) => names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '');
            if (g.none.length) {
                add({
                    kind: 'location_check_blocked', severity: 'high', adminId, employeeId: null, dayKey: null, ref: 'no-branch',
                    title: `${g.none.length} employee(s) must give a location but have no branch, so they cannot punch in`,
                    detail: `${list(g.none)}. Give them a branch, or turn off "Require location" (company Settings → Geofencing, or the employee's own Attendance Exceptions).`,
                    evidence: { names: g.none },
                });
            }
            if (g.off.length) {
                add({
                    kind: 'location_check_blocked', severity: 'medium', adminId, employeeId: null, dayKey: null, ref: 'fence-off',
                    title: `${g.off.length} employee(s) must give a location but every branch they belong to has location checking off`,
                    detail: `${list(g.off)}. The current app lets them punch without a check; on the old app (1.2) every punch-in, lunch and punch-out is refused. Turn off "Require location", or switch the branch check back on with the branch's real location.`,
                    evidence: { names: g.off },
                });
            }
        }
    });

    // 13–14. Daily deep pass over a day of location points.
    if (runDeep) {
        await run('tracking_scan', async () => {
            const ids = await Tracking.distinct('employeeId', { timestamp: { $gte: since24h } });
            for (const id of ids) {
                const emp = empById.get(String(id));
                if (!emp) continue;
                const pts = await Tracking.find({ employeeId: id, timestamp: { $gte: since24h } }).select('latitude longitude accuracy timestamp').sort({ timestamp: 1 }).lean();
                if (pts.length < 10) continue;

                // Gaps only count while the person was meant to be tracked.
                let intervals = null;
                if (!alwaysTenants.has(String(emp.adminId))) {
                    const days = await Attendance.find({ employeeId: id, date: { $gte: new Date(yesterdayStart.getTime() - 24 * HOUR) } }).select('punchIn punchOut shifts').lean();
                    intervals = [];
                    for (const d of days) {
                        const sessions = d.shifts?.length ? d.shifts : [{ punchIn: d.punchIn, punchOut: d.punchOut }];
                        for (const s of sessions) if (s.punchIn) intervals.push([new Date(s.punchIn).getTime(), new Date(s.punchOut || now).getTime()]);
                    }
                }
                const gaps = findGaps(pts.map((p) => p.timestamp), GAP_MINUTES * MIN, intervals);
                if (isTracked(emp) && gaps.length >= GAPS_TO_FLAG) {
                    add({
                        kind: 'tracking_gaps', severity: 'medium', adminId: emp.adminId, employeeId: id, dayKey: istDateKey(now), ref: 'gaps',
                        title: `${nameOf(id)}'s phone had ${gaps.length} tracking gaps over ${GAP_MINUTES} min in the last day (longest ${Math.max(...gaps.map((g) => g.minutes))} min)`,
                        detail: `First gaps: ${gaps.slice(0, 5).map((g) => `${ist(g.from)} +${g.minutes}m`).join(', ')}. Usually the phone putting the app to sleep: set battery to "No restrictions" and turn auto-start on.`,
                        evidence: { gaps: gaps.slice(0, 20), count: gaps.length },
                    });
                }
                const jumps = countJumps(pts.filter((p) => isTrustworthyFix(p.accuracy)));
                if (jumps >= JUMPS_TO_FLAG) {
                    add({
                        kind: 'gps_jumps', severity: 'low', adminId: emp.adminId, employeeId: id, dayKey: istDateKey(now), ref: 'jumps',
                        title: `${nameOf(id)}'s phone reported ${jumps} impossible location jumps in the last day`,
                        detail: 'Readings that claim to be accurate but move faster than anyone can travel. Auto punch-out now ignores these, but the route map for this phone is unreliable.',
                        evidence: { jumps, points: pts.length },
                    });
                }
            }
        });
    }

    // Companies kept on the previous release are not this release's to report on.
    for (let i = found.length - 1; i >= 0; i--) {
        if (isFrozenTenant(found[i].adminId)) found.splice(i, 1);
    }

    summary.found = found.length;
    if (dryRun) return { ...summary, findings: found };

    // ── Store: upsert by fingerprint, then close what has gone away ─────────
    for (const f of found) {
        const fingerprint = [f.kind, f.adminId || '-', f.employeeId || '-', f.dayKey || '-', f.ref || '-'].join('|');
        seen.add(fingerprint);
        try {
            const existing = await HealthFinding.findOne({ fingerprint }).select('status resolvedBy').lean();
            const base = { adminId: f.adminId || null, employeeId: f.employeeId || null, kind: f.kind, severity: f.severity, dayKey: f.dayKey || null, title: f.title, detail: f.detail, evidence: f.evidence, lastSeenAt: now };
            if (!existing) {
                await HealthFinding.create({
                    ...base, fingerprint, firstSeenAt: now,
                    ...(f.resolve ? { status: 'resolved', resolvedAt: now, resolvedBy: 'auto', note: f.resolve } : {}),
                });
                summary.created++;
            } else {
                const set = { ...base };
                // A person's "resolved" stands; the check only re-opens what IT closed.
                if (f.resolve && existing.status === 'open') Object.assign(set, { status: 'resolved', resolvedAt: now, resolvedBy: 'auto', note: f.resolve });
                else if (!f.resolve && existing.status === 'resolved' && existing.resolvedBy === 'auto') Object.assign(set, { status: 'open', resolvedAt: null, resolvedBy: null, note: null });
                await HealthFinding.updateOne({ fingerprint }, { $set: set, $inc: { occurrences: 1 } });
                summary.updated++;
            }
        } catch (err) {
            summary.errors++;
            console.error('[health] could not store a finding:', err.message);
        }
    }

    try {
        const closable = [...STATE_KINDS, ...(runDeep ? DEEP_KINDS : [])];
        const stale = await HealthFinding.find({ status: 'open', kind: { $in: closable } }).select('fingerprint').lean();
        const gone = stale.filter((s) => !seen.has(s.fingerprint)).map((s) => s.fingerprint);
        if (gone.length) {
            const r = await HealthFinding.updateMany({ fingerprint: { $in: gone } }, { $set: { status: 'resolved', resolvedAt: now, resolvedBy: 'auto', note: 'Cleared by itself: the check no longer sees this.' } });
            summary.autoResolved = r.modifiedCount || 0;
        }
    } catch (err) {
        summary.errors++;
        console.error('[health] could not close cleared findings:', err.message);
    }

    console.log(`[health] found=${summary.found} new=${summary.created} updated=${summary.updated} cleared=${summary.autoResolved} deep=${runDeep} errors=${summary.errors}`);
    return summary;
}

module.exports = {
    runHealthCheck,
    insideAfterExit,
    looksLikeWrongExit,
    findGaps,
    countJumps,
    isRealError,
    errorKey,
    ALERT_SLUG,
    STATE_KINDS,
};
