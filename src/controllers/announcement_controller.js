const Announcement = require('../models/Announcement');
const AnnouncementResponse = require('../models/AnnouncementResponse');
const User = require('../models/User');
const mongoose = require('mongoose');
const { serialisePerTenant } = require('../utils/employee_lock');

const roleOf = (req) => req.currentUser?.role || req.user?.role;

// Employees read the notice board; only HR/admin write to it.
//
// The routes' checkPermission() restricts SUB-ADMINS only -- every other role,
// employees included, passes straight through it -- so without this check an
// employee's token could post, rewrite, pin or delete company-wide notices
// (signed "HR Team" or anything else) with a plain API call. The role is read
// from the database record before the JWT, so a promotion takes effect at once.
function refuseEmployee(req, res) {
    if (roleOf(req) !== 'employee') return false;
    res.status(403).json({ message: 'Only HR or an admin can change announcements.' });
    return true;
}

const TYPES = ['general', 'urgent', 'event', 'policy'];
const TITLE_MAX = 150;
const CONTENT_MAX = 5000;
const QUESTION_KINDS = ['none', 'yes_no', 'single', 'multiple', 'number'];
const CHOICE_KINDS = ['yes_no', 'single', 'multiple'];
const AUDIENCE_MODES = ['all', 'branches', 'departments', 'shifts', 'employees'];
const OPTIONS_MAX = 20;
const OPTION_LEN = 100;
const PROMPT_MAX = 300;
const UNIT_MAX = 20;
const NUMBER_LIMIT = 1000000;
const AUDIENCE_MAX = 2000;
// A popup stops appearing on its own once the notice is this old, unless its
// question is still open. A new joiner should not be greeted by a month of
// old popups.
const POPUP_DAYS = 30;

const has = (src, k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;

// The question part of a notice, always returned whole so an edit replaces it
// cleanly.
function readQuestion(q) {
    const none = { kind: 'none', prompt: '', options: [], min: null, max: null, unit: '', allowChange: true };
    if (q === null || q === undefined) return { data: none };
    if (typeof q !== 'object' || Array.isArray(q)) return { error: 'The question is not in the right form.' };
    const kind = q.kind === undefined || q.kind === '' ? 'none' : q.kind;
    if (!QUESTION_KINDS.includes(kind)) return { error: 'Please choose what to ask: nothing, yes/no, pick one, pick several or a number.' };
    if (kind === 'none') return { data: none };

    const out = { ...none, kind };
    if (q.prompt !== undefined && q.prompt !== null) {
        if (typeof q.prompt !== 'string') return { error: 'The question must be text.' };
        const prompt = q.prompt.trim();
        if (prompt.length > PROMPT_MAX) return { error: `The question is too long. Please keep it under ${PROMPT_MAX} letters.` };
        out.prompt = prompt;
    }
    if (q.allowChange !== undefined) {
        if (typeof q.allowChange !== 'boolean') return { error: '"Can change answer" must be yes or no.' };
        out.allowChange = q.allowChange;
    }
    if (kind === 'yes_no') out.options = ['Yes', 'No'];
    if (kind === 'single' || kind === 'multiple') {
        if (!Array.isArray(q.options)) return { error: 'Please add the choices people can pick from.' };
        if (q.options.some((o) => typeof o !== 'string')) return { error: 'Each choice must be text.' };
        const options = q.options.map((o) => o.trim()).filter(Boolean);
        if (options.length < 2) return { error: 'Please add at least two choices.' };
        if (options.length > OPTIONS_MAX) return { error: `Please keep it to ${OPTIONS_MAX} choices or fewer.` };
        const long = options.find((o) => o.length > OPTION_LEN);
        if (long) return { error: `The choice "${long.slice(0, 30)}..." is too long. Please keep each under ${OPTION_LEN} letters.` };
        const seen = new Set();
        for (const o of options) {
            const key = o.toLowerCase();
            if (seen.has(key)) return { error: `The choice "${o}" is listed twice.` };
            seen.add(key);
        }
        out.options = options;
    }
    if (kind === 'number') {
        const whole = (v) => (v === undefined || v === null || v === '' ? null
            : (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= NUMBER_LIMIT ? v : NaN));
        const min = whole(q.min);
        const max = whole(q.max);
        if (Number.isNaN(min) || Number.isNaN(max)) return { error: `The lowest and highest numbers must be whole numbers up to ${NUMBER_LIMIT}.` };
        out.min = min === null ? 0 : min;
        out.max = max;
        if (out.max !== null && out.min > out.max) return { error: 'The lowest number cannot be more than the highest.' };
        if (q.unit !== undefined && q.unit !== null) {
            if (typeof q.unit !== 'string') return { error: 'The unit must be text, e.g. "passes".' };
            const unit = q.unit.trim();
            if (unit.length > UNIT_MAX) return { error: `The unit is too long. Please keep it under ${UNIT_MAX} letters.` };
            out.unit = unit;
        }
    }
    return { data: out };
}

function readAudience(a) {
    if (a === null || a === undefined) return { data: { mode: 'all', ids: [] } };
    if (typeof a !== 'object' || Array.isArray(a)) return { error: 'The audience is not in the right form.' };
    const mode = a.mode === undefined || a.mode === '' ? 'all' : a.mode;
    if (!AUDIENCE_MODES.includes(mode)) return { error: 'Please choose who sees it: everyone, branches, departments, shifts or chosen employees.' };
    if (mode === 'all') return { data: { mode, ids: [] } };
    const raw = Array.isArray(a.ids) ? a.ids : [];
    if (raw.some((id) => typeof id !== 'string' || !mongoose.isValidObjectId(id))) return { error: 'Some of the picked people or groups are not valid.' };
    const ids = [...new Set(raw)];
    const what = { branches: 'branch', departments: 'department', shifts: 'shift', employees: 'employee' }[mode];
    if (ids.length === 0) return { error: `Please pick at least one ${what}.` };
    if (ids.length > AUDIENCE_MAX) return { error: `Please pick ${AUDIENCE_MAX} or fewer.` };
    return { data: { mode, ids } };
}

// Copy only the fields a notice has. The body used to be spread straight into
// create/findOneAndUpdate: a {"$set": {"adminId": ...}} body moved a notice
// into another company, "author" could be signed as anyone, and an edit sent
// back the whole stored document (createdAt, __v, date ...). An edit is also
// validated here because findOneAndUpdate ran without validators, so a blank
// title or an unknown type was saved as sent.
function readAnnouncementInput(body, isEdit, now = new Date()) {
    const src = body || {};
    const out = {};

    if (has(src, 'title') || !isEdit) {
        if (typeof src.title !== 'string' || !src.title.trim()) return { error: 'Please enter a title for the notice.' };
        const title = src.title.trim();
        if (title.length > TITLE_MAX) return { error: `The title is too long. Please keep it under ${TITLE_MAX} letters.` };
        out.title = title;
    }
    if (has(src, 'content') || !isEdit) {
        if (typeof src.content !== 'string' || !src.content.trim()) return { error: 'Please write the message for the notice.' };
        const content = src.content.trim();
        if (content.length > CONTENT_MAX) return { error: `The message is too long (${content.length} letters). Please keep it under ${CONTENT_MAX}.` };
        out.content = content;
    }
    if (has(src, 'type') || !isEdit) {
        const type = src.type === undefined || src.type === '' ? 'general' : src.type;
        if (!TYPES.includes(type)) return { error: 'Please choose a type: general, urgent, event or policy.' };
        out.type = type;
    }
    if (has(src, 'pinned')) {
        if (typeof src.pinned !== 'boolean') return { error: 'Pinned must be yes or no.' };
        out.pinned = src.pinned;
    }
    if (has(src, 'display') || !isEdit) {
        const d = src.display ?? {};
        if (typeof d !== 'object' || Array.isArray(d)) return { error: 'The display choices are not in the right form.' };
        for (const k of ['popup', 'markAsRead']) {
            if (d[k] !== undefined && typeof d[k] !== 'boolean') return { error: 'Popup and "Mark as read" must be yes or no.' };
        }
        out.display = { popup: d.popup === true, markAsRead: d.markAsRead === true };
    }
    if (has(src, 'question') || !isEdit) {
        const { data, error } = readQuestion(src.question);
        if (error) return { error };
        out.question = data;
    }
    if (has(src, 'closesAt') || !isEdit) {
        const c = src.closesAt;
        if (c === null || c === undefined || c === '') {
            out.closesAt = null;
        } else {
            const at = typeof c === 'string' ? new Date(c) : null;
            if (!at || Number.isNaN(at.getTime())) return { error: 'The closing time is not a valid date.' };
            if (at.getTime() > now.getTime() + 2 * 365 * 864e5) return { error: 'The closing time is too far ahead.' };
            // A new notice cannot be born closed; an edit may close one now.
            if (!isEdit && at.getTime() <= now.getTime()) return { error: 'The closing time has already passed. Pick a later time.' };
            out.closesAt = at;
        }
    }
    if (has(src, 'audience') || !isEdit) {
        const { data, error } = readAudience(src.audience);
        if (error) return { error };
        out.audience = data;
    }
    return { data: out };
}

// The picked branches/departments/shifts/employees must belong to this company.
async function checkAudienceOwnership(adminId, audience) {
    if (!audience || audience.mode === 'all') return null;
    const ids = audience.ids.map((id) => new mongoose.Types.ObjectId(id));
    const filter = { _id: { $in: ids }, adminId };
    let found;
    if (audience.mode === 'employees') found = await User.countDocuments({ ...filter, role: 'employee' });
    else {
        const name = { branches: 'Branch', departments: 'Department', shifts: 'Shift' }[audience.mode];
        found = await require(`../models/${name}`).countDocuments(filter);
    }
    if (found !== ids.length) return 'Some of the picked people or groups are not in your company. Refresh the page and pick again.';
    return null;
}

const idStr = (v) => (v && v._id ? String(v._id) : v ? String(v) : '');

/** Whether this employee is one the notice is meant for. */
function inAudience(a, u) {
    const mode = a.audience?.mode || 'all';
    if (mode === 'all') return true;
    if (!u) return false;
    const ids = new Set((a.audience.ids || []).map(String));
    if (mode === 'employees') return ids.has(String(u._id));
    if (mode === 'branches') return [u.branchId, ...(u.branchIds || [])].some((x) => x && ids.has(idStr(x)));
    if (mode === 'departments') return !!u.departmentId && ids.has(idStr(u.departmentId));
    if (mode === 'shifts') return [u.shiftId, ...(u.shiftIds || [])].some((x) => x && ids.has(idStr(x)));
    return false;
}

const hasQuestion = (a) => !!a.question?.kind && a.question.kind !== 'none';
const isOpen = (a, now) => !a.closesAt || new Date(a.closesAt).getTime() > now.getTime();

/**
 * Whether the app should pop this notice up for this employee. Only when the
 * admin ticked "show as popup", and only until the employee has done what it
 * asks: answered its open question, tapped "Mark as read", or (with neither)
 * seen it once.
 */
function isPendingFor(a, r, now = new Date()) {
    if (!a.display?.popup) return false;
    const question = hasQuestion(a);
    const open = isOpen(a, now);
    const fresh = now.getTime() - new Date(a.createdAt).getTime() <= POPUP_DAYS * 864e5;
    if (question && open && !r?.answeredAt) return true;
    if (!fresh) return false;
    if (a.display?.markAsRead && !r?.readAt) return true;
    if (!question && !a.display?.markAsRead && !r?.seenAt) return true;
    return false;
}

function myResponse(r) {
    if (!r) return null;
    return {
        seenAt: r.seenAt || null,
        readAt: r.readAt || null,
        answeredAt: r.answeredAt || null,
        answer: r.answeredAt ? r.answer || null : null,
    };
}

// What an employee gets: never who else the notice was aimed at.
function forEmployee(a, r, now) {
    const { adminId, createdBy, ...rest } = a;
    return {
        ...rest,
        audience: { mode: a.audience?.mode || 'all' },
        myResponse: myResponse(r),
        isOpen: isOpen(a, now),
        pending: isPendingFor(a, r, now),
    };
}

const AUDIENCE_FIELDS = 'name phone branchId branchIds departmentId shiftId shiftIds';
const activeEmployees = (adminId) =>
    User.find({ adminId, role: 'employee', status: { $ne: 'inactive' } }).select(AUDIENCE_FIELDS).lean();

const notFound = (res) => res.status(404).json({ message: 'Notice not found' });

exports.getAnnouncements = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const query = { adminId };
        const { type } = req.query;
        if (typeof type === 'string' && TYPES.includes(type)) query.type = type;

        const list = await Announcement.find(query).sort({ pinned: -1, createdAt: -1 }).lean();
        const now = new Date();

        if (roleOf(req) === 'employee') {
            const me = await User.findById(req.userId).select(AUDIENCE_FIELDS).lean();
            const mine = list.filter((a) => inAudience(a, me));
            const responses = await AnnouncementResponse.find({
                announcementId: { $in: mine.map((a) => a._id) }, employeeId: req.userId,
            }).lean();
            const byPost = new Map(responses.map((r) => [String(r.announcementId), r]));
            return res.json(mine.map((a) => forEmployee(a, byPost.get(String(a._id)), now)));
        }

        // Panel: each notice with how far it has got, counted over the active
        // employees it is for today.
        const [employees, responses] = await Promise.all([
            activeEmployees(adminId),
            AnnouncementResponse.find({ adminId, announcementId: { $in: list.map((a) => a._id) } })
                .select('announcementId employeeId seenAt readAt answeredAt').lean(),
        ]);
        const byPost = new Map();
        for (const r of responses) {
            const k = String(r.announcementId);
            if (!byPost.has(k)) byPost.set(k, new Map());
            byPost.get(k).set(String(r.employeeId), r);
        }
        res.json(list.map((a) => {
            const audience = employees.filter((e) => inAudience(a, e));
            const rows = byPost.get(String(a._id)) || new Map();
            let seen = 0; let read = 0; let answered = 0;
            for (const e of audience) {
                const r = rows.get(String(e._id));
                if (!r) continue;
                if (r.seenAt || r.readAt || r.answeredAt) seen++;
                if (r.readAt) read++;
                if (r.answeredAt) answered++;
            }
            return { ...a, stats: { audience: audience.length, seen, read, answered }, isOpen: isOpen(a, now) };
        }));
    } catch (error) {
        console.error('GET Announcements Error:', error);
        res.status(500).json({ message: 'Could not load the notices. Please try again.' });
    }
};

exports.addAnnouncement = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        const { data, error } = readAnnouncementInput(req.body, false);
        if (error) return res.status(400).json({ message: error });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const ownership = await checkAudienceOwnership(adminId, data.audience);
        if (ownership) return res.status(400).json({ message: ownership });
        // The same notice posted twice within a minute is one double tap: answer
        // with the notice already posted rather than publishing it twice.
        const repeat = await Announcement.findOne({
            adminId,
            title: data.title,
            content: data.content,
            createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
        });
        if (repeat) return res.status(200).json(repeat);
        const announcement = await Announcement.create({
            ...data,
            adminId,
            createdBy: mongoose.isValidObjectId(req.userId) ? req.userId : null,
            // Pinned to IST: on a UTC server a notice posted before 05:30 IST
            // was stamped with the previous day's date.
            date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' })
        });
        res.status(201).json(announcement);
    } catch (error) {
        console.error('Announcement Create Error:', error);
        res.status(500).json({ message: 'Could not post the notice. Please try again.' });
    }
};

// Once people have answered, the question can grow (new choices at the end)
// but not change under them: their answers are stored as choice positions.
function questionChangeRefusal(oldQ, newQ, answered) {
    if (!answered) return null;
    const before = oldQ?.kind || 'none';
    const people = `${answered} ${answered === 1 ? 'person has' : 'people have'} already answered`;
    if (newQ.kind !== before) return `${people}, so the question type cannot change. Post a new notice instead.`;
    if (CHOICE_KINDS.includes(before)) {
        const old = oldQ.options || [];
        const same = old.every((o, i) => newQ.options[i] === o);
        if (!same) return `${people}. You can add choices at the end, but not change or remove the ones they picked from.`;
    }
    return null;
}

exports.updateAnnouncement = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const { data, error } = readAnnouncementInput(req.body, true);
        if (error) return res.status(400).json({ message: error });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const existing = await Announcement.findOne({ _id: req.params.id, adminId }).lean();
        if (!existing) return notFound(res);
        if (data.audience) {
            const ownership = await checkAudienceOwnership(adminId, data.audience);
            if (ownership) return res.status(400).json({ message: ownership });
        }
        if (data.question) {
            const answered = await AnnouncementResponse.countDocuments({ announcementId: existing._id, answeredAt: { $ne: null } });
            const refusal = questionChangeRefusal(existing.question, data.question, answered);
            if (refusal) return res.status(409).json({ message: refusal });
        }
        const announcement = await Announcement.findOneAndUpdate(
            { _id: req.params.id, adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!announcement) return notFound(res);
        res.json(announcement);
    } catch (error) {
        console.error('Announcement Update Error:', error);
        res.status(500).json({ message: 'Could not save the notice. Please try again.' });
    }
};

exports.deleteAnnouncement = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const announcement = await Announcement.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!announcement) return notFound(res);
        await AnnouncementResponse.deleteMany({ announcementId: announcement._id });
        res.json({ message: 'Notice deleted' });
    } catch (error) {
        console.error('Announcement Delete Error:', error);
        res.status(500).json({ message: 'Could not delete the notice. Please try again.' });
    }
};

exports.togglePin = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const announcement = await Announcement.findOne({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!announcement) return notFound(res);

        announcement.pinned = !announcement.pinned;
        await announcement.save();
        res.json(announcement);
    } catch (error) {
        console.error('Announcement Pin Error:', error);
        res.status(500).json({ message: 'Could not pin the notice. Please try again.' });
    }
};

// ---- Employee side: seen, read, answer ----

// The notice, if it exists in this company and is meant for this employee.
async function noticeForMe(req) {
    if (!mongoose.isValidObjectId(req.params.id)) return null;
    const a = await Announcement.findOne({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) }).lean();
    if (!a) return null;
    const me = await User.findById(req.userId).select(AUDIENCE_FIELDS).lean();
    return inAudience(a, me) ? a : null;
}

// One row per (notice, employee). Written with an update pipeline so a first
// contact creates the row and a later one only fills what is still empty;
// the unique index makes two taps at once land on the same row.
function upsertResponse(a, employeeId, fields, extraFilter = {}) {
    const now = new Date();
    return AnnouncementResponse.collection.findOneAndUpdate(
        { announcementId: a._id, employeeId: new mongoose.Types.ObjectId(String(employeeId)), ...extraFilter },
        [{
            $set: {
                adminId: a.adminId,
                seenAt: { $ifNull: ['$seenAt', now] },
                createdAt: { $ifNull: ['$createdAt', now] },
                updatedAt: now,
                ...fields,
            },
        }],
        { upsert: true, returnDocument: 'after' },
    );
}

exports.markSeen = async (req, res) => {
    try {
        const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const ids = [...new Set(raw.filter((id) => typeof id === 'string' && mongoose.isValidObjectId(id)))].slice(0, 100);
        if (ids.length === 0) return res.json({ seen: 0 });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const [list, me] = await Promise.all([
            Announcement.find({ _id: { $in: ids }, adminId }).select('adminId audience').lean(),
            User.findById(req.userId).select(AUDIENCE_FIELDS).lean(),
        ]);
        const mine = list.filter((a) => inAudience(a, me));
        for (const a of mine) await upsertResponse(a, req.userId, {});
        res.json({ seen: mine.length });
    } catch (error) {
        console.error('Announcement Seen Error:', error);
        res.status(500).json({ message: 'Could not update the notice. Please try again.' });
    }
};

exports.markRead = async (req, res) => {
    try {
        const a = await noticeForMe(req);
        if (!a) return notFound(res);
        const r = await upsertResponse(a, req.userId, { readAt: { $ifNull: ['$readAt', new Date()] } });
        res.json({ myResponse: myResponse(r), pending: isPendingFor(a, r) });
    } catch (error) {
        console.error('Announcement Read Error:', error);
        res.status(500).json({ message: 'Could not mark it as read. Please try again.' });
    }
};

// The answer as stored, or the reason it cannot be.
function readAnswer(q, body) {
    const src = body || {};
    if (q.kind === 'number') {
        const n = typeof src.number === 'string' && src.number.trim() !== '' ? Number(src.number) : src.number;
        if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'Please enter a number.' };
        if (!Number.isInteger(n)) return { error: 'Please enter a whole number.' };
        const min = q.min ?? 0;
        if (n < min) return { error: `The number cannot be less than ${min}.` };
        if (q.max !== null && q.max !== undefined && n > q.max) return { error: `The number cannot be more than ${q.max}.` };
        return { data: { number: n } };
    }
    const options = q.options || [];
    const choices = Array.isArray(src.choices) ? src.choices : [];
    if (choices.length === 0) return { error: q.kind === 'multiple' ? 'Please tick at least one choice.' : 'Please pick an answer.' };
    if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= options.length)) {
        return { error: 'That choice is no longer on the list. Close and open the notice again.' };
    }
    const unique = [...new Set(choices)].sort((x, y) => x - y);
    if (q.kind !== 'multiple' && unique.length !== 1) return { error: 'Please pick one answer.' };
    return { data: { choices: unique } };
}

exports.respond = async (req, res) => {
    try {
        const a = await noticeForMe(req);
        if (!a) return notFound(res);
        if (!hasQuestion(a)) return res.status(400).json({ message: 'This notice has no question to answer.' });
        if (!isOpen(a, new Date())) return res.status(409).json({ message: 'Answers for this notice are closed.' });
        const { data, error } = readAnswer(a.question, req.body);
        if (error) return res.status(400).json({ message: error });

        // Without "can change answer", only a first answer is taken: the
        // filter then matches no row that already has one, the upsert collides
        // with the unique index, and that collision is the refusal.
        const lockFirst = a.question.allowChange === false ? { answeredAt: null } : {};
        let r;
        try {
            r = await upsertResponse(a, req.userId, { answer: { $literal: data }, answeredAt: new Date() }, lockFirst);
        } catch (e) {
            if (e?.code === 11000) {
                const prev = await AnnouncementResponse.findOne({ announcementId: a._id, employeeId: req.userId }).lean();
                return res.status(409).json({
                    message: 'You have already answered, and this notice does not allow changing it.',
                    myResponse: myResponse(prev),
                });
            }
            throw e;
        }
        res.json({ myResponse: myResponse(r), pending: isPendingFor(a, r) });
    } catch (error) {
        console.error('Announcement Respond Error:', error);
        res.status(500).json({ message: 'Could not save your answer. Please try again.' });
    }
};

// ---- Admin: results ----

exports.getResults = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const a = await Announcement.findOne({ _id: req.params.id, adminId }).lean();
        if (!a) return notFound(res);

        const [employees, responses] = await Promise.all([
            User.find({ adminId, role: 'employee' })
                .select(`${AUDIENCE_FIELDS} status`)
                .populate('branchId', 'name').populate('departmentId', 'name')
                .lean(),
            AnnouncementResponse.find({ announcementId: a._id }).lean(),
        ]);
        const byEmp = new Map(responses.map((r) => [String(r.employeeId), r]));
        const q = a.question || { kind: 'none' };
        const options = q.options || [];

        const people = [];
        for (const e of employees) {
            const r = byEmp.get(String(e._id));
            const member = e.status !== 'inactive' && inAudience(a, e);
            // People no longer in the audience (moved branch, left) are listed
            // only if they did respond, so no answer silently disappears.
            if (!member && !r) continue;
            people.push({
                employeeId: e._id,
                name: e.name || 'Employee',
                phone: e.phone || '',
                branch: e.branchId?.name || '',
                department: e.departmentId?.name || '',
                inAudience: member,
                seenAt: r?.seenAt || null,
                readAt: r?.readAt || null,
                answeredAt: r?.answeredAt || null,
                answer: r?.answeredAt ? {
                    choices: r.answer?.choices || [],
                    labels: (r.answer?.choices || []).map((i) => options[i] ?? `Choice ${i + 1}`),
                    number: r.answer?.number ?? null,
                } : null,
            });
        }
        people.sort((x, y) => x.name.localeCompare(y.name));

        const counted = people.filter((p) => p.inAudience);
        const answeredPeople = people.filter((p) => p.answeredAt);
        const totals = {
            audience: counted.length,
            seen: counted.filter((p) => p.seenAt || p.readAt || p.answeredAt).length,
            read: counted.filter((p) => p.readAt).length,
            answered: counted.filter((p) => p.answeredAt).length,
        };
        totals.notAnswered = hasQuestion(a) ? totals.audience - totals.answered : 0;

        let optionTotals = [];
        let number = null;
        if (CHOICE_KINDS.includes(q.kind)) {
            optionTotals = options.map((label, index) => {
                const who = answeredPeople.filter((p) => p.answer.choices.includes(index));
                return { index, label, count: who.length, people: who.map((p) => ({ employeeId: p.employeeId, name: p.name })) };
            });
        } else if (q.kind === 'number') {
            const values = answeredPeople.map((p) => p.answer.number).filter((n) => typeof n === 'number');
            const total = values.reduce((s, n) => s + n, 0);
            number = {
                answered: values.length,
                total,
                average: values.length ? Math.round((total / values.length) * 100) / 100 : null,
                min: values.length ? Math.min(...values) : null,
                max: values.length ? Math.max(...values) : null,
                unit: q.unit || '',
            };
        }

        res.json({
            announcement: { ...a, isOpen: isOpen(a, new Date()) },
            totals,
            options: optionTotals,
            number,
            people,
        });
    } catch (error) {
        console.error('Announcement Results Error:', error);
        res.status(500).json({ message: 'Could not load the results. Please try again.' });
    }
};

// Exposed for the QA unit checks (qa/admin-festivals-notice/unit.cjs, qa/notices/).
exports._test = { readAnnouncementInput, readAnswer, inAudience, isPendingFor, questionChangeRefusal, TITLE_MAX, CONTENT_MAX };

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.addAnnouncement = serialisePerTenant(exports.addAnnouncement, 'create');
