const Festival = require('../models/Festival');
const mongoose = require('mongoose');

exports.getFestivals = async (req, res) => {
    try {
        if (!req.adminId) {
            return res.status(401).json({ message: "Admin ID missing" });
        }
        const festivals = await Festival.find({ 
            adminId: new mongoose.Types.ObjectId(req.adminId) 
        }).sort({ startDate: 1 });
        res.json(festivals);
    } catch (error) {
        console.error("GET Festivals Error:", error);
        res.status(500).json({ message: error.message });
    }
};

exports.createFestival = async (req, res) => {
    try {
        const data = { ...req.body, adminId: new mongoose.Types.ObjectId(req.adminId) };
        if (req.file) {
            data.posterUrl = req.file.path;
        }
        
        const festival = await Festival.create(data);
        res.status(201).json(festival);
    } catch (error) {
        console.error("Festival Creation Error:", error);
        res.status(500).json({ message: error.message || "Failed to create festival" });
    }
};

exports.updateFestival = async (req, res) => {
    try {
        const data = { ...req.body };
        if (req.file) {
            data.posterUrl = req.file.path;
        } else if (req.body.removePoster === 'true') {
            data.posterUrl = "";
        }

        const festival = await Festival.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            data,
            { new: true, runValidators: true }
        );
        if (!festival) return res.status(404).json({ message: 'Festival not found' });
        res.json(festival);
    } catch (error) {
        console.error("Festival Update Error:", error);
        res.status(500).json({ message: error.message || "Failed to update festival" });
    }
};

exports.deleteFestival = async (req, res) => {
    try {
        const festival = await Festival.findOneAndDelete({ 
            _id: req.params.id, 
            adminId: new mongoose.Types.ObjectId(req.adminId) 
        });
        if (!festival) return res.status(404).json({ message: 'Festival not found' });
        res.json({ message: 'Festival removed' });
    } catch (error) {
        console.error("Delete Festival Error:", error);
        res.status(500).json({ message: error.message });
    }
};
