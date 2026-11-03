const mongoose = require('mongoose');
const HealthFinding = require('../models/HealthFinding');
const User = require('../models/User');
const { runHealthCheck } = require('../jobs/health_check');

// Super admin → Health: what the hourly health check found in real data.
// Mounted under /api/superadmin, so protect + superAdminOnly already apply.

const SEVERITIES = ['high', 'medium', 'low'];
const STATUSES = ['open', 'resolved', 'all'];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// GET /superadmin/health?status=open&severity=&kind=&adminId=&page=&limit=
// The chip counts are computed under the same filter as the list (all except
// the dimension being counted), so a chip's number is the rows it shows.
exports.getFindings = async (req, res) => {
    try {
        const q = req.query || {};
        const status = STATUSES.includes(q.status) ? q.status : 'open';
        if (q.severity && !SEVERITIES.includes(q.severity)) return res.status(400).json({ message: 'Unknown severity.' });
        if (q.kind && !HealthFinding.KINDS.includes(q.kind)) return res.status(400).json({ message: 'Unknown kind of finding.' });
        if (q.adminId && !OBJECT_ID_RE.test(String(q.adminId))) return res.status(400).json({ message: 'Unknown company.' });
        const page = Math.max(1, parseInt(q.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25));

        const scope = {};
        if (status !== 'all') scope.status = status;
        if (q.adminId) scope.adminId = new mongoose.Types.ObjectId(String(q.adminId));
        const filter = { ...scope };
        if (q.severity) filter.severity = q.severity;
        if (q.kind) filter.kind = q.kind;

        const [rows, total, bySeverity, byKind, last] = await Promise.all([
            HealthFinding.find(filter).sort({ lastSeenAt: -1, _id: -1 }).lean(),
            HealthFinding.countDocuments(filter),
            HealthFinding.aggregate([{ $match: { ...scope, ...(q.kind ? { kind: q.kind } : {}) } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]),
            HealthFinding.aggregate([{ $match: { ...scope, ...(q.severity ? { severity: q.severity } : {}) } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]),
            HealthFinding.findOne({}).sort({ lastSeenAt: -1 }).select('lastSeenAt').lean(),
        ]);

        // Most serious first, then newest. Sorted here rather than in Mongo
        // because severity is a word, not a number.
        rows.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (new Date(b.lastSeenAt) - new Date(a.lastSeenAt)));
        const pageRows = rows.slice((page - 1) * limit, page * limit);

        const ids = [...new Set(pageRows.flatMap((r) => [r.adminId, r.employeeId]).filter(Boolean).map(String))];
        const names = new Map((await User.find({ _id: { $in: ids } }).select('name phone role').lean()).map((u) => [String(u._id), u]));

        res.json({
            findings: pageRows.map((r) => ({
                ...r,
                companyName: r.adminId ? names.get(String(r.adminId))?.name || null : null,
                employeeName: r.employeeId ? names.get(String(r.employeeId))?.name || null : null,
                employeePhone: r.employeeId ? names.get(String(r.employeeId))?.phone || null : null,
            })),
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            currentPage: page,
            limit,
            counts: {
                bySeverity: Object.fromEntries(bySeverity.map((x) => [x._id, x.n])),
                byKind: Object.fromEntries(byKind.map((x) => [x._id, x.n])),
            },
            lastRunAt: last?.lastSeenAt || null,
        });
    } catch (error) {
        console.error('Get health findings error:', error);
        res.status(500).json({ message: 'Could not load the health check. Please try again.' });
    }
};

// PATCH /superadmin/health/:id { status: 'open'|'resolved', note? }
exports.updateFinding = async (req, res) => {
    try {
        const { id } = req.params;
        if (!OBJECT_ID_RE.test(String(id))) return res.status(404).json({ message: 'Finding not found.' });
        const { status, note } = req.body || {};
        if (!['open', 'resolved'].includes(status)) return res.status(400).json({ message: 'Choose open or resolved.' });
        if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) {
            return res.status(400).json({ message: 'The note must be text of at most 500 characters.' });
        }
        const set = status === 'resolved'
            ? { status, resolvedAt: new Date(), resolvedBy: String(req.userId), note: note ? String(note).trim() : null }
            : { status, resolvedAt: null, resolvedBy: null, note: note ? String(note).trim() : null };
        const row = await HealthFinding.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
        if (!row) return res.status(404).json({ message: 'Finding not found.' });
        res.json(row);
    } catch (error) {
        console.error('Update health finding error:', error);
        res.status(500).json({ message: 'Could not update the finding. Please try again.' });
    }
};

// POST /superadmin/health/run { deep?: boolean } — run the check now.
let running = false;
exports.runNow = async (req, res) => {
    if (running) return res.status(409).json({ message: 'A check is already running. Try again in a minute.' });
    running = true;
    try {
        const summary = await runHealthCheck(new Date(), { deep: req.body?.deep !== false });
        res.json({ ok: true, summary });
    } catch (error) {
        console.error('Run health check error:', error);
        res.status(500).json({ message: 'The check could not finish. Please try again.' });
    } finally {
        running = false;
    }
};
