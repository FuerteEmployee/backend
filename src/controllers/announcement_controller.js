const Announcement = require('../models/Announcement');
const mongoose = require('mongoose');
const { serialisePerTenant } = require('../utils/employee_lock');

// Employees read the notice board; only HR/admin write to it.
//
// The routes' checkPermission() restricts SUB-ADMINS only -- every other role,
// employees included, passes straight through it -- so without this check an
// employee's token could post, rewrite, pin or delete company-wide notices
// (signed "HR Team" or anything else) with a plain API call. The role is read
// from the database record before the JWT, so a promotion takes effect at once.
function refuseEmployee(req, res) {
    const role = req.currentUser?.role || req.user?.role;
    if (role !== 'employee') return false;
    res.status(403).json({ message: 'Only HR or an admin can change announcements.' });
    return true;
}

const TYPES = ['general', 'urgent', 'event', 'policy'];
const TITLE_MAX = 150;
const CONTENT_MAX = 5000;

// Copy only the fields a notice has. The body used to be spread straight into
// create/findOneAndUpdate: a {"$set": {"adminId": ...}} body moved a notice
// into another company, "author" could be signed as anyone, and an edit sent
// back the whole stored document (createdAt, __v, date ...). An edit is also
// validated here because findOneAndUpdate ran without validators, so a blank
// title or an unknown type was saved as sent.
function readAnnouncementInput(body, isEdit) {
    const src = body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const out = {};

    if (has('title') || !isEdit) {
        if (typeof src.title !== 'string' || !src.title.trim()) return { error: 'Please enter a title for the notice.' };
        const title = src.title.trim();
        if (title.length > TITLE_MAX) return { error: `The title is too long. Please keep it under ${TITLE_MAX} letters.` };
        out.title = title;
    }
    if (has('content') || !isEdit) {
        if (typeof src.content !== 'string' || !src.content.trim()) return { error: 'Please write the message for the notice.' };
        const content = src.content.trim();
        if (content.length > CONTENT_MAX) return { error: `The message is too long (${content.length} letters). Please keep it under ${CONTENT_MAX}.` };
        out.content = content;
    }
    if (has('type') || !isEdit) {
        const type = src.type === undefined || src.type === '' ? 'general' : src.type;
        if (!TYPES.includes(type)) return { error: 'Please choose a type: general, urgent, event or policy.' };
        out.type = type;
    }
    if (has('pinned')) {
        if (typeof src.pinned !== 'boolean') return { error: 'Pinned must be yes or no.' };
        out.pinned = src.pinned;
    }
    return { data: out };
}

const notFound = (res) => res.status(404).json({ message: 'Notice not found' });

exports.getAnnouncements = async (req, res) => {
    try {
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };
        const { type } = req.query;
        if (typeof type === 'string' && TYPES.includes(type)) query.type = type;

        const announcements = await Announcement.find(query).sort({ pinned: -1, createdAt: -1 });
        res.json(announcements);
    } catch (error) {
        console.error('GET Announcements Error:', error);
        res.status(500).json({ message: 'Could not load the notices. Please try again.' });
    }
};

exports.addAnnouncement = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        const { data, error } = readAnnouncementInput(req.body, false);
        if (error) return res.status(400).json({ message: error });
        // The same notice posted twice within a minute is one double tap: answer
        // with the notice already posted rather than publishing it twice.
        const repeat = await Announcement.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            title: data.title,
            content: data.content,
            createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
        });
        if (repeat) return res.status(200).json(repeat);
        const announcement = await Announcement.create({
            ...data,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            // Pinned to IST: on a UTC server a notice posted before 05:30 IST
            // was stamped with the previous day's date.
            date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' })
        });
        res.status(201).json(announcement);
    } catch (error) {
        console.error('Announcement Create Error:', error);
        res.status(500).json({ message: 'Could not post the notice. Please try again.' });
    }
};

exports.updateAnnouncement = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const { data, error } = readAnnouncementInput(req.body, true);
        if (error) return res.status(400).json({ message: error });
        const announcement = await Announcement.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!announcement) return notFound(res);
        res.json(announcement);
    } catch (error) {
        console.error('Announcement Update Error:', error);
        res.status(500).json({ message: 'Could not save the notice. Please try again.' });
    }
};

exports.deleteAnnouncement = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const announcement = await Announcement.findOneAndDelete({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!announcement) return notFound(res);
        res.json({ message: 'Notice deleted' });
    } catch (error) {
        console.error('Announcement Delete Error:', error);
        res.status(500).json({ message: 'Could not delete the notice. Please try again.' });
    }
};

exports.togglePin = async (req, res) => {
    if (refuseEmployee(req, res)) return;
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
        const announcement = await Announcement.findOne({ _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId) });
        if (!announcement) return notFound(res);

        announcement.pinned = !announcement.pinned;
        await announcement.save();
        res.json(announcement);
    } catch (error) {
        console.error('Announcement Pin Error:', error);
        res.status(500).json({ message: 'Could not pin the notice. Please try again.' });
    }
};

// Exposed for the QA unit check (qa/admin-festivals-notice/unit.cjs).
exports._test = { readAnnouncementInput, TITLE_MAX, CONTENT_MAX };

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.addAnnouncement = serialisePerTenant(exports.addAnnouncement, 'create');
