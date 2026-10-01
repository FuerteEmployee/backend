const Department = require('../models/Department');
const { getPlanLimit } = require('../utils/plan_limits');
const User = require('../models/User');
const mongoose = require('mongoose');
const { isFieldRole } = require('../utils/geofence_window');
const { serialisePerTenant } = require('../utils/employee_lock');

const MAX_NAME_LENGTH = 100;
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// See branch_controller: someone who has left never blocks a delete.
const ACTIVE_EMPLOYEE = { role: 'employee', status: { $ne: 'inactive' } };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * The fields an admin may set on a department, validated, in plain words.
 *
 * Only these are copied -- the update used to pass req.body wholesale, so a
 * body carrying `adminId` moved the department into another company. And the
 * colour was stored as typed: "purple!!" saved, and every card and badge for
 * that department then rendered with no colour at all.
 */
function readDepartmentInput(body = {}, { partial = false } = {}) {
    const data = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

    if (has('name') || !partial) {
        const name = body.name == null ? '' : String(body.name).trim();
        if (!name) return { error: 'Enter a department name.' };
        if (name.length > MAX_NAME_LENGTH) return { error: `The department name is too long (${MAX_NAME_LENGTH} characters at most).` };
        data.name = name;
    }

    if (has('colorCode')) {
        const color = String(body.colorCode).trim();
        if (!HEX_COLOR.test(color)) return { error: 'The colour must be a hex code like #6366F1.' };
        data.colorCode = color;
    }

    for (const key of ['trackingEnabled', 'autoPunchOutEnabled']) {
        if (!has(key)) continue;
        if (typeof body[key] !== 'boolean') return { error: 'Location settings must be switched on or off.' };
        data[key] = body[key];
    }

    if (has('isFieldStaff')) {
        const v = body.isFieldStaff;
        if (v !== true && v !== false && v !== null) return { error: 'Field staff must be switched on or off.' };
        data.isFieldStaff = v;
    }

    return { data, error: null };
}

function sendError(res, error, action) {
    if (error && error.name === 'ValidationError' && error.errors) {
        const first = Object.values(error.errors)[0];
        return res.status(400).json({ message: first?.message || 'Please check the form and try again.' });
    }
    console.error(`[department] ${action} failed:`, error);
    return res.status(500).json({ message: `Could not ${action} the department. Please try again.` });
}

async function findDuplicateName(adminId, name, excludeId) {
    const existing = await Department.find({ adminId }, 'name').lean();
    return existing.find((d) => String(d._id) !== String(excludeId || '') && sameName(d.name, name)) || null;
}

exports.getDepartments = async (req, res) => {
    try {
        const adminIdObj = new mongoose.Types.ObjectId(req.adminId);
        const departments = await Department.aggregate([
            { $match: { adminId: adminIdObj } },
            {
                $lookup: {
                    from: 'users',
                    let: { deptId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$adminId', adminIdObj] },
                                        { $eq: ['$role', 'employee'] },
                                        { $eq: ['$departmentId', '$$deptId'] }
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
                    name: 1,
                    colorCode: 1,
                    trackingEnabled: 1,
                    autoPunchOutEnabled: 1,
                    isFieldStaff: 1,
                    createdAt: 1,
                    employees: { $size: '$employees' },
                    // What decides whether the department may be deleted.
                    activeEmployees: {
                        $size: { $filter: { input: '$employees', cond: { $ne: ['$$this.status', 'inactive'] } } }
                    }
                }
            }
        ]);

        // Whether the auto punch-out engine treats this department as field
        // staff purely because of its NAME (isFieldRole matches words such as
        // "sales" or "field"). Computed by the engine's own function, not a
        // copy, so the page can tell the admin that auto punch-out will never
        // act here -- and warn that renaming it can silently change that.
        for (const d of departments) {
            d.fieldRole = isFieldRole({ departmentId: { name: d.name, isFieldStaff: d.isFieldStaff } });
        }
        res.json(departments);
    } catch (error) {
        sendError(res, error, 'load');
    }
};

/**
 * GET /departments/usage: how many departments the tenant has against the plan cap,
 * so the page can say "N of M used" and disable Add at the limit instead of
 * letting the admin fill in the whole form and then refusing it.
 */
exports.getDepartmentUsage = async (req, res) => {
    try {
        const [limit, used] = await Promise.all([
            getPlanLimit(req.adminId, 'branchesDepts'),
            Department.countDocuments({ adminId: req.adminId }),
        ]);
        res.json({ used, limit });
    } catch (error) {
        sendError(res, error, 'load');
    }
};

exports.createDepartment = async (req, res) => {
    try {
        // Plan cap (super admin → plan → branchesDepts). See utils/plan_limits.
        const limit = await getPlanLimit(req.adminId, 'branchesDepts');
        if (limit !== null) {
            const used = await Department.countDocuments({ adminId: req.adminId });
            if (used >= limit) {
                return res.status(400).json({
                    message: `Your plan allows ${limit} departments, and all ${limit} are in use. Ask your provider to upgrade the plan to add more.`,
                    limitReached: true, limit, used,
                });
            }
        }

        const { data, error } = readDepartmentInput(req.body);
        if (error) return res.status(400).json({ message: error });

        const adminId = new mongoose.Types.ObjectId(req.adminId);
        // Department pickers (employee form, salary and attendance filters)
        // show names only, so two called "Sales" cannot be told apart.
        const duplicate = await findDuplicateName(adminId, data.name);
        if (duplicate) {
            return res.status(409).json({ message: `A department called "${duplicate.name.trim()}" already exists. Use a different name.` });
        }

        const department = await Department.create({ ...data, adminId });
        res.status(201).json(department);
    } catch (error) {
        sendError(res, error, 'create');
    }
};

exports.updateDepartment = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Department not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const current = await Department.findOne({ _id: req.params.id, adminId }).lean();
        if (!current) return res.status(404).json({ message: 'Department not found' });

        const { data, error } = readDepartmentInput(req.body, { partial: true });
        if (error) return res.status(400).json({ message: error });

        // Only a rename is checked, so legacy duplicates stay editable.
        if (data.name !== undefined && !sameName(data.name, current.name)) {
            const duplicate = await findDuplicateName(adminId, data.name, current._id);
            if (duplicate) {
                return res.status(409).json({ message: `A department called "${duplicate.name.trim()}" already exists. Use a different name.` });
            }
        }

        const department = await Department.findOneAndUpdate(
            { _id: current._id, adminId },
            { $set: data },
            { new: true, runValidators: true }
        );
        if (!department) return res.status(404).json({ message: 'Department not found' });
        res.json(department);
    } catch (error) {
        sendError(res, error, 'update');
    }
};

exports.deleteDepartment = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Department not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const department = await Department.findOne({ _id: req.params.id, adminId });
        if (!department) return res.status(404).json({ message: 'Department not found' });

        // Refuse while anyone active is still in it. Deleting used to succeed
        // and clear their departmentId, which silently changes how they are
        // treated: department-level location tracking stops for anyone not
        // enabled individually, and a field-role name ("Sales") stops
        // exempting them from auto punch-out. That is a per-person decision.
        const activeEmployees = await User.countDocuments({ adminId, departmentId: department._id, ...ACTIVE_EMPLOYEE });
        if (activeEmployees > 0) {
            return res.status(409).json({
                message: `${plural(activeEmployees, 'active employee is', 'active employees are')} still in this department. Move them to another department first, then delete it.`,
                activeEmployees,
            });
        }

        await Department.deleteOne({ _id: department._id, adminId });

        // Clear the dangling reference on any (inactive) employee still
        // pointing at this department (mirrors deleteBranch's cleanup --
        // otherwise department-name lookups and the employee-count aggregation
        // silently corrupt for them).
        await User.updateMany({ adminId, departmentId: department._id }, { departmentId: null });

        res.json({ message: 'Department removed' });
    } catch (error) {
        sendError(res, error, 'delete');
    }
};

// Same-instant creates queue per company (utils/employee_lock.js serialisePerTenant):
// the duplicate check above reads then writes, so two requests arriving together
// both passed it and both created.
exports.createDepartment = serialisePerTenant(exports.createDepartment, 'create');
