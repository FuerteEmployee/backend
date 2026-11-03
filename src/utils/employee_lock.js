// Run one person's conflicting actions one at a time.
//
// Why. Every punch and every "create" handler is read-then-write: look for a row, and
// if there is none, insert one. Two requests for the same person that arrive together
// (a double tap, a retry, the offline queue replaying next to a live tap) both run the
// read before either runs the write, so both insert. Measured 2026-09-30: three
// simultaneous punch-ins made a duplicate attendance day in 14 of 15 races, and two
// simultaneous expense claims, tickets, leads or leave requests each made two rows.
// 7 employee-days already carry duplicate attendance rows.
//
// What this is. A keyed queue: the second request waits for the first to finish, then
// runs its own read, which now sees the first request's row and refuses in words
// ("Already punched in today"). No new failure mode for the person; the second tap just
// gets the right answer instead of a second record.
//
// What this is NOT. It is per Node process. Production and staging each run ONE pm2
// instance, so it is a complete guard there. The durable guarantee is a unique index on
// { adminId, employeeId, dayKey } in Attendance, which needs the existing duplicate days
// merged by hand first (see models/Attendance.js). If the API is ever scaled to several
// processes this helper is not enough on its own.

// How long a waiting request is held up by one that has not finished. A request stuck on
// a slow photo upload must not block that person's next punch forever; after this the
// queue moves on (the stuck one is not cancelled, it just stops holding the line).
const MAX_HOLD_MS = Number(process.env.EMPLOYEE_LOCK_MAX_HOLD_MS) || 60 * 1000;

const tails = new Map();

/**
 * Run `fn` after every earlier `fn` for the same `key` has finished (or been held for
 * MAX_HOLD_MS). Returns fn's own result, or rethrows its error. One caller's failure never
 * blocks the next.
 */
function withEmployeeLock(key, fn) {
    const previous = tails.get(key) || Promise.resolve();
    const run = previous.then(fn);
    const release = Promise.race([
        run.then(() => undefined, () => undefined),
        new Promise((resolve) => {
            const timer = setTimeout(resolve, MAX_HOLD_MS);
            if (timer.unref) timer.unref();
        }),
    ]);
    tails.set(key, release);
    release.then(() => { if (tails.get(key) === release) tails.delete(key); });
    return run;
}

/**
 * Wrap an Express handler so one signed-in person's calls in the same `scope` run one at
 * a time. A request with no user id (which a protected route never has) just runs.
 */
function serialisePerUser(handler, scope) {
    return function serialised(req, res, next) {
        const id = req && req.userId ? String(req.userId) : null;
        if (!id) return handler(req, res, next);
        return withEmployeeLock(`${scope}:${id}`, () => handler(req, res, next));
    };
}

/** For tests: how many keys are currently queued. */
function queuedKeys() {
    return tails.size;
}

/**
 * Same as serialisePerUser, keyed on the COMPANY instead of the person. For admin
 * creates guarded only by a read-then-check ("a branch with this name already
 * exists"): two same-instant requests, from one admin's double tap or from two
 * sub-admins, both passed the check and both created. Queued, the second sees the
 * first one's row.
 */
function serialisePerTenant(handler, scope) {
    return function serialised(req, res, next) {
        const id = req && req.adminId ? String(req.adminId) : null;
        if (!id) return handler(req, res, next);
        return withEmployeeLock(`${scope}:tenant:${id}`, () => handler(req, res, next));
    };
}

module.exports = { withEmployeeLock, serialisePerUser, serialisePerTenant, queuedKeys, MAX_HOLD_MS };
