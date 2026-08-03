const mongoose = require('mongoose');
const Device = require('../models/Device');
const User = require('../models/User');
const { friendlyMongooseError } = require('../utils/mongoose_errors');
const { invalidateDeviceCache } = require('../utils/device_registry');

// Super-admin management of physical biometric terminals. Tenants do not
// self-serve device registration — claiming a machine decides which company's
// attendance a punch lands in, so it stays a platform-level operation.

// GET /api/superadmin/devices?adminId=&status=&search=
exports.getDevices = async (req, res) => {
    try {
        const { adminId, status, search } = req.query;
        const query = {};

        if (adminId) {
            query.adminId = mongoose.Types.ObjectId.isValid(adminId)
                ? new mongoose.Types.ObjectId(adminId)
                : adminId;
        }
        if (status && status !== 'all') {
            if (status === 'unassigned') query.adminId = null;
            else query.status = status;
        }
        if (search) {
            const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            query.$or = [{ serialNumber: rx }, { label: rx }, { model: rx }];
        }

        const devices = await Device.find(query)
            .populate('adminId', 'name phone')
            .sort({ adminId: 1, createdAt: -1 })
            .lean();

        // Surface the count of machines still waiting to be claimed — that's the
        // number the super admin actually needs to act on.
        const unassignedCount = await Device.countDocuments({ adminId: null });

        res.json({ devices, unassignedCount, total: devices.length });
    } catch (error) {
        console.error('Get devices error:', error);
        res.status(500).json({ message: error.message });
    }
};

// POST /api/superadmin/devices
// Registers a machine up front (serial read off the device menu) OR claims an
// already auto-discovered one, which is why a duplicate serial is treated as a
// claim rather than an error.
exports.createDevice = async (req, res) => {
    try {
        const { serialNumber, adminId, label = '', model = '', notes = '' } = req.body;

        if (!serialNumber || !String(serialNumber).trim()) {
            return res.status(400).json({ message: 'Serial number is required.' });
        }

        const sn = String(serialNumber).trim().toUpperCase();

        let owner = null;
        if (adminId) {
            owner = await User.findOne({ _id: adminId, role: 'admin' }).select('_id name');
            if (!owner) {
                return res.status(404).json({ message: 'That customer no longer exists.' });
            }
        }

        const existing = await Device.findOne({ serialNumber: sn });
        if (existing) {
            // Already claimed by a different company — refuse rather than
            // silently move it, since re-pointing a live machine mid-month
            // would split one person's attendance across two tenants.
            if (existing.adminId && String(existing.adminId) !== String(adminId || '')) {
                const current = await User.findById(existing.adminId).select('name');
                return res.status(409).json({
                    message: `Serial ${sn} is already assigned to ${current?.name || 'another customer'}. Release it from that customer first.`,
                });
            }

            existing.adminId = owner ? owner._id : null;
            existing.status = owner ? 'active' : 'unassigned';
            if (label) existing.label = label;
            if (model) existing.model = model;
            if (notes) existing.notes = notes;
            await existing.save();
            invalidateDeviceCache(sn);

            const saved = await Device.findById(existing._id).populate('adminId', 'name phone').lean();
            return res.status(200).json(saved);
        }

        const device = await Device.create({
            serialNumber: sn,
            adminId: owner ? owner._id : null,
            status: owner ? 'active' : 'unassigned',
            label,
            model,
            notes,
            autoDiscovered: false,
        });
        invalidateDeviceCache(sn);

        const saved = await Device.findById(device._id).populate('adminId', 'name phone').lean();
        res.status(201).json(saved);
    } catch (error) {
        console.error('Create device error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// PUT /api/superadmin/devices/:id
exports.updateDevice = async (req, res) => {
    try {
        const device = await Device.findById(req.params.id);
        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }

        const { adminId, label, model, status, notes } = req.body;

        if (adminId !== undefined) {
            if (adminId === null || adminId === '') {
                // Releasing a machine: park it as unassigned so it stops
                // recording attendance anywhere until it's claimed again.
                device.adminId = null;
                device.status = 'unassigned';
            } else {
                const owner = await User.findOne({ _id: adminId, role: 'admin' }).select('_id');
                if (!owner) {
                    return res.status(404).json({ message: 'That customer no longer exists.' });
                }
                device.adminId = owner._id;
                if (device.status === 'unassigned') device.status = 'active';
            }
        }

        if (label !== undefined) device.label = label;
        if (model !== undefined) device.model = model;
        if (notes !== undefined) device.notes = notes;

        // Only active/disabled are settable by hand — 'unassigned' is derived
        // from having no owner, so it can't be chosen independently.
        if (status !== undefined && ['active', 'disabled'].includes(status)) {
            if (!device.adminId) {
                return res.status(400).json({ message: 'Assign this machine to a customer before enabling it.' });
            }
            device.status = status;
        }

        await device.save();
        invalidateDeviceCache(device.serialNumber);

        const saved = await Device.findById(device._id).populate('adminId', 'name phone').lean();
        res.json(saved);
    } catch (error) {
        console.error('Update device error:', error);
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// DELETE /api/superadmin/devices/:id
// Note: deleting only forgets the mapping. If the machine is still powered on
// and pointed at us it will re-appear as unassigned on its next push.
exports.deleteDevice = async (req, res) => {
    try {
        const device = await Device.findByIdAndDelete(req.params.id);
        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }
        invalidateDeviceCache(device.serialNumber);
        res.json({ message: `Machine ${device.serialNumber} removed.` });
    } catch (error) {
        console.error('Delete device error:', error);
        res.status(500).json({ message: error.message });
    }
};

// POST /api/superadmin/devices/:id/clear-unresolved
// Dismiss the diagnostic buffer once the admin has fixed the PIN mapping.
exports.clearUnresolved = async (req, res) => {
    try {
        const device = await Device.findByIdAndUpdate(
            req.params.id,
            { $set: { recentUnresolved: [] } },
            { new: true },
        ).populate('adminId', 'name phone').lean();

        if (!device) {
            return res.status(404).json({ message: 'Machine not found.' });
        }
        res.json(device);
    } catch (error) {
        console.error('Clear unresolved error:', error);
        res.status(500).json({ message: error.message });
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
        res.status(500).json({ message: error.message });
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
        const { serialNumber, label = '', model = '' } = req.body;

        if (!serialNumber || !String(serialNumber).trim()) {
            return res.status(400).json({ message: 'Enter the serial number printed on the machine.' });
        }

        const sn = String(serialNumber).trim().toUpperCase();
        const myAdminId = new mongoose.Types.ObjectId(req.adminId);

        const existing = await Device.findOne({ serialNumber: sn });

        if (existing && existing.adminId && String(existing.adminId) !== String(req.adminId)) {
            // Deliberately vague about WHO holds it — that would leak one
            // customer's hardware inventory to another.
            return res.status(409).json({
                message: `Serial ${sn} is already registered to another company. If this machine is yours, contact B.O.T support on +91 97240 00697 to have it moved.`,
            });
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
        res.status(500).json({ message: error.message });
    }
};

// PUT /api/devices/:id — label, notes and on/off. Never the owning company.
exports.updateMyDevice = async (req, res) => {
    try {
        const { label, notes, status } = req.body;
        const update = {};
        if (label !== undefined) update.label = label;
        if (notes !== undefined) update.notes = notes;
        // Pausing a machine is safe and useful (e.g. a unit being serviced).
        // 'unassigned' is derived from having no owner, so it isn't selectable.
        if (status !== undefined && ['active', 'disabled'].includes(status)) {
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
        res.status(500).json({ message: error.message });
    }
};

// GET /api/superadmin/devices/:id/pin-map
// The PIN → employee table for this machine's tenant, so the super admin can
// see exactly who a given PIN will resolve to (and spot gaps) without leaving
// the Machines screen.
exports.getDevicePinMap = async (req, res) => {
    try {
        const device = await Device.findById(req.params.id).lean();
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
        res.status(500).json({ message: error.message });
    }
};
