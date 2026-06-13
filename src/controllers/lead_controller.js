const Lead = require('../models/Lead');

exports.getLeads = async (req, res) => {
    try {
        const query = { adminId: req.adminId };
        const { status } = req.query;
        if (status && status !== 'all') query.status = status;

        const leads = await Lead.find(query).sort({ createdAt: -1 });
        res.json(leads);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.addLead = async (req, res) => {
    try {
        const lead = await Lead.create({
            ...req.body,
            adminId: req.adminId
        });
        res.status(201).json(lead);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateLead = async (req, res) => {
    try {
        const lead = await Lead.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId },
            req.body,
            { new: true }
        );
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        res.json(lead);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteLead = async (req, res) => {
    try {
        const lead = await Lead.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        res.json({ message: 'Lead deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
