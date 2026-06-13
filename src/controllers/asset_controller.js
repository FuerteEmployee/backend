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

exports.addAsset = async (req, res) => {
    try {
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
