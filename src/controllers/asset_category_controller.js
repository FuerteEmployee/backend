const AssetCategory = require('../models/AssetCategory');
const Asset = require('../models/Asset');

const isObjectId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The starter list a company gets the first time anyone opens its device
// categories. Seeded here, once, rather than by the Allocate page: the page
// did it in an effect that ran while the list was still loading (length 0),
// so every visit fired seven POSTs that the unique index turned into seven
// 400s -- and a sub-admin without "create" got seven 403s instead.
const DEFAULT_CATEGORIES = ['Laptop', 'Mobile', 'Monitor', 'Headset', 'Keyboard', 'Mouse', 'Tablet'];

const NAME_MAX = 40;
const ICON_MAX = 40;
const DESCRIPTION_MAX = 200;

function readName(raw) {
    if (typeof raw !== 'string') return { error: 'Please enter a category name.' };
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'Please enter a category name.' };
    if (name.length > NAME_MAX) return { error: `The category name is too long (at most ${NAME_MAX} characters).` };
    return { name };
}

function readOptional(raw, max, label) {
    if (raw === undefined) return {};
    if (raw === null || raw === '') return { value: '' };
    if (typeof raw !== 'string') return { error: `Please enter the ${label} as plain text.` };
    const value = raw.trim();
    if (value.length > max) return { error: `The ${label} is too long (at most ${max} characters).` };
    return { value };
}

// Same name ignoring case, so "laptop" cannot sit next to "Laptop".
async function nameTaken(adminId, name, excludeId) {
    const query = { adminId, name: new RegExp(`^${escapeRegex(name)}$`, 'i') };
    if (excludeId) query._id = { $ne: excludeId };
    return AssetCategory.exists(query);
}

function serverError(res, error, message) {
    console.error(message, error);
    return res.status(500).json({ message });
}

exports.getCategories = async (req, res) => {
    try {
        let categories = await AssetCategory.find({ adminId: req.adminId }).sort({ name: 1 }).lean();
        if (categories.length === 0) {
            try {
                await AssetCategory.insertMany(
                    DEFAULT_CATEGORIES.map((name) => ({ adminId: req.adminId, name, icon: 'Monitor' })),
                    { ordered: false }
                );
            } catch (e) {
                // Two first visits at once: the unique index keeps one copy.
                if (e?.code !== 11000 && !e?.writeErrors) throw e;
            }
            categories = await AssetCategory.find({ adminId: req.adminId }).sort({ name: 1 }).lean();
        }
        res.status(200).json(categories);
    } catch (error) {
        serverError(res, error, 'Could not load device categories. Please try again.');
    }
};

exports.createCategory = async (req, res) => {
    try {
        const { name, error } = readName(req.body?.name);
        if (error) return res.status(400).json({ message: error });
        const icon = readOptional(req.body?.icon, ICON_MAX, 'icon');
        const description = readOptional(req.body?.description, DESCRIPTION_MAX, 'description');
        if (icon.error || description.error) return res.status(400).json({ message: icon.error || description.error });

        if (await nameTaken(req.adminId, name)) {
            return res.status(409).json({ message: `There is already a category called "${name}".` });
        }

        const category = await AssetCategory.create({
            adminId: req.adminId,
            name,
            ...(icon.value ? { icon: icon.value } : {}),
            ...(description.value !== undefined ? { description: description.value } : {}),
        });
        res.status(201).json(category);
    } catch (error) {
        if (error?.code === 11000) return res.status(409).json({ message: 'There is already a category with that name.' });
        serverError(res, error, 'The category could not be saved. Please try again.');
    }
};

exports.updateCategory = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Category not found' });
        const existing = await AssetCategory.findOne({ _id: req.params.id, adminId: req.adminId }).lean();
        if (!existing) return res.status(404).json({ message: 'Category not found' });

        const update = {};
        if (req.body?.name !== undefined) {
            const { name, error } = readName(req.body.name);
            if (error) return res.status(400).json({ message: error });
            if (await nameTaken(req.adminId, name, existing._id)) {
                return res.status(409).json({ message: `There is already a category called "${name}".` });
            }
            update.name = name;
        }
        const icon = readOptional(req.body?.icon, ICON_MAX, 'icon');
        const description = readOptional(req.body?.description, DESCRIPTION_MAX, 'description');
        if (icon.error || description.error) return res.status(400).json({ message: icon.error || description.error });
        if (icon.value) update.icon = icon.value;
        if (description.value !== undefined) update.description = description.value;

        if (Object.keys(update).length === 0) return res.status(400).json({ message: 'Nothing to change.' });

        const category = await AssetCategory.findOneAndUpdate(
            { _id: existing._id, adminId: req.adminId },
            { $set: update },
            { new: true, runValidators: true }
        );

        // Devices store the category by name, so a rename carries them along;
        // otherwise they would all fall out of the category they were in.
        let movedDevices = 0;
        if (update.name && update.name !== existing.name) {
            const r = await Asset.updateMany(
                { adminId: req.adminId, deviceType: existing.name },
                { $set: { deviceType: update.name } }
            );
            movedDevices = r.modifiedCount || 0;
        }
        res.status(200).json({ ...category.toObject(), movedDevices });
    } catch (error) {
        if (error?.code === 11000) return res.status(409).json({ message: 'There is already a category with that name.' });
        serverError(res, error, 'The category could not be updated. Please try again.');
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Category not found' });
        const category = await AssetCategory.findOne({ _id: req.params.id, adminId: req.adminId }).lean();
        if (!category) return res.status(404).json({ message: 'Category not found' });

        const inUse = await Asset.countDocuments({ adminId: req.adminId, deviceType: category.name });
        if (inUse > 0) {
            return res.status(409).json({
                message: `"${category.name}" is used by ${inUse} device record${inUse === 1 ? '' : 's'}, so it cannot be deleted. Rename it instead, or move those devices to another category first.`,
                inUse,
            });
        }

        await AssetCategory.deleteOne({ _id: category._id, adminId: req.adminId });
        res.status(200).json({ message: 'Category deleted' });
    } catch (error) {
        serverError(res, error, 'The category could not be deleted. Please try again.');
    }
};
