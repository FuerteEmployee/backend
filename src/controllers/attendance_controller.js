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
const { MAX_SESSIONS, allSessions, gradeDay, computeWorkedMs, computeSessionWorkMs } = require('../utils/shift_status');
const { logAttendanceEvent } = require('../utils/attendance_event_logger');
const { isWeeklyOff, toLocalDateKey, isLatePunchIn, determineHalfDayStatus, istStartOfDay, istEndOfDay, istDateKey, applyPunchRounding, shiftTimeOnDate } = require('../utils/attendance_helpers');

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
        console.error("Cloudinary Upload Error:", error);
        return null;
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
function evaluateGeofence({ user, settings, rules, location, isWFH, isDevicePunch }) {
    const branches = [user?.branchId, ...(user?.branchIds || [])].filter((b) => b && b.geoFenceEnabled !== false);
    const fallback = settings?.attendance?.officeRadius || 3000;

    if (!isWFH && branches.length > 0 && location?.lat != null && location?.lng != null) {
        const { distance, radius } = nearestBranchDistance(location.lat, location.lng, branches, fallback);
        const rounded = Number.isFinite(distance) ? Math.round(distance) : null;
        const maxRadius = radius || fallback;
        if (rules.requireLocation && Number.isFinite(distance) && distance > maxRadius) {
            return {
                distance: rounded,
                reject: { message: `You Are Not At Office Location (Distance: ${rounded}m)`, distance: rounded },
            };
        }
        return { distance: rounded, reject: null };
    }

    if (!isWFH && !isDevicePunch && rules.requireLocation && branches.length === 0) {
        return { distance: null, reject: { message: 'No branch assigned. Cannot verify location.' } };
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

/**
 * Calculates current month stats for the employee to return in punch-in response
 */
async function getEmployeeSummary(adminId, employeeId) {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // Count attendance
    const attendanceCount = await Attendance.countDocuments({
        adminId,
        employeeId,
        date: { $gte: startOfMonth }
    });

    // Count holidays (festivals)
    const holidays = await Festival.countDocuments({
        adminId,
        startDate: { $gte: startOfMonth.toISOString().split('T')[0] }
    });

    return { attendanceCount, holidays };
}

exports.punchIn = async (req, res) => {
    try {
        const employeeId = req.userId; // Use userId from protect middleware
        const { location, photo, isWFH, address, accuracy, fixAt } = req.body;

        const accuracyError = rejectPoorAccuracy(accuracy);
        if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });
        const now = new Date();
        const today = istStartOfDay(now);

        // 1. Check if already punched in
        let attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: today
        });

        // 2. Fetch User, Shift and Settings
        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        const settings = await Settings.findOne({ adminId: req.adminId });

        // Rounded per settings.attendance.roundingInterval/Direction (only if
        // 'Punch In' is in roundingAppliedTo) — feeds status/half-day checks and
        // is what actually gets stored, so payroll and the late check agree.
        const punchInTime = applyPunchRounding(now, 'Punch In', settings);

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
                    message: `Maximum daily session limit (${MAX_SESSIONS}) reached. Please contact your admin if you need another session today.`,
                });
            }

            // The fence applies to EVERY session, not just the first one.
            const reGeo = evaluateGeofence({ user, settings, rules, location, isWFH, isDevicePunch: req.isDevicePunch });
            if (reGeo.reject) return res.status(400).json(reGeo.reject);

            // Perform multiple punch in
            const photoUrl = photo ? await uploadToCloudinary(photo) : null;
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
        const geo = evaluateGeofence({ user, settings, rules, location, isWFH, isDevicePunch: req.isDevicePunch });
        if (geo.reject) return res.status(400).json(geo.reject);
        const punchInDistance = geo.distance;

        // 4. Determine Status (Late Check & Shift-specific Half Day check)
        let status = 'present';
        if (user.shiftId && !isWFH) {
            if (isLatePunchIn(punchInTime, user.shiftId, settings)) {
                status = 'late';
            }
            if (user.shiftId.halfDayLatePunchInMin) {
                const shiftStart = shiftTimeOnDate(user.shiftId.startTime, punchInTime);
                const halfDayPunchInCutoff = new Date(shiftStart.getTime() + user.shiftId.halfDayLatePunchInMin * 60 * 1000);
                if (punchInTime > halfDayPunchInCutoff) {
                    status = 'half-day';
                }
            }
        }

        // 4. Perform Uploads in Parallel for Speed
        const photoUrl = photo ? await uploadToCloudinary(photo) : null;

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
            punchOut: null,
            lunchInTime: null,
            lunchOutTime: null,
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
        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(req.userId),
            date: { $gte: istStartOfDay(), $lte: istEndOfDay() },
        })
            .select('date punchIn punchOut lunchInTime lunchOutTime shifts status totalWorkMs punchOutIsProvisional autoPunchOut autoPunchOutReason')
            .lean();

        // A provisional punch-out is a device toggle that may only be someone
        // leaving for lunch, so the day is NOT closed and tracking must
        // continue. Reporting it as a real punch-out would stop the tracker
        // half way through an afternoon.
        if (attendance && attendance.punchOut && attendance.punchOutIsProvisional) {
            attendance.punchOut = null;
        }

        res.json(attendance || null);
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

        const accuracyError = rejectPoorAccuracy(accuracy);
        if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });
        const now = new Date();
        const today = istStartOfDay(now);

        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: today
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No punch-in record found for today' });
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
        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        // Rounded per settings.attendance.roundingInterval/Direction (only if
        // 'Punch Out' is in roundingAppliedTo) — this is what actually gets
        // stored and fed into worked-hours/half-day/payroll math.
        const punchOutTime = applyPunchRounding(now, 'Punch Out', settings);

        const outGeo = evaluateGeofence({
            user, settings, rules, location,
            isWFH: attendance.isWFH, isDevicePunch: req.isDevicePunch,
        });
        if (outGeo.reject) return res.status(400).json(outGeo.reject);
        const punchOutDistance = outGeo.distance;

        const photoUrl = photo ? await uploadToCloudinary(photo) : null;

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

        // 6. Background Sync Salary
        calculateAndSaveSalary(req.adminId, user, now.getMonth() + 1, now.getFullYear()).catch(err => {
            console.error("Salary Sync Error:", err);
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.lunchIn = async (req, res) => {
    try {
        const accuracyError = rejectPoorAccuracy(req.body?.accuracy);
        if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });

        const employeeId = req.body.employeeId || req.userId;
        const { location, address, accuracy } = req.body;
        const todayStart = istStartOfDay();
        const todayEnd = istEndOfDay();

        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: { $gte: todayStart, $lte: todayEnd }
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No attendance record found for today' });
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

        // --- Geofencing check for Lunch-In ---
        const user = await User.findById(employeeId).populate('branchId branchIds');
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

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

        attendance.lunchInTime = applyPunchRounding(new Date(), 'Lunch In', settings);
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
        const accuracyError = rejectPoorAccuracy(req.body?.accuracy);
        if (accuracyError) return res.status(400).json({ message: accuracyError, retryable: true });

        const employeeId = req.body.employeeId || req.userId;
        const { location, address, accuracy } = req.body;
        const todayStart = istStartOfDay();
        const todayEnd = istEndOfDay();

        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: { $gte: todayStart, $lte: todayEnd }
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No attendance record found for today' });
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
        const user = await User.findById(employeeId).populate('branchId branchIds');
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        const lunchOutGeo = evaluateGeofence({
            user, settings, rules, location,
            isWFH: attendance.isWFH || attendance.remarks === 'Work From Home',
            isDevicePunch: req.isDevicePunch,
        });
        if (lunchOutGeo.reject) return res.status(400).json(lunchOutGeo.reject);
        const lunchOutDistance = lunchOutGeo.distance;

        attendance.lunchOutTime = applyPunchRounding(new Date(), 'Lunch Out', settings);
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

        if (employeeId) query.employeeId = new mongoose.Types.ObjectId(employeeId);
        if (startDate && endDate) {
            query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }

        const reports = await Attendance.find(query).populate({
            path: 'employeeId',
            select: 'name phone shiftId branchId',
            populate: [
                { path: 'shiftId', select: 'name startTime endTime' },
                { path: 'branchId', select: 'branchName city' },
            ],
        });
        res.json(reports);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        const { punchIn, punchOut, lunchInTime, lunchOutTime, status, remarks } = req.body;

        const attendance = await Attendance.findOne({
            _id: new mongoose.Types.ObjectId(id),
            adminId: new mongoose.Types.ObjectId(req.adminId)
        });
        if (!attendance) return res.status(404).json({ message: 'Record not found' });

        if (punchIn) attendance.punchIn = punchIn;
        if (punchOut) attendance.punchOut = punchOut;
        if (lunchInTime) attendance.lunchInTime = lunchInTime;
        if (lunchOutTime) attendance.lunchOutTime = lunchOutTime;
        if (status) attendance.status = status;
        if (remarks !== undefined) attendance.remarks = remarks;

        await attendance.save();
        res.json(attendance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Admin marks an employee absent for a given day — find-or-create the
// Attendance doc rather than requiring one to already exist (unlike
// updateAttendance, which 404s if there's no record yet).
exports.markAbsent = async (req, res) => {
    try {
        const { employeeId, date } = req.body;
        if (!employeeId || !date) {
            return res.status(400).json({ message: 'employeeId and date are required' });
        }

        const day = istStartOfDay(new Date(date));

        let attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: day
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
        attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + 'Marked absent by admin';

        await attendance.save();
        res.json(attendance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Active employees with no Attendance record for today — the ones who never
// punched in at all (as opposed to Missing Punch, which is punched-in-but-
// not-out and already has a record).
exports.getAbsentToday = async (req, res) => {
    try {
        const todayStart = istStartOfDay();
        const todayEnd = istEndOfDay();

        const [employees, todayRecords] = await Promise.all([
            User.find({ adminId: req.adminId, role: 'employee', status: 'active' })
                .select('name phone shiftId branchId')
                .populate('shiftId', 'name')
                .populate('branchId', 'branchName')
                .lean(),
            Attendance.find({ adminId: req.adminId, date: { $gte: todayStart, $lte: todayEnd } })
                .select('employeeId')
                .lean(),
        ]);

        const presentIds = new Set(todayRecords.map(a => String(a.employeeId)));
        const absentees = employees.filter(e => !presentIds.has(String(e._id)));

        res.json(absentees);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Bundled KPI numbers for the Attendance page — a single round trip instead
// of shipping the whole day's records/employee list to the browser to count.
exports.getStats = async (req, res) => {
    try {
        const day = req.query.date ? new Date(req.query.date) : new Date();
        const dayStart = istStartOfDay(day);
        const dayEnd = istEndOfDay(day);

        const [activeEmployeeCount, todayRecords, pendingRegularizations] = await Promise.all([
            User.countDocuments({ adminId: req.adminId, role: 'employee', status: 'active' }),
            Attendance.find({ adminId: req.adminId, date: { $gte: dayStart, $lte: dayEnd } })
                .select('status punchIn punchOut wasLate')
                .lean(),
            Regularization.countDocuments({ adminId: req.adminId, status: 'pending' }),
        ]);

        // Half-day gets its own dedicated count (like the dashboard's "Half Day
        // Today" card) instead of being folded into presentToday — otherwise
        // this number silently means something different here than it does
        // on the admin dashboard, which is confusing when the two are compared.
        const presentToday = todayRecords.filter(r => ['present', 'late', 'wfh'].includes(r.status)).length;
        const halfDayToday = todayRecords.filter(r => r.status === 'half-day').length;
        const lateArrivals = todayRecords.filter(r => r.status === 'late' || r.wasLate).length;
        const missingPunch = todayRecords.filter(r => r.punchIn && !r.punchOut).length;
        const absentToday = Math.max(0, activeEmployeeCount - todayRecords.length);

        res.json({
            date: dayStart.toISOString().slice(0, 10),
            presentToday,
            halfDayToday,
            lateArrivals,
            missingPunch,
            absentToday,
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

    req.adminId = adminId;
    req.userId = employeeId;
    return handler(req, res);
};

exports.getEmployeeHistory = async (req, res) => {
    try {
        const employeeId = req.userId;
        const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);
        const totalDays = new Date(year, month, 0).getDate();

        // Cap calculation to today if we're in the current month
        const now = new Date();
        const isCurrentMonth = (now.getFullYear() === year && now.getMonth() + 1 === month);
        const calcUpToDay = isCurrentMonth ? now.getDate() : totalDays;

        // 1. Fetch data
        const [user, settings, history, festivals] = await Promise.all([
            User.findById(employeeId).populate('shiftId'),
            Settings.findOne({ adminId: req.adminId }),
            Attendance.find({ adminId: req.adminId, employeeId, date: { $gte: startDate, $lte: endDate } }),
            Festival.find({
                adminId: req.adminId,
                $or: [
                    { startDate: { $gte: startDate.toISOString().split('T')[0], $lte: endDate.toISOString().split('T')[0] } },
                    { endDate: { $gte: startDate.toISOString().split('T')[0], $lte: endDate.toISOString().split('T')[0] } }
                ]
            })
        ]);

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
            festival: 0,
            weeklyOff: 0,
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
                }

                fullHistory.push({ ...record._doc, duration });
            } else {
                // Determine missing day status
                const festivalName = festivalMap.get(dateStr);
                const dayIsOff = isWeeklyOff(dayName, d, weeklyHolidays, settings?.attendance?.workDays, user?.shiftId?.workDays);

                let status = 'absent';
                let remarks = '';

                if (festivalName) {
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
