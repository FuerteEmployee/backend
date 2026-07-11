const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Settings = require('../models/Settings');
const Festival = require('../models/Festival');
const Regularization = require('../models/Regularization');
const { cloudinary } = require('../config/cloudinary');
const { calculateAndSaveSalary } = require('./salary_controller');
const { calculateDistance, nearestBranchDistance } = require('../utils/distance');
const { isWeeklyOff, toLocalDateKey, isLatePunchIn, determineHalfDayStatus } = require('../utils/attendance_helpers');

async function uploadToCloudinary(dataUrl, folder = 'attendance') {
    if (!dataUrl) return null;
    try {
        const result = await cloudinary.uploader.upload(dataUrl, {
            folder: folder,
            resource_type: 'auto'
        });
        return result.secure_url;
    } catch (error) {
        console.error("Cloudinary Upload Error:", error);
        return null;
    }
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
        const { location, photo, isWFH, address } = req.body;
        const now = new Date();
        const today = new Date(); today.setHours(0, 0, 0, 0);

        // 1. Check if already punched in
        let attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: today
        });

        // 2. Fetch User, Shift and Settings
        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        const settings = await Settings.findOne({ adminId: req.adminId });

        const allowMultiple = settings?.attendance?.allowMultiplePunches || false;

        if (attendance) {
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

            // Perform multiple punch in
            const photoUrl = photo ? await uploadToCloudinary(photo) : null;
            attendance.punchOut = null;
            attendance.punchOutLocation = null;
            attendance.punchOutCoordinates = null;
            attendance.punchOutPhoto = null;
            
            attendance.shifts = attendance.shifts || [];
            attendance.shifts.push({ punchIn: now });
            
            if (!attendance.remarks?.includes('Multiple shifts')) {
                attendance.remarks = (attendance.remarks ? attendance.remarks + ' | ' : '') + 'Multiple shifts';
            }
            
            await attendance.save();
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
        const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
        let punchInDistance = null;
        if (!isWFH && branches.length > 0 && location?.lat != null && location?.lng != null) {
            const distance = nearestBranchDistance(location.lat, location.lng, branches);
            if (Number.isFinite(distance)) punchInDistance = Math.round(distance);

            if (rules.requireLocation && distance > 300) { // 300 meters limit (generous for GPS inaccuracy)
                return res.status(400).json({
                    message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)`,
                    distance: Math.round(distance)
                });
            }
        } else if (!isWFH && rules.requireLocation && branches.length === 0) {
            return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
        }

        // 4. Determine Status (Late Check & Shift-specific Half Day check)
        let status = 'present';
        if (user.shiftId && !isWFH) {
            if (isLatePunchIn(now, user.shiftId, settings)) {
                status = 'late';
            }
            if (user.shiftId.halfDayLatePunchInMin) {
                const [sHour, sMinute] = user.shiftId.startTime.split(':').map(Number);
                const halfDayPunchInCutoff = new Date(now);
                halfDayPunchInCutoff.setHours(sHour, sMinute + user.shiftId.halfDayLatePunchInMin, 0, 0);
                if (now > halfDayPunchInCutoff) {
                    status = 'half-day';
                }
            }
        }

        // 4. Perform Uploads in Parallel for Speed
        const photoUrl = photo ? await uploadToCloudinary(photo) : null;

        // WFH is a first-class status; wasLate will be set on punch-out so the
        // flag survives the status normalisation (late → present/half-day).
        const finalStatus = isWFH ? 'wfh' : status;
        attendance = new Attendance({
            adminId: req.adminId,
            employeeId,
            date: today,
            punchIn: now,
            punchInLocation: address || "Location provided by user",
            punchInCoordinates: location || null,
            punchInDistance,
            punchInPhoto: photoUrl,
            status: finalStatus,
            isWFH: !!isWFH,
            remarks: isWFH ? 'Work From Home' : '',
            punchOut: null,
            lunchInTime: null,
            lunchOutTime: null,
            shifts: [{ punchIn: now }],
            totalWorkMs: 0
        });

        await attendance.save();

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

exports.punchOut = async (req, res) => {
    try {
        const employeeId = req.userId;
        const { location, photo, address } = req.body;
        const now = new Date();
        const today = new Date(); today.setHours(0, 0, 0, 0);

        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: today
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No punch-in record found for today' });
        }

        if (attendance.punchOut) {
            return res.status(400).json({ message: 'Already punched out today' });
        }

        // --- Geofencing check for Punch-Out ---
        const user = await User.findById(employeeId).populate('shiftId branchId branchIds');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
        let punchOutDistance = null;
        if (!attendance.isWFH && branches.length > 0 && location?.lat != null && location?.lng != null) {
            const distance = nearestBranchDistance(location.lat, location.lng, branches);
            if (Number.isFinite(distance)) punchOutDistance = Math.round(distance);

            if (rules.requireLocation && distance > 300) {
                return res.status(400).json({ message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)` });
            }
        } else if (!attendance.isWFH && rules.requireLocation && branches.length === 0) {
            return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
        }

        const photoUrl = photo ? await uploadToCloudinary(photo) : null;

        attendance.punchOut = now;
        attendance.punchOutLocation = address || "Location provided by user";
        attendance.punchOutCoordinates = location || null;
        attendance.punchOutDistance = punchOutDistance;
        attendance.punchOutPhoto = photoUrl;

        // Update the last shift in the array
        if (attendance.shifts && attendance.shifts.length > 0) {
            const lastShift = attendance.shifts[attendance.shifts.length - 1];
            if (!lastShift.punchOut) {
                lastShift.punchOut = now;
                const shiftMs = lastShift.punchOut - lastShift.punchIn;
                attendance.totalWorkMs = (attendance.totalWorkMs || 0) + shiftMs;
            }
        } else {
            // Fallback for older records
            const workMillis = attendance.punchOut - attendance.punchIn;
            attendance.totalWorkMs = (attendance.totalWorkMs || 0) + workMillis;
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

        await attendance.save();

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
        const employeeId = req.body.employeeId || req.userId;
        const { location, address } = req.body;
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: { $gte: todayStart, $lte: todayEnd }
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No attendance record found for today' });
        }

        if (attendance.punchOut) {
            return res.status(400).json({ message: 'Already punched out for today' });
        }

        // --- Geofencing check for Lunch-In ---
        const user = await User.findById(employeeId).populate('branchId branchIds');
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        const lunchInBranches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
        let lunchInDistance = null;
        if (attendance.remarks !== 'Work From Home' && lunchInBranches.length > 0 && location?.lat != null && location?.lng != null) {
            const distance = nearestBranchDistance(location.lat, location.lng, lunchInBranches);
            if (Number.isFinite(distance)) lunchInDistance = Math.round(distance);

            if (rules.requireLocation && distance > 300) {
                return res.status(400).json({ message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)` });
            }
        } else if (rules.requireLocation && attendance.remarks !== 'Work From Home' && lunchInBranches.length === 0) {
            return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
        }

        if (attendance.lunchOutTime) {
            return res.status(400).json({ message: 'Lunch already completed for today' });
        }

        attendance.lunchInTime = new Date();
        attendance.lunchInLocation = address || "Location provided by user";
        attendance.lunchInCoordinates = location || null;
        attendance.lunchInDistance = lunchInDistance;
        await attendance.save();

        res.json(attendance);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.lunchOut = async (req, res) => {
    try {
        const employeeId = req.body.employeeId || req.userId;
        const { location, address } = req.body;
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

        const attendance = await Attendance.findOne({
            adminId: new mongoose.Types.ObjectId(req.adminId),
            employeeId: new mongoose.Types.ObjectId(employeeId),
            date: { $gte: todayStart, $lte: todayEnd }
        });

        if (!attendance) {
            return res.status(404).json({ message: 'No attendance record found for today' });
        }

        if (attendance.punchOut) {
            return res.status(400).json({ message: 'Already punched out for today' });
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

        const lunchOutBranches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
        let lunchOutDistance = null;
        if (attendance.remarks !== 'Work From Home' && lunchOutBranches.length > 0 && location?.lat != null && location?.lng != null) {
            const distance = nearestBranchDistance(location.lat, location.lng, lunchOutBranches);
            if (Number.isFinite(distance)) lunchOutDistance = Math.round(distance);

            if (rules.requireLocation && distance > 300) {
                return res.status(400).json({ message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)` });
            }
        } else if (rules.requireLocation && attendance.remarks !== 'Work From Home' && lunchOutBranches.length === 0) {
            return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
        }

        attendance.lunchOutTime = new Date();
        attendance.lunchOutLocation = address || "Location provided by user";
        attendance.lunchOutCoordinates = location || null;
        attendance.lunchOutDistance = lunchOutDistance;
        await attendance.save();

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

        const day = new Date(date);
        day.setHours(0, 0, 0, 0);

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
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

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
        const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

        const [activeEmployeeCount, todayRecords, pendingRegularizations] = await Promise.all([
            User.countDocuments({ adminId: req.adminId, role: 'employee', status: 'active' }),
            Attendance.find({ adminId: req.adminId, date: { $gte: dayStart, $lte: dayEnd } })
                .select('status punchIn punchOut wasLate')
                .lean(),
            Regularization.countDocuments({ adminId: req.adminId, status: 'pending' }),
        ]);

        const presentToday = todayRecords.filter(r => ['present', 'late', 'wfh'].includes(r.status)).length;
        const lateArrivals = todayRecords.filter(r => r.status === 'late' || r.wasLate).length;
        const missingPunch = todayRecords.filter(r => r.punchIn && !r.punchOut).length;
        const absentToday = Math.max(0, activeEmployeeCount - todayRecords.length);

        res.json({
            date: dayStart.toISOString().slice(0, 10),
            presentToday,
            lateArrivals,
            missingPunch,
            absentToday,
            pendingRegularizations,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
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
            User.findById(employeeId),
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
            attendanceMap.set(toLocalDateKey(rec.date), rec);
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
                const dayIsOff = isWeeklyOff(dayName, d, weeklyHolidays, settings?.attendance?.workDays);

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
