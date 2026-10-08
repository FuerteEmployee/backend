const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Settings = require('../models/Settings');
const PunchLog = require('../models/PunchLog');
const Festival = require('../models/Festival');
const Regularization = require('../models/Regularization');
const { cloudinary } = require('../config/cloudinary');
const { calculateAndSaveSalary } = require('./salary_controller');
const { calculateDistance, nearestBranchDistance, PUNCH_MAX_ACCURACY_M } = require('../utils/distance');
const { MAX_SESSIONS, allSessions, gradeDay, computeWorkedMs, computeSessionWorkMs, isAfterShiftEnd } = require('../utils/shift_status');
// Used only by the admin endpoints below (updateAttendance, getReports).
const { computeSessionGrossMs, syncRootPunchOut, isDayOpen, requiredWorkMs, scheduledLunchMs, resolveGraceMs } = require('../utils/shift_status');
const Leave = require('../models/Leave');
const { logAttendanceEvent } = require('../utils/attendance_event_logger');
const { isWeeklyOff, toLocalDateKey, isLatePunchIn, determineHalfDayStatus, stripGradingRemarks, istStartOfDay, istEndOfDay, istDateKey, istMonthRange, istTimeOnDate, applyPunchRounding } = require('../utils/attendance_helpers');
const { istCalendarDate, parseIstWallClock, istHHMM } = require('../utils/attendance_helpers');
const { findWorkingDay } = require('../utils/working_day');
const { serialisePerUser, withEmployeeLock } = require('../utils/employee_lock');
const { isFrozenTenant, sendFrozen } = require('../utils/frozen_tenants');

// A punch photo a device may send: a base64 JPEG/PNG/WebP data URL, at most
// ~3 MB. Anything else from the camera endpoint -- a URL, a path, a huge
// string -- is ignored rather than handed to Cloudinary.
const MAX_DEVICE_PHOTO_CHARS = 4 * 1024 * 1024;
function isImageDataUrl(value) {
    return typeof value === 'string'
        && value.length <= MAX_DEVICE_PHOTO_CHARS
        && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

async function uploadToCloudinary(dataUrl, folder = 'attendance') {
    if (!dataUrl) return null;
    try {
        const result = await cloudinary.uploader.upload(dataUrl, {
            folder: folder,
            resource_type: 'auto',
            // Backstop, not the primary fix -- the client already downsamples
            // and compresses a punch selfie before it ever leaves the phone
            // (see captureScannerPhoto in routes/user/index.tsx). This exists
            // for whatever the client does NOT control: an old cached APK
            // build a device hasn't picked up the OTA update for yet, or any
            // future capture path that forgets to shrink its own image.
            // `limit` only ever shrinks -- an image already under 480px on
            // its long edge is left alone, never upscaled. `quality: auto`
            // lets Cloudinary pick the smallest size that still looks right
            // for a face, rather than a fixed number that is a compromise for
            // every photo.
            transformation: [{ width: 480, height: 480, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
        });
        return result.secure_url;
    } catch (error) {
        // THROWS. This used to `return null`, which meant a Cloudinary outage
        // produced a punch that was written, reported as successful, and had no
        // photo -- indistinguishable afterwards from a punch where nobody was
        // asked for one. The caller is the only place that knows whether a
        // missing photo is acceptable, so the decision belongs there.
        console.error("Cloudinary Upload Error:", error);
        throw error;
    }
}

/**
 * The photo that goes on a punch, or a refusal.
 *
 * A punch selfie is the only evidence that the person who punched is the person
 * whose name is on the record -- GPS proves a phone was at the office, not who
 * was holding it. It was optional: `photo ? await upload(photo) : null` meant
 * omitting the field entirely produced a fully accepted punch, so the check
 * could be skipped by anyone posting to the API directly.
 *
 * DEVICE PUNCHES ARE EXEMPT, and that exemption is load-bearing. eSSL/ZKTeco
 * terminals reach punchIn()/punchOut() through callHandler() in
 * iclock_controller with a synthetic `{ isDevicePunch: true, body: {} }` request
 * -- they have no camera and can never send a photo. Requiring one without this
 * gate would reject every hardware punch in production. Their identity evidence
 * is the fingerprint at the terminal plus the serial→tenant→PIN→employee
 * resolution, not a selfie.
 */
async function resolvePunchPhoto(req, photo, action) {
    if (req.isDevicePunch) {
        // The BOTLens face kiosk (deviceSource 'lens') DOES have a camera and
        // sends the frame it matched the face in. Keep it, so a camera punch
        // shows a photo on the attendance screen like an app punch does. It is
        // evidence, not the check -- the face match already identified the
        // person -- so a missing or failed photo never refuses the punch.
        // Fingerprint terminals send none and are unaffected.
        if (req.deviceSource !== 'lens' || !isImageDataUrl(photo)) return { ok: true, url: null };
        try {
            return { ok: true, url: await uploadToCloudinary(photo, 'attendance/lens') };
        } catch (err) {
            console.error('[lens] punch photo upload failed, punch kept without it:', err.message);
            return { ok: true, url: null };
        }
    }

    if (!photo) {
        return {
            ok: false,
            status: 400,
            message: `A photo is required to ${action}. Please allow camera access and try again.`,
        };
    }

    try {
        return { ok: true, url: await uploadToCloudinary(photo) };
    } catch (err) {
        // Fail the punch rather than record it without the photo it is supposed
        // to carry. The employee can retry; a silently photo-less punch cannot
        // be told apart later from one that was never checked.
        return {
            ok: false,
            status: 503,
            message: 'Your photo could not be uploaded, so the punch was not recorded. Please check your connection and try again.',
        };
    }
}

/**
 * Refuse a punch taken on a hopelessly poor fix -- a cell-tower or wifi
 * fallback position can be kilometres out, and accepting one either lets
 * somebody punch in from home or blocks somebody standing at the door.
 *
 * This is a RETRY, not a denial: the employee is stood there trying to punch,
 * so the message tells them what to do rather than accusing them of anything.
 * The threshold is deliberately far looser (150 m) than the 35 m gate used to
 * decide whether someone has LEFT a fence -- one is "is this fix usable at
 * all", the other is "is this fix good enough to take pay away on".
 *
 * An unreported accuracy is allowed through. Old APKs in the field send 0 for
 * "unknown", and blocking those would lock every un-updated client out of
 * punching entirely.
 *
 * @returns an error message string, or null when the fix is acceptable
 */
function rejectPoorAccuracy(accuracy) {
    if (accuracy == null) return null;
    const acc = Number(accuracy);
    if (!Number.isFinite(acc) || acc <= 0) return null; // unknown, not poor
    if (acc > PUNCH_MAX_ACCURACY_M) {
        return `GPS accuracy is too poor (${Math.round(acc)}m). Please move to an open area for a better signal and try again.`;
    }
    return null;
}

// ─── Minimum gap between consecutive punches ─────────────────────────────────
//
// A segment of the day has to last long enough to be that segment. Observed
// 2026-09-17: two employees recorded lunches of ONE SECOND (14:52:48 to
// 14:52:49, 18:18:58 to 18:18:59) -- a double tap on "Start Lunch" then "End
// Lunch", stored as a real break. The same double tap is available at both
// ends of the break: punch-in then "Start Lunch", and "End Lunch" then
// punch-out. All three feed determineHalfDayStatus and, under a from_punches
// lunch policy, the payroll deduction.
//
// `punchDebounceSeconds` does not cover any of this. It guards DEVICE taps, in
// the iclock controller, before the tap ever reaches a handler; these arrive
// through the app, where nothing debounced them.
//
// Rejecting beats silently ignoring: the employee is holding the phone and
// needs to know the action did not take, or they will believe it did.
//
// Kept as one helper rather than three copies. shift_status.js carries the
// scars of the alternative -- logic duplicated across two controllers that had
// already diverged before anyone centralised it.

const DEFAULT_MIN_GAP_SECONDS = 60;

/**
 * Resolve a configured minimum gap. Unset falls back to the default; an
 * explicit 0 disables the gate, matching how `punchDebounceSeconds` documents
 * its own 0. Nothing is affected by that reading today: the keys were missing
 * from the Settings schema until now, so strict mode dropped every write and
 * no tenant has ever had a stored value to reinterpret.
 */
function minGapSeconds(settings, key) {
    const raw = Number(settings?.attendance?.[key]);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_GAP_SECONDS;
}

/**
 * @param since    the earlier punch's timestamp, or null/undefined when that
 *                 punch never happened -- then there is nothing to measure and
 *                 the gate does not apply
 * @param seconds  0 or less disables
 * @param phrase   {what, doing} -- "Lunch started 3s ago. Wait at least 60s
 *                 before ending it."
 * @returns a 400 body to send, or null to proceed
 *
 * A negative gap (the stored punch is in the future, e.g. a corrected time or
 * device clock skew) is let through rather than blocked. This gate exists to
 * catch a fat-fingered double tap, and it must never be the thing standing
 * between an employee and closing their day.
 */
function tooSoonSince(since, seconds, phrase, now = Date.now()) {
    if (!since || !(seconds > 0)) return null;
    const gapMs = now - new Date(since).getTime();
    if (gapMs < 0 || gapMs >= seconds * 1000) return null;
    return {
        message: `${phrase.what} ${Math.round(gapMs / 1000)}s ago. `
            + `Wait at least ${seconds}s before ${phrase.doing}.`,
        retryable: true,
    };
}

/**
 * When this punch happened.
 *
 * For an app punch, now. For a biometric terminal, the moment of the TAP,
 * which iclock_controller passes as `req.tapTime`: a terminal with no network
 * keeps its taps and sends them later, and stamping arrival time stored a
 * 10:45 punch-in delivered at 11:12 as 11:12 -- late. Everything a handler
 * decides from the clock (the stored time, which day, late, the minimum gaps)
 * must use this one value, or the parts disagree about when the punch was.
 *
 * `tapTime` is only read on a device punch, and only iclock's synthetic request
 * sets it -- never a request body -- so an app user cannot choose a time.
 */
function punchMoment(req) {
    const t = req?.isDevicePunch ? req.tapTime : null;
    return t instanceof Date && !Number.isNaN(t.getTime()) ? t : new Date();
}

/**
 * The punch-in that opened the segment currently running.
 *
 * Not simply `attendance.punchIn`: sessions live in `attendance.shifts[]` and
 * session 1 is ALSO the root punchIn, so on a second shift the root holds this
 * morning's start and gating against it would never fire.
 */
function currentPunchIn(attendance) {
    const sessions = attendance?.shifts || [];
    const last = sessions[sessions.length - 1];
    return last?.punchIn || attendance?.punchIn || null;
}

/**
 * Fixes worth storing alongside a punch, so a disputed punch can be judged
 * later. `fixAt` is when the DEVICE captured the position; a large gap from the
 * punch time means it came off an offline queue and was never current.
 */
function fixQuality(accuracy, fixAt) {
    const acc = Number(accuracy);
    const at = fixAt ? new Date(fixAt) : null;
    return {
        accuracy: Number.isFinite(acc) && acc > 0 ? acc : null,
        fixAt: at && !Number.isNaN(at.getTime()) ? at : null,
    };
}

/**
 * Resolve which channel a punch came from, for storage.
 *
 * One definition, used for BOTH `Attendance.source` and the per-session
 * `punchInSource`/`punchOutSource`. Duplicating the ternary is how hardware
 * punches ended up tagged as the camera last time -- a new channel that forgets
 * to set `deviceSource` must be a visible omission, not a silent fallback in
 * three different places.
 */
function punchSource(req) {
    if (!req?.isDevicePunch) return 'app';
    return req.deviceSource || 'lens';
}

/**
 * The fields describing ONE end of a session -- where it happened, how good the
 * fix was, how far from the branch, and which channel reported it.
 *
 * `end` is 'punchIn' or 'punchOut'. Returned as a flat object so it can be
 * spread straight onto a session sub-document; the keys deliberately match the
 * root punch field names so the two layouts stay readable side by side.
 */
function sessionEndFields(end, { req, address, location, accuracy, distance }) {
    const fix = fixQuality(accuracy, null);
    return {
        [`${end}Source`]: punchSource(req),
        [`${end}Location`]: address || null,
        [`${end}Coordinates`]: location || null,
        [`${end}Accuracy`]: fix.accuracy,
        [`${end}Distance`]: Number.isFinite(Number(distance)) ? Number(distance) : null,
    };
}

/**
 * Human-readable distance for an error message a real person has to read on a
 * phone screen. A raw meter count reads fine at "450m" but stops being
 * legible the moment it is wrong by an order of magnitude or more -- an
 * employee mis-assigned to a branch 900+ km away saw "(Distance: 925548m)",
 * six digits with no unit break, which does not register as "impossibly far
 * away" the way "925.5 km" does at a glance. Switches to km at 1000m, one
 * decimal place.
 */
function formatDistance(metres) {
    if (!Number.isFinite(metres)) return 'an unknown distance';
    if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
    return `${Math.round(metres)}m`;
}

/**
 * "18:30" -> "6:30 PM", for a message an employee reads. The app shows every
 * time in 12-hour form, so a refusal saying "18:30" next to "06:30 PM" on the
 * same screen reads as two different times.
 */
function hhmm12(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return hhmm || '';
    const h = Number(m[1]);
    return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** An instant as IST "6:30 PM". */
function istTime12(date) {
    return hhmm12(istHHMM(date));
}

/**
 * Distance to the nearest fenced branch, and whether this punch must be refused.
 *
 * ONE implementation for every session of the day. The second punch-in used to
 * skip this check completely: a fence could be walked straight through by
 * punching out and back in, and session 2+ recorded no distance at all, which
 * left the detail view with nothing to show for it.
 *
 * Distance is computed whether or not the fence is enforced -- it is evidence.
 * `requireLocation` governs only the refusal.
 */
function evaluateGeofence({ user, settings, rules, location, isWFH, isDevicePunch, requireFix = false }) {
    // Two different lists, because "has no branch" and "has a branch that is
    // not fenced" are opposite situations that this function used to conflate.
    //
    // Collapsing them inverted the per-branch toggle: switching geoFenceEnabled
    // OFF removed the branch from the array, the empty array then read as "no
    // branch assigned", and every employee on that branch was REFUSED the punch
    // with "No branch assigned. Cannot verify location." Turning a fence off is
    // an exemption -- it must let people punch from anywhere, not lock them out
    // of punching at all, and certainly not with a message denying they have a
    // branch they plainly do have.
    const assigned = [user?.branchId, ...(user?.branchIds || [])].filter(Boolean);
    const branches = assigned.filter((b) => b.geoFenceEnabled !== false);
    const fallback = settings?.attendance?.officeRadius || 3000;

    // No coordinates at all used to PASS: the distance check below only runs
    // when a location is sent, so a punch with GPS off -- or a direct API call
    // that simply omitted `location` -- skipped a fence the tenant requires.
    // Punch-in/out only (`requireFix`); the app already refuses to send these
    // without a fix, so this closes the gap without changing what employees
    // see. Work-from-home and device punches are never measured, as before.
    const hasFix = location?.lat != null && location?.lng != null;
    if (requireFix && !hasFix && !isWFH && !isDevicePunch && rules.requireLocation && branches.length > 0) {
        return {
            distance: null,
            reject: { message: 'Turn on location (GPS) on your phone to punch. Your punch is checked against your branch.', locationRequired: true },
        };
    }

    if (!isWFH && branches.length > 0 && location?.lat != null && location?.lng != null) {
        const { distance, radius } = nearestBranchDistance(location.lat, location.lng, branches, fallback);
        const rounded = Number.isFinite(distance) ? Math.round(distance) : null;
        const maxRadius = radius || fallback;
        if (rules.requireLocation && Number.isFinite(distance) && distance > maxRadius) {
            return {
                distance: rounded,
                reject: {
                    message: `You Are Not At Office Location (Distance: ${formatDistance(distance)})`,
                    distance: rounded,
                },
            };
        }
        return { distance: rounded, reject: null };
    }

    if (!isWFH && !isDevicePunch && rules.requireLocation && branches.length === 0) {
        // Refuse ONLY when there is genuinely nothing to measure against. If a
        // branch is assigned and its fence is simply switched off, that is a
        // deliberate exemption and the punch is allowed through unmeasured.
        if (assigned.length === 0) {
            return { distance: null, reject: { message: 'No branch assigned. Cannot verify location.' } };
        }
        return { distance: null, reject: null };
    }

    return { distance: null, reject: null };
}

function getAttendanceRules(user, settings) {
    if (user?.attendanceExceptions?.overrideGlobal) {
        return {
            requireLocation: user.attendanceExceptions.requireLocation,
            remotePunch: user.attendanceExceptions.remotePunch
        };
    }
    return {
        requireLocation: settings?.attendance?.requireLocation || false,
        remotePunch: settings?.attendance?.remotePunch || false
    };
}

// Exported so the profile endpoint can tell the app whether to OFFER the
// Work From Home toggle, using the same precedence that decides whether the
// punch is accepted. A client with its own copy of this rule would show a
// control that 403s, which is worse than not showing it at all.
exports.getAttendanceRules = getAttendanceRules;

/**
 * Calculates current month stats for the employee to return in punch-in response
 */
async function getEmployeeSummary(adminId, employeeId) {
    // The IST month, not the host's: on a UTC server `new Date(y, m, 1)` is
    // 05:30 IST on the 1st, and the date key built from it named the wrong day.
    const cal = istCalendarDate();
    const { start: startOfMonth } = istMonthRange(cal.getFullYear(), cal.getMonth() + 1);

    // Count attendance
    const attendanceCount = await Attendance.countDocuments({
        adminId,
        employeeId,
        date: { $gte: startOfMonth }
    });

    // Count holidays (festivals)
    const holidays = await Festival.countDocuments({
        adminId,
        startDate: { $gte: istDateKey(startOfMonth) }
    });

    return { attendanceCount, holidays };
}

exports.punchIn = async (req, res) => {
    try {
        const employeeId = req.userId; // Use userId from protect middleware
        const { location, photo, isWFH, address, accuracy, fixAt } = req.body;

        // The accuracy gate exists to stop a cell-tower guess deciding whether
        // somebody is standing at the office door. A Work From Home punch is
        // not measured against any fence, so there is nothing for a poor fix to
        // corrupt -- and refusing one would block the employee this mode exists
        // to serve, who is indoors on wifi with no clear sky, over a number
        // nobody is going to read. Position is still recorded, just not judged.
        if (!isWFH) {
            const accuracyError = rejectPoorAccuracy(accuracy);
            if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });
        }
        const now = punchMoment(req);

        // 1. Fetch User, Shift and Settings. The shift comes first because it
        // decides which day this punch is filed under (see working_day.js).
        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        const settings = await Settings.findOne({ adminId: req.adminId });

        // 2. Check if already punched in
        const workDay = await findWorkingDay({
            Attendance,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            shift: user?.shiftId,
            now,
        });
        // A night shift still open from before midnight (or just after its
        // end) has to be closed first. Opening a second day on top of it is
        // how a night worker ended up with an open row and a "late" one.
        if (workDay.row && workDay.row !== workDay.primary && isDayOpen(workDay.row)) {
            const since = currentPunchIn(workDay.row);
            return res.status(400).json({
                message: `You are still punched in from your last shift${since ? ` (since ${istTime12(since)})` : ''}. Punch out first.`,
            });
        }
        const today = workDay.dayStart;
        let attendance = workDay.primary;

        // Rounded per settings.attendance.roundingInterval/Direction (only if
        // 'Punch In' is in roundingAppliedTo) — feeds status/half-day checks and
        // is what actually gets stored, so payroll and the late check agree.
        const punchInTime = applyPunchRounding(now, 'Punch In', settings);

        // No NEW session once the shift is over.
        //
        // Applies to the first punch of the day and to every re-punch, so it
        // sits above both branches below. Punch-OUT is deliberately never
        // guarded: somebody still on the clock at shift end has to be able to
        // close their own day.
        //
        // Observed 2026-09-18: an employee punched in at 18:44 against a
        // 09:30-18:30 shift. There was no shift left to work, so the 04:00 job
        // closed the session at the punch-in instant itself -- a zero-length
        // day, graded `needs_review`, which pays nothing and has to be sorted
        // out by an admin. Refusing the punch at the door says so immediately,
        // while the employee is still holding the phone and can ask.
        //
        // Off by default for a tenant that sets `blockPunchInAfterShiftEnd:
        // false` -- a 24/7 operation, or one whose shifts are nominal.
        const blockAfterEnd = settings?.attendance?.blockPunchInAfterShiftEnd !== false;
        const afterEndGraceMs = Math.max(0, Number(settings?.attendance?.punchInGraceAfterShiftEndMins) || 0) * 60 * 1000;
        if (blockAfterEnd && user?.shiftId && isAfterShiftEnd(user.shiftId, punchInTime, afterEndGraceMs)) {
            return res.status(400).json({
                message: `Your ${user.shiftId.name ? `${user.shiftId.name} shift` : 'shift'} ended at ${hhmm12(user.shiftId.endTime)}. `
                    + `Punch-in is closed for today. If you worked, ask your admin to add it through Attendance Regularization.`,
                shiftEnded: true,
            });
        }

        // Camera-detected punches (BOTLens) reflect physical reality — the
        // person genuinely left and came back — so they always get to
        // re-punch regardless of the tenant's app-facing policy toggle.
        const allowMultiple = req.isDevicePunch || settings?.attendance?.allowMultiplePunches || false;

        if (attendance && attendance.punchIn) {
            if (!allowMultiple) {
                return res.status(400).json({ message: 'Already punched in today' });
            }
            if (!attendance.punchOut) {
                return res.status(400).json({ message: 'You must punch out first before punching in again.' });
            }

            // Remote Punch Check
            const rules = getAttendanceRules(user, settings);
            if (isWFH && !rules.remotePunch) {
                return res.status(403).json({ message: 'Remote punch (Work From Home) is disabled for your account.' });
            }

            // Hard cap on sessions per day. Without it a device toggling in a
            // pocket, or somebody tapping repeatedly, grows shifts[] without
            // bound -- and every one of those entries is counted by the hours
            // calculation. The message names the limit so the employee knows
            // this is a rule rather than a fault.
            const sessionCount = allSessions(attendance).length;
            if (sessionCount >= MAX_SESSIONS) {
                return res.status(400).json({
                    message: `You have already had ${MAX_SESSIONS} separate work sessions today, which is the daily limit. `
                        + `Ask your admin to add the extra time through Attendance Regularization \u2014 your work still counts.`,
                });
            }

            // Punching in again the instant after punching out is the mirror of the
            // instant punch-out: a stray tap on "Punch In Again" made a session with
            // a one-second gap behind it and used up one of the day's sessions. Same
            // `workMinGapSeconds` as the other work segments, measured from the last
            // punch-out. A retry, never a refusal to work.
            const sinceOutTooSoon = tooSoonSince(
                attendance.punchOut,
                minGapSeconds(settings, 'workMinGapSeconds'),
                { what: 'You punched out', doing: 'punching in again' },
                now.getTime(),
            );
            if (sinceOutTooSoon) return res.status(400).json(sinceOutTooSoon);

            // The fence applies to EVERY session, not just the first one.
            const reGeo = evaluateGeofence({ user, settings, rules, location, isWFH, isDevicePunch: req.isDevicePunch, requireFix: true });
            if (reGeo.reject) return res.status(400).json(reGeo.reject);

            // Perform multiple punch in
            const rePhoto = await resolvePunchPhoto(req, photo, 'punch in');
            if (!rePhoto.ok) return res.status(rePhoto.status).json({ message: rePhoto.message });
            const photoUrl = rePhoto.url;
            attendance.punchOut = null;
            attendance.punchOutLocation = null;
            attendance.punchOutCoordinates = null;
            attendance.punchOutPhoto = null;
            attendance.punchOutIsProvisional = false;

            attendance.shifts = attendance.shifts || [];
            attendance.shifts.push({
                punchIn: punchInTime,
                ...sessionEndFields('punchIn', {
                    req, address, location, accuracy, distance: reGeo.distance,
                }),
            });
            
            if (!attendance.remarks?.includes('Multiple shifts')) {
                attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + 'Multiple shifts';
            }
            
            await attendance.save();

            logAttendanceEvent({
                adminId: req.adminId, employeeId, type: 'punch-in', at: punchInTime,
                source: req.isDevicePunch ? (req.deviceSource || 'lens') : 'app',
                sessionNumber: sessionCount + 1,
                lat: location?.lat, lng: location?.lng, accuracy,
            });

            const summary = await getEmployeeSummary(req.adminId, employeeId);
            return res.status(201).json({
                message: `Re-Punched In successfully.`,
                attendance,
                summary
            });
        }

        if (!user) return res.status(404).json({ message: 'User not found' });

        const rules = getAttendanceRules(user, settings);

        // 3. Remote Punch Check
        if (isWFH && !rules.remotePunch) {
            return res.status(403).json({ message: 'Remote punch (Work From Home) is disabled for your account.' });
        }

        // 4. Geofencing — compute distance to nearest branch whenever we can
        // (persisted below regardless of enforcement), but only HARD-REJECT
        // the punch when requireLocation is actually turned on for this user.
        const geo = evaluateGeofence({ user, settings, rules, location, isWFH, isDevicePunch: req.isDevicePunch, requireFix: true });
        if (geo.reject) return res.status(400).json(geo.reject);
        const punchInDistance = geo.distance;

        // 4. Determine Status (late check only).
        //
        // No half-day verdict here. `halfDayLatePunchInMin` used to mark the
        // day half-day the moment someone was past it, but it is now the
        // shift's late GRACE: it widens the hours bar, and the day is graded
        // on hours at punch-out (determineHalfDayStatus + gradeDay). Since
        // isLatePunchIn uses that same grace, every late arrival was stored as
        // "Half Day" all day, before a single hour had been measured, and the
        // cutoff was not overnight-aware. isLatePunchIn is.
        let status = 'present';
        if (user.shiftId && !isWFH && isLatePunchIn(punchInTime, user.shiftId, settings)) {
            status = 'late';
        }

        // 4. Perform Uploads in Parallel for Speed
        const inPhoto = await resolvePunchPhoto(req, photo, 'punch in');
        if (!inPhoto.ok) return res.status(inPhoto.status).json({ message: inPhoto.message });
        const photoUrl = inPhoto.url;

        // WFH is a first-class status; wasLate will be set on punch-out so the
        // flag survives the status normalisation (late → present/half-day).
        const finalStatus = isWFH ? 'wfh' : status;
        if (!attendance) {
            attendance = new Attendance({
                adminId: req.adminId,
                employeeId,
                date: today,
            });
        }
        const punchInFix = fixQuality(accuracy, fixAt);
        attendance.set({
            punchIn: punchInTime,
            punchInAccuracy: punchInFix.accuracy,
            punchInFixAt: punchInFix.fixAt,
            punchInLocation: address || "Location provided by user",
            punchInCoordinates: location || null,
            punchInDistance,
            punchInPhoto: photoUrl,
            status: finalStatus,
            // Device punches carry `deviceSource` to say WHICH device: the
            // iclock/ADMS controller sets 'biometric', the BOTLens camera route
            // leaves it unset and falls back to 'lens'.
            source: punchSource(req),
            isWFH: !!isWFH,
            remarks: isWFH ? 'Work From Home' : '',
            // A fresh day on an EXISTING row (one marked absent, or edited
            // empty) must not inherit the old punch-out's evidence. Only the
            // time was reset, so the old punch-out selfie showed beside the new
            // punch-in photo the moment someone punched in.
            punchOut: null,
            punchOutPhoto: null,
            punchOutLocation: null,
            punchOutCoordinates: null,
            punchOutDistance: null,
            punchOutAccuracy: null,
            punchOutFixAt: null,
            punchOutIsProvisional: false,
            lunchInTime: null,
            lunchInLocation: null,
            lunchInCoordinates: null,
            lunchInDistance: null,
            lunchOutTime: null,
            lunchOutLocation: null,
            lunchOutCoordinates: null,
            lunchOutDistance: null,
            shifts: [{
                punchIn: punchInTime,
                ...sessionEndFields('punchIn', {
                    req, address, location, accuracy, distance: punchInDistance,
                }),
            }],
            geoStatus: punchInDistance == null ? 'unknown' : 'inside_geofence',
            autoPunchOut: false,
            autoPunchOutReason: null,
            calculatedDistance: null,
            totalWorkMs: 0
        });

        await attendance.save();

        // The FIRST punch-in of the day had no evidence row -- the logger was
        // wired only into the re-punch branch below and into punch-out, so a
        // normal one-session day produced a log that began at going-home time.
        logAttendanceEvent({
            adminId: req.adminId, employeeId, type: 'punch-in', at: punchInTime,
            source: punchSource(req), sessionNumber: 1,
            lat: location?.lat, lng: location?.lng, accuracy,
            distanceFromBranch: punchInDistance,
        });

        // Get month stats for feedback
        const summary = await getEmployeeSummary(req.adminId, employeeId);

        res.status(201).json({
            message: `Punch-in Successful. Status: ${status}`,
            attendance,
            summary
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/attendance/today
 *
 * The authenticated employee's own attendance for today, or null.
 *
 * Small, unglamorous, and load-bearing: this is what the native background
 * tracker polls to decide whether it should still be running. Without it the
 * service has no way to learn that the employee punched out on the BIOMETRIC
 * TERMINAL or the LENS CAMERA -- neither of which the phone ever hears about --
 * and would keep recording, and keep its notification up, until the battery
 * died. The reference project never had to solve this because it has one punch
 * channel; we have three.
 *
 * Returns `null` rather than 404 when there is no record: "not punched in" is a
 * normal answer, and the tracker treats a failed request as "keep running", so
 * an error here would be read as "carry on" -- the exact opposite of the truth.
 */
exports.getToday = async (req, res) => {
    try {
        // The working day, not the calendar day: after midnight a night
        // worker's open shift is dated yesterday, and answering "not punched
        // in" would stop the tracker half way through their shift.
        const me = await User.findById(req.userId)
            .select('shiftId trackingEnabled departmentId')
            .populate('shiftId')
            .populate('departmentId', 'trackingEnabled')
            .lean();
        const trackingSettings = await Settings.findOne({ adminId: req.adminId }).select('attendance.trackingMode').lean();
        // "Keep recording even with no open shift." The native tracker stops itself
        // when this endpoint shows no open session; `trackAlways` tells it not to.
        // Only when the company chose "always" AND this person's tracking is on,
        // so switching someone's tracking off still stops their phone.
        const trackAlways = trackingSettings?.attendance?.trackingMode === 'always'
            && (me?.trackingEnabled === true || me?.departmentId?.trackingEnabled === true);
        const { row: attendance } = await findWorkingDay({
            Attendance,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(req.userId),
            shift: me?.shiftId,
            select: 'date punchIn punchOut lunchInTime lunchOutTime shifts status totalWorkMs punchOutIsProvisional autoPunchOut autoPunchOutReason',
            lean: true,
        });

        // A provisional punch-out is a device toggle that may only be someone
        // leaving for lunch, so the day is NOT closed and tracking must
        // continue. Reporting it as a real punch-out would stop the tracker
        // half way through an afternoon.
        if (attendance && attendance.punchOut && attendance.punchOutIsProvisional) {
            attendance.punchOut = null;
        }

        // Unchanged for "on duty": the same row, or null. For "always" the flag is
        // added (and sent even when there is no row), so a phone that understands
        // it keeps tracking; an older phone ignores it and behaves as before.
        if (!trackAlways) return res.json(attendance || null);
        res.json({ ...(attendance || {}), trackAlways: true });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * The caller's OWN recent days that were closed for them, not by them.
 *
 * When nobody punches out, closeForgottenPunches stamps the shift end so the
 * day can still be graded and paid. That is a fallback, not a measurement --
 * and on a day with no GPS (so no geofence evaluation either) it is the only
 * thing the record has to go on. This endpoint is what lets us ask the one
 * person who actually knows.
 *
 * Days already carrying a pending or approved correction are filtered out, so
 * the prompt stops once the question has been answered. A REJECTED request does
 * not filter it out: the admin declining one claimed time does not mean the
 * shift-end default is now correct.
 */
exports.getMissedPunchOuts = async (req, res) => {
    try {
        const adminId = new mongoose.Types.ObjectId(req.adminId);
        const employeeId = new mongoose.Types.ObjectId(req.userId);

        const settings = await Settings.findOne({ adminId }).lean();
        const windowDays = Number(settings?.attendance?.correctionWindowDays) > 0
            ? Number(settings.attendance.correctionWindowDays)
            : 7;

        const from = istStartOfDay(new Date(Date.now() - (windowDays - 1) * 24 * 60 * 60 * 1000));
        const to = istEndOfDay(new Date());

        const rows = await Attendance.find({
            adminId,
            employeeId,
            date: { $gte: from, $lte: to },
            'shifts.closeReason': 'shift_end',
        }).select('date punchIn punchOut shifts').lean();

        if (!rows.length) return res.json([]);

        const claimed = new Set(
            (await Regularization.find({
                adminId,
                employeeId,
                status: { $in: ['pending', 'approved'] },
                date: { $gte: from, $lte: to },
            }).select('date').lean()).map((r) => istDateKey(r.date)),
        );

        const user = await User.findById(employeeId).populate('shiftId', 'name startTime endTime').lean();

        const out = [];
        for (const a of rows) {
            const dayKey = istDateKey(a.date);
            if (claimed.has(dayKey)) continue;

            // By timestamp, not array position -- shifts[] is not ordered.
            const session = (a.shifts || [])
                .filter((s) => s && s.closeReason === 'shift_end' && s.punchOut)
                .sort((x, y) => new Date(y.punchOut) - new Date(x.punchOut))[0];
            if (!session) continue;

            out.push({
                attendanceId: a._id,
                date: a.date,
                dayKey,
                punchIn: session.punchIn || a.punchIn,
                systemPunchOut: session.punchOut,
                shiftName: user?.shiftId?.name || null,
                shiftEndTime: user?.shiftId?.endTime || null,
            });
        }

        out.sort((x, y) => new Date(y.date) - new Date(x.date));
        res.json(out);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * GET /api/attendance/punch-log?employeeId=&date=YYYY-MM-DD
 *
 * Every raw tap a terminal reported for one employee on one IST day, in tap
 * order — what the admin panel's expandable tap list shows.
 *
 * Discarded taps are included on purpose. When an employee insists they tapped
 * and the day shows nothing, the answer is usually a debounced double-press,
 * and that is only visible if the rejected taps come back too.
 */
exports.getPunchLog = async (req, res) => {
    try {
        const { employeeId, date } = req.query;
        if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
            return res.status(400).json({ message: 'A valid employeeId is required' });
        }

        // Accept either a plain 'YYYY-MM-DD' or any parseable date, and resolve
        // it to the IST day key the taps were filed under.
        const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
            ? String(date)
            : istDateKey(date ? new Date(date) : new Date());

        const taps = await PunchLog.find({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            dayKey,
        })
            .sort({ deviceTime: 1 })
            .select('deviceTime receivedAt serialNumber pin source discarded discardReason derivedAction')
            .lean();

        res.json({ dayKey, taps });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.punchOut = async (req, res) => {
    try {
        const employeeId = req.userId;
        const { location, photo, address, accuracy, fixAt } = req.body;

        const now = punchMoment(req);

        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // The working day: for a night shift after midnight that is the row
        // opened last night (see working_day.js).
        const { row: attendance } = await findWorkingDay({
            Attendance,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            shift: user.shiftId,
            now,
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No punch-in record found for today' });
        }

        // Same exemption as punch-in: a WFH day is not measured against any
        // fence, so a poor indoor fix must not strand the employee unable to
        // close a day they were allowed to open.
        if (!attendance.isWFH) {
            const accuracyError = rejectPoorAccuracy(accuracy);
            if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });
        }

        if (attendance.punchOut) {
            // A device-set punchOut is provisional — it might just be the
            // employee leaving for lunch, since Lens/biometric only ever send
            // a generic in/out toggle. If the employee now explicitly punches
            // out via the app, honor that as the real, final exit instead of
            // blocking it. A second explicit punch-out (app or device) after
            // an already-confirmed one is still rejected as normal.
            const canOverrideProvisional = attendance.punchOutIsProvisional && !req.isDevicePunch;
            if (!canOverrideProvisional) {
                return res.status(400).json({ message: 'Already punched out today' });
            }
        }

        // --- Geofencing check for Punch-Out ---
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        // Punching out the instant after punching in is the most damaging face of
        // the same double tap, and it was the one left ungated. This handler used
        // to say "punch-out is never gated on punch-in", reasoning that closing a
        // day is the one action an employee must always be able to complete. A
        // short wait does not stop anyone completing it, though, and without one a
        // single stray tap made a zero-second day: no hours, graded needs_review,
        // pays nothing, and (unless multiple punches are on) the employee could not
        // punch in again -- an admin had to repair it. Reported 2026-09-30 from a
        // real phone: punch in and out within one second, no gap at all.
        //
        // Measured from the CURRENT session's punch-in, like the lunch gate, so a
        // second shift is judged on when that shift started. Same setting as the
        // other work segments (`workMinGapSeconds`, default 60, 0 disables). The
        // employee is told how long to wait; it is a retry, never a refusal to close.
        const sinceInTooSoon = tooSoonSince(
            currentPunchIn(attendance),
            minGapSeconds(settings, 'workMinGapSeconds'),
            { what: 'You punched in', doing: 'punching out' },
            now.getTime(),
        );
        if (sinceInTooSoon) return res.status(400).json(sinceInTooSoon);

        // Ending the break and immediately punching out is the third face of
        // the same double tap. Only applies when a lunch-out was actually
        // recorded -- a day with no break has nothing to measure from.
        const sinceLunchTooSoon = tooSoonSince(
            attendance.lunchOutTime,
            minGapSeconds(settings, 'workMinGapSeconds'),
            { what: 'Lunch ended', doing: 'punching out' },
            now.getTime(),
        );
        if (sinceLunchTooSoon) return res.status(400).json(sinceLunchTooSoon);

        // Rounded per settings.attendance.roundingInterval/Direction (only if
        // 'Punch Out' is in roundingAppliedTo) — this is what actually gets
        // stored and fed into worked-hours/half-day/payroll math.
        const punchOutTime = applyPunchRounding(now, 'Punch Out', settings);

        const outGeo = evaluateGeofence({
            user, settings, rules, location,
            isWFH: attendance.isWFH, isDevicePunch: req.isDevicePunch, requireFix: true,
        });
        if (outGeo.reject) return res.status(400).json(outGeo.reject);
        const punchOutDistance = outGeo.distance;

        const outPhoto = await resolvePunchPhoto(req, photo, 'punch out');
        if (!outPhoto.ok) return res.status(outPhoto.status).json({ message: outPhoto.message });
        const photoUrl = outPhoto.url;

        const punchOutFix = fixQuality(accuracy, fixAt);
        attendance.punchOut = punchOutTime;
        attendance.punchOutAccuracy = punchOutFix.accuracy;
        attendance.punchOutFixAt = punchOutFix.fixAt;
        attendance.punchOutLocation = address || "Location provided by user";
        attendance.punchOutCoordinates = location || null;
        attendance.punchOutDistance = punchOutDistance;
        attendance.punchOutPhoto = photoUrl;
        attendance.punchOutIsProvisional = !!req.isDevicePunch;

        // Update the last shift in the array — skipped when overriding an
        // already-closed provisional shift (see canOverrideProvisional above):
        // that shift's own punchIn/punchOut stays as the device recorded it,
        // and totalWorkMs isn't double-counted.
        let closedSessionNumber = 1;
        if (attendance.shifts && attendance.shifts.length > 0) {
            const lastShift = attendance.shifts[attendance.shifts.length - 1];
            closedSessionNumber = attendance.shifts.length;
            if (!lastShift.punchOut) {
                lastShift.punchOut = punchOutTime;
                // Why it closed, on every path. A device toggle is not the same
                // signal as someone pressing the button, and a day closed by a
                // job is different again -- without this they are
                // indistinguishable after the fact.
                lastShift.closeReason = req.isDevicePunch ? 'device' : 'manual';
                Object.assign(lastShift, sessionEndFields('punchOut', {
                    req, address, location, accuracy, distance: punchOutDistance,
                }));
            }
        }

        // Recompute from every session, clamped to the shift window and with
        // lunch deducted, rather than accumulating raw punch gaps.
        //
        // The old approach added (out - in) per session: it counted an early
        // punch-in as worked time, counted time past shift end as worked hours
        // rather than overtime, and never subtracted lunch -- so a day could
        // exceed the shift length and still be graded on that inflated figure.
        attendance.totalWorkMs = computeWorkedMs(attendance, user.shiftId, settings);

        // Per-session durations, recomputed for every session on each close so
        // an earlier session written before this field existed, or one an admin
        // has since corrected, is brought up to date too.
        for (const sess of (attendance.shifts || [])) {
            sess.workMs = computeSessionWorkMs(sess, attendance, user.shiftId);
        }

        // 5. Preserve punctuality signal before status is normalised.
        // status 'late' or 'half-day' (if due to punch-in) gets overwritten below,
        // but wasLate survives so the payroll engine can still read it.
        if (attendance.status === 'late' || attendance.status === 'half-day' || (user.shiftId && isLatePunchIn(attendance.punchIn, user.shiftId, settings))) {
            attendance.wasLate = true;
        }

        // 6. Apply configurable half-day rules (shared with regularization approval).
        const { status: finalStatus, netWorkHours, remarksAppend } = determineHalfDayStatus({
            punchIn: attendance.punchIn,
            punchOut: attendance.punchOut,
            totalWorkMs: attendance.totalWorkMs,
            lunchInTime: attendance.lunchInTime,
            lunchOutTime: attendance.lunchOutTime,
            isWFH: attendance.isWFH,
            shift: user.shiftId,
        }, settings);

        attendance.status = finalStatus;
        // Rebuilt, not appended. The fragments below describe the day as it
        // stands NOW, and a day is graded once per session close -- an earlier
        // session's "Early punch-out" survived into a day that ran to shift
        // end, because the append guard only ever caught exact repeats.
        attendance.remarks = stripGradingRemarks(attendance.remarks);
        if (finalStatus === 'half-day' && remarksAppend) {
            attendance.remarks = (attendance.remarks || '') + remarksAppend;
        }

        // Hours-based grade across ALL sessions, which the shift-rule check
        // above cannot see -- it only looks at the first punch-in and the last
        // punch-out. A day worked as three short sessions can satisfy every
        // shift rule and still fall well short of the required hours.
        //
        // Only ever downgrades: if either check says half-day, it is a
        // half-day. Upgrading here would let hours override an explicit
        // late-arrival or early-out rule the admin configured.
        const hoursGrade = gradeDay(attendance, user.shiftId, settings);
        if (hoursGrade === 'half-day' && attendance.status === 'present') {
            attendance.status = 'half-day';
            const note = ' | Short hours across sessions';
            if (!String(attendance.remarks || '').includes(note.trim())) {
                attendance.remarks = (attendance.remarks || '') + note;
            }
        }

        await attendance.save();

        logAttendanceEvent({
            adminId: req.adminId, employeeId, type: 'punch-out', at: punchOutTime,
            source: req.isDevicePunch ? (req.deviceSource || 'lens') : 'app',
            sessionNumber: closedSessionNumber,
            lat: location?.lat, lng: location?.lng, accuracy,
            distanceFromBranch: punchOutDistance,
            closeReason: req.isDevicePunch ? 'device' : 'manual',
        });

        res.json({
            message: 'Punch-out Successful',
            workHours: Number.isFinite(netWorkHours) ? netWorkHours.toFixed(2) : '0.00',
            attendance
        });

        // 6. Background Sync Salary -- for the month the DAY is in, in IST.
        // `now.getMonth()` is the host's month: on a UTC server a punch-out
        // before 05:30 IST on the 1st re-synced the month before, and a night
        // shift closed on the 1st belongs to the previous month's last day.
        const payMonth = istCalendarDate(attendance.date || now);
        calculateAndSaveSalary(req.adminId, user, payMonth.getMonth() + 1, payMonth.getFullYear()).catch(err => {
            console.error("Salary Sync Error:", err);
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.lunchIn = async (req, res) => {
    try {
        const employeeId = req.userId; // never the body: that let a caller start or end a co-worker's lunch
        const { location, address, accuracy } = req.body;
        const now = punchMoment(req);

        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        const { row: attendance } = await findWorkingDay({
            Attendance,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            shift: user?.shiftId,
            now,
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No attendance record found for today' });
        }

        // WFH days are not fenced, so a poor fix is no reason to refuse (as punch-in).
        if (!attendance.isWFH) {
            const accuracyError = rejectPoorAccuracy(accuracy);
            if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });
        }

        if (attendance.punchOut) {
            // A device-set punchOut is provisional — it may just be the
            // employee leaving for lunch. An explicit "Start Lunch" tap in
            // the app confirms exactly that: clear it and record lunch
            // normally instead of rejecting.
            if (!attendance.punchOutIsProvisional) {
                return res.status(400).json({ message: 'Already punched out for today' });
            }
            attendance.punchOut = null;
            attendance.punchOutLocation = null;
            attendance.punchOutCoordinates = null;
            attendance.punchOutPhoto = null;
            attendance.punchOutIsProvisional = false;
        }

        // Lunch already started and not ended. A second "Start Lunch" used to pass
        // every check below and overwrite lunchInTime, silently shortening the
        // recorded break (seen live on 2026-09-30: two taps 268 ms apart both
        // saved). A repeat within a minute is the same tap, so answer as if it
        // worked; later than that, say when lunch started.
        if (attendance.lunchInTime && !attendance.lunchOutTime) {
            const ago = now.getTime() - new Date(attendance.lunchInTime).getTime();
            if (ago >= 0 && ago < 60 * 1000) return res.json(attendance);
            return res.status(400).json({
                message: `Lunch already started at ${hhmmIST(attendance.lunchInTime)}. Tap End Lunch when you are back.`,
            });
        }

        // --- Geofencing check for Lunch-In ---
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        // Arriving and immediately starting lunch is the same double tap that
        // produced the one-second breaks, one button earlier. Measured from the
        // CURRENT session's punch-in, so a second shift is gated on when that
        // shift started rather than on this morning.
        const sinceArrivalTooSoon = tooSoonSince(
            currentPunchIn(attendance),
            minGapSeconds(settings, 'workMinGapSeconds'),
            { what: 'You punched in', doing: 'starting lunch' },
            now.getTime(),
        );
        if (sinceArrivalTooSoon) return res.status(400).json(sinceArrivalTooSoon);

        const lunchInGeo = evaluateGeofence({
            user, settings, rules, location,
            isWFH: attendance.isWFH || attendance.remarks === 'Work From Home',
            isDevicePunch: req.isDevicePunch,
        });
        if (lunchInGeo.reject) return res.status(400).json(lunchInGeo.reject);
        const lunchInDistance = lunchInGeo.distance;

        if (attendance.lunchOutTime) {
            return res.status(400).json({ message: 'Lunch already completed for today' });
        }

        attendance.lunchInTime = applyPunchRounding(now, 'Lunch In', settings);
        attendance.lunchInLocation = address || "Location provided by user";
        attendance.lunchInCoordinates = location || null;
        attendance.lunchInDistance = lunchInDistance;
        await attendance.save();

        // Lunch had no evidence row on any channel -- so a break taken on the
        // Lens camera left nothing behind but two timestamps on the day state,
        // which an admin correction then silently overwrote.
        logAttendanceEvent({
            adminId: req.adminId, employeeId, type: 'lunch-in', at: attendance.lunchInTime,
            source: punchSource(req), sessionNumber: Math.max(1, (attendance.shifts || []).length),
            lat: location?.lat, lng: location?.lng, accuracy,
            distanceFromBranch: lunchInDistance,
        });

        res.json(attendance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.lunchOut = async (req, res) => {
    try {
        const employeeId = req.userId; // never the body: that let a caller start or end a co-worker's lunch
        const { location, address, accuracy } = req.body;
        const now = punchMoment(req);

        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        const { row: attendance } = await findWorkingDay({
            Attendance,
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            shift: user?.shiftId,
            now,
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No attendance record found for today' });
        }

        if (!attendance.isWFH) {
            const accuracyError = rejectPoorAccuracy(accuracy);
            if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });
        }

        if (attendance.punchOut) {
            // Same provisional-override as lunchIn — additionally backfill
            // lunchInTime from the device's own exit time when it was never
            // explicitly set (the employee went straight from a device
            // "out" tap to tapping "End Lunch Break" without ever tapping
            // "Start Lunch" in the app).
            if (!attendance.punchOutIsProvisional) {
                return res.status(400).json({ message: 'Already punched out for today' });
            }
            if (!attendance.lunchInTime) {
                attendance.lunchInTime = attendance.punchOut;
                attendance.lunchInLocation = attendance.punchOutLocation;
                attendance.lunchInCoordinates = attendance.punchOutCoordinates;
                attendance.lunchInDistance = attendance.punchOutDistance;
            }
            attendance.punchOut = null;
            attendance.punchOutLocation = null;
            attendance.punchOutCoordinates = null;
            attendance.punchOutPhoto = null;
            attendance.punchOutIsProvisional = false;
        }

        if (!attendance.lunchInTime) {
            return res.status(400).json({ message: 'No lunch-in record found. Please lunch-in first.' });
        }


        if (attendance.lunchOutTime) {
            return res.status(400).json({ message: 'Already recorded lunch-out for today' });
        }

        // --- Geofencing check for Lunch-Out ---
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        // A break has to last long enough to be a break -- see tooSoonSince.
        const lunchTooSoon = tooSoonSince(
            attendance.lunchInTime,
            minGapSeconds(settings, 'lunchMinGapSeconds'),
            { what: 'Lunch started', doing: 'ending it' },
            now.getTime(),
        );
        if (lunchTooSoon) return res.status(400).json(lunchTooSoon);

        const lunchOutGeo = evaluateGeofence({
            user, settings, rules, location,
            isWFH: attendance.isWFH || attendance.remarks === 'Work From Home',
            isDevicePunch: req.isDevicePunch,
        });
        if (lunchOutGeo.reject) return res.status(400).json(lunchOutGeo.reject);
        const lunchOutDistance = lunchOutGeo.distance;

        attendance.lunchOutTime = applyPunchRounding(now, 'Lunch Out', settings);
        attendance.lunchOutLocation = address || "Location provided by user";
        attendance.lunchOutCoordinates = location || null;
        attendance.lunchOutDistance = lunchOutDistance;
        await attendance.save();

        // Lunch had no evidence row on any channel -- so a break taken on the
        // Lens camera left nothing behind but two timestamps on the day state,
        // which an admin correction then silently overwrote.
        logAttendanceEvent({
            adminId: req.adminId, employeeId, type: 'lunch-out', at: attendance.lunchOutTime,
            source: punchSource(req), sessionNumber: Math.max(1, (attendance.shifts || []).length),
            lat: location?.lat, lng: location?.lng, accuracy,
            distanceFromBranch: lunchOutDistance,
        });

        res.json(attendance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getReports = async (req, res) => {
    try {
        const { startDate, endDate, employeeId } = req.query;
        const query = { adminId: new mongoose.Types.ObjectId(req.adminId) };

        // A malformed id used to throw inside the ObjectId constructor and come
        // back as a 500 carrying the BSON error text.
        if (employeeId) {
            if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
                return res.status(400).json({ message: 'employeeId is not a valid id' });
            }
            query.employeeId = new mongoose.Types.ObjectId(String(employeeId));
        }
        if ((startDate && Number.isNaN(new Date(startDate).getTime()))
            || (endDate && Number.isNaN(new Date(endDate).getTime()))) {
            return res.status(400).json({ message: 'startDate and endDate must be dates (YYYY-MM-DD)' });
        }
        if (startDate && endDate) {
            // IST day boundaries, NOT the raw strings.
            //
            // `new Date('2026-09-17')` is UTC midnight, but an Attendance
            // `date` is an IST-midnight instant (2026-09-16T18:30:00Z for that
            // same day). So `{ $gte: <utc midnight>, $lte: <utc midnight> }`
            // -- which is what a single-day call (startDate === endDate) built
            // -- excluded the very rows it was asking for and returned an
            // EMPTY list. Every IST-correct row was unreachable this way; only
            // legacy rows still sitting at UTC midnight matched, so the bug
            // looked intermittent rather than total.
            //
            // That is what emptied the auto punch-out layer on the tracking
            // map: `/attendance/reports?startDate=D&endDate=D` returned
            // nothing, so there were no sessions to plot and the
            // "why this happened" link had no pin to focus.
            //
            // Spanning start-of-first-day..end-of-last-day also keeps the
            // legacy UTC-midnight rows inside the window, so this widens the
            // result set and never narrows it.
            query.date = {
                $gte: istStartOfDay(new Date(startDate)),
                $lte: istEndOfDay(new Date(endDate)),
            };
        }

        const [reports, settings] = await Promise.all([
            Attendance.find(query).populate({
                path: 'employeeId',
                select: 'name phone shiftId branchId',
                populate: [
                    // The grading fields ride along so `grading` below can be
                    // computed from the same shift the server grades with.
                    { path: 'shiftId', select: 'name startTime endTime halfDayLatePunchInMin halfDayEarlyPunchOutMin lunch workDays' },
                    { path: 'branchId', select: 'branchName city' },
                ],
            }).lean(),
            Settings.findOne({ adminId: req.adminId }).lean(),
        ]);

        // The Full-Day bar each day is measured against, computed by the SAME
        // functions gradeDay/determineHalfDayStatus use. The detail sheet used
        // to rebuild it in the browser from the tenant's minLunch + lateGrace,
        // ignoring the shift's own lunch block and grace, so for a 09:30-18:30
        // shift with a 60-minute lunch it showed "required 8h55m" against the
        // server's 7h50m -- and explained half-days with numbers the grade was
        // never based on.
        for (const r of reports) {
            const shift = r.employeeId?.shiftId;
            if (!shift || typeof shift !== 'object') { r.grading = null; continue; }
            const ref = r.punchIn ? new Date(r.punchIn) : new Date(r.date);
            const grace = resolveGraceMs(shift, settings);
            r.grading = {
                requiredMs: requiredWorkMs(shift, settings, ref),
                lunchMs: scheduledLunchMs(shift, settings, ref),
                graceInMs: grace.inMs,
                graceOutMs: grace.outMs,
            };
        }
        res.json(reports);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ─── Admin edit of one attendance day ────────────────────────────────────────

const EDITABLE_TIME_FIELDS = [
    ['punchIn', 'Punch in'],
    ['punchOut', 'Punch out'],
    ['lunchInTime', 'Lunch start'],
    ['lunchOutTime', 'Lunch end'],
];
const ADMIN_STATUSES = ['present', 'absent', 'half-day', 'late', 'wfh', 'needs_review'];

/** A shift whose end is at or before its start runs past midnight. */
function isOvernightShift(shift) {
    const toMin = (t) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const s = toMin(shift?.startTime);
    const e = toMin(shift?.endTime);
    return s !== null && e !== null && e <= s;
}

const hhmmIST = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });

/**
 * PUT /api/attendance/:id -- the admin's "Modify Punch Time".
 *
 * This used to assign the raw body values to the ROOT fields and save, and
 * nothing else. Three consequences, all of them silent:
 *
 *   1. shifts[] was never touched. allSessions() treats shifts[] as the truth
 *      the moment it is populated, so the corrected time was computed away:
 *      totalWorkMs, the half-day grade and payroll all kept the old punch.
 *      (regularization_controller documents the identical bug on its path.)
 *   2. The status was whatever the dialog's select held -- the OLD status, since
 *      it is prefilled -- so moving a 09:50 arrival to 09:30 left the day
 *      'half-day' and "Late punch-in" in the remarks.
 *   3. datetime-local strings carry no offset and were cast in the HOST
 *      timezone. Production runs in UTC, so "09:30" was stored as 15:00 IST.
 *
 * Now: times are parsed as IST, validated (on the record's day, out after in,
 * not in the future), written through to the sessions, and the day is re-graded
 * with the same functions the punch-out path uses. An explicit status is still
 * honoured as an override; "auto" (or no status) means "grade it from the times".
 *
 * Only whitelisted fields are read from the body -- never spread it.
 */
exports.updateAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(404).json({ message: 'Record not found' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        const attendance = await Attendance.findOne({
            _id: new mongoose.Types.ObjectId(id),
            adminId: new mongoose.Types.ObjectId(req.adminId)
        });
        if (!attendance) return res.status(404).json({ message: 'Record not found' });

        const user = await User.findOne({ _id: attendance.employeeId, adminId: req.adminId }).populate('shiftId');
        const shift = user?.shiftId || null;
        const settings = await Settings.findOne({ adminId: req.adminId });

        // ── Parse. undefined = leave alone; '' / null = clear the field. ──────
        const next = {};
        for (const [field, label] of EDITABLE_TIME_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) continue;
            const raw = body[field];
            if (raw === null || raw === '') { next[field] = null; continue; }
            if (typeof raw !== 'string') return res.status(400).json({ message: `${label} is not a valid time` });
            const when = parseIstWallClock(raw);
            if (!when) return res.status(400).json({ message: `${label} is not a valid time` });
            next[field] = when;
        }
        // Compared with the root AND with the session it maps to: a row the old
        // version of this endpoint left with the two disagreeing is then
        // repaired by simply opening it and saving.
        const liveSessions = (attendance.shifts || []).filter((s) => s && s.punchIn)
            .sort((a, b) => new Date(a.punchIn) - new Date(b.punchIn));
        const ms = (d) => (d ? new Date(d).getTime() : null);
        const timeChanged = Object.keys(next).filter((f) => {
            const nxt = next[f] ? next[f].getTime() : null;
            if (ms(attendance[f]) !== nxt) return true;
            if (!liveSessions.length) return false;
            if (f === 'punchIn') return ms(liveSessions[0].punchIn) !== nxt;
            if (f === 'punchOut') return ms(liveSessions[liveSessions.length - 1].punchOut) !== nxt;
            return false;
        });

        let explicitStatus = null;
        if (body.status !== undefined && body.status !== null && body.status !== '' && body.status !== 'auto') {
            if (!ADMIN_STATUSES.includes(body.status)) {
                return res.status(400).json({ message: `Status must be one of: ${ADMIN_STATUSES.join(', ')}` });
            }
            explicitStatus = body.status;
        }
        if (body.remarks !== undefined && body.remarks !== null && typeof body.remarks !== 'string') {
            return res.status(400).json({ message: 'Remarks must be text' });
        }
        if (typeof body.remarks === 'string' && body.remarks.length > 1000) {
            return res.status(400).json({ message: 'Remarks can be at most 1000 characters' });
        }
        if (body.isWFH !== undefined && typeof body.isWFH !== 'boolean') {
            return res.status(400).json({ message: 'isWFH must be true or false' });
        }

        // ── Validate the day as it would be after the edit. ──────────────────
        const merged = {};
        for (const [field] of EDITABLE_TIME_FIELDS) {
            merged[field] = field in next ? next[field] : (attendance[field] ? new Date(attendance[field]) : null);
        }
        if (timeChanged.length) {
            const dayStart = istStartOfDay(new Date(attendance.date));
            const dayEnd = istEndOfDay(new Date(attendance.date));
            const overnight = isOvernightShift(shift);
            const latestAllowed = Date.now() + 60 * 1000;
            const dayLabel = istDateKey(attendance.date);
            for (const [field, label] of EDITABLE_TIME_FIELDS) {
                const v = merged[field];
                if (!v || !timeChanged.includes(field)) continue;
                const t = v.getTime();
                // An end may run into the next morning only on a shift that does.
                const endField = field === 'punchOut' || field === 'lunchOutTime';
                const upper = endField && overnight ? dayEnd.getTime() + 24 * 60 * 60 * 1000 : dayEnd.getTime();
                if (t < dayStart.getTime() || t > upper) {
                    return res.status(400).json({ message: `${label} (${v.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}) is not on ${dayLabel}. An edit must stay on the day it corrects.` });
                }
                if (t > latestAllowed) {
                    return res.status(400).json({ message: `${label} cannot be in the future.` });
                }
            }
            if (merged.punchOut && !merged.punchIn) {
                return res.status(400).json({ message: 'A punch out needs a punch in.' });
            }
            if (merged.punchIn && merged.punchOut && merged.punchOut <= merged.punchIn) {
                return res.status(400).json({ message: 'Punch out must be after punch in.' });
            }
            if (merged.lunchOutTime && !merged.lunchInTime) {
                return res.status(400).json({ message: 'A lunch end needs a lunch start.' });
            }
            if (merged.lunchInTime && merged.lunchOutTime && merged.lunchOutTime <= merged.lunchInTime) {
                return res.status(400).json({ message: 'Lunch end must be after lunch start.' });
            }
            if ((merged.lunchInTime || merged.lunchOutTime) && !merged.punchIn) {
                return res.status(400).json({ message: 'Lunch needs a punch in on the same day.' });
            }
        }

        // ── Apply, writing through to the sessions. ──────────────────────────
        for (const f of timeChanged) attendance[f] = next[f];

        if (timeChanged.includes('punchIn') || timeChanged.includes('punchOut')) {
            const sessions = (attendance.shifts || []).filter(Boolean);
            if (!merged.punchIn) {
                // No punch-in left means no sessions left.
                attendance.shifts = [];
            } else if (sessions.length === 0) {
                // Legacy single-session row: the root IS the session, so write
                // one explicitly and every reader sees the same numbers.
                attendance.shifts = [{
                    punchIn: merged.punchIn,
                    punchOut: merged.punchOut || null,
                    punchInSource: 'admin',
                    punchOutSource: merged.punchOut ? 'admin' : null,
                    closeReason: merged.punchOut ? 'admin' : null,
                }];
            } else {
                // Root punchIn is the day's FIRST arrival and root punchOut its
                // LAST exit, so each edit belongs to that end of the day. By
                // timestamp, never by index -- shifts[] is not stored in order.
                const byIn = [...sessions].sort((a, b) => new Date(a.punchIn || 0) - new Date(b.punchIn || 0));
                if (timeChanged.includes('punchIn')) {
                    byIn[0].punchIn = merged.punchIn;
                    byIn[0].punchInSource = 'admin';
                }
                if (timeChanged.includes('punchOut')) {
                    const last = byIn[byIn.length - 1];
                    last.punchOut = merged.punchOut || null;
                    last.punchOutSource = merged.punchOut ? 'admin' : null;
                    last.closeReason = merged.punchOut ? 'admin' : null;
                }
                // Every session must still make sense after the edit.
                for (const s of byIn) {
                    if (s.punchIn && s.punchOut && new Date(s.punchOut) <= new Date(s.punchIn)) {
                        return res.status(400).json({
                            message: `That would leave a session running ${hhmmIST(s.punchIn)} to ${hhmmIST(s.punchOut)}. `
                                + 'This day has several sessions; correct the middle ones through Attendance Regularization.',
                        });
                    }
                }
                // An open session anywhere but the end would read as "on duty".
                const openIdx = byIn.findIndex((s) => s.punchIn && !s.punchOut);
                if (openIdx !== -1 && openIdx !== byIn.length - 1) {
                    return res.status(400).json({ message: 'Only the last session of the day can be left without a punch out.' });
                }
                syncRootPunchOut(attendance);
                if (!merged.punchOut) attendance.punchOut = null;
            }
        }

        if (timeChanged.includes('punchOut')) {
            // An admin's time is explicit, never a provisional device toggle.
            attendance.punchOutIsProvisional = false;
        }
        if (timeChanged.length) {
            // Device day-reconciliation owns only the fields listed here. An
            // edited field left in the list would be silently overwritten by the
            // terminal's positional inference on the employee's next tap.
            attendance.derivedFields = (attendance.derivedFields || []).filter((f) => !timeChanged.includes(f));
        }

        let wfhChanged = false;
        if (typeof body.isWFH === 'boolean') {
            wfhChanged = attendance.isWFH !== body.isWFH;
            attendance.isWFH = body.isWFH;
        } else if (explicitStatus === 'wfh') {
            wfhChanged = !attendance.isWFH;
            attendance.isWFH = true;
        }

        // ── Re-grade, with the punch-out path's own functions. ───────────────
        const regrade = timeChanged.length > 0 || wfhChanged;
        if (regrade) {
            attendance.totalWorkMs = computeWorkedMs(attendance, shift, settings);
            for (const s of (attendance.shifts || [])) {
                s.workMs = computeSessionWorkMs(s, attendance, shift);
                s.grossMs = computeSessionGrossMs(s);
            }
            if (timeChanged.includes('punchIn')) {
                // Re-derived, not only ever set: the arrival itself was corrected.
                attendance.wasLate = !!(attendance.punchIn && shift && isLatePunchIn(attendance.punchIn, shift, settings));
            }
        }

        if (explicitStatus) {
            attendance.status = explicitStatus;
        } else if (regrade) {
            if (!attendance.punchIn) {
                attendance.status = 'absent';
                attendance.wasLate = false;
            } else if (isDayOpen(attendance)) {
                // An open day has no verdict yet (see gradeDay); only the
                // arrival can be described.
                const late = shift ? isLatePunchIn(attendance.punchIn, shift, settings) : false;
                attendance.status = attendance.isWFH ? 'wfh' : (late ? 'late' : 'present');
            } else {
                const { status: graded, remarksAppend } = determineHalfDayStatus({
                    punchIn: attendance.punchIn,
                    punchOut: attendance.punchOut,
                    totalWorkMs: attendance.totalWorkMs,
                    lunchInTime: attendance.lunchInTime,
                    lunchOutTime: attendance.lunchOutTime,
                    isWFH: attendance.isWFH,
                    shift,
                }, settings);
                attendance.status = graded;
                attendance.remarks = stripGradingRemarks(attendance.remarks);
                if (graded === 'half-day' && remarksAppend) attendance.remarks = (attendance.remarks || '') + remarksAppend;
                // Same hours-across-sessions downgrade as punchOut().
                const hoursGrade = gradeDay(attendance, shift, settings);
                if (hoursGrade === 'half-day' && attendance.status === 'present') {
                    attendance.status = 'half-day';
                    const note = ' | Short hours across sessions';
                    if (!String(attendance.remarks || '').includes(note.trim())) attendance.remarks = (attendance.remarks || '') + note;
                }
            }
        }

        if (typeof body.remarks === 'string') {
            attendance.remarks = body.remarks.trim() || null;
        }
        if (timeChanged.length && !String(attendance.remarks || '').includes('Edited by admin')) {
            attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + 'Edited by admin';
        }

        await attendance.save();

        // Evidence trail, as the other correction paths leave one.
        if (timeChanged.includes('punchIn') && attendance.punchIn) {
            logAttendanceEvent({ adminId: req.adminId, employeeId: attendance.employeeId, type: 'punch-in', at: attendance.punchIn, source: 'admin', closeReason: 'admin' });
        }
        if (timeChanged.includes('punchOut') && attendance.punchOut) {
            logAttendanceEvent({ adminId: req.adminId, employeeId: attendance.employeeId, type: 'punch-out', at: attendance.punchOut, source: 'admin', closeReason: 'admin' });
        }

        res.json(attendance);

        // Keep the stored payslip in step, as punch-out and regularization do.
        // The IST month of the record, not the host's.
        if (user && (regrade || explicitStatus)) {
            const [y, m] = istDateKey(attendance.date).split('-').map(Number);
            calculateAndSaveSalary(req.adminId, user, m, y).catch((err) => {
                console.error('Attendance edit salary sync error:', err);
            });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Admin marks an employee absent for a given day — find-or-create the
// Attendance doc rather than requiring one to already exist (unlike
// updateAttendance, which 404s if there's no record yet).
exports.markAbsent = async (req, res) => {
    try {
        const { employeeId, date } = req.body || {};
        if (!employeeId || !date) {
            return res.status(400).json({ message: 'employeeId and date are required' });
        }
        if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
            return res.status(400).json({ message: 'employeeId is not a valid id' });
        }
        const parsed = new Date(date);
        if (typeof date !== 'string' || Number.isNaN(parsed.getTime())) {
            return res.status(400).json({ message: 'date must be a date (YYYY-MM-DD)' });
        }

        // The employee must belong to THIS tenant. Without the check any id
        // was accepted, and an attendance row was written under this admin
        // for somebody else's employee.
        const employee = await User.findOne({ _id: employeeId, adminId: req.adminId, role: 'employee' }).populate('shiftId');
        if (!employee) return res.status(404).json({ message: 'Employee not found' });

        const day = istStartOfDay(parsed);
        if (day > istStartOfDay(new Date())) {
            return res.status(400).json({ message: 'A future day cannot be marked absent.' });
        }

        // Range, not equality: a row written before the IST fix sits at local
        // or UTC midnight, and an exact match missed it and wrote a duplicate.
        let attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(String(employeeId)),
            date: { $gte: day, $lte: istEndOfDay(day) },
        });

        if (!attendance) {
            attendance = new Attendance({ adminId: req.adminId, employeeId, date: day });
        }

        attendance.status = 'absent';
        attendance.punchIn = null;
        attendance.punchOut = null;
        attendance.punchOutIsProvisional = false;
        attendance.lunchInTime = null;
        attendance.lunchOutTime = null;
        // The sessions and the worked total go too. shifts[] is what every
        // reader measures, so leaving it behind kept the hours on an "absent"
        // day -- the detail sheet still listed the sessions, and overtime (which
        // reads totalWorkMs regardless of status) could still be paid on it.
        attendance.shifts = [];
        attendance.totalWorkMs = 0;
        attendance.wasLate = false;
        attendance.isWFH = false;
        attendance.derivedFields = [];
        attendance.autoPunchOut = false;
        attendance.autoPunchOutReason = null;
        // ...and the evidence of the punches being undone. The times were
        // cleared but the selfies, places and distances stayed, so an "Absent"
        // row on the Attendance page still showed the employee's punch photo.
        // The raw taps (PunchLog) and the event log are kept as the audit trail.
        attendance.set({
            punchInPhoto: null, punchOutPhoto: null,
            punchInLocation: null, punchOutLocation: null, lunchInLocation: null, lunchOutLocation: null,
            punchInCoordinates: null, punchOutCoordinates: null, lunchInCoordinates: null, lunchOutCoordinates: null,
            punchInDistance: null, punchOutDistance: null, lunchInDistance: null, lunchOutDistance: null,
            punchInAccuracy: null, punchOutAccuracy: null, punchInFixAt: null, punchOutFixAt: null,
            calculatedDistance: null, geoStatus: null,
        });
        attendance.remarks = stripGradingRemarks(attendance.remarks);
        if (!String(attendance.remarks || '').includes('Marked absent by admin')) {
            attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + 'Marked absent by admin';
        }

        await attendance.save();
        res.json(attendance);

        const [y, m] = istDateKey(day).split('-').map(Number);
        calculateAndSaveSalary(req.adminId, employee, m, y).catch((err) => {
            console.error('Mark-absent salary sync error:', err);
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Who is where on one IST day. Lives in utils/day_classification.js so the
// admin dashboard counts people with exactly the same rules as this page.
const { classifyDay } = require("../utils/day_classification");

// Active employees expected at work today who have not turned up: no graded
// row, not on approved leave, not on their weekly off or a holiday. Same
// classification as the Absent Today card (getStats), so the count on the card
// is the length of this list.
exports.getAbsentToday = async (req, res) => {
    try {
        // ?date=YYYY-MM-DD for another day, so the Attendance page can list the
        // absent people for the day it is showing (same rule as getStats).
        const day = req.query.date ? new Date(req.query.date) : new Date();
        if (Number.isNaN(day.getTime())) return res.status(400).json({ message: 'date must be a date (YYYY-MM-DD)' });
        const { out } = await classifyDay(req.adminId, day);
        res.json(out.absent.map(({ weeklyHolidays, ...e }) => e));
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Bundled KPI numbers for the Attendance page — a single round trip instead
// of shipping the whole day's records/employee list to the browser to count.
exports.getStats = async (req, res) => {
    try {
        const day = req.query.date ? new Date(req.query.date) : new Date();
        if (Number.isNaN(day.getTime())) {
            return res.status(400).json({ message: 'date must be a date (YYYY-MM-DD)' });
        }
        const { dayKey, holiday, employees, out, lateArrivals, onDuty, pendingRegularizations } = await classifyDay(req.adminId, day);

        // Half-day and needs_review keep their own counts (as on the admin
        // dashboard) rather than being folded into presentToday. Every active
        // employee is in exactly one of: present, halfDay, needsReview, onLeave,
        // weeklyOff, holiday, absent -- so these add up to activeEmployees.
        res.json({
            // The IST day these numbers are for. This was
            // dayStart.toISOString().slice(0, 10), and dayStart is IST midnight
            // -- 18:30 UTC the day BEFORE -- so it always named yesterday.
            date: dayKey,
            activeEmployees: employees.length,
            presentToday: out.present.length + out.late.length + out.wfh.length,
            halfDayToday: out.halfDay.length,
            needsReviewToday: out.needsReview.length,
            lateArrivals,
            // Punched in and not (finally) out: on duty now, for today.
            missingPunch: onDuty,
            absentToday: out.absent.length,
            onLeaveToday: out.onLeave.length,
            weeklyOffToday: out.weeklyOff.length,
            holidayToday: out.holiday.length,
            holidayName: holiday,
            pendingRegularizations,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Entry point for trusted devices (e.g. the BOTLens camera service) acting on
// behalf of an employee who isn't logged in themselves. Auth is a shared
// secret (see device_attendance_routes.js), so adminId/employeeId are taken
// from the request body instead of a decoded JWT, then delegated to the same
// punch handlers used by the employee-facing routes.
exports.devicePunch = async (req, res) => {
    const { adminId, employeeId, action } = req.body;
    if (!adminId || !employeeId || !action) {
        return res.status(400).json({ message: 'adminId, employeeId and action are required' });
    }

    const handlers = { 'punch-in': exports.punchIn, 'punch-out': exports.punchOut, 'lunch-in': exports.lunchIn, 'lunch-out': exports.lunchOut };
    const handler = handlers[action];
    if (!handler) {
        return res.status(400).json({ message: `Invalid action '${action}'. Expected one of: ${Object.keys(handlers).join(', ')}` });
    }
    // A malformed id made findById throw a CastError, which reached the caller
    // as a 500 carrying Mongoose's own message.
    if (!mongoose.isValidObjectId(employeeId) || !mongoose.isValidObjectId(adminId)) {
        return res.status(400).json({ message: 'adminId and employeeId must be valid ids' });
    }

    // The calling device (BOTLens) sends its own locally-cached adminId, which
    // can drift out of sync with the employee's actual tenant (e.g. if it gets
    // re-linked). Cross-check against the User doc's real adminId rather than
    // trusting the request blindly — otherwise a stale/wrong adminId silently
    // creates attendance under the wrong company instead of erroring.
    const employee = await User.findById(employeeId);
    if (!employee) {
        return res.status(404).json({ message: 'Employee not found' });
    }
    if (String(employee.adminId) !== String(adminId)) {
        return res.status(409).json({ message: 'adminId does not match this employee\'s actual tenant — refusing to record attendance under the wrong company' });
    }
    if (isFrozenTenant(employee.adminId)) return sendFrozen(res);

    req.adminId = adminId;
    req.userId = employeeId;
    return handler(req, res);
};

exports.getEmployeeHistory = async (req, res) => {
    try {
        const employeeId = req.userId;
        // Today and the month bounds in IST, not host time: on a UTC server
        // host-midnight month bounds dropped the 1st's row (stored at IST
        // midnight, i.e. 18:30 UTC the day before) and the 1st read as absent.
        const [nowY, nowM, nowD] = istDateKey().split('-').map(Number);
        const month = parseInt(req.query.month) || nowM;
        const year = parseInt(req.query.year) || nowY;

        const { start: startDate, end: endDate } = istMonthRange(year, month);
        const totalDays = new Date(year, month, 0).getDate();
        const mm = String(month).padStart(2, '0');
        const monthStartKey = `${year}-${mm}-01`;
        const monthEndKey = `${year}-${mm}-${String(totalDays).padStart(2, '0')}`;

        // Cap calculation to today if we're in the current month
        const isCurrentMonth = (nowY === year && nowM === month);
        const calcUpToDay = isCurrentMonth ? nowD : totalDays;

        // 1. Fetch data
        const [user, settings, history, festivals, leaves] = await Promise.all([
            User.findById(employeeId).populate('shiftId'),
            Settings.findOne({ adminId: req.adminId }),
            Attendance.find({ adminId: req.adminId, employeeId, date: { $gte: startDate, $lte: endDate } }),
            Festival.find({
                adminId: req.adminId,
                // Any festival overlapping the month, including one that
                // starts before it and ends after it.
                startDate: { $lte: monthEndKey },
                endDate: { $gte: monthStartKey },
            }),
            Leave.find({
                adminId: req.adminId, employeeId, status: 'approved',
                startDate: { $lte: endDate }, endDate: { $gte: startDate },
            }).populate('leaveTypeId', 'leaveName'),
        ]);

        // Approved leave, keyed by IST day. It was never read here, so a day
        // off on approved leave showed as "Absent" on the employee's calendar
        // and counted in their absent total -- while payroll, which reads the
        // leave itself, paid it. Keys are walked as calendar strings so the
        // host timezone cannot shift a day.
        const leaveMap = new Map();
        for (const l of leaves) {
            if (!l.startDate || !l.endDate) continue;
            let key = istDateKey(l.startDate);
            const lastKey = istDateKey(l.endDate);
            for (let guard = 0; key <= lastKey && guard < 400; guard++) {
                leaveMap.set(key, l);
                const [ky, km, kd] = key.split('-').map(Number);
                key = new Date(Date.UTC(ky, km - 1, kd + 1)).toISOString().slice(0, 10);
            }
        }

        const attendanceMap = new Map();
        history.forEach(rec => {
            attendanceMap.set(istDateKey(rec.date), rec);
        });

        const festivalMap = new Map();
        festivals.forEach(f => {
            let current = new Date(f.startDate);
            let last = new Date(f.endDate || f.startDate);
            while (current <= last) {
                festivalMap.set(current.toISOString().split('T')[0], f.name);
                current.setDate(current.getDate() + 1);
            }
        });

        const weeklyHolidays = user?.weeklyHolidays || [];
        const fullHistory = [];
        const summary = {
            present: 0,
            absent: 0,
            halfDay: 0,
            late: 0,
            // Both of these existed as stored statuses with nowhere to be
            // counted. The if/else below fell through for them, so a WFH day
            // and a needs_review day each occupied a slot in `totalDays` while
            // appearing in no bucket -- the figures did not add up, and a month
            // worked entirely from home summed to zero days present.
            wfh: 0,
            needsReview: 0,
            festival: 0,
            weeklyOff: 0,
            leave: 0,
            totalDays: calcUpToDay
        };

        // 2. Iterate through all days of the month (Up to today if current month)
        for (let d = 1; d <= calcUpToDay; d++) {
            const date = new Date(year, month - 1, d);
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });

            let record = attendanceMap.get(dateStr);

            if (record) {
                // If record exists, calculate duration
                let duration = "00 h 00 m";
                if (record.totalWorkMs) {
                    const hours = Math.floor(record.totalWorkMs / (1000 * 60 * 60));
                    const minutes = Math.floor((record.totalWorkMs % (1000 * 60 * 60)) / (1000 * 60));
                    duration = `${hours.toString().padStart(2, '0')} h ${minutes.toString().padStart(2, '0')} m`;
                } else if (record.punchIn && record.punchOut) {
                    const diff = record.punchOut - record.punchIn;
                    const hours = Math.floor(diff / (1000 * 60 * 60));
                    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    duration = `${hours.toString().padStart(2, '0')} h ${minutes.toString().padStart(2, '0')} m`;
                }

                // Update summary
                if (record.status === 'present') summary.present++;
                else if (record.status === 'half-day') summary.halfDay++;
                else if (record.status === 'late') {
                    summary.present++; // Late counts as present
                    summary.late++;
                } else if (record.status === 'wfh') {
                    summary.present++; // worked, just not from the office
                    summary.wfh++;
                } else if (record.status === 'needs_review') {
                    // Deliberately NOT folded into present or absent. The day
                    // carries a real punch that could not be measured, and
                    // saying which of the two it is, is exactly the question
                    // being escalated.
                    summary.needsReview++;
                } else if (record.status === 'absent') {
                    summary.absent++;
                }

                fullHistory.push({ ...record._doc, duration });
            } else {
                // Determine missing day status
                const festivalName = festivalMap.get(dateStr);
                const dayIsOff = isWeeklyOff(dayName, d, weeklyHolidays, settings?.attendance?.workDays, user?.shiftId?.workDays);
                const leave = leaveMap.get(dateStr);

                let status = 'absent';
                let remarks = '';

                if (leave && !festivalName && !dayIsOff) {
                    // Same precedence as classifyDay: a holiday or weekly off
                    // stays what it is, and leave covers only working days.
                    status = 'leave';
                    const typeName = leave.leaveTypeId?.leaveName || 'Leave';
                    remarks = leave.dayPortion && leave.dayPortion !== 'full'
                        ? `${typeName} (half day)`
                        : typeName;
                    summary.leave++;
                } else if (festivalName) {
                    status = 'festival';
                    remarks = festivalName;
                    summary.festival++;
                } else if (dayIsOff) {
                    status = 'weekly-off';
                    remarks = `${dayName} Holiday`;
                    summary.weeklyOff++;
                } else {
                    summary.absent++;
                }

                const placeholderDate = new Date(date);
                placeholderDate.setHours(12, 0, 0, 0);

                fullHistory.push({
                    date: placeholderDate,
                    status: status,
                    remarks: remarks,
                    isPlaceholder: true,
                    duration: "00 h 00 m"
                });
            }
        }

        // 3. Apply Filtering if requested
        let filteredHistory = fullHistory;
        if (req.query.status) {
            const filterStatus = req.query.status.toLowerCase();
            filteredHistory = fullHistory.filter(item => item.status.toLowerCase() === filterStatus);
        }

        res.json({
            summary,
            history: filteredHistory.sort((a, b) => new Date(b.date) - new Date(a.date))
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// One person's punches run one at a time. Every handler above reads the day and then writes it,
// so two requests arriving together (a double tap, a retry, the offline queue replaying beside a
// live tap) each saw "no row yet" and each created one: 3 simultaneous punch-ins made a duplicate
// attendance day in 14 of 15 races. Queued, the second request runs after the first has written
// and answers "Already punched in". Wrapped here, after every handler is defined, so the
// biometric path (iclock -> callHandler) and devicePunch pick up the wrapped versions too.
// See utils/employee_lock.js for what this does and does not guarantee.
for (const name of ['punchIn', 'punchOut', 'lunchIn', 'lunchOut']) {
    exports[name] = serialisePerUser(exports[name], 'punch');
}

// Mark Absent reads the day and may create it, so it takes the SAME lock as that
// employee's punches (keyed on the employee in the body, not the admin): racing
// a punch-in it could otherwise write a second row for the day.
{
    const markAbsentUnlocked = exports.markAbsent;
    exports.markAbsent = (req, res, next) => {
        const target = req.body && req.body.employeeId ? String(req.body.employeeId) : null;
        if (!target) return markAbsentUnlocked(req, res, next);
        return withEmployeeLock(`punch:${target}`, () => markAbsentUnlocked(req, res, next));
    };
}
