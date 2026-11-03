const Asset = require('../models/Asset');
const User = require('../models/User');
const { istDateKey } = require('../utils/attendance_helpers');
const { serialisePerTenant } = require('../utils/employee_lock');

// A malformed id used to reach Mongoose and come back as a 500 "Cast to
// ObjectId failed"; anything that is not 24 hex characters cannot match.
const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

const STATUSES = ['active', 'returned', 'damaged'];
const UNLOCK_TYPES = ['password', 'pin', 'pattern'];

// ₹1 crore for one device -- the same ceiling the app uses for advances and
// expenses. Well above any laptop or phone, low enough to catch a typo.
const MAX_AMOUNT = 10000000;

const LIMITS = { deviceType: 60, brand: 60, model: 80, serialNumber: 80, unlockCredentials: 100 };
const LABELS = { deviceType: 'device category', brand: 'brand', model: 'model', serialNumber: 'serial number', unlockCredentials: 'unlock password or PIN' };

// Serial numbers are compared ignoring case: "ABC123" and "abc123" are the
// same sticker read twice.
const CASE_INSENSITIVE = { locale: 'en', strength: 2 };

function validDateKey(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    if (y < 2000 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Copy only known asset fields out of a request body, validating each. A
 * create insists on everything the model requires; an edit (`partial`) checks
 * only what was sent. employeeId/employeeName are handled separately, since
 * the name is always taken from the employee record, never the body.
 */
function readAssetBody(body, { partial }) {
    const src = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const data = {};

    for (const key of ['deviceType', 'brand', 'model', 'serialNumber', 'unlockCredentials']) {
        if (!has(key)) continue;
        const raw = src[key];
        if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
            return { error: `Please enter the ${LABELS[key]} as plain text.` };
        }
        const value = raw === null ? '' : String(raw).trim();
        if (value.length > LIMITS[key]) return { error: `The ${LABELS[key]} is too long (at most ${LIMITS[key]} characters).` };
        data[key] = value;
    }

    const required = ['deviceType', 'brand', 'model', 'serialNumber'];
    const missing = required.filter((k) => (partial ? has(k) && !data[k] : !data[k]));
    if (missing.length) return { error: `Please fill in the ${missing.map((k) => LABELS[k]).join(', ')}.` };

    if (has('amount') || !partial) {
        const raw = src.amount;
        const n = typeof raw === 'string' ? Number(raw.replace(/,/g, '').trim()) : raw;
        if (raw === '' || raw === null || raw === undefined || typeof n !== 'number' || !Number.isFinite(n)) {
            return { error: 'Please enter the device value in rupees.' };
        }
        if (n < 0) return { error: 'The device value cannot be less than ₹0.' };
        if (n > MAX_AMOUNT) return { error: 'The device value is too large (at most ₹1 crore).' };
        data.amount = Math.round(n * 100) / 100;
    }

    if (has('allocatedAt') || !partial) {
        const v = typeof src.allocatedAt === 'string' ? src.allocatedAt.slice(0, 10) : '';
        if (!validDateKey(v)) return { error: 'Please pick the date the device was given.' };
        if (v > istDateKey()) return { error: 'The date the device was given cannot be in the future.' };
        data.allocatedAt = v;
    }

    if (has('status')) {
        if (!STATUSES.includes(src.status)) return { error: 'Please pick a status from the list.' };
        data.status = src.status;
    }
    if (has('unlockType')) {
        if (!UNLOCK_TYPES.includes(src.unlockType)) return { error: 'Please pick how the device unlocks.' };
        data.unlockType = src.unlockType;
    }
    if (has('patternSize')) {
        const n = Number(src.patternSize);
        if (n !== 3 && n !== 4) return { error: 'The pattern grid must be 3x3 or 4x4.' };
        data.patternSize = n;
    }
    if (data.unlockType === 'pin' && data.unlockCredentials && !/^\d{4,16}$/.test(data.unlockCredentials)) {
        return { error: 'A PIN can only have digits (4 to 16).' };
    }

    if (data.brand !== undefined || data.model !== undefined) {
        // deviceName is what the lists show; recomputed below when only one
        // of the two is sent.
        data._nameParts = true;
    }
    return { data };
}

/** The employee a device is being given to, checked against this company. */
async function readEmployee(adminId, employeeId) {
    if (!isObjectId(employeeId)) return { error: 'Please choose the employee who gets the device.' };
    const emp = await User.findOne({ _id: employeeId, adminId, role: 'employee' }).select('_id name status').lean();
    if (!emp) return { error: 'That person is not an employee of your company.' };
    return { emp };
}

// Prevents the same physical device (serial number) from being allocated
// (status: 'active') to more than one record at a time.
async function findActiveDuplicate(adminId, serialNumber, excludeId) {
    if (!serialNumber) return null;
    const query = { adminId, serialNumber: String(serialNumber).trim(), status: 'active' };
    if (excludeId) query._id = { $ne: excludeId };
    return Asset.findOne(query).collation(CASE_INSENSITIVE).select('employeeName').lean();
}

const duplicateMessage = (serial, dup) =>
    `Serial number "${serial}" is already given to ${dup.employeeName}. Mark it returned before giving it to someone else.`;

function serverError(res, error, message) {
    console.error(message, error);
    return res.status(500).json({ message });
}

exports.getAssets = async (req, res) => {
    try {
        const query = { adminId: req.adminId };
        const { employeeId, status } = req.query;

        if (employeeId !== undefined) {
            if (!isObjectId(employeeId)) return res.json([]);
            query.employeeId = employeeId;
        }
        if (status !== undefined) {
            if (!STATUSES.includes(status)) return res.json([]);
            query.status = status;
        }

        const assets = await Asset.find(query).sort({ createdAt: -1 }).lean();
        res.json(assets);
    } catch (error) {
        serverError(res, error, 'Could not load devices. Please try again.');
    }
};

exports.addAsset = async (req, res) => {
    try {
        const { data, error } = readAssetBody(req.body, { partial: false });
        if (error) return res.status(400).json({ message: error });
        delete data._nameParts;

        const { emp, error: empError } = await readEmployee(req.adminId, req.body?.employeeId);
        if (empError) return res.status(400).json({ message: empError });
        if (emp.status === 'inactive') {
            return res.status(400).json({ message: `${emp.name} is inactive. Make them active again before giving them a device.` });
        }

        const status = data.status || 'active';
        if (status === 'active') {
            const dup = await findActiveDuplicate(req.adminId, data.serialNumber);
            if (dup) return res.status(409).json({ message: duplicateMessage(data.serialNumber, dup) });
        }

        // The same device given to the same person twice within a minute is one
        // double tap (without a serial number nothing else would stop it).
        const repeat = await Asset.findOne({
            adminId: req.adminId,
            employeeId: emp._id,
            brand: data.brand,
            model: data.model,
            serialNumber: data.serialNumber || { $in: [null, ''] },
            createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
        });
        if (repeat) return res.status(200).json(repeat);

        const asset = await Asset.create({
            ...data,
            status,
            deviceName: `${data.brand} ${data.model}`.trim(),
            employeeId: emp._id,
            employeeName: emp.name,
            returnedAt: status === 'returned' ? istDateKey() : null,
            adminId: req.adminId,
        });
        res.status(201).json(asset);
    } catch (error) {
        serverError(res, error, 'The device could not be saved. Please try again.');
    }
};

exports.updateAsset = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Device not found' });

        const existing = await Asset.findOne({ _id: req.params.id, adminId: req.adminId }).lean();
        if (!existing) return res.status(404).json({ message: 'Device not found' });

        // Whitelisted, never the body as-is: {"$set": {"adminId": …}} is an
        // update operator and would have moved the record to another company.
        const { data, error } = readAssetBody(req.body, { partial: true });
        if (error) return res.status(400).json({ message: error });
        if (data._nameParts) {
            data.deviceName = `${data.brand ?? existing.brand} ${data.model ?? existing.model}`.trim();
            delete data._nameParts;
        }

        const bodyKeys = Object.keys(req.body || {});
        const nextStatus = data.status ?? existing.status;

        // "Mark returned" on a device that is already back.
        if (bodyKeys.length === 1 && data.status === 'returned' && existing.status === 'returned') {
            return res.status(409).json({ message: 'This device is already marked as returned.' });
        }

        const employeeChanged = req.body?.employeeId !== undefined && String(req.body.employeeId) !== String(existing.employeeId);
        if (employeeChanged) {
            const { emp, error: empError } = await readEmployee(req.adminId, req.body.employeeId);
            if (empError) return res.status(400).json({ message: empError });
            if (emp.status === 'inactive' && nextStatus !== 'returned') {
                return res.status(400).json({ message: `${emp.name} is inactive. Make them active again before giving them a device.` });
            }
            data.employeeId = emp._id;
            data.employeeName = emp.name;
        }

        const nextSerial = data.serialNumber ?? existing.serialNumber;
        if (nextStatus === 'active') {
            const dup = await findActiveDuplicate(req.adminId, nextSerial, existing._id);
            if (dup) return res.status(409).json({ message: duplicateMessage(nextSerial, dup) });
        }

        // Keep the return date with the record: set when it comes back,
        // cleared when it goes out again.
        if (nextStatus === 'returned' && existing.status !== 'returned') data.returnedAt = istDateKey();
        if (nextStatus !== 'returned' && existing.status === 'returned') data.returnedAt = null;

        if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to change.' });

        const asset = await Asset.findOneAndUpdate(
            { _id: existing._id, adminId: req.adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!asset) return res.status(404).json({ message: 'Device not found' });
        res.json(asset);
    } catch (error) {
        serverError(res, error, 'The device could not be updated. Please try again.');
    }
};

exports.deleteAsset = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Device not found' });
        const asset = await Asset.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
        if (!asset) return res.status(404).json({ message: 'Device not found' });
        res.json({ message: 'Device record deleted' });
    } catch (error) {
        serverError(res, error, 'The device could not be deleted. Please try again.');
    }
};

exports._internal = { readAssetBody, validDateKey };

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.addAsset = serialisePerTenant(exports.addAsset, 'create');
