const mongoose = require('mongoose');
const Device = require('../models/Device');
const User = require('../models/User');
const { friendlyMongooseError } = require('../utils/mongoose_errors');
const { invalidateDeviceCache, isUsableSerial } = require('../utils/device_registry');

const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

/** Free text from a form: must be a string when present, trimmed, capped. */
function readText(value, max, label) {
    if (value === undefined) return { value: undefined };
    if (value === null) return { value: '' };
    if (typeof value !== 'string') return { error: `${label} must be text.` };
    const v = value.trim();
    if (v.length > max) return { error: `${label} can be at most ${max} characters.` };
    return { value: v };
}

// The User ID a machine gives a person when they are enrolled. eSSL/ZKTeco
// terminals use digits (some firmware also letters); nothing else can match a
// tap, so anything else is a typo that would silently never resolve.
const PIN_RE = /^[A-Za-z0-9]{1,20}$/;

// Super-admin management of physical biometric terminals. Tenants do not
// self-serve device registration — claiming a machine decides which company's
// attendance a punch lands in, so it stays a platform-level operation.

const DEVICE_STATUS_FILTERS = ['all', 'active', 'disabled', 'unassigned', 'offline'];
// Offline = assigned, active, and silent for longer than the offline alert
// waits (jobs/device_health.js), so the filter and the alert agree.
const OFFLINE_AFTER_MINUTES = parseInt(process.env.DEVICE_QUIET_MINUTES || '120', 10);
// A deliberate clock correction. ±14 h covers every real timezone mistake.
const CLOCK_OFFSET_MAX = 14 * 60;
const SUPER_DEVICE_POPULATE = ['adminId', 'name phone companyName'];

/** The company (tenant admin) a machine may be given to, or an error. */
async function findOwner(adminId) {
    if (!isId(String(adminId))) return { status: 400, message: 'Choose a company from the list.' };
    const owner = await User.findOne({ _id: adminId, role: 'admin' }).select('_id name companyName');
    if (!owner) return { status: 404, message: 'That company no longer exists.' };
    return { owner };
}
const ownerName = (u) => (u && (u.companyName || u.name)) || 'another company';

/** label / model / notes from a super-admin form, validated. */
function readDeviceText(body) {
    const label = readText(body.label, 60, 'Location');
    const model = readText(body.model, 40, 'Model');
    const notes = readText(body.notes, 500, 'Notes');
    const error = label.error || model.error || notes.error;
    return { error, label: label.value, model: model.value, notes: notes.value };
}

const superDeviceById = (id) => Device.findById(id).populate(...SUPER_DEVICE_POPULATE).lean();

// GET /api/superadmin/devices?adminId=&status=&search=
exports.getDevices = async (req, res) => {
    try {
        const { adminId, status = 'all', search } = req.query;
        const query = {};

        if (adminId !== undefined && adminId !== '') {
            if (!isId(String(adminId))) return res.status(400).json({ message: 'Unknown company.' });
            query.adminId = new mongoose.Types.ObjectId(String(adminId));
        }
        if (!DEVICE_STATUS_FILTERS.includes(String(status))) {
            return res.status(400).json({ message: 'Unknown status filter.' });
        }
        const unassignedCount = await Device.countDocuments({ adminId: null });

        if (status === 'unassigned') {
            // A company filter and "unassigned" can never both match.
            if (query.adminId) return res.json({ devices: [], unassignedCount, total: 0, offlineAfterMinutes: OFFLINE_AFTER_MINUTES });
            query.adminId = null;
        } else if (status === 'offline') {
            query.status = 'active';
            if (!query.adminId) query.adminId = { $ne: null };
            query.$and = [{ $or: [
                { lastSeenAt: null },
                { lastSeenAt: { $lt: new Date(Date.now() - OFFLINE_AFTER_MINUTES * 60 * 1000) } },
            ] }];
        } else if (status !== 'all') {
            query.status = status;
        }

        if (typeof search === 'string' && search.trim()) {
            const rx = new RegExp(search.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            // Company name/phone too: "which machines does this company have"
            // is the question support is usually asking.
            const owners = await User.find({ role: 'admin', $or: [{ name: rx }, { companyName: rx }, { phone: rx }] })
                .select('_id').limit(200).lean();
            const or = [{ serialNumber: rx }, { label: rx }, { model: rx }];
            if (owners.length) or.push({ adminId: { $in: owners.map((o) => o._id) } });
            (query.$and = query.$and || []).push({ $or: or });
        }

        const devices = await Device.find(query)
            .populate(...SUPER_DEVICE_POPULATE)
            .sort({ adminId: 1, createdAt: -1 })
            .limit(500)
            .lean();

        // unassignedCount is the number the super admin actually needs to act
        // on, so it ignores the filters.
        res.json({ devices, unassignedCount, total: devices.length, offlineAfterMinutes: OFFLINE_AFTER_MINUTES });
    } catch (error) {
        console.error('Get devices error:', error);
        res.status(500).json({ message: 'Could not load the machines. Please try again.' });
    }
};

// GET /api/superadmin/devices/companies
// Every company a machine can be given to, for the picker. The Customers list
// is paged (20 by default, 100 at most) and skips companies with no
// subscription record, so it cannot serve as the picker.
exports.getDeviceCompanies = async (req, res) => {
    try {
        const rows = await User.find({ role: 'admin' })
            .select('name companyName phone isActive')
            .lean();
        const list = rows.map((u) => ({
            _id: u._id,
            name: u.companyName || u.name || 'Unnamed company',
            contact: u.companyName && u.name && u.companyName !== u.name ? u.name : '',
            phone: u.phone || '',
            isActive: u.isActive !== false,
        }));
        list.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
        res.json(list);
    } catch (error) {
        console.error('Get device companies error:', error);
        res.status(500).json({ message: 'Could not load the companies. Please try again.' });
    }
};

// POST /api/superadmin/devices
// Registers a machine up front (serial read off the device menu) OR assigns an
// already auto-discovered one, which is why an unassigned duplicate serial is
// treated as a claim rather than an error.
exports.createDevice = async (req, res) => {
    try {
        const body = req.body || {};
        const { serialNumber, adminId } = body;

        if (typeof serialNumber !== 'string' || !serialNumber.trim()) {
            return res.status(400).json({ message: 'Enter the serial number.' });
        }
        const sn = serialNumber.trim().toUpperCase();
        if (!isUsableSerial(sn)) {
            return res.status(400).json({
                message: 'That does not look like a serial number. Use only the letters and digits shown under Menu → System Info → Serial Number.',
            });
        }
        const text = readDeviceText(body);
        if (text.error) return res.status(400).json({ message: text.error });

        let owner = null;
        if (adminId !== undefined && adminId !== null && adminId !== '') {
            const found = await findOwner(adminId);
            if (!found.owner) return res.status(found.status).json({ message: found.message });
            owner = found.owner;
        }

        const existing = await Device.findOne({ serialNumber: sn });
        if (existing) {
            // Already claimed by a different company — refuse rather than
            // silently move it, since re-pointing a live machine mid-month
            // would split one person's attendance across two tenants.
            if (existing.adminId && String(existing.adminId) !== String(owner?._id || '')) {
                const current = await User.findById(existing.adminId).select('name companyName');
                return res.status(409).json({
                    message: `${sn} already belongs to ${ownerName(current)}. Release it from that company first.`,
                });
            }
            if (existing.adminId) {
                return res.status(409).json({ message: `${sn} is already registered to ${ownerName(owner)}.` });
            }
            if (!owner) {
                return res.status(409).json({ message: `${sn} is already on the list, waiting for a company. Use Assign on its row.` });
            }

            existing.adminId = owner._id;
            existing.status = 'active';
            existing.claimedBy = req.userId || null;
            existing.claimedAt = new Date();
            existing.claimedVia = 'superadmin';
            if (text.label) existing.label = text.label;
            if (text.model) existing.model = text.model;
            if (text.notes) existing.notes = text.notes;
            await existing.save();
            invalidateDeviceCache(sn);
            console.log(`[devices] ${sn} assigned to adminId=${owner._id} by super admin ${req.userId}`);
            return res.status(200).json(await superDeviceById(existing._id));
        }

        const device = await Device.create({
            serialNumber: sn,
            adminId: owner ? owner._id : null,
            status: owner ? 'active' : 'unassigned',
            label: text.label || '',
            model: text.model || '',
            notes: text.notes || '',
            autoDiscovered: false,
            ...(owner ? { claimedBy: req.userId || null, claimedAt: new Date(), claimedVia: 'superadmin' } : {}),
        });
        invalidateDeviceCache(sn);

        res.status(201).json(await superDeviceById(device._id));
    } catch (error) {
        console.error('Create device error:', error);
        if (error?.code === 11000) return res.status(409).json({ message: 'That serial number is already on the list.' });
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// PUT /api/superadmin/devices/:id
// Assign, release, rename, pause/resume, and the manual clock correction.
exports.updateDevice = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const device = await Device.findById(req.params.id);
        if (!device) return res.status(404).json({ message: 'Machine not found.' });

        const body = req.body || {};
        const { adminId, status, clockOffsetMinutes } = body;
        const text = readDeviceText(body);
        if (text.error) return res.status(400).json({ message: text.error });

        if (status !== undefined && !['active', 'disabled'].includes(status)) {
            return res.status(400).json({ message: 'Status must be active or disabled.' });
        }
        if (clockOffsetMinutes !== undefined && (!Number.isInteger(clockOffsetMinutes) || Math.abs(clockOffsetMinutes) > CLOCK_OFFSET_MAX)) {
            return res.status(400).json({ message: `Clock correction must be a whole number of minutes between -${CLOCK_OFFSET_MAX} and ${CLOCK_OFFSET_MAX}.` });
        }

        if (adminId !== undefined) {
            if (adminId === null || adminId === '') {
                // Releasing a machine: park it as unassigned so it stops
                // recording attendance anywhere until it's claimed again.
                device.adminId = null;
                device.status = 'unassigned';
                device.claimedBy = null;
                device.claimedAt = null;
                device.claimedVia = null;
            } else {
                const found = await findOwner(adminId);
                if (!found.owner) return res.status(found.status).json({ message: found.message });
                if (device.adminId && String(device.adminId) !== String(found.owner._id)) {
                    // Same rule as createDevice: moving a live machine straight
                    // from one company to another splits someone's month.
                    const current = await User.findById(device.adminId).select('name companyName');
                    return res.status(409).json({ message: `${device.serialNumber} belongs to ${ownerName(current)}. Release it first, then assign it.` });
                }
                if (!device.adminId) {
                    device.adminId = found.owner._id;
                    device.claimedBy = req.userId || null;
                    device.claimedAt = new Date();
                    device.claimedVia = 'superadmin';
                    if (device.status === 'unassigned') device.status = 'active';
                }
            }
        }

        if (text.label !== undefined) device.label = text.label;
        if (text.model !== undefined) device.model = text.model;
        if (text.notes !== undefined) device.notes = text.notes;
        if (clockOffsetMinutes !== undefined) device.clockOffsetMinutes = clockOffsetMinutes;

        // Only active/disabled are settable by hand — 'unassigned' is derived
        // from having no owner, so it can't be chosen independently.
        if (status !== undefined) {
            if (!device.adminId) {
                return res.status(400).json({ message: 'Assign this machine to a company first.' });
            }
            device.status = status;
        }

        await device.save();
        invalidateDeviceCache(device.serialNumber);
        res.json(await superDeviceById(device._id));
    } catch (error) {
        console.error('Update device error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// DELETE /api/superadmin/devices/:id
// Deleting only forgets the mapping. If the machine is still powered on and
// pointed at us it will re-appear as unassigned on its next push. A machine
// that belongs to a company must be released first: deleting it straight away
// stops that company's attendance with one click.
exports.deleteDevice = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const device = await Device.findById(req.params.id).select('serialNumber adminId');
        if (!device) return res.status(404).json({ message: 'Machine not found.' });
        if (device.adminId) {
            const current = await User.findById(device.adminId).select('name companyName');
            return res.status(409).json({ message: `${device.serialNumber} belongs to ${ownerName(current)}. Release it first, then remove it.` });
        }
        await Device.deleteOne({ _id: device._id, adminId: null });
        invalidateDeviceCache(device.serialNumber);
        res.json({ message: `Machine ${device.serialNumber} removed.` });
    } catch (error) {
        console.error('Delete device error:', error);
        res.status(500).json({ message: 'Could not remove the machine. Please try again.' });
    }
};

// POST /api/superadmin/devices/:id/clear-unresolved
// Dismiss the diagnostic buffer once the admin has fixed the PIN mapping.
exports.clearUnresolved = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const device = await Device.findByIdAndUpdate(
            req.params.id,
            { $set: { recentUnresolved: [] } },
            { new: true },
        ).populate(...SUPER_DEVICE_POPULATE).lean();

        if (!device) return res.status(404).json({ message: 'Machine not found.' });
        res.json(device);
    } catch (error) {
        console.error('Clear unresolved error:', error);
        res.status(500).json({ message: 'Could not clear the warnings. Please try again.' });
    }
};

// ─── TENANT-FACING (company admin) ───────────────────────────────────────────
// A tenant may VIEW their own machines and rename them, but never claim,
// release or reassign one — that decides whose attendance a punch becomes, so
// it stays a platform operation. Every query below is scoped to req.adminId.

// GET /api/devices
exports.getMyDevices = async (req, res) => {
    try {
        const devices = await Device.find({ adminId: new mongoose.Types.ObjectId(req.adminId) })
            .sort({ createdAt: -1 })
            .lean();

        // Employees whose PIN is set, so the page can show what each machine
        // will actually resolve to, and who is still unmapped.
        const employees = await User.find({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            role: 'employee',
        })
            .select('name phone deviceUserId status profileImage')
            .sort({ name: 1 })
            .lean();

        res.json({
            devices,
            employees,
            mapped: employees.filter((e) => e.deviceUserId).length,
            unmapped: employees.filter((e) => !e.deviceUserId).length,
        });
    } catch (error) {
        console.error('Get my devices error:', error);
        res.status(500).json({ message: 'Could not load your machines. Try again.' });
    }
};

// POST /api/devices — a company admin registers their own machine.
//
// The serial number is printed on the device, so whoever has physical access can
// read it. Self-registration is therefore allowed for a serial that is free, but
// a serial already attached to a DIFFERENT company can never be taken over here
// — that would silently divert another company's attendance. Moving a claimed
// machine stays a support operation.
exports.claimDevice = async (req, res) => {
    try {
        const { serialNumber } = req.body || {};

        if (typeof serialNumber !== 'string' || !serialNumber.trim()) {
            return res.status(400).json({ message: 'Enter the serial number printed on the machine.' });
        }

        const sn = serialNumber.trim().toUpperCase();
        if (!isUsableSerial(sn)) {
            return res.status(400).json({
                message: 'That does not look like a serial number. Use only the letters and digits shown under Menu → System Info → Serial Number.',
            });
        }
        const labelIn = readText(req.body.label, 60, 'Location');
        const modelIn = readText(req.body.model, 40, 'Model');
        if (labelIn.error || modelIn.error) {
            return res.status(400).json({ message: labelIn.error || modelIn.error });
        }
        const label = labelIn.value || '';
        const model = modelIn.value || '';
        const myAdminId = new mongoose.Types.ObjectId(req.adminId);

        const existing = await Device.findOne({ serialNumber: sn });

        if (existing && existing.adminId && String(existing.adminId) !== String(req.adminId)) {
            // Deliberately vague about WHO holds it — that would leak one
            // customer's hardware inventory to another.
            return res.status(409).json({
                message: `Serial ${sn} is already registered to another company. If this machine is yours, contact B.O.T support on +91 97240 00697 to have it moved.`,
            });
        }

        if (existing && existing.adminId && String(existing.adminId) === String(req.adminId)) {
            return res.status(409).json({ message: `${sn} is already one of your machines.` });
        }

        if (existing) {
            const wasUnclaimed = !existing.adminId;
            existing.adminId = myAdminId;
            if (existing.status === 'unassigned') existing.status = 'active';
            if (label) existing.label = label;
            if (model) existing.model = model;
            if (wasUnclaimed) {
                existing.claimedBy = req.userId;
                existing.claimedAt = new Date();
                existing.claimedVia = 'admin';
            }
            await existing.save();
            invalidateDeviceCache(sn);
            console.log(`[devices] ${sn} claimed by adminId=${req.adminId} (userId=${req.userId})`);
            return res.status(200).json(existing.toObject());
        }

        const device = await Device.create({
            serialNumber: sn,
            adminId: myAdminId,
            status: 'active',
            label,
            model,
            autoDiscovered: false,
            claimedBy: req.userId,
            claimedAt: new Date(),
            claimedVia: 'admin',
        });
        invalidateDeviceCache(sn);
        console.log(`[devices] ${sn} registered by adminId=${req.adminId} (userId=${req.userId})`);
        res.status(201).json(device.toObject());
    } catch (error) {
        console.error('Claim device error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// DELETE /api/devices/:id — detach the machine from MY company.
// Not a hard delete: the row survives as unassigned so its history and serial
// stay intact and it can be re-registered (by this company or, after a resale,
// another one). Permanent deletion stays a super-admin action.
exports.releaseMyDevice = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const device = await Device.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            { $set: { adminId: null, status: 'unassigned' } },
            { new: true },
        ).lean();

        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }
        invalidateDeviceCache(device.serialNumber);
        console.log(`[devices] ${device.serialNumber} released by adminId=${req.adminId}`);
        res.json({ message: `${device.serialNumber} removed from your company. It will stop recording attendance.` });
    } catch (error) {
        console.error('Release my device error:', error);
        res.status(500).json({ message: 'Could not remove the machine. Try again.' });
    }
};

// PUT /api/devices/:id — label, notes and on/off. Never the owning company.
exports.updateMyDevice = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const { status } = req.body || {};
        const labelIn = readText(req.body?.label, 60, 'Location');
        const notesIn = readText(req.body?.notes, 300, 'Notes');
        if (labelIn.error || notesIn.error) {
            return res.status(400).json({ message: labelIn.error || notesIn.error });
        }
        const update = {};
        if (labelIn.value !== undefined) update.label = labelIn.value;
        if (notesIn.value !== undefined) update.notes = notesIn.value;
        // Pausing a machine is safe and useful (e.g. a unit being serviced).
        // 'unassigned' is derived from having no owner, so it isn't selectable.
        if (status !== undefined) {
            if (!['active', 'disabled'].includes(status)) {
                return res.status(400).json({ message: 'A machine can only be recording or paused.' });
            }
            update.status = status;
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ message: 'Nothing to update.' });
        }

        // adminId in the filter is what stops one tenant renaming another's machine.
        const device = await Device.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            { $set: update },
            { new: true },
        ).lean();

        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }
        // A pause must take effect on the very next tap, not after the 30s
        // registry cache expires.
        invalidateDeviceCache(device.serialNumber);
        res.json(device);
    } catch (error) {
        console.error('Update my device error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// POST /api/devices/:id/clear-unresolved
exports.clearMyUnresolved = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const device = await Device.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            { $set: { recentUnresolved: [] } },
            { new: true },
        ).lean();

        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }
        res.json(device);
    } catch (error) {
        console.error('Clear my unresolved error:', error);
        res.status(500).json({ message: 'Could not clear the warnings. Try again.' });
    }
};

// PUT /api/devices/pins/:employeeId — the "Who each ID belongs to" list.
//
// Its own endpoint rather than the Employees edit, so it is governed by the
// Biometric Device permission the page itself uses: a sub-admin allowed to
// manage machines could see the list but got a 403 from the Employees route on
// every save. Same rules as the employee form: trimmed, blank clears it, and
// one ID per person in the company.
exports.setEmployeePin = async (req, res) => {
    try {
        const { employeeId } = req.params;
        if (!isId(String(employeeId))) return res.status(404).json({ message: 'Employee not found.' });

        const raw = req.body?.deviceUserId;
        if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
            return res.status(400).json({ message: 'The ID must be a number from the machine.' });
        }
        const pin = raw === undefined || raw === null ? '' : String(raw).trim();
        if (pin && !PIN_RE.test(pin)) {
            return res.status(400).json({
                message: 'Use the User ID exactly as the machine shows it: digits (or letters), no spaces, at most 20 characters.',
            });
        }

        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const employee = await User.findOne({ _id: employeeId, adminId, role: 'employee' }).select('_id name deviceUserId');
        if (!employee) return res.status(404).json({ message: 'Employee not found.' });

        if (pin) {
            const clash = await User.findOne({ adminId, deviceUserId: pin, _id: { $ne: employee._id } }).select('name').lean();
            if (clash) {
                return res.status(409).json({
                    message: `ID ${pin} is already given to ${clash.name}. Each person needs their own ID, otherwise their punches can't be told apart.`,
                });
            }
        }

        try {
            await User.updateOne({ _id: employee._id, adminId }, { $set: { deviceUserId: pin || null } });
        } catch (err) {
            // The unique index caught a race with another save.
            if (err?.code === 11000) {
                return res.status(409).json({ message: `ID ${pin} was just given to someone else. Choose another.` });
            }
            throw err;
        }

        res.json({ _id: employee._id, name: employee.name, deviceUserId: pin || null });
    } catch (error) {
        console.error('Set employee PIN error:', error);
        res.status(500).json({ message: 'Could not save the ID. Try again.' });
    }
};

// GET /api/superadmin/devices/:id/pin-map
// The PIN → employee table for this machine's tenant, so the super admin can
// see exactly who a given PIN will resolve to (and spot gaps) without leaving
// the Machines screen.
exports.getDevicePinMap = async (req, res) => {
    try {
        if (!isId(String(req.params.id))) return res.status(404).json({ message: 'Machine not found.' });
        const device = await Device.findById(req.params.id).select('serialNumber label adminId status recentUnresolved').lean();
        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }
        if (!device.adminId) {
            return res.json({ device, employees: [], unmapped: 0 });
        }

        const employees = await User.find({ adminId: device.adminId, role: 'employee' })
            .select('name phone deviceUserId status')
            .sort({ deviceUserId: 1, name: 1 })
            .lean();

        res.json({
            device,
            employees,
            unmapped: employees.filter((e) => !e.deviceUserId).length,
        });
    } catch (error) {
        console.error('Get device pin map error:', error);
        res.status(500).json({ message: 'Could not load the PIN list. Please try again.' });
    }
};
