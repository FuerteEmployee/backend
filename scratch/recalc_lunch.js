// Recalculate totalWorkMs for days graded BEFORE the per-shift lunch policy
// shipped, so stored days match what the shift now says.
//
// READ ONLY unless --apply is passed. Run from backend/:
//   node scratch/recalc_lunch.js                       # dry run, today
//   node scratch/recalc_lunch.js 2026-09-17 2026-09-18 # dry run, range
//   node scratch/recalc_lunch.js 2026-09-18 2026-09-18 --apply
//
// Why this exists: a day's totalWorkMs is written once, by whichever path
// closed it. Changing a shift's lunch rule does not reach back and re-grade
// days already stored -- deliberately, because silently rewriting past pay is
// worse than leaving it. This makes the rewrite explicit, reviewable and
// opt-in.
//
// It only ever recomputes from the SAME functions the live paths use, so a day
// it rewrites is identical to the same day closed after the deploy. It never
// invents punches and never touches a day it cannot recompute.
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Attendance = require('../src/models/Attendance');
const Settings = require('../src/models/Settings');
require('../src/models/Shift');
const { computeWorkedMs, computeSessionWorkMs, gradeDay, resolveLunchPolicy, lunchDeductionMs } = require('../src/utils/shift_status');
const { istStartOfDay, istEndOfDay, istDateKey } = require('../src/utils/attendance_helpers');

const APPLY = process.argv.includes('--apply');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const START = args[0] || istDateKey(new Date());
const END = args[1] || START;

const hm = (ms) => `${Math.floor((ms || 0) / 3600000)}h${String(Math.round(((ms || 0) % 3600000) / 60000)).padStart(2, '0')}`;

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log(`${APPLY ? '*** APPLY ***' : 'DRY RUN'}  days ${START} .. ${END}\n`);

    const from = istStartOfDay(new Date(`${START}T06:00:00Z`));
    const to = istEndOfDay(new Date(`${END}T06:00:00Z`));

    const rows = await Attendance.find({ date: { $gte: from, $lte: to } });
    const settingsCache = new Map();
    const userCache = new Map();

    let changed = 0, unchanged = 0, skipped = 0;
    let totalDeltaMs = 0;

    for (const a of rows) {
        const uid = String(a.employeeId);
        if (!userCache.has(uid)) {
            userCache.set(uid, await User.findById(a.employeeId).populate('shiftId').lean());
        }
        const user = userCache.get(uid);
        if (!user) { skipped++; continue; }

        const aid = String(a.adminId);
        if (!settingsCache.has(aid)) {
            settingsCache.set(aid, await Settings.findOne({ adminId: a.adminId }).lean());
        }
        const settings = settingsCache.get(aid);
        const shift = user.shiftId || null;

        // A still-open day has no final total yet; leave it to whoever closes it.
        if (!a.punchIn || !a.punchOut) { skipped++; continue; }

        const before = a.totalWorkMs || 0;
        const after = computeWorkedMs(a, shift, settings);
        const beforeGrade = a.status;

        if (before === after) { unchanged++; continue; }

        const sum = (a.shifts || []).reduce((n, s) => n + (s.workMs || 0), 0);
        const policy = resolveLunchPolicy(shift, settings);
        const ded = lunchDeductionMs(a, settings, shift, sum);

        console.log(`${a.dayKey || istDateKey(a.date)}  ${String(user.name || '').trim().padEnd(22)}`);
        console.log(`    sessions ${hm(sum)}  |  stored ${hm(before)} -> recomputed ${hm(after)}  `
            + `(${after > before ? '+' : ''}${Math.round((after - before) / 60000)} min)`);
        console.log(`    lunch policy '${policy.mode}' deducts ${Math.round(ded / 60000)} min`
            + `${shift ? ` (shift "${shift.name}")` : ' (no shift)'}`);

        totalDeltaMs += after - before;
        changed++;

        if (APPLY) {
            a.totalWorkMs = after;
            for (const s of (a.shifts || [])) s.workMs = computeSessionWorkMs(s, a, shift);
            const grade = gradeDay(a, shift, settings);
            // Only ever replaces a grade the engine can compute. A day a human
            // set to something else (needs_review, an admin override) is left
            // alone -- re-grading it would quietly discard that decision.
            if (grade && ['present', 'half-day', 'absent'].includes(a.status)) a.status = grade;
            await a.save();
            if (a.status !== beforeGrade) console.log(`    status ${beforeGrade} -> ${a.status}`);
        }
    }

    console.log(`\n${changed} day(s) would change, ${unchanged} already correct, ${skipped} skipped (open or no user).`);
    console.log(`net change ${totalDeltaMs >= 0 ? '+' : ''}${Math.round(totalDeltaMs / 60000)} minutes across all employees.`);
    if (changed && !APPLY) console.log('\nNothing was written. Re-run with --apply to commit.');

    await mongoose.disconnect();
})().catch(async (e) => { console.error('ERROR:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
