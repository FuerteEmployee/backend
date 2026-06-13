const Announcement = require('../models/Announcement');
const mongoose = require('mongoose');

exports.getAnnouncements = async (req, res) => {
    try {
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };
        const { type } = req.query;
        if (type && type !== 'all') query.type = type;

        const announcements = await Announcement.find(query).sort({ pinned: -1, createdAt: -1 });
        res.json(announcements);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.addAnnouncement = async (req, res) => {
    try {
        const announcement = await Announcement.create({
            ...req.body,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        });
        res.status(201).json(announcement);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateAnnouncement = async (req, res) => {
    try {
        const announcement = await Announcement.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            req.body,
            { new: true }
        );
        if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
        res.json(announcement);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteAnnouncement = async (req, res) => {
    try {
        const announcement = await Announcement.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
        res.json({ message: 'Announcement deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.togglePin = async (req, res) => {
    try {
        const announcement = await Announcement.findOne({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
        
        announcement.pinned = !announcement.pinned;
        await announcement.save();
        res.json(announcement);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
