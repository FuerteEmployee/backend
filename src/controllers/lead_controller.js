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
        const imageUrls = req.files ? req.files.map(f => f.path) : [];

        if (req.user.role === 'employee') {
            const { name, email, phone, company, address, businessType, requirement } = req.body;
            const lead = await Lead.create({
                name,
                email,
                phone,
                company,
                address,
                businessType,
                requirement,
                imageUrls,
                source: req.currentUser.name,
                adminId: req.adminId
            });
            return res.status(201).json(lead);
        }

        const lead = await Lead.create({
            ...req.body,
            imageUrls,
            adminId: req.adminId
        });
        res.status(201).json(lead);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateLead = async (req, res) => {
    try {
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot edit leads' });
        }

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
        if (req.user.role === 'employee') {
            return res.status(403).json({ message: 'Employees cannot delete leads' });
        }

        const lead = await Lead.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        res.json({ message: 'Lead deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
