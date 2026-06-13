const AssetCategory = require('../models/AssetCategory');

exports.getCategories = async (req, res) => {
    try {
        const categories = await AssetCategory.find({ adminId: req.user.adminId });
        res.status(200).json(categories);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.createCategory = async (req, res) => {
    try {
        const { name, icon, description } = req.body;
        const category = new AssetCategory({
            adminId: req.user.adminId,
            name,
            icon,
            description
        });
        await category.save();
        res.status(201).json(category);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const { name, icon, description } = req.body;
        const category = await AssetCategory.findOneAndUpdate(
            { _id: req.params.id, adminId: req.user.adminId },
            { name, icon, description },
            { new: true }
        );
        if (!category) return res.status(404).json({ message: 'Category not found' });
        res.status(200).json(category);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const category = await AssetCategory.findOneAndDelete({ _id: req.params.id, adminId: req.user.adminId });
        if (!category) return res.status(404).json({ message: 'Category not found' });
        res.status(200).json({ message: 'Category deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
