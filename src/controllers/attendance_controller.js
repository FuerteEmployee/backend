const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Settings = require('../models/Settings');
const Festival = require('../models/Festival');
const { cloudinary } = require('../config/cloudinary');
const { calculateAndSaveSalary } = require('./salary_controller');
const { calculateDistance, nearestBranchDistance } = require('../utils/distance');
const { isWeeklyOff, toLocalDateKey } = require('../utils/attendance_helpers');

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

        // 4. Geofencing check (Skip if WFH) — pass if near ANY assigned branch
        if (!isWFH && rules.requireLocation) {
            const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
            if (branches.length === 0) {
                return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
            }

            const distance = nearestBranchDistance(location?.lat, location?.lng, branches);

            if (distance > 300) { // 300 meters limit (generous for GPS inaccuracy)
                return res.status(400).json({
                    message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)`,
                    distance: Math.round(distance)
                });
            }
        }

        // 4. Determine Status (Late Check)
        let status = 'present';
        if (user.shiftId && !isWFH) {
            const [sHour, sMinute] = user.shiftId.startTime.split(':').map(Number);
            const graceMinutes = settings?.attendance?.lateGrace || 15;

            const shiftTime = new Date(now);
            shiftTime.setHours(sHour, sMinute + graceMinutes, 0, 0);

            if (now > shiftTime) {
                status = 'late';
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
        const user = await User.findById(employeeId).populate('branchId branchIds');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const settings = await Settings.findOne({ adminId: req.adminId });
        const rules = getAttendanceRules(user, settings);

        if (rules.requireLocation && !attendance.isWFH) {
            const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
            if (branches.length === 0) {
                return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
            }
            const distance = nearestBranchDistance(location?.lat, location?.lng, branches);
            if (distance > 300) {
                return res.status(400).json({ message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)` });
            }
        }

        const photoUrl = photo ? await uploadToCloudinary(photo) : null;

        attendance.punchOut = now;
        attendance.punchOutLocation = address || "Location provided by user";
        attendance.punchOutCoordinates = location || null;
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
        // status 'late' gets overwritten below, but wasLate survives so the
        // payroll engine (and analytics) can still read it.
        if (attendance.status === 'late') attendance.wasLate = true;

        // 6. Apply configurable half-day rules.
        const hdr = settings?.attendance?.halfDayRules || {};
        const hdMethod = hdr.method || 'durationBased';
        const hdBothLogic = hdr.bothLogic || 'or';
        const hdCutoff = hdr.cutoffTime || '09:35';
        const hdMinHours = hdr.minHours != null ? hdr.minHours : (settings?.attendance?.halfDayHours ?? 4);
        const hdDeductLunch = hdr.deductLunch !== false; // default true

        // Net worked time (ms). Start from totalWorkMs which already tracks multi-punch shifts.
        let netWorkMs = attendance.totalWorkMs || (attendance.punchOut - attendance.punchIn);
        if (hdDeductLunch && attendance.lunchInTime && attendance.lunchOutTime) {
            const lunchMs = new Date(attendance.lunchOutTime) - new Date(attendance.lunchInTime);
            if (lunchMs > 0) netWorkMs = Math.max(0, netWorkMs - lunchMs);
        }
        const netWorkHours = netWorkMs / (1000 * 60 * 60);

        // Time-based: punch-in strictly after cutoffTime = late arrival.
        // Grace rule: 09:35:00 is still on time; 09:35:01 is late.
        let isLateArrival = false;
        if (attendance.punchIn) {
            const [cutH, cutM] = hdCutoff.split(':').map(Number);
            const pi = new Date(attendance.punchIn);
            const piMins = pi.getHours() * 60 + pi.getMinutes();
            const piSecs = pi.getSeconds();
            const cutMins = cutH * 60 + cutM;
            isLateArrival = piMins > cutMins || (piMins === cutMins && piSecs > 0);
        }

        // Duration-based: net hours below minimum = short day.
        const isShortDay = netWorkHours < hdMinHours;

        let isHalfDay = false;
        if (hdMethod === 'timeBased') {
            isHalfDay = isLateArrival;
        } else if (hdMethod === 'durationBased') {
            isHalfDay = isShortDay;
        } else { // 'both'
            isHalfDay = hdBothLogic === 'or' ? (isLateArrival || isShortDay) : (isLateArrival && isShortDay);
        }

        const remarkParts = [];
        if (isLateArrival && (hdMethod !== 'durationBased')) remarkParts.push(`Late arrival (after ${hdCutoff})`);
        if (isShortDay && (hdMethod !== 'timeBased')) remarkParts.push(`Short hours (${netWorkHours.toFixed(2)}h < ${hdMinHours}h)`);

        if (isHalfDay) {
            attendance.status = 'half-day';
            const detail = remarkParts.length ? ` | ${remarkParts.join('; ')}` : '';
            attendance.remarks = (attendance.remarks || '') + detail;
        } else if (attendance.isWFH) {
            attendance.status = 'wfh'; // keep WFH bucket, don't collapse to 'present'
        } else {
            attendance.status = 'present';
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

        if (rules.requireLocation && attendance.remarks !== 'Work From Home') {
            const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
            if (branches.length === 0) {
                return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
            }
            const distance = nearestBranchDistance(location?.lat, location?.lng, branches);
            if (distance > 300) {
                return res.status(400).json({ message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)` });
            }
        }

        if (attendance.lunchOutTime) {
            return res.status(400).json({ message: 'Lunch already completed for today' });
        }

        attendance.lunchInTime = new Date();
        attendance.lunchInLocation = address || "Location provided by user";
        attendance.lunchInCoordinates = location || null;
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

        if (rules.requireLocation && attendance.remarks !== 'Work From Home') {
            const branches = [user.branchId, ...(user.branchIds || [])].filter(Boolean);
            if (branches.length === 0) {
                return res.status(400).json({ message: 'No branch assigned. Cannot verify location.' });
            }
            const distance = nearestBranchDistance(location?.lat, location?.lng, branches);
            if (distance > 300) {
                return res.status(400).json({ message: `You Are Not At Office Location (Distance: ${Math.round(distance)}m)` });
            }
        }

        attendance.lunchOutTime = new Date();
        attendance.lunchOutLocation = address || "Location provided by user";
        attendance.lunchOutCoordinates = location || null;
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

        const reports = await Attendance.find(query).populate('employeeId', 'name phone');
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
