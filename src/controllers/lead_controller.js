const Lead = require('../models/Lead');
const User = require('../models/User');

const isEmployee = (req) => (req.currentUser?.role || req.user?.role) === 'employee';

// A malformed id used to reach Mongoose and come back as a 500 "Cast to
// ObjectId failed"; any id that is not 24 hex characters cannot be a lead.
const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

const STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'lost', 'won'];
const BOT_STATUSES = ['Inactive', 'Active', 'Completed - Converted', 'Completed - Lost'];

// ₹1,000 crore. Far above any real SMB deal, but it stops a stray paste
// (1e55) from turning the Open Pipeline tile into nonsense.
const MAX_VALUE = 10000000000;
const MAX_SALES_CALLS = 100000;

const LIMITS = {
    name: 100, company: 150, email: 254, phone: 20, source: 60,
    notes: 2000, address: 500, businessType: 100, requirement: 200,
};
const LABELS = {
    name: 'name', company: 'business name', email: 'email', phone: 'phone number',
    source: 'source', notes: 'notes', address: 'address', businessType: 'business type',
    requirement: 'requirement',
};

// Admins can add their own fields on the Leads page (Settings.leadFields).
// Those keys are always "custom_<label>", and only plain values may be stored
// under them -- an object here is how a "$set" or "$where" would reach Mongo.
const CUSTOM_KEY = /^custom_[a-z0-9_]{1,60}$/;
const MAX_CUSTOM_FIELDS = 40;
const MAX_CUSTOM_TEXT = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Loose on purpose, the same rule as the employee app's New Lead form:
// landlines, +91 and spaces are all real, but a lead nobody can call back is
// worth refusing.
function phoneProblem(phone) {
    if (!/^[0-9+\-\s().]+$/.test(phone)) return 'The phone number can only have digits, spaces, + and -.';
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return 'Please enter a phone number with 10 to 13 digits.';
    return null;
}

// The last ten digits: "+91 98765 43210", "098765-43210" and "9876543210"
// are the same customer.
const phoneKeyOf = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

function validDateKey(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Copy only known lead fields out of a request body, validating each one.
 * `partial` (an edit) checks just the fields that were sent; a create also
 * insists on the four the model requires. Returns { data, error }.
 */
function readLeadBody(body, { partial, employee }) {
    const data = {};
    const src = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;

    const textKeys = employee
        ? ['name', 'email', 'phone', 'company', 'address', 'businessType', 'requirement']
        : ['name', 'email', 'phone', 'company', 'source', 'notes', 'address', 'businessType', 'requirement'];

    for (const key of textKeys) {
        if (!has(key)) continue;
        const raw = src[key];
        if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
            return { error: `Please enter the ${LABELS[key]} as plain text.` };
        }
        const value = raw === null ? '' : String(raw).trim();
        if (value.length > LIMITS[key]) {
            return { error: `The ${LABELS[key]} is too long (at most ${LIMITS[key]} characters).` };
        }
        data[key] = value;
    }

    const required = ['name', 'phone', 'email', 'company'];
    const missing = required.filter((k) => (partial ? has(k) && !data[k] : !data[k]));
    if (missing.length) {
        return { error: `Please fill in the customer's ${missing.map((k) => LABELS[k]).join(', ')}.` };
    }

    if (data.email && !EMAIL_RE.test(data.email)) {
        return { error: 'Please enter a valid email address, like name@example.com.' };
    }
    if (data.phone) {
        const problem = phoneProblem(data.phone);
        if (problem) return { error: problem };
        data.phoneKey = phoneKeyOf(data.phone);
    }

    if (employee) return { data };

    if (has('status')) {
        if (!STATUSES.includes(src.status)) return { error: 'Please pick a stage from the list.' };
        data.status = src.status;
    }
    if (has('botStatus')) {
        if (!BOT_STATUSES.includes(src.botStatus)) return { error: 'Please pick a bot status from the list.' };
        data.botStatus = src.botStatus;
    }
    if (has('value')) {
        const raw = src.value === '' || src.value === null ? 0 : src.value;
        const n = typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : raw;
        if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'Please enter the deal value as a number.' };
        if (n < 0) return { error: 'The deal value cannot be less than ₹0.' };
        if (n > MAX_VALUE) return { error: 'The deal value is too large (at most ₹1,000 crore).' };
        data.value = Math.round(n * 100) / 100;
    }
    if (has('salesCalls')) {
        const raw = src.salesCalls === '' || src.salesCalls === null ? 0 : src.salesCalls;
        const n = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_SALES_CALLS) {
            return { error: 'Sales calls must be a whole number, 0 or more.' };
        }
        data.salesCalls = n;
    }
    if (has('followUpDate')) {
        const v = src.followUpDate === null ? '' : src.followUpDate;
        if (typeof v !== 'string') return { error: 'Please pick a valid follow-up date.' };
        if (v.trim() === '') data.followUpDate = null;
        else if (!validDateKey(v.trim())) return { error: 'Please pick a valid follow-up date.' };
        else data.followUpDate = v.trim();
    }

    // Admin-defined fields.
    let customCount = 0;
    for (const key of Object.keys(src)) {
        if (!CUSTOM_KEY.test(key)) continue;
        if (++customCount > MAX_CUSTOM_FIELDS) return { error: 'Too many extra fields on one lead.' };
        const v = src[key];
        if (v === null || v === '') { data[key] = null; continue; }
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) return { error: 'Please enter a valid number.' };
            data[key] = v;
        } else if (typeof v === 'boolean') {
            data[key] = v;
        } else if (typeof v === 'string') {
            if (v.length > MAX_CUSTOM_TEXT) return { error: `An extra field is too long (at most ${MAX_CUSTOM_TEXT} characters).` };
            data[key] = v.trim();
        } else {
            return { error: 'Extra fields can only hold text, a number or a date.' };
        }
    }

    return { data };
}

/**
 * Resolve an assignment to a real employee of this company. The lead keeps
 * the name in `assignedTo` (what every existing lead and the list show) and
 * now also the id, so a renamed or same-named employee stays the right one.
 */
async function readAssignment(src, adminId) {
    const has = (k) => Object.prototype.hasOwnProperty.call(src || {}, k) && src[k] !== undefined;
    if (!has('assignedToId') && !has('assignedTo')) return {};

    let id = has('assignedToId') ? src.assignedToId : undefined;
    if (id === undefined) {
        const name = typeof src.assignedTo === 'string' ? src.assignedTo.trim() : '';
        if (!name || name === 'Unassigned') return { data: { assignedTo: 'Unassigned', assignedToId: null } };
        // An older page that sends only the name: accept it when it names
        // exactly one active employee.
        const matches = await User.find({ adminId, role: 'employee', status: { $ne: 'inactive' }, name })
            .select('_id name').limit(2).lean();
        if (matches.length !== 1) return { error: 'Please pick the person from the list.' };
        return { data: { assignedTo: matches[0].name, assignedToId: matches[0]._id } };
    }

    if (id === null || id === '') return { data: { assignedTo: 'Unassigned', assignedToId: null } };
    if (!isObjectId(id)) return { error: 'Please pick the person from the list.' };
    const emp = await User.findOne({ _id: id, adminId, role: 'employee' }).select('_id name status').lean();
    if (!emp) return { error: 'That person is not an employee of your company.' };
    if (emp.status === 'inactive') return { error: `${emp.name} is inactive, so leads cannot be given to them.` };
    return { data: { assignedTo: emp.name, assignedToId: emp._id } };
}

/**
 * Another lead in this company with the same phone number, if any. New and
 * edited leads carry `phoneKey`; older ones do not, so those are compared by
 * reading their phone.
 */
async function findDuplicate(adminId, phone, excludeId) {
    const key = phoneKeyOf(phone);
    if (key.length < 10) return null;
    const query = { adminId, $or: [{ phoneKey: key }, { phoneKey: { $exists: false } }] };
    if (excludeId) query._id = { $ne: excludeId };
    const candidates = await Lead.find(query).select('name company phone phoneKey createdAt').lean();
    return candidates.find((l) => (l.phoneKey || phoneKeyOf(l.phone)) === key) || null;
}

function duplicateMessage(dup, employee) {
    if (employee) {
        return 'This customer is already in your company\'s leads. Please check with your admin before adding them again.';
    }
    return `A lead with this phone number already exists: ${dup.name}${dup.company ? ` (${dup.company})` : ''}.`;
}

function serverError(res, error, message) {
    console.error(message, error);
    return res.status(500).json({ message });
}

exports.getLeads = async (req, res) => {
    try {
        const query = { adminId: req.adminId };
        const { status } = req.query;
        if (typeof status === 'string' && status !== 'all') {
            if (!STATUSES.includes(status)) return res.json([]);
            query.status = status;
        }

        // An employee sees only the leads they brought in. Unscoped, this
        // handed every employee the company's whole sales pipeline -- customer
        // names, phone numbers and emails -- and the employee Quick Actions
        // screen fetched it on every visit just to draw an "Add Lead" button.
        if (isEmployee(req)) query.createdBy = req.userId;

        // createdBy is populated with the name only: the admin list shows who
        // brought the lead in, and nothing else about that person is needed.
        const leads = await Lead.find(query)
            .select('-phoneKey')
            .populate('createdBy', 'name')
            .sort({ createdAt: -1 })
            .lean();
        res.json(leads);
    } catch (error) {
        serverError(res, error, 'Could not load leads. Please try again.');
    }
};

exports.addLead = async (req, res) => {
    try {
        const employee = isEmployee(req);
        const imageUrls = Array.isArray(req.files) ? req.files.map((f) => f.path) : [];

        const { data, error } = readLeadBody(req.body, { partial: false, employee });
        if (error) return res.status(400).json({ message: error });

        const dup = await findDuplicate(req.adminId, data.phone);
        if (dup) return res.status(409).json({ message: duplicateMessage(dup, employee), duplicate: true });

        if (employee) {
            const lead = await Lead.create({
                ...data,
                imageUrls,
                source: req.currentUser.name,
                createdBy: req.userId,
                adminId: req.adminId,
            });
            return res.status(201).json(lead);
        }

        const assignment = await readAssignment(req.body, req.adminId);
        if (assignment.error) return res.status(400).json({ message: assignment.error });

        const lead = await Lead.create({
            ...data,
            ...(assignment.data || {}),
            imageUrls,
            adminId: req.adminId,
        });
        res.status(201).json(lead);
    } catch (error) {
        serverError(res, error, 'The lead could not be saved. Please try again.');
    }
};

exports.updateLead = async (req, res) => {
    try {
        if (isEmployee(req)) {
            return res.status(403).json({ message: 'Employees cannot edit leads' });
        }
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });

        // Whitelisted, never the body as-is: a body of {"$set": {"adminId": …}}
        // is an update operator, and deleting the plain adminId key did not stop
        // it moving a lead into another company.
        const { data, error } = readLeadBody(req.body, { partial: true, employee: false });
        if (error) return res.status(400).json({ message: error });

        const assignment = await readAssignment(req.body, req.adminId);
        if (assignment.error) return res.status(400).json({ message: assignment.error });
        Object.assign(data, assignment.data || {});

        const existing = await Lead.findOne({ _id: req.params.id, adminId: req.adminId }).select('_id').lean();
        if (!existing) return res.status(404).json({ message: 'Lead not found' });

        if (data.phone) {
            const dup = await findDuplicate(req.adminId, data.phone, existing._id);
            if (dup) return res.status(409).json({ message: duplicateMessage(dup, false), duplicate: true });
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ message: 'Nothing to change.' });
        }

        const lead = await Lead.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId },
            { $set: data },
            { new: true, runValidators: true }
        ).populate('createdBy', 'name');
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        res.json(lead);
    } catch (error) {
        serverError(res, error, 'The lead could not be updated. Please try again.');
    }
};

exports.deleteLead = async (req, res) => {
    try {
        if (isEmployee(req)) {
            return res.status(403).json({ message: 'Employees cannot delete leads' });
        }
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Lead not found' });

        const lead = await Lead.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        res.json({ message: 'Lead deleted' });
    } catch (error) {
        serverError(res, error, 'The lead could not be deleted. Please try again.');
    }
};

// Exported for unit checks.
exports._internal = { readLeadBody, phoneKeyOf, phoneProblem, validDateKey };
const { serialisePerUser } = require('../utils/employee_lock');

// The duplicate-phone check reads then writes; two requests together both passed it.
exports.addLead = serialisePerUser(exports.addLead, 'create');
