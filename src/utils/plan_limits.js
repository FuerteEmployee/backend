const Subscription = require('../models/Subscription');

/**
 * How many of something a plan allows, from a plan module value.
 *
 * The plan builder stores these as select strings ('none' | '2' | '10' | '50' |
 * 'unlimited', or '2 shifts', '50/mo'), and older plans store booleans. The
 * create handlers used to run `Number(value)`, so a boolean `true` -- "on" --
 * became a limit of ONE branch.
 *
 * Returns null for no limit, 0 for not allowed, or the numeric cap.
 */
function parsePlanLimit(value) {
    if (value === undefined || value === null || value === true || value === 'unlimited') return null;
    if (value === false || value === 'none') return 0;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    const n = parseInt(String(value), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The limit a tenant's plan puts on `moduleKey`, or null when there is none
 * (no subscription, no plan, or the module is not capped). Legacy tenants with
 * no subscription record are unlimited, matching checkModuleAccess.
 */
async function getPlanLimit(adminId, moduleKey) {
    if (!adminId) return null;
    const sub = await Subscription.findOne({ adminId }).populate('planId');
    const modules = sub?.planId?.modules;
    if (!modules) return null;
    return parsePlanLimit(modules.get?.(moduleKey) ?? modules[moduleKey]);
}

module.exports = { parsePlanLimit, getPlanLimit };
