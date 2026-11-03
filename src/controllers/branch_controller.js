const Branch = require('../models/Branch');
const { getPlanLimit } = require('../utils/plan_limits');
const User = require('../models/User');
const mongoose = require('mongoose');
const { serialisePerTenant } = require('../utils/employee_lock');

// A branch radius above this is not a fence any more -- 100 km covers a whole
// city region. Switching the branch's geo-fence off is the honest way to say
// "punch from anywhere", and it reads as that on the page.
const MAX_RADIUS_M = 100000;
// And below this it is smaller than the error of an ordinary phone fix (often
// 20-50 m indoors), so it refuses people standing inside the office.
const MIN_RADIUS_M = 50;
const MAX_NAME_LENGTH = 100;
const MAX_ADDRESS_LENGTH = 300;

// An employee who has left keeps their assignment on record, but nothing
// punches for them, so they never block a delete. Missing status reads as
// active: that is the schema default.
const ACTIVE_EMPLOYEE = { role: 'employee', status: { $ne: 'inactive' } };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * The fields an admin may set on a branch, validated, in plain words.
 *
 * Only these are copied. The update used to hand req.body straight to
 * findOneAndUpdate, so a body carrying `adminId` moved the branch into another
 * company; and the create stored whatever arrived, so `latitude: 200` or
 * `radius: -50` saved without complaint and the page then promised employees
 * "must be within -50 m". A value that cannot be a real fence is refused here,
 * with a message the admin can act on, rather than stored and discovered at
 * 9am when nobody can punch in.
 *
 * `partial` is for updates: fields absent from the body are left alone.
 */
function readBranchInput(body = {}, { partial = false } = {}) {
    const data = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

    const text = (key, { label, required, max }) => {
        if (!has(key)) {
            if (required && !partial) return `Enter the ${label}.`;
            return null;
        }
        const value = body[key] === null ? '' : String(body[key]).trim();
        if (required && !value) return `Enter the ${label}.`;
        if (value.length > max) return `The ${label} is too long (${max} characters at most).`;
        data[key] = value;
        return null;
    };

    const coordinate = (key, { label, limit }) => {
        if (!has(key)) return partial ? null : `Enter the branch ${label}, or use Auto-detect while standing at the branch.`;
        const raw = body[key];
        const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
        if (raw === null || raw === '' || typeof value !== 'number' || !Number.isFinite(value)) {
            return `The ${label} must be a number, like ${key === 'latitude' ? '22.3039' : '70.8022'}.`;
        }
        if (value < -limit || value > limit) return `The ${label} must be between -${limit} and ${limit}.`;
        data[key] = value;
        return null;
    };

    const errors = [
        text('branchName', { label: 'branch name', required: true, max: MAX_NAME_LENGTH }),
        text('branchLocation', { label: 'branch address', required: true, max: MAX_ADDRESS_LENGTH }),
        text('city', { label: 'city', required: false, max: MAX_NAME_LENGTH }),
        coordinate('latitude', { label: 'latitude', limit: 90 }),
        coordinate('longitude', { label: 'longitude', limit: 180 }),
    ];

    // 0,0 is a point in the Atlantic off West Africa. It is what an empty form
    // sends, never where an office is -- and a fence there refuses every punch
    // as thousands of kilometres away. One branch in the database already sat
    // on it.
    if (data.latitude === 0 && data.longitude === 0) {
        errors.push('Set the branch location: latitude and longitude cannot both be 0. Use Auto-detect at the branch, or copy them from Google Maps.');
    }

    if (has('radius')) {
        const raw = body.radius;
        // Blank or 0 means "use the company default" -- which is what 0 already
        // meant to the punch check (nearestBranchDistance ignores radius <= 0).
        // Stored as null so it reads as a choice rather than a zero-metre fence.
        if (raw === null || raw === '' || raw === 0 || raw === '0') {
            data.radius = null;
        } else {
            const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
            if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_RADIUS_M || value > MAX_RADIUS_M) {
                errors.push(`The radius must be between ${MIN_RADIUS_M} m and ${MAX_RADIUS_M / 1000} km, or left blank to use the company default.`);
            } else {
                data.radius = Math.round(value);
            }
        }
    }

    if (has('geoFenceEnabled')) {
        if (typeof body.geoFenceEnabled !== 'boolean') errors.push('Geo-fence must be switched on or off.');
        else data.geoFenceEnabled = body.geoFenceEnabled;
    }

    const error = errors.find(Boolean) || null;
    return { data, error };
}

// A Mongoose error, or anything else unexpected, never reaches the admin
// verbatim ("Cast to Number failed for value ..."): validation problems keep
// their (schema-written, human) message, the rest become a generic retry.
function sendError(res, error, action) {
    if (error && error.name === 'ValidationError' && error.errors) {
        const first = Object.values(error.errors)[0];
        return res.status(400).json({ message: first?.message || 'Please check the form and try again.' });
    }
    console.error(`[branch] ${action} failed:`, error);
    return res.status(500).json({ message: `Could not ${action} the branch. Please try again.` });
}

async function findDuplicateName(adminId, name, excludeId) {
    const existing = await Branch.find({ adminId }, 'branchName').lean();
    return existing.find((b) => String(b._id) !== String(excludeId || '') && sameName(b.branchName, name)) || null;
}

exports.getBranches = async (req, res) => {
    try {
        const adminIdObj = new mongoose.Types.ObjectId(req.adminId);
        const branches = await Branch.aggregate([
            { $match: { adminId: adminIdObj } },
            {
                // Count employees whose primary branch OR any of their multiple branches is this branch
                $lookup: {
                    from: 'users',
                    let: { branchId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$adminId', adminIdObj] },
                                        { $eq: ['$role', 'employee'] },
                                        {
                                            $or: [
                                                { $eq: ['$branchId', '$$branchId'] },
                                                { $in: ['$$branchId', { $ifNull: ['$branchIds', []] }] }
                                            ]
                                        }
                                    ]
                                }
                            }
                        },
                        // Only the status is needed to count; the lookup used to
                        // pull every matching user document in full.
                        { $project: { status: 1 } }
                    ],
                    as: 'employees'
                }
            },
            {
                $project: {
                    _id: 1,
                    branchName: 1,
                    branchLocation: 1,
                    city: 1,
                    latitude: 1,
                    longitude: 1,
                    radius: 1,
                    // Without this the admin panel could never show, let alone
                    // edit, the per-branch fence switch: the field existed on
                    // the schema but the list projection dropped it, so every
                    // branch read back as undefined.
                    geoFenceEnabled: 1,
                    createdAt: 1,
                    employees: { $size: '$employees' },
                    // What decides whether the branch may be deleted (see
                    // deleteBranch), so the page can say so before the click.
                    activeEmployees: {
                        $size: { $filter: { input: '$employees', cond: { $ne: ['$$this.status', 'inactive'] } } }
                    }
                }
            }
        ]);
        res.json(branches);
    } catch (error) {
        sendError(res, error, 'load');
    }
};

/**
 * GET /branches/usage: how many branches the tenant has against the plan cap,
 * so the page can say "N of M used" and disable Add at the limit instead of
 * letting the admin fill in the whole form and then refusing it.
 */
exports.getBranchUsage = async (req, res) => {
    try {
        const [limit, used] = await Promise.all([
            getPlanLimit(req.adminId, 'branchesDepts'),
            Branch.countDocuments({ adminId: req.adminId }),
        ]);
        res.json({ used, limit });
    } catch (error) {
        sendError(res, error, 'load');
    }
};

exports.createBranch = async (req, res) => {
    try {
        // Plan cap (super admin → plan → branchesDepts). See utils/plan_limits.
        const limit = await getPlanLimit(req.adminId, 'branchesDepts');
        if (limit !== null) {
            const used = await Branch.countDocuments({ adminId: req.adminId });
            if (used >= limit) {
                return res.status(400).json({
                    message: `Your plan allows ${limit} branches, and all ${limit} are in use. Ask your provider to upgrade the plan to add more.`,
                    limitReached: true, limit, used,
                });
            }
        }

        const { data, error } = readBranchInput(req.body);
        if (error) return res.status(400).json({ message: error });

        const adminId = new mongoose.Types.ObjectId(req.adminId);
        // Two branches with the same name make every branch picker ambiguous
        // (employee form, attendance and tracking filters show names only).
        const duplicate = await findDuplicateName(adminId, data.branchName);
        if (duplicate) {
            return res.status(409).json({ message: `A branch called "${duplicate.branchName.trim()}" already exists. Use a different name.` });
        }

        const branch = await Branch.create({ ...data, adminId });
        res.status(201).json(branch);
    } catch (error) {
        sendError(res, error, 'create');
    }
};

exports.updateBranch = async (req, res) => {
    try {
        // A malformed id is simply a branch that does not exist here; letting it
        // reach the query produced a raw CastError.
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Branch not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const current = await Branch.findOne({ _id: req.params.id, adminId }).lean();
        if (!current) return res.status(404).json({ message: 'Branch not found' });

        const { data, error } = readBranchInput(req.body, { partial: true });
        if (error) return res.status(400).json({ message: error });

        // Only a rename is checked, so a pair of legacy duplicates can still
        // have their radius or address edited without being forced apart first.
        if (data.branchName !== undefined && !sameName(data.branchName, current.branchName)) {
            const duplicate = await findDuplicateName(adminId, data.branchName, current._id);
            if (duplicate) {
                return res.status(409).json({ message: `A branch called "${duplicate.branchName.trim()}" already exists. Use a different name.` });
            }
        }

        const branch = await Branch.findOneAndUpdate(
            { _id: current._id, adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!branch) return res.status(404).json({ message: 'Branch not found' });
        res.json(branch);
    } catch (error) {
        sendError(res, error, 'update');
    }
};

exports.deleteBranch = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Branch not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const branch = await Branch.findOne({ _id: req.params.id, adminId });
        if (!branch) return res.status(404).json({ message: 'Branch not found' });

        // Refuse while anyone active still works here.
        //
        // Deleting used to succeed and quietly re-point those employees to
        // their next branch, or to none. An employee left with no branch is
        // then REFUSED every punch while the company requires location ("No
        // branch assigned. Cannot verify location." -- and the app, which
        // treats a branch-less employee as remote, shows "Remote punch is
        // disabled" instead). Nobody is told until they are stood at the door
        // at 9am. Moving them first is a decision the admin should make, per
        // person, with the employee list in front of them.
        const assigned = { adminId, $or: [{ branchId: branch._id }, { branchIds: branch._id }] };
        const activeEmployees = await User.countDocuments({ ...assigned, ...ACTIVE_EMPLOYEE });
        if (activeEmployees > 0) {
            return res.status(409).json({
                message: `${plural(activeEmployees, 'active employee is', 'active employees are')} still assigned to this branch. Move them to another branch first, then delete it.`,
                activeEmployees,
            });
        }

        await Branch.deleteOne({ _id: branch._id, adminId });

        // Clean up references on the (inactive) employees left, so no one
        // points to a deleted branch if they are ever reactivated.
        // 1. Remove it from everyone's multi-branch list.
        await User.updateMany(
            { adminId, branchIds: branch._id },
            { $pull: { branchIds: branch._id } }
        );
        // 2. Re-point anyone whose PRIMARY branch was this one to their first
        //    remaining branch (or null if they have none left).
        const affected = await User.find({ adminId, branchId: branch._id });
        for (const u of affected) {
            u.branchId = (u.branchIds && u.branchIds.length > 0) ? u.branchIds[0] : null;
            await u.save();
        }

        res.json({ message: 'Branch removed' });
    } catch (error) {
        sendError(res, error, 'delete');
    }
};

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.createBranch = serialisePerTenant(exports.createBranch, 'create');
