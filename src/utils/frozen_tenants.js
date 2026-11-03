// Companies that stay on the previous production release.
//
// Production runs two backends on ONE database: the frozen old process at
// api.beontimeofficial.com serves the companies listed in FROZEN_TENANT_IDS,
// and this code serves everyone else. This process must never act for a
// frozen company -- not sign its people in, not record their punches, not let
// the super admin change its account -- or that company's data would be
// changed by code it was promised it would not see.
//
// Every refusal is a 403 with code 'frozen_tenant' and is decided BEFORE any
// write, so a refused request leaves no trace. The website reads the code and
// switches that browser to the old screens (src/lib/legacy-switch.ts).
//
// FROZEN_TENANT_IDS is a comma-separated list of tenant (admin) ids. Unset or
// empty means nobody is frozen, which is the state everywhere but production.

const MESSAGE = 'Your company uses the classic B.O.T website. Please open botcrm.beontimeofficial.com.';

function frozenIds() {
    return new Set(
        String(process.env.FROZEN_TENANT_IDS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    );
}

function isFrozenTenant(tenantId) {
    if (!tenantId) return false;
    const ids = frozenIds();
    return ids.size > 0 && ids.has(String(tenantId));
}

// The company a user belongs to: an admin IS the company; everyone else
// carries it in adminId. A super admin belongs to no company and is never frozen.
function tenantOfUser(user) {
    if (!user || user.role === 'superadmin') return null;
    return user.role === 'admin' ? user._id : user.adminId;
}

function isFrozenUser(user) {
    return isFrozenTenant(tenantOfUser(user));
}

function sendFrozen(res) {
    return res.status(403).json({ code: 'frozen_tenant', message: MESSAGE });
}

// Mongo filter fragment that leaves frozen companies out of a tenant-wide job.
// `field` is the document's tenant field (usually 'adminId').
function excludeFrozen(field = 'adminId') {
    const ids = [...frozenIds()];
    if (ids.length === 0) return {};
    const mongoose = require('mongoose');
    return { [field]: { $nin: ids.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) } };
}

module.exports = { frozenIds, isFrozenTenant, tenantOfUser, isFrozenUser, sendFrozen, excludeFrozen, MESSAGE };
