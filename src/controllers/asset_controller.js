const Asset = require('../models/Asset');

exports.getAssets = async (req, res) => {
    try {
        const query = { adminId: req.adminId };
        const { employeeId, status } = req.query;

        if (employeeId) query.employeeId = employeeId;
        if (status) query.status = status;

        const assets = await Asset.find(query).sort({ createdAt: -1 });
        res.json(assets);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Prevents the same physical device (serial number) from being allocated
// (status: 'active') to more than one record at a time.
async function findActiveDuplicate(adminId, serialNumber, excludeId) {
    if (!serialNumber) return null;
    const query = { adminId, serialNumber, status: 'active' };
    if (excludeId) query._id = { $ne: excludeId };
    return Asset.findOne(query);
}

exports.addAsset = async (req, res) => {
    try {
        const status = req.body.status || 'active';
        if (status === 'active') {
            const dup = await findActiveDuplicate(req.adminId, req.body.serialNumber);
            if (dup) {
                return res.status(400).json({ message: `Serial number "${req.body.serialNumber}" is already allocated to ${dup.employeeName}. Return it before reassigning.` });
            }
        }
        const asset = await Asset.create({
            ...req.body,
            adminId: req.adminId
        });
        res.status(201).json(asset);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateAsset = async (req, res) => {
    try {
        if (req.body.status === 'active' || req.body.serialNumber) {
            const existing = await Asset.findOne({ _id: req.params.id, adminId: req.adminId });
            if (!existing) return res.status(404).json({ message: 'Asset not found' });
            const nextSerial = req.body.serialNumber ?? existing.serialNumber;
            const nextStatus = req.body.status ?? existing.status;
            if (nextStatus === 'active') {
                const dup = await findActiveDuplicate(req.adminId, nextSerial, req.params.id);
                if (dup) {
                    return res.status(400).json({ message: `Serial number "${nextSerial}" is already allocated to ${dup.employeeName}. Return it before reassigning.` });
                }
            }
        }
        const asset = await Asset.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId },
            req.body,
            { new: true }
        );
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        res.json(asset);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteAsset = async (req, res) => {
    try {
        const asset = await Asset.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        res.json({ message: 'Asset deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
