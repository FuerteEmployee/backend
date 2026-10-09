const User = require('../models/User');
const Branch = require('../models/Branch');
const Department = require('../models/Department');
const Shift = require('../models/Shift');
const Attendance = require('../models/Attendance');
const { MAX_SESSIONS } = require('../utils/shift_status');
const Festival = require('../models/Festival');
const Subscription = require('../models/Subscription');
const LoginSession = require('../models/LoginSession');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { decrypt: decryptSecret } = require('../utils/reversible_crypto');
const mongoose = require('mongoose');
const { friendlyMongooseError } = require('../utils/mongoose_errors');
const { istStartOfDay, istEndOfDay, istDateKey } = require('../utils/attendance_helpers');
const { isFrozenUser, sendFrozen } = require('../utils/frozen_tenants');

/**
 * Normalise a Biometric Device ID (the PIN an employee is enrolled under on a
 * physical eSSL/ZKTeco terminal) and reject duplicates within the tenant.
 *
 * A pushed punch identifies the person by nothing but this PIN, so it has to map
 * to exactly one employee per company. Blank input becomes null rather than ""
 * so unmapped employees don't all collide with each other under the partial
 * unique index on { adminId, deviceUserId }.
 *
 * Mutates `data` in place. Returns an error message string, or null if fine.
 */
async function normalizeDeviceUserId(data, adminId, excludeUserId = null) {
    if (!Object.prototype.hasOwnProperty.call(data, 'deviceUserId')) return null;

    const raw = data.deviceUserId;
    const trimmed = raw === null || raw === undefined ? '' : String(raw).trim();

    if (!trimmed) {
        data.deviceUserId = null;
        return null;
    }

    data.deviceUserId = trimmed;

    const query = { adminId: new mongoose.Types.ObjectId(adminId), deviceUserId: trimmed };
    if (excludeUserId) {
        query._id = { $ne: mongoose.Types.ObjectId.isValid(excludeUserId)
            ? new mongoose.Types.ObjectId(excludeUserId)
            : excludeUserId };
    }

    const clash = await User.findOne(query).select('name');
    if (clash) {
        return `Biometric Device ID "${trimmed}" is already assigned to ${clash.name}. Each employee needs a unique ID, otherwise punches from the machine can't tell them apart.`;
    }
    return null;
}

// Generate JWT
/**
 * Canonicalise an IP before it lands in the audit table.
 *
 * Node reports IPv4 clients as IPv4-mapped IPv6 on a dual-stack socket, so a
 * real address arrives as "::ffff:203.0.113.9" — the prefix is noise an admin
 * shouldn't have to mentally strip. Loopback likewise arrives as "::1", which
 * reads as garbage in the UI; store the canonical 127.0.0.1 instead. Loopback
 * means the request reached the API on the same host: local development, or a
 * production request that arrived without X-Forwarded-For.
 */
const normalizeIp = (ip) => {
    if (!ip) return null;
    const stripped = String(ip).replace(/^::ffff:/i, '').trim();
    if (!stripped) return null;
    return stripped === '::1' ? '127.0.0.1' : stripped;
};

const isLoopbackOrPrivate = (ip) =>
    !!ip && (ip === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i.test(ip));

/**
 * The client's address, or null when it cannot be told apart from other clients.
 *
 * In production the API sits behind Nginx, so the socket peer is loopback and
 * the client is in X-Forwarded-For. Only the LAST entry of that header is
 * trustworthy: it is the one the nearest proxy appended. The first entry is
 * whatever the client itself sent, so reading it (as this file used to) let
 * anyone write any address into the access log -- or dodge a per-address limit
 * by sending a new one on every request.
 *
 * A loopback peer with no forwarding header (local development) returns null:
 * every request looks identical, so a per-address limit must not apply.
 */
const clientIp = (req) => {
    const peer = normalizeIp(req.socket?.remoteAddress || req.ip);
    if (peer && !isLoopbackOrPrivate(peer)) return peer;
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return hops.length ? normalizeIp(hops[hops.length - 1]) : null;
};

/**
 * Append a login/logout row to the real access log.
 *
 * Never allowed to fail the surrounding request: an audit write that blocks a
 * login would turn a logging problem into an outage.
 */
const recordSession = async (user, action, req, extra = {}) => {
    try {
        const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
        await LoginSession.create({
            ipAddress: clientIp(req) || normalizeIp(req.socket?.remoteAddress || req.ip),
            adminId: user.role === 'admin' || user.role === 'superadmin' ? user._id : user.adminId,
            userId: user._id,
            name: user.name,
            role: user.role,
            phone: user.phone,
            action,
            userAgent: (req.headers['user-agent'] || '').slice(0, 512) || null,
            // Client-supplied: only ever short strings, never an object.
            appName: clip(extra.appName, 32),
            installId: clip(extra.installId, 64),
            appVersion: clip(extra.appVersion, 32),
        });
    } catch (err) {
        console.error('[session-log] failed to record', action, err.message);
    }
};

const generateToken = (user) => {
    return jwt.sign(
        {
            userId: user._id,
            adminId: user.role === 'superadmin' ? user._id : (user.role === 'admin' ? user._id : user.adminId),
            role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
};

// --- AUTH LOGIC ---

/**
 * The 10-digit login ID from whatever the phone field held, or null.
 *
 * Every stored phone is exactly ten digits. People paste "+91 98765 43210",
 * "098765 43210" or "98765-43210"; all of those are the same number. Anything
 * that is not a string or a number is refused outright: an object such as
 * {"$regex": "^9"} used to reach User.findOne unchanged, which returned the
 * first matching account, issued it an OTP and then signed the caller in.
 */
const normalizeLoginPhone = (raw) => {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const text = String(raw).trim();
    if (!text || text.length > 20 || !/^\+?[\d\s\-().]+$/.test(text)) return null;
    let digits = text.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return /^\d{10}$/.test(digits) ? digits : null;
};

const normalizeLoginOtp = (raw) => {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const text = String(raw).trim();
    return /^\d{6}$/.test(text) ? text : null;
};

/**
 * In-process login throttles, the same shape as the ATTLOG dedupe in
 * utils/device_registry.js. They live in memory, so they reset on a restart
 * and are per process: fine for the single EC2 process, not for a
 * multi-instance or serverless deployment.
 *
 * Three limits, each env-overridable:
 *  - LOGIN_MAX_WRONG_OTP (5): wrong codes against one issued OTP. Past it the
 *    OTP is deleted and the person must ask for a new one. A 6-digit code could
 *    otherwise be guessed at request speed -- 12 wrong tries followed by the
 *    right one still signed in.
 *  - LOGIN_MAX_OTP_REQUESTS (6 per 15 min): codes asked for one phone without
 *    a successful sign-in. A successful sign-in clears it, so the ordinary
 *    "ask, type, in" flow never counts up.
 *  - LOGIN_MAX_IP_FAILURES (30 per 15 min): unknown numbers and wrong or
 *    expired codes from one address. Only failures count, because a whole
 *    office signs in from one address at 9:30.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const envInt = (name, dflt) => {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
};
const LOGIN_MAX_WRONG_OTP = envInt('LOGIN_MAX_WRONG_OTP', 5);
const LOGIN_MAX_OTP_REQUESTS = envInt('LOGIN_MAX_OTP_REQUESTS', 6);
const LOGIN_MAX_IP_FAILURES = envInt('LOGIN_MAX_IP_FAILURES', 30);
const OTP_TTL_MS = 10 * 60 * 1000;

const loginCounters = new Map(); // key -> { count, firstAt }
const counterGet = (key) => {
    const c = loginCounters.get(key);
    if (!c) return null;
    if (Date.now() - c.firstAt >= LOGIN_WINDOW_MS) { loginCounters.delete(key); return null; }
    return c;
};
const counterCount = (key) => counterGet(key)?.count || 0;
const counterBump = (key) => {
    const c = counterGet(key);
    if (c) c.count += 1;
    else loginCounters.set(key, { count: 1, firstAt: Date.now() });
    if (loginCounters.size > 5000) {
        const cutoff = Date.now() - LOGIN_WINDOW_MS;
        for (const [k, v] of loginCounters) if (v.firstAt < cutoff) loginCounters.delete(k);
    }
    return counterCount(key);
};
const counterReset = (key) => loginCounters.delete(key);
const minutesLeft = (key) => {
    const c = counterGet(key);
    return c ? Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - c.firstAt)) / 60000)) : 1;
};
const waitWords = (mins) => (mins <= 1 ? '1 minute' : `${mins} minutes`);

const tooManyFromIp = (res, ipKey) => res.status(429).json({
    code: 'too_many_attempts',
    message: `Too many tries from this network. Please wait ${waitWords(minutesLeft(ipKey))} and try again.`,
});
const ipFailure = (ipKey) => { if (ipKey) counterBump(ipKey); };

const EMPLOYEE_COMPANY_OFF = "Your company's B.O.T account is switched off, so you cannot sign in. Please tell your admin.";
const SUBADMIN_COMPANY_OFF = "Your company's B.O.T account is switched off, so you cannot sign in. Please tell your company owner.";
const EMPLOYEE_COMPANY_ATTENTION = "Your company's B.O.T account needs attention, so the app is not available right now. Please tell your admin.";

/**
 * Why this person may not sign in right now, or null. Checked both when the
 * code is asked for (so no OTP is issued at all) and again when it is
 * verified (the state may have changed within the code's ten minutes).
 *
 *  - The account itself switched off (status, or isActive for panel roles).
 *  - Employees and sub-admins of a switched-off company. The tenant used to
 *    be checked only by `protect`, after sign-in, so these people got an OTP
 *    and then saw every screen fail with "tenant inactive".
 *  - Employees of a company whose subscription is expired, cancelled, paused
 *    or past its trial -- the same test checkSubscription applies. The admin
 *    still signs in (to renew) and so do sub-admins (they see the notice).
 */
const loginRefusal = async (user) => {
    if (user.status === 'inactive' || (user.role !== 'employee' && user.isActive === false)) {
        return {
            status: 403,
            code: 'account_inactive',
            message: user.inactiveReason?.trim() || 'Your account is inactive. Please contact your admin.',
            name: user.name,
        };
    }
    if (user.role !== 'employee' && user.role !== 'subadmin') return null;

    const admin = user.adminId
        ? await User.findOne({ _id: user.adminId, role: 'admin' }).select('isActive status').lean()
        : null;
    if (!admin || admin.isActive === false || admin.status === 'inactive') {
        return {
            status: 403,
            code: 'company_inactive',
            message: user.role === 'employee' ? EMPLOYEE_COMPANY_OFF : SUBADMIN_COMPANY_OFF,
        };
    }

    if (user.role === 'employee') {
        const sub = await Subscription.findOne({ adminId: admin._id }).select('status trialEndDate').lean();
        const blocked = sub && (
            ['expired', 'cancelled', 'paused'].includes(sub.status)
            || (sub.status === 'trial' && sub.trialEndDate && new Date(sub.trialEndDate) < new Date())
        );
        if (blocked) {
            return {
                status: 403,
                code: 'company_subscription',
                subscriptionStatus: sub.status === 'trial' ? 'expired' : sub.status,
                message: EMPLOYEE_COMPANY_ATTENTION,
            };
        }
    }
    return null;
};
const sendRefusal = (res, refusal) => {
    const { status, ...body } = refusal;
    return res.status(status).json(body);
};

// BOTLens (the camera console) is admin-only -- employees mark attendance via
// the camera itself, they never need to log in there. Keyed off the `app` flag
// the BOTLens client sends, so the shared login endpoint stays unrestricted
// for every other caller.
const BOTLENS_ADMIN_ONLY = { message: 'Only company admins can access BOTLens. Please contact your administrator.' };

exports.loginRequest = async (req, res) => {
    const { app } = req.body || {};
    try {
        const phone = normalizeLoginPhone(req.body?.phone);
        if (!phone) {
            return res.status(400).json({ code: 'bad_phone', message: 'Please enter your 10-digit mobile number.' });
        }

        const ip = clientIp(req);
        const ipKey = ip ? `ip:${ip}` : null;
        if (ipKey && counterCount(ipKey) >= LOGIN_MAX_IP_FAILURES) return tooManyFromIp(res, ipKey);

        const reqKey = `req:${phone}`;
        if (counterCount(reqKey) >= LOGIN_MAX_OTP_REQUESTS) {
            return res.status(429).json({
                code: 'too_many_requests',
                message: `Too many codes asked for this number. Please wait ${waitWords(minutesLeft(reqKey))} and try again.`,
            });
        }

        const user = await User.findOne({ phone });
        if (!user) {
            ipFailure(ipKey);
            // The "no account" message is a product decision: most users read
            // little English and need to be told to ask their admin. It does
            // reveal whether a number is registered.
            return res.status(404).json({ code: 'not_registered', message: 'You are not registered. Please contact your admin to register you first.' });
        }

        // A company kept on the previous release signs in there, never here.
        if (isFrozenUser(user)) return sendFrozen(res);

        if (app === 'botlens' && user.role !== 'admin') return res.status(403).json(BOTLENS_ADMIN_ONLY);

        const refusal = await loginRefusal(user);
        if (refusal) return sendRefusal(res, refusal);

        // No SMS gateway is wired up -- the OTP is shown directly on screen, so
        // it's generated here and returned as-is rather than sent out-of-band.
        const otp = String(crypto.randomInt(100000, 1000000));
        // updateOne rather than save(): a legacy record that fails today's
        // validation must not make its owner unable to sign in.
        await User.updateOne({ _id: user._id }, { $set: { otp, otpExpiry: new Date(Date.now() + OTP_TTL_MS) } });
        counterBump(reqKey);
        counterReset(`wrong:${phone}`); // a fresh code gets a fresh set of tries

        res.status(200).json({ message: 'OTP generated', otp, expiresInSeconds: OTP_TTL_MS / 1000 });
    } catch (error) {
        console.error("Login Request Error:", error);
        res.status(500).json({ message: 'Could not send the code. Please try again.' });
    }
};

exports.verifyOtp = async (req, res) => {
    const { app } = req.body || {};
    try {
        const phone = normalizeLoginPhone(req.body?.phone);
        if (!phone) {
            return res.status(400).json({ code: 'bad_phone', message: 'Please enter your 10-digit mobile number.' });
        }
        const otp = normalizeLoginOtp(req.body?.otp);
        if (!otp) return res.status(400).json({ code: 'bad_otp', message: 'Please enter the 6-digit code.' });

        const ip = clientIp(req);
        const ipKey = ip ? `ip:${ip}` : null;
        if (ipKey && counterCount(ipKey) >= LOGIN_MAX_IP_FAILURES) return tooManyFromIp(res, ipKey);

        const wrongKey = `wrong:${phone}`;
        const user = await User.findOne({ phone });

        // Before the code is even looked at: a code the previous release issued
        // to a frozen company's user must not be consumed (or honoured) here.
        if (user && isFrozenUser(user)) return sendFrozen(res);

        // No pending code (never asked, already used, or deleted after too many
        // wrong tries) is "expired". The old check compared the stored value to
        // the submitted one, so a request with NO otp against an account with
        // no pending code matched undefined === undefined and signed in.
        if (!user || !user.otp || !user.otpExpiry || user.otpExpiry < new Date()) {
            ipFailure(ipKey);
            return res.status(400).json({ code: 'otp_expired', message: 'This code has expired. Please ask for a new code.' });
        }

        // Re-checked here (not just at login-request) so an OTP issued via
        // another app's login flow can't be replayed against BOTLens for a
        // non-admin phone number.
        if (app === 'botlens' && user.role !== 'admin') return res.status(403).json(BOTLENS_ADMIN_ONLY);

        // Checked before comparing, and synchronously with the bump below, so
        // parallel guesses cannot all slip past the limit.
        if (counterCount(wrongKey) >= LOGIN_MAX_WRONG_OTP) {
            ipFailure(ipKey);
            return res.status(429).json({ code: 'otp_locked', message: 'Too many wrong codes. Please ask for a new code.' });
        }

        const stored = Buffer.from(String(user.otp));
        const given = Buffer.from(otp);
        const matches = stored.length === given.length && crypto.timingSafeEqual(stored, given);
        if (!matches) {
            ipFailure(ipKey);
            const wrong = counterBump(wrongKey);
            const left = LOGIN_MAX_WRONG_OTP - wrong;
            if (left <= 0) {
                // Delete the code: the limit then survives a restart too.
                await User.updateOne({ _id: user._id, otp: user.otp }, { $unset: { otp: 1, otpExpiry: 1 } });
                return res.status(429).json({ code: 'otp_locked', message: 'Too many wrong codes. Please ask for a new code.' });
            }
            return res.status(400).json({
                code: 'otp_wrong',
                message: `Wrong code. Please check and try again (${left} ${left === 1 ? 'try' : 'tries'} left).`,
                attemptsLeft: left,
            });
        }

        // Single use, atomically: of two requests carrying the same correct
        // code, only the one that removes it gets a token.
        const consumed = await User.updateOne({ _id: user._id, otp: user.otp }, { $unset: { otp: 1, otpExpiry: 1 } });
        if (!consumed.modifiedCount) {
            return res.status(400).json({ code: 'otp_expired', message: 'This code has expired. Please ask for a new code.' });
        }
        counterReset(wrongKey);

        // Re-checked here: the account or the company may have been switched
        // off in the ten minutes the code was valid.
        const refusal = await loginRefusal(user);
        if (refusal) return sendRefusal(res, refusal);

        counterReset(`req:${phone}`);
        const token = generateToken(user);
        // Stored but deliberately not enforced: multi-device login is allowed.
        await User.updateOne({ _id: user._id }, { $set: { activeToken: token } });

        await recordSession(user, 'login', req, {
            appName: typeof app === 'string' && app ? app : 'web',
            installId: req.body.installId,
            appVersion: req.body.appVersion,
        });

        // For subadmin, pull company info from the parent admin
        let companyName = user.companyName;
        let companyLogo = user.companyLogo;
        let address = user.address;
        let email = user.email;
        if (user.role === 'subadmin' && user.adminId) {
            const admin = await User.findById(user.adminId).select('companyName companyLogo address email').lean();
            if (admin) {
                companyName = admin.companyName;
                companyLogo = admin.companyLogo;
                address = admin.address;
                email = admin.email;
            }
        }

        res.status(200).json({
            _id: user._id,
            // The tenant this session belongs to -- their own id for an admin,
            // the parent's for a subadmin/employee. Mirrors what generateToken
            // puts in the JWT. The app sends it back as Capgo's custom_id so a
            // release can be piloted on one company.
            adminId: user.role === 'admin' || user.role === 'superadmin' ? user._id : user.adminId,
            name: user.name,
            phone: user.phone,
            role: user.role,
            companyName,
            companyLogo,
            address,
            email,
            token,
            permissions: user.role === 'subadmin' ? (user.permissions || {}) : undefined,
        });
    } catch (error) {
        console.error("Verify OTP Error:", error);
        res.status(500).json({ message: 'Could not sign you in. Please try again.' });
    }
};

// Re-confirms the logged-in admin's identity using the separate BOTLens
// email+password pair (set by the super admin), before BOTLens allows adding
// a new employee. Deliberately not a login endpoint — it issues no token,
// it only checks the credentials against the account already authenticated
// by the request's JWT.
exports.verifyBotlensCredentials = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findById(req.userId);
        if (!user || !user.botlensEmail || !user.botlensPasswordEnc) {
            return res.status(403).json({ message: 'No BOTLens credentials are configured for this account. Ask your super admin to set them first.' });
        }
        if (!email || user.botlensEmail.toLowerCase() !== String(email).trim().toLowerCase()) {
            return res.status(401).json({ message: 'Incorrect email or password' });
        }
        const actual = decryptSecret(user.botlensPasswordEnc) || '';
        const given = password || '';
        const match = actual.length === given.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(given));
        if (!match) {
            return res.status(401).json({ message: 'Incorrect email or password' });
        }
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Never sent back through the profile routes, even to the account's own owner.
// activeToken is the caller's own JWT echoed back: anything that records
// responses (a proxy log, a crash report, a screenshot of devtools) would then
// hold a working credential. otp/otpExpiry are sign-in secrets, and the BOTLens
// pair belongs to the retired kiosk integration and is read only by super admin.
const PRIVATE_PROFILE_FIELDS = ['activeToken', 'otp', 'otpExpiry', 'botlensPasswordEnc', 'botlensEmail'];
const stripPrivateProfileFields = (obj) => {
    for (const field of PRIVATE_PROFILE_FIELDS) delete obj[field];
    return obj;
};

// The "sensitive set" an employee may change on their OWN record only when the
// admin allows it (Settings.employeeSelfService.allowSensitiveEdits, default
// off): legal name, bank details, PAN and Aadhaar -- numbers and scans. Salary
// is paid to the account on file, so this is what stops a borrowed or stolen
// phone from redirecting someone's pay. Only employees are gated; an admin or
// sub-admin editing their own profile is not, and admin edits to an employee
// go through updateUser, which this does not touch.
const BANK_DETAIL_FIELDS = ['accountNumber', 'bankName', 'ifsc', 'branchName', 'nameAsPerBank'];
const canEditSensitiveDetails = (user, settings) =>
    user?.role !== 'employee' || settings?.employeeSelfService?.allowSensitiveEdits === true;

// Forms resend every field, so "present in the body" is not "changed". Blank,
// null and missing all read as the same empty value, and surrounding spaces
// are ignored, so re-saving an untouched form never counts as an edit.
const sameText = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

// Which parts of the sensitive set this update would actually change.
function sensitiveChanges(current, updateData, files) {
    const changed = new Set();
    if (updateData.name !== undefined && !sameText(updateData.name, current.name)) changed.add('name');
    if (updateData.panNo !== undefined && !sameText(updateData.panNo, current.panNo)) changed.add('pan');
    if (updateData.aadhaarNo !== undefined && !sameText(updateData.aadhaarNo, current.aadhaarNo)) changed.add('aadhaar');
    if (updateData.bankDetails) {
        const stored = current.bankDetails || {};
        if (BANK_DETAIL_FIELDS.some(k => updateData.bankDetails[k] !== undefined && !sameText(updateData.bankDetails[k], stored[k]))) {
            changed.add('bank');
        }
    }
    // An uploaded scan can never be "unchanged": it replaces what is on file.
    if (files?.panCard?.length) changed.add('pan');
    if (files?.aadhaarCard?.length) changed.add('aadhaar');
    return changed;
}

function sensitiveRefusalMessage(changed) {
    const idChange = changed.has('bank') || changed.has('pan') || changed.has('aadhaar');
    if (changed.has('name') && !idChange) return 'Ask HR to change your name.';
    if (changed.has('name')) return 'Ask HR to change your name, bank, PAN or Aadhaar details.';
    return 'Ask HR to change your bank, PAN or Aadhaar details.';
}

exports.getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.userId).populate('shiftId shiftIds branchId branchIds departmentId');
        if (!user) return res.status(404).json({ message: 'User not found' });

        // The WORKING day, which for a night shift after midnight is the row
        // opened last night. The calendar day made Home offer Punch In to
        // somebody half way through their shift.
        const { findWorkingDay } = require('../utils/working_day');

        const [workDay, recentAttendance, upcomingHolidays, settings] = await Promise.all([
            findWorkingDay({
                Attendance,
                adminId: user.adminId || user._id,
                employeeId: user._id,
                shift: user.shiftId,
            }),
            Attendance.find({ employeeId: user._id })
                .sort({ date: -1 })
                .limit(5),
            // The company's NEXT holidays. Unfiltered, this returned the 50
            // oldest festivals, so the Home card listed January's as upcoming.
            Festival.find({
                adminId: user.adminId || user._id,
                endDate: { $gte: istDateKey() },
            }).sort({ startDate: 1 }).limit(5),
            require('../models/Settings').findOne({ adminId: user.adminId || user._id })
        ]);

        const userObj = stripPrivateProfileFields(user.toObject());
        // Resolved here rather than letting the app read tenant settings, which
        // employees cannot (and should not) do. The app shows bank, PAN, Aadhaar
        // and name as read-only when false; updateProfile enforces the same rule.
        userObj.canEditSensitiveDetails = canEditSensitiveDetails(user, settings);
        userObj.todayAttendance = workDay.row || null;
        userObj.recentAttendance = recentAttendance;
        userObj.upcomingHolidays = upcomingHolidays;
        userObj.allowMultiplePunches = settings?.attendance?.allowMultiplePunches || false;
        // Sent rather than hardcoded in the app: the cap is env-overridable
        // (MAX_DAILY_SESSIONS), so a client with its own copy of "5" would
        // silently disagree with the server the first time anyone changed it —
        // and the employee would see a live button that always fails.
        userObj.maxDailySessions = MAX_SESSIONS;

        // Whether punch-in closes at shift end, and how long after it. Home
        // used to hide Punch In at shift end regardless, so a tenant that
        // switched the block off (or gave a late window) still saw "Your shift
        // ended" -- a refusal the server would never have made.
        userObj.punchInAfterShiftEnd = {
            blocked: settings?.attendance?.blockPunchInAfterShiftEnd !== false,
            graceMins: Math.max(0, Number(settings?.attendance?.punchInGraceAfterShiftEndMins) || 0),
        };

        // May this employee declare a day Work From Home?
        //
        // Resolved with the SAME function the punch endpoint uses to accept or
        // refuse the punch (per-employee attendanceExceptions override, else
        // the tenant default), so the toggle is offered exactly when it would
        // work. Sent rather than derived on the phone for the same reason
        // maxDailySessions is: the rule has one home, and the client showing a
        // control the server then refuses is the failure being avoided.
        //
        // An employee with NO branch is remote by definition and is already
        // sent isWFH on every punch, so the toggle is pointless for them --
        // the app hides it and nothing changes.
        const { getAttendanceRules } = require('./attendance_controller');
        userObj.canWorkFromHome = !!getAttendanceRules(user, settings).remotePunch;

        // EFFECTIVE tracking flag, resolved server-side.
        //
        // The app starts the background tracker on profile.trackingEnabled, so
        // the department policy has to be folded in HERE -- the phone has no
        // business knowing how the two settings compose, and leaving it to the
        // client would mean the rule lived in two places and eventually drifted.
        //
        // OR, not AND: sixteen employees were enabled individually before the
        // department field existed, and requiring both would have switched every
        // one of them off silently the moment this shipped.
        userObj.trackingEnabled = user.trackingEnabled === true
            || user.departmentId?.trackingEnabled === true;

        // When tracking runs: 'on_duty' (punch-in to punch-out) or 'always'. The
        // app shows it to the employee in words, so they know which applies.
        userObj.trackingMode = settings?.attendance?.trackingMode === 'always' ? 'always' : 'on_duty';

        // Surfaced so the app can explain WHY it is tracking, rather than the
        // employee discovering a location icon with no account of it.
        userObj.trackingPolicy = {
            fromEmployee: user.trackingEnabled === true,
            fromDepartment: user.departmentId?.trackingEnabled === true,
            departmentName: user.departmentId?.name || null,
            autoPunchOutEnabled: user.departmentId?.autoPunchOutEnabled === true,
        };

        res.json(userObj);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Return the current tenant's subscription status for the logged-in admin/subadmin.
// Intentionally NOT gated by subscription middleware so the frontend can still
// read the status (and render the trial/expired notice) even after expiry.
/**
 * POST /api/users/logout
 *
 * Exists so the access log has a real logout event to pair with each login —
 * sessions were previously cleared client-side only, leaving the server with no
 * idea a session had ended. Also drops activeToken.
 *
 * Always responds 200: the client is going to clear its session regardless, and
 * a failed logout call must not leave the user stuck on a screen they've asked
 * to leave.
 */
exports.logout = async (req, res) => {
    try {
        const user = req.currentUser || await User.findById(req.userId);
        if (user) {
            await recordSession(user, 'logout', req, { appName: req.body?.app || 'web' });
            // updateOne, not save(): a record failing today's validation must
            // not turn a sign-out into an error.
            await User.updateOne({ _id: user._id }, { $unset: { activeToken: 1 } });
        }
    } catch (error) {
        console.error('[logout] failed', error.message);
    }
    res.status(200).json({ ok: true });
};

exports.getMySubscription = async (req, res) => {
    try {
        const role = req.currentUser?.role || req.user?.role;
        // Superadmins have no tenant subscription of their own.
        if (role === 'superadmin') {
            return res.json({ status: 'none' });
        }
        // The plan, its price tier and seat counts are the account owner's
        // business. Nothing in the employee app reads this route.
        if (role === 'employee') {
            return res.status(403).json({ message: 'Only your company admin can see the plan and billing.' });
        }

        const sub = await Subscription.findOne({ adminId: req.adminId }).populate('planId');

        // Legacy tenants without a subscription record are treated as unrestricted.
        if (!sub) {
            return res.json({ status: 'none' });
        }

        const now = new Date();
        const MS_PER_DAY = 1000 * 60 * 60 * 24;

        // The relevant deadline depends on where the tenant is in its lifecycle.
        let deadline = null;
        if (sub.status === 'trial') deadline = sub.trialEndDate;
        else if (sub.status === 'grace') deadline = sub.graceEndDate || sub.currentPeriodEnd;
        else if (sub.status === 'active') deadline = sub.currentPeriodEnd;

        const daysRemaining = deadline
            ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now.getTime()) / MS_PER_DAY))
            : null;

        // A trial whose end date has passed is effectively expired even if a cron
        // hasn't flipped the status yet — surface that to the client.
        const effectiveStatus =
            sub.status === 'trial' && sub.trialEndDate && new Date(sub.trialEndDate) < now
                ? 'expired'
                : sub.status;

        // Enough for the panel-wide renewal banner and the lock screen, which
        // a sub-admin sees too -- but not the plan, cycle or seat counts,
        // since Plan & Billing is an owner-only page.
        const gate = {
            status: effectiveStatus,
            rawStatus: sub.status,
            trialEndDate: sub.trialEndDate,
            currentPeriodEnd: sub.currentPeriodEnd,
            graceEndDate: sub.graceEndDate,
            deadline,
            daysRemaining,
            bannerThresholdDays: sub.bannerThresholdDays ?? 7,
        };
        if (role !== 'admin') {
            return res.json({ ...gate, planName: null, planSlug: null, limited: true });
        }

        // Counted live, the same way the Employees page counts ("N of M used").
        // Subscription.employeesUsed is only re-synced on create/delete and by
        // the nightly job, so it drifts (31 stored against 27 real on the test
        // tenant) and the two pages disagreed.
        const employeesUsed = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
        const max = sub.planId?.maxEmployees;

        res.json({
            ...gate,
            planName: sub.planId?.name || null,
            planSlug: sub.planId?.slug || null,
            billingCycle: sub.billingCycle,
            employeesUsed,
            maxEmployees: max === null || max === undefined || max === '' ? null : Number(max),
        });
    } catch (error) {
        console.error('[subscription] read failed:', error);
        res.status(500).json({ message: 'Could not load your plan. Please try again.' });
    }
};

/**
 * GET /users/subscription/invoices -- the tenant's own invoices, newest first,
 * for Plan & Billing. Admin only (route). Payment-gateway ids and internal
 * notes stay out.
 */
exports.getMyInvoices = async (req, res) => {
    try {
        const invoices = await require('../models/Invoice')
            .find({ adminId: req.adminId })
            .select('invoiceNumber amount currency period status paidAt dueDate createdAt')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json(invoices);
    } catch (error) {
        console.error('[subscription] invoices failed:', error);
        res.status(500).json({ message: 'Could not load invoices. Please try again.' });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const allowedFields = ['name', 'phone', 'email', 'address', 'bloodGroup', 'contactPersonName', 'contactPersonMobile', 'aadhaarNo', 'panNo', 'bankDetails'];
        const updateData = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) updateData[key] = req.body[key];
        }
        // bankDetails arrives as a JSON string when the request is multipart (file uploads present)
        if (typeof updateData.bankDetails === 'string') {
            try { updateData.bankDetails = JSON.parse(updateData.bankDetails); } catch { delete updateData.bankDetails; }
        }
        // Anything but a plain object (null, an array, a number) is not a set of
        // bank fields; ignore it rather than let it wipe the stored details.
        if (updateData.bankDetails !== undefined
            && (!updateData.bankDetails || typeof updateData.bankDetails !== 'object' || Array.isArray(updateData.bankDetails))) {
            delete updateData.bankDetails;
        }

        // The acting user's live record, loaded by `protect`. Compared against
        // below, so only a real change to the sensitive set is refused.
        const current = req.currentUser || await User.findById(req.userId);
        if (!current) return res.status(404).json({ message: 'User not found' });

        let settings = null;
        if (current.role === 'employee') {
            settings = await require('../models/Settings')
                .findOne({ adminId: current.adminId })
                .select('employeeSelfService');
            if (!canEditSensitiveDetails(current, settings)) {
                const changed = sensitiveChanges(current, updateData, req.files);
                if (changed.size > 0) {
                    return res.status(403).json({ code: 'sensitive_edit_locked', message: sensitiveRefusalMessage(changed) });
                }
                // Unchanged copies of locked fields are dropped, not written back.
                delete updateData.name;
                delete updateData.panNo;
                delete updateData.aadhaarNo;
                delete updateData.bankDetails;
            }
        }

        // Bank fields are written one by one. Assigning `bankDetails` whole
        // replaced the sub-document, so a request carrying only the IFSC wiped
        // the account number beside it.
        if (updateData.bankDetails) {
            for (const key of BANK_DETAIL_FIELDS) {
                const value = updateData.bankDetails[key];
                if (value !== undefined) updateData[`bankDetails.${key}`] = typeof value === 'string' ? value.trim() : value;
            }
            delete updateData.bankDetails;
        }

        if (req.files?.logo?.[0]) updateData.profileImage = req.files.logo[0].path;
        if (req.files?.panCard?.length) updateData.panCardUrls = req.files.panCard.map(f => f.path);
        if (req.files?.aadhaarCard?.length) updateData.aadhaarCardUrls = req.files.aadhaarCard.map(f => f.path);

        // Explicit duplicate-phone guard when the employee is changing their own login number
        if (updateData.phone) {
            const queryId = mongoose.Types.ObjectId.isValid(req.userId) ? new mongoose.Types.ObjectId(req.userId) : req.userId;
            const existing = await User.findOne({ phone: updateData.phone, _id: { $ne: queryId } });
            if (existing) {
                return res.status(409).json({ message: `This phone number (${updateData.phone}) is already registered. Please use a different phone number.` });
            }
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            updateData,
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        const userObj = stripPrivateProfileFields(user.toObject());
        userObj.canEditSensitiveDetails = canEditSensitiveDetails(user, settings);
        res.json(userObj);
    } catch (error) {
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

// --- EMPLOYEE MANAGEMENT LOGIC (Admin Only) ---

// The same private set the profile routes strip, as a projection. The lists
// below used to return every employee's activeToken -- a live 30-day JWT -- so
// any admin or sub-admin who opened the Employees page held a working login
// for each of their staff (19 of 26 on the test tenant).
const PRIVATE_LIST_PROJECTION = PRIVATE_PROFILE_FIELDS.map((f) => `-${f}`).join(' ');

// A search box's text is matched literally. Passed straight to $regex, "(a+)+$"
// or a stray "[" is a pattern, not a name: at best an error, at worst a slow
// scan of every user in the tenant.
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getUsers = async (req, res) => {
    try {
        const { search, role } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        // Sub-admins see employees only. Other sub-admins' records (their
        // permission maps) belong to /admin-users, which is admin-only; this
        // route used to hand them over to any sub-admin who passed ?role=subadmin.
        const callerRole = req.currentUser?.role || req.user?.role;
        if (callerRole === 'subadmin') query.role = 'employee';
        else if (role) query.role = String(role);
        if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };

        const users = await User.find(query)
            .select(PRIVATE_LIST_PROJECTION)
            .populate('departmentId branchId branchIds shiftId shiftIds')
            .limit(limit)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        const count = await User.countDocuments(query);
        res.json({
            users,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            totalUsers: count
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getEmployees = async (req, res) => {
    try {
        const employees = await User.find({ adminId: new mongoose.Types.ObjectId(req.adminId), role: 'employee' })
            .select(PRIVATE_LIST_PROJECTION)
            .populate('departmentId branchId branchIds shiftId shiftIds')
            .sort({ createdAt: -1 });
        res.json(employees);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Minimal id+name listing of colleagues, safe to expose to any employee (e.g. for bill-split pickers)
exports.getCoworkers = async (req, res) => {
    try {
        const queryId = mongoose.Types.ObjectId.isValid(req.userId) ? new mongoose.Types.ObjectId(req.userId) : req.userId;
        const coworkers = await User.find({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            role: 'employee',
            _id: { $ne: queryId }
        }).select('_id name');
        res.json(coworkers);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Fields a tenant request may never write through the employee routes: they
// decide who an account IS (role, tenant) and how it signs in. These routes
// used to copy req.body wholesale, so `role: 'superadmin'` in the body minted a
// platform account -- and with the OTP returned in the login response, anyone
// holding a token could then sign in as it. Sub-admins have their own
// admin-only route (/admin-users); nothing here may create or edit one.
const PROTECTED_USER_FIELDS = [
    '_id', 'role', 'adminId', 'permissions', 'otp', 'otpExpiry', 'activeToken',
    'botlensEmail', 'botlensPassword', 'botlensPasswordEnc', 'lastPingRequestedAt',
    // Bookkeeping, and the admin-account fields that mean nothing on an
    // employee. No form sends them; accepting them only lets a request
    // backdate a record or flip a flag nothing reads.
    'createdAt', 'updatedAt', '__v', 'isActive', 'subscriptionPlan', 'subscriptionStartDate', 'subscriptionEndDate',
];
const stripProtectedFields = (data) => {
    for (const key of Object.keys(data)) {
        // A top-level "$set"/"$unset"/"$rename" is an update OPERATOR to
        // findOneAndUpdate, not a field, so {"$set": {"role": "superadmin"}}
        // walked straight past the list above and was written. A dotted key
        // ("permissions.x") reaches a protected root the same way.
        const root = key.split('.')[0];
        if (key.startsWith('$') || PROTECTED_USER_FIELDS.includes(root)) delete data[key];
    }
    return data;
};

// Every reference on an employee points at a per-tenant record, and nothing
// downstream re-checks who owns it: the app's Home card shows the populated
// branch name and address, the punch geofence measures against that branch's
// coordinates, lateness runs on that shift's hours. An id from another company
// was accepted as-is, so a request could attach a stranger's branch (and read
// it back through the populated list) or run someone's attendance against it.
const TENANT_REFS = [
    ['branchId', Branch, 'branch', 'branches'],
    ['branchIds', Branch, 'branch', 'branches'],
    ['departmentId', Department, 'department', 'departments'],
    ['shiftId', Shift, 'shift', 'shifts'],
    ['shiftIds', Shift, 'shift', 'shifts'],
];
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Returns a plain sentence when a reference is malformed or not this tenant's,
// otherwise null. Only fields present in the request are checked, so the
// Tracking and Shifts pages, which send one field each, are unaffected.
async function checkTenantRefs(data, adminId) {
    for (const [field, Model, label, plural] of TENANT_REFS) {
        const value = data[field];
        if (value === undefined || value === null || value === '') continue;
        const ids = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && v !== '');
        if (!ids.length) continue;
        if (ids.some((id) => !OBJECT_ID_RE.test(String(id)))) {
            return `That ${label} could not be found. Refresh the page and choose it again.`;
        }
        const unique = [...new Set(ids.map(String))];
        const found = await Model.countDocuments({
            _id: { $in: unique.map((id) => new mongoose.Types.ObjectId(id)) },
            adminId: new mongoose.Types.ObjectId(adminId),
        });
        if (found !== unique.length) {
            return `That ${label} is not one of your company's ${plural}. Refresh the page and choose it again.`;
        }
    }
    return null;
}

// The login ID. Every stored phone is exactly ten digits, and login-request
// looks the number up verbatim, so " 9876543210" or "98765 43210" would save
// fine and then never sign in -- and would dodge the duplicate check below.
const PHONE_RE = /^\d{10}$/;

// Plain checks the schema cannot phrase for people. Mutates `data` (trims the
// phone); returns an error sentence or null. `isCreate` makes name and phone
// required; on update only what was sent is checked.
function validateEmployeeInput(data, { isCreate }) {
    if (isCreate || data.name !== undefined) {
        if (typeof data.name !== 'string' || !data.name.trim()) return 'Please enter the employee\'s name.';
        data.name = data.name.trim();
    }
    if (isCreate || data.phone !== undefined) {
        const phone = typeof data.phone === 'string' || typeof data.phone === 'number' ? String(data.phone).trim() : '';
        if (!PHONE_RE.test(phone)) return 'Please enter a 10-digit mobile number.';
        data.phone = phone;
    }
    if (data.salary !== undefined && data.salary !== null && data.salary !== '') {
        const salary = Number(data.salary);
        if (!Number.isFinite(salary) || salary < 0) return 'Please enter the salary as an amount of ₹0 or more.';
        data.salary = salary;
    }
    return null;
}

const EMPLOYEE_FIELD_LABELS = {
    salary: 'salary', employmentType: 'pay type', gender: 'gender', dob: 'date of birth',
    joiningDate: 'joining date', status: 'status', day: 'weekly holiday', weeks: 'weekly holiday weeks',
    email: 'email address', name: 'name', phone: 'phone number',
};

// friendlyMongooseError passes a CastError or an enum failure through as the
// raw Mongoose sentence ("Cast to Number failed for value \"abc\" ... at path
// \"salary\""), which the form then showed verbatim. Name the field instead.
function employeeSaveError(error) {
    const first = error?.name === 'ValidationError' ? Object.values(error.errors || {})[0] : error;
    if (first && (first.name === 'CastError' || first.name === 'ValidatorError')) {
        const fullPath = String(first.path || '');
        const leaf = fullPath.split('.').filter((p) => !/^\d+$/.test(p)).pop() || '';
        const label = fullPath.includes('bucketWeights')
            ? 'payroll day weights (each 0 to 1)'
            : EMPLOYEE_FIELD_LABELS[leaf] || leaf.replace(/([A-Z])/g, ' $1').toLowerCase() || 'value';
        if (first.kind === 'required') return { status: 400, message: `Please enter the ${label}.` };
        return { status: 400, message: `Please check the ${label}: the value entered is not valid.` };
    }
    return friendlyMongooseError(error);
}

// What the employee routes send back: the saved record without the private set.
const publicEmployee = (user) => stripPrivateProfileFields(user.toObject());

/** The plan's employee cap for a tenant, or null for no cap (no plan / not set). */
async function seatLimitFor(adminId) {
    if (!adminId) return null;
    const sub = await Subscription.findOne({ adminId }).populate('planId');
    const max = sub?.planId?.maxEmployees;
    return max === null || max === undefined || max === '' ? null : Number(max);
}

/**
 * GET /users/employees/usage -> { used, limit }: seats used against the plan
 * cap, so the Employees page can say "N of M used" and disable Add at the
 * cap instead of refusing a fully filled-in form. limit null = no cap.
 */
exports.getEmployeeUsage = async (req, res) => {
    try {
        const [limit, used] = await Promise.all([
            seatLimitFor(req.adminId),
            User.countDocuments({ adminId: req.adminId, role: 'employee' }),
        ]);
        res.json({ used, limit });
    } catch (error) {
        console.error('[employees] usage failed:', error);
        res.status(500).json({ message: 'Could not load the seat count. Please try again.' });
    }
};

exports.createUser = async (req, res) => {
    try {
        const userData = {
            ...stripProtectedFields({ ...req.body }),
            role: 'employee',
            adminId: new mongoose.Types.ObjectId(req.adminId),
        };
        
        // Clean up empty strings for ObjectId fields
        ['shiftId', 'departmentId', 'branchId'].forEach(field => {
            if (userData[field] === "") {
                delete userData[field];
            }
        });

        // Multi-branch support: keep primary branchId in sync with branchIds
        if (Array.isArray(userData.branchIds) && userData.branchIds.filter(Boolean).length > 0) {
            userData.branchIds = userData.branchIds.filter(Boolean);
            userData.branchId = userData.branchIds[0];
        } else if (userData.branchId) {
            userData.branchIds = [userData.branchId];
        }

        // Multi-shift support: keep primary shiftId (used for attendance/lateness
        // calculations) in sync with shiftIds — mirrors branchId/branchIds above.
        if (Array.isArray(userData.shiftIds) && userData.shiftIds.filter(Boolean).length > 0) {
            userData.shiftIds = userData.shiftIds.filter(Boolean);
            userData.shiftId = userData.shiftIds[0];
        } else if (userData.shiftId) {
            userData.shiftIds = [userData.shiftId];
        }

        const inputError = validateEmployeeInput(userData, { isCreate: true });
        if (inputError) return res.status(400).json({ message: inputError });

        const refError = await checkTenantRefs(userData, req.adminId);
        if (refError) return res.status(400).json({ message: refError });

        // Explicit duplicate-phone guard — don't rely solely on the DB unique
        // index, since a phone can be shared across different adminId tenants
        // and stale/broken indexes on this collection have slipped through before.
        if (userData.phone) {
            const existing = await User.findOne({ phone: userData.phone });
            if (existing) {
                return res.status(409).json({ message: `This phone number (${userData.phone}) is already registered. Please use a different phone number.` });
            }
        }

        // Biometric PIN must be unique within the company — see normalizeDeviceUserId.
        const deviceIdError = await normalizeDeviceUserId(userData, req.adminId);
        if (deviceIdError) {
            return res.status(409).json({ message: deviceIdError });
        }

        // Enforce employee seat limit check. Inactive employees count too, so a
        // company cannot deactivate people to add more and switch them back on.
        const maxEmployees = await seatLimitFor(req.adminId);
        const seatMessage = `Employee seat limit reached (maximum ${maxEmployees} employees allowed on your plan). Please upgrade your plan to add more.`;
        if (maxEmployees !== null) {
            const currentCount = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
            if (currentCount >= maxEmployees) {
                return res.status(400).json({ message: seatMessage, limitReached: true });
            }
        }

        const user = await User.create(userData);

        // Re-check after the insert: two admins saving at the same moment could
        // both pass the count above and take the company one over its plan.
        // The later insert is undone rather than kept.
        if (maxEmployees !== null) {
            const after = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
            if (after > maxEmployees) {
                await User.deleteOne({ _id: user._id });
                return res.status(400).json({ message: seatMessage, limitReached: true });
            }
        }

        // Sync employeesUsed count on the tenant's subscription (if subscription exists)
        if (userData.role === 'employee' && req.adminId) {
            const count = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
            const subscription = await Subscription.findOne({ adminId: req.adminId });
            if (subscription) {
                subscription.employeesUsed = count;
                await subscription.save();
            }
        }

        res.status(201).json(publicEmployee(user));
    } catch (error) {
        const { status, message } = employeeSaveError(error);
        res.status(status).json({ message });
    }
};

exports.updateUser = async (req, res) => {
    try {
        // No request/document logging here: the body is the whole employee
        // form -- bank account, PAN, Aadhaar, salary -- and it was being
        // written to the server log on every save.
        const updateData = stripProtectedFields({ ...req.body });
        
        // Clean up empty strings for ObjectId fields
        ['shiftId', 'departmentId', 'branchId'].forEach(field => {
            if (updateData[field] === "") {
                updateData[field] = null;
            }
        });

        // Multi-branch support: keep primary branchId in sync with branchIds
        if (Array.isArray(updateData.branchIds) && updateData.branchIds.filter(Boolean).length > 0) {
            updateData.branchIds = updateData.branchIds.filter(Boolean);
            updateData.branchId = updateData.branchIds[0];
        } else if (updateData.branchId) {
            updateData.branchIds = [updateData.branchId];
        } else if (Array.isArray(updateData.branchIds) && updateData.branchIds.length === 0) {
            updateData.branchId = null;
        }

        // Multi-shift support: keep primary shiftId (used for attendance/lateness
        // calculations) in sync with shiftIds — mirrors branchId/branchIds above.
        if (Array.isArray(updateData.shiftIds) && updateData.shiftIds.filter(Boolean).length > 0) {
            updateData.shiftIds = updateData.shiftIds.filter(Boolean);
            updateData.shiftId = updateData.shiftIds[0];
        } else if (updateData.shiftId) {
            updateData.shiftIds = [updateData.shiftId];
        } else if (Array.isArray(updateData.shiftIds) && updateData.shiftIds.length === 0) {
            updateData.shiftId = null;
        }

        const inputError = validateEmployeeInput(updateData, { isCreate: false });
        if (inputError) return res.status(400).json({ message: inputError });

        const refError = await checkTenantRefs(updateData, req.adminId);
        if (refError) return res.status(400).json({ message: refError });

        // Clear any stale deactivation reason once the account is reactivated
        if (updateData.status === 'active') {
            updateData.inactiveReason = '';
        }

        // Explicit duplicate-phone guard when the phone is being changed
        if (updateData.phone) {
            const queryId = mongoose.Types.ObjectId.isValid(req.params.id) ? new mongoose.Types.ObjectId(req.params.id) : req.params.id;
            const existing = await User.findOne({ phone: updateData.phone, _id: { $ne: queryId } });
            if (existing) {
                return res.status(409).json({ message: `This phone number (${updateData.phone}) is already registered. Please use a different phone number.` });
            }
        }

        // Biometric PIN must stay unique within the company — see normalizeDeviceUserId.
        const deviceIdError = await normalizeDeviceUserId(updateData, req.adminId, req.params.id);
        if (deviceIdError) {
            return res.status(409).json({ message: deviceIdError });
        }

        // Employees only: sub-admins are edited through /admin-users, which
        // carries its own admin-only guard.
        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: new mongoose.Types.ObjectId(req.adminId), role: 'employee' },
            updateData,
            { new: true, runValidators: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(publicEmployee(user));
    } catch (error) {
        const { status, message } = employeeSaveError(error);
        res.status(status).json({ message });
    }
};

// --- SUBADMIN / ADMIN USER MANAGEMENT ---

// Every page key a sub-admin can be given. Must match, literally, the admin
// route path (app-sidebar derives its key by stripping the leading "/"), the
// checkPermission() key on the backend routes, and ALL_PAGES in users.tsx.
// `biometric-devices` and `advance-salary` were missing here, so the defaults
// never mentioned them.
const ALL_PAGES = ['dashboard','branches','departments','employees','leaves','attendance','tickets','salary','advance-salary','leads','festivals','announcements','tracking','leave-types','shifts','biometric-devices','assets','expenses','settings'];
const DEFAULT_SUBADMIN_PAGES = ['dashboard','employees','leaves','attendance','salary','advance-salary','expenses'];
const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete'];

function buildDefaultPermissions() {
    return ALL_PAGES.reduce((acc, key) => {
        const on = DEFAULT_SUBADMIN_PAGES.includes(key);
        acc[key] = { view: on, create: false, edit: false, delete: false };
        return acc;
    }, {});
}

/**
 * The stored permission map is read by checkPermission as
 * `permissions[page][action]` and was saved exactly as sent: any key, any
 * value, including an action without view (which checkPermission honours --
 * "edit" alone let a sub-admin change records on a page they could not open).
 * Only known pages and actions survive, every value is a real boolean, and an
 * action without view is dropped.
 */
function sanitizePermissions(input) {
    if (input === undefined) return undefined;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out = {};
    for (const page of ALL_PAGES) {
        const src = input[page] && typeof input[page] === 'object' ? input[page] : {};
        const view = src.view === true;
        out[page] = PERMISSION_ACTIONS.reduce((acc, action) => {
            acc[action] = view && src[action] === true;
            return acc;
        }, {});
    }
    return out;
}

function validateSubadminName(name) {
    if (typeof name !== 'string' || !name.trim()) return 'Please enter a name.';
    if (name.trim().length > 80) return 'The name can be at most 80 characters.';
    return null;
}

// What an admin needs to see about a sub-admin -- and nothing a list must
// never carry (tokens, OTPs, BOTLens credentials).
const SUBADMIN_FIELDS = '_id name phone role isActive permissions createdAt updatedAt';

exports.getAdminUsers = async (req, res) => {
    try {
        // Same rule as the employee lists: this returned every sub-admin's
        // live activeToken (a valid JWT) to the admin's browser.
        const users = await User.find({ adminId: req.adminId, role: 'subadmin' })
            .select(SUBADMIN_FIELDS)
            .sort({ createdAt: -1 });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Could not load users. Please try again.' });
    }
};

exports.createAdminUser = async (req, res) => {
    try {
        const { name, permissions } = req.body || {};
        const nameError = validateSubadminName(name);
        if (nameError) return res.status(400).json({ message: nameError });
        const rawPhone = req.body?.phone;
        const phone = typeof rawPhone === 'string' || typeof rawPhone === 'number' ? String(rawPhone).trim() : '';
        if (!PHONE_RE.test(phone)) return res.status(400).json({ message: 'Please enter a 10-digit mobile number.' });
        const perms = sanitizePermissions(permissions);
        if (perms === null) return res.status(400).json({ message: 'Page permissions could not be read. Please try again.' });

        // Phones are the login ID across every tenant and role, so a number
        // that already belongs to an employee, an admin or anyone else is
        // refused -- otherwise one of the two could never sign in.
        const existing = await User.findOne({ phone }).select('_id');
        if (existing) return res.status(409).json({ message: `This phone number (${phone}) is already registered. Please use a different phone number.` });
        const user = await User.create({
            name: name.trim(),
            phone,
            role: 'subadmin',
            adminId: req.adminId,
            permissions: perms || buildDefaultPermissions(),
        });
        res.status(201).json(await User.findById(user._id).select(SUBADMIN_FIELDS));
    } catch (error) {
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.updateAdminUser = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'User not found' });
        const { name, permissions, isActive } = req.body || {};
        if (req.body?.phone !== undefined) {
            return res.status(400).json({ message: "A sub-admin's phone number cannot be changed. Remove them and add the new number instead." });
        }
        const update = {};
        if (name !== undefined) {
            const nameError = validateSubadminName(name);
            if (nameError) return res.status(400).json({ message: nameError });
            update.name = name.trim();
        }
        if (permissions !== undefined) {
            const perms = sanitizePermissions(permissions);
            if (perms === null) return res.status(400).json({ message: 'Page permissions could not be read. Please try again.' });
            update.permissions = perms;
        }
        if (isActive !== undefined) {
            if (typeof isActive !== 'boolean') return res.status(400).json({ message: 'Status must be active or inactive.' });
            update.isActive = isActive;
            // `status` too: the login routes check `status`, not `isActive`,
            // so a deactivated sub-admin used to get a code and a token that
            // then failed on every request with "account inactive". With both
            // set, the login screen refuses them up front and says why.
            update.status = isActive ? 'active' : 'inactive';
            update.inactiveReason = isActive ? '' : 'Your access to the admin panel has been turned off. Please contact your company admin.';
        }
        if (Object.keys(update).length === 0) return res.status(400).json({ message: 'Nothing to update.' });
        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: req.adminId, role: 'subadmin' },
            { $set: update },
            { new: true, runValidators: true }
        ).select(SUBADMIN_FIELDS);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (error) {
        const { status, message } = friendlyMongooseError(error);
        res.status(status).json({ message });
    }
};

exports.deleteAdminUser = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'User not found' });
        const user = await User.findOneAndDelete({ _id: req.params.id, adminId: req.adminId, role: 'subadmin' });
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User removed' });
    } catch (error) {
        res.status(500).json({ message: 'Could not remove the user. Please try again.' });
    }
};

exports.deleteUser = async (req, res) => {
    try {
        // Employees only, as in updateUser -- a sub-admin holding employees:delete
        // must not be able to remove another sub-admin through this route.
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'User not found' });
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const target = await User.findOne({ _id: req.params.id, adminId, role: 'employee' }).select('_id name');
        if (!target) return res.status(404).json({ message: 'User not found' });

        // Refuse once the employee has any history. Delete is permanent, and it
        // left attendance, leave, salary, advance and expense rows pointing at
        // nobody -- payroll and reports then show a blank name, and the record of
        // what was paid is gone. Deactivating keeps all of it and still blocks
        // their login.
        const employeeId = target._id;
        const [attendance, leave, salary, advance, expense, correction] = await Promise.all([
            Attendance.exists({ adminId, employeeId }),
            require('../models/Leave').exists({ adminId, employeeId }),
            require('../models/Salary').exists({ adminId, employeeId }),
            require('../models/AdvanceSalaryRequest').exists({ companyId: adminId, employeeId }),
            require('../models/Expense').exists({ adminId, employeeId }),
            require('../models/Regularization').exists({ adminId, employeeId }),
        ]);
        const history = [
            attendance && 'attendance', leave && 'leave', salary && 'salary', advance && 'advance',
            expense && 'expense', correction && 'attendance correction',
        ].filter(Boolean);
        if (history.length) {
            return res.status(409).json({
                message: `${target.name || 'This employee'} has ${history.join(', ')} records, so they cannot be deleted. Deactivate them instead: their history is kept and they can no longer log in.`,
                hasHistory: true,
                history,
            });
        }

        const user = await User.findOneAndDelete({ _id: employeeId, adminId, role: 'employee' });
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Their registered face goes with them: a face kiosk must never be able
        // to recognise someone who is no longer in the company.
        await require('../models/FaceProfile').deleteMany({ adminId: user.adminId, employeeId: user._id });

        // Sync employeesUsed count on the tenant's subscription (if subscription exists)
        if (user.role === 'employee' && req.adminId) {
            const count = await User.countDocuments({ adminId: req.adminId, role: 'employee' });
            const subscription = await Subscription.findOne({ adminId: req.adminId });
            if (subscription) {
                subscription.employeesUsed = count;
                await subscription.save();
            }
        }

        res.json({ message: 'User removed' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
