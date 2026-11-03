#!/usr/bin/env node
/**
 * What would the new code actually CHANGE, across every real day on record?
 *
 *   node scratch/impact_grading_diff.js
 *
 * READ-ONLY. Replays every attendance document through the current gradeDay
 * and reports where the computed grade differs from what is stored — because
 * "the tests pass" and "this is safe to deploy" are different claims, and only
 * this one is about money.
 *
 * Each transition is classified by who it costs:
 *   BETTER  the employee is paid more, or an unfair mark is removed
 *   WORSE   the employee is paid less  <-- these need a human before deploy
 *   NEUTRAL bookkeeping only
 */
require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
require(path.join(SRC, 'models/Shift'));
const Attendance = require(path.join(SRC, 'models/Attendance'));
const User = require(path.join(SRC, 'models/User'));
const Settings = require(path.join(SRC, 'models/Settings'));
const { gradeDay, computeWorkedMs, isDayOpen } = require(path.join(SRC, 'utils/shift_status'));

// Rough pay weight per status, only to signal direction of change.
const WEIGHT = { present: 1, late: 1, wfh: 1, 'half-day': 0.5, absent: 0, needs_review: null };

const direction = (from, to) => {
    const a = WEIGHT[from];
    const b = WEIGHT[to];
    if (b === null) return 'NEUTRAL';        // needs_review: withheld for a human, not a deduction
    if (a === null || a === undefined) return 'NEUTRAL';
    if (b > a) return 'BETTER';
    if (b < a) return 'WORSE';
    return 'NEUTRAL';
};

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    console.log(`cluster: ${(process.env.MONGO_URI.match(/@([^/]+)/) || [])[1]}\n`);

    const users = new Map((await User.find({}).populate('shiftId').lean()).map((u) => [String(u._id), u]));
    const settings = new Map((await Settings.find({}).lean()).map((s) => [String(s.adminId), s]));

    const rows = await Attendance.find({}).lean();
    console.log(`replaying ${rows.length} attendance documents through the current gradeDay\n`);

    const transitions = new Map();
    let open = 0, unchanged = 0, noUser = 0, threw = 0;
    const worstExamples = [];

    for (const a of rows) {
        const u = users.get(String(a.employeeId));
        if (!u) { noUser++; continue; }
        if (isDayOpen(a)) { open++; continue; }

        let grade;
        try {
            grade = gradeDay(a, u.shiftId, settings.get(String(a.adminId)));
        } catch (e) { threw++; continue; }

        if (grade === null) { open++; continue; }
        const stored = a.status || '(none)';
        if (grade === stored) { unchanged++; continue; }

        const key = `${stored} -> ${grade}`;
        const dir = direction(stored, grade);
        const rec = transitions.get(key) || { n: 0, dir, examples: [] };
        rec.n++;
        if (rec.examples.length < 3) {
            rec.examples.push(`${a.dayKey || String(a.date).slice(0, 10)} ${u.name} worked=${((computeWorkedMs(a, u.shiftId, settings.get(String(a.adminId))) || 0) / 3600000).toFixed(2)}h shift=${u.shiftId ? u.shiftId.startTime + '-' + u.shiftId.endTime : 'none'}`);
        }
        transitions.set(key, rec);
        if (dir === 'WORSE' && worstExamples.length < 12) worstExamples.push({ key, ex: rec.examples[rec.examples.length - 1] });
    }

    const sorted = [...transitions.entries()].sort((x, y) => y[1].n - x[1].n);
    const total = sorted.reduce((s, [, r]) => s + r.n, 0);

    console.log('== GRADE CHANGES ==');
    console.log(`  unchanged: ${unchanged} | still open (not graded): ${open} | changed: ${total}`);
    if (noUser) console.log(`  skipped, employee record missing: ${noUser}`);
    if (threw) console.log(`  skipped, gradeDay threw: ${threw}`);
    console.log('');

    for (const [key, r] of sorted) {
        console.log(`  ${String(r.dir).padEnd(7)} ${String(r.n).padStart(4)}  ${key}`);
        for (const e of r.examples) console.log(`                 ${e}`);
    }

    const byDir = {};
    for (const [, r] of sorted) byDir[r.dir] = (byDir[r.dir] || 0) + r.n;
    console.log('\n== WHO PAYS ==');
    for (const d of ['WORSE', 'BETTER', 'NEUTRAL']) if (byDir[d]) console.log(`  ${d.padEnd(7)} ${byDir[d]}`);

    if (byDir.WORSE) {
        console.log('\n  !! Days where an employee would be paid LESS than the record currently says.');
        console.log('     Each needs a human decision before this reaches production.');
    } else {
        console.log('\n  No day is downgraded. Nothing reduces anyone\'s pay.');
    }

    await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
