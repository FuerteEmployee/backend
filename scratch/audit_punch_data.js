#!/usr/bin/env node
/**
 * Whole-database audit of attendance/punch integrity. READ-ONLY.
 *
 *   node scratch/audit_punch_data.js
 *
 * Each check reports a count and a few real examples. Checks are ordered by
 * how much damage the defect does to pay, not by how interesting it is.
 */
require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const IST = 330 * 60000;
const ist = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().replace('T', ' ').slice(0, 19) : 'null');
const day = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : '?');
const h = (ms) => (ms ? (ms / 3600000).toFixed(2) + 'h' : '0h');

const findings = [];
function report(sev, title, count, detail, examples = []) {
    findings.push({ sev, title, count });
    if (!count) { console.log(`\n  ok   ${title}: none`); return; }
    console.log(`\n  ${sev.padEnd(6)} ${title}: ${count}`);
    if (detail) console.log(`         ${detail}`);
    for (const e of examples.slice(0, 4)) console.log(`         · ${e}`);
}

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const db = mongoose.connection.db;
    const A = db.collection('attendances');
    const U = db.collection('users');

    const total = await A.countDocuments();
    const names = new Map((await U.find({ role: 'employee' }).project({ name: 1 }).toArray()).map((u) => [String(u._id), u.name]));
    const who = (id) => names.get(String(id)) || String(id).slice(-6);

    console.log(`cluster: ${(process.env.MONGO_URI.match(/@([^/]+)/) || [])[1]}`);
    console.log(`attendance documents: ${total}\n${'='.repeat(70)}`);

    // 1 ── punch-out before punch-in
    let rows = await A.find({ punchIn: { $ne: null }, punchOut: { $ne: null }, $expr: { $lt: ['$punchOut', '$punchIn'] } }).limit(2000).toArray();
    report('CRIT', 'Punch-out earlier than punch-in (negative worked time)', rows.length,
        'Cannot be paid and cannot be graded; arithmetic is impossible.',
        rows.map((r) => `${day(r.date)} ${who(r.employeeId)} in=${ist(r.punchIn)} out=${ist(r.punchOut)}`));

    // 2 ── graded absent despite a real punch-in
    rows = await A.find({ status: 'absent', punchIn: { $ne: null } }).limit(2000).toArray();
    report('CRIT', 'Marked ABSENT although they punched in', rows.length,
        'Unpaid days for people who came to work.',
        rows.map((r) => `${day(r.date)} ${who(r.employeeId)} in=${ist(r.punchIn)} out=${ist(r.punchOut)} worked=${h(r.totalWorkMs)}`));

    // 3 ── closed day with no worked time
    rows = await A.find({ punchIn: { $ne: null }, punchOut: { $ne: null }, $or: [{ totalWorkMs: { $in: [null, 0] } }, { totalWorkMs: { $exists: false } }] }).limit(2000).toArray();
    report('CRIT', 'Closed day with totalWorkMs 0/absent', rows.length,
        'Both punches exist but no duration was computed, so hours-based grading and OT cannot run.',
        rows.map((r) => `${day(r.date)} ${who(r.employeeId)} in=${ist(r.punchIn)} out=${ist(r.punchOut)}`));

    // 4 ── the UTC shift-end signature: auto-closed at an exact :30 IST boundary
    rows = await A.find({ 'shifts.closeReason': 'shift_end' }).limit(3000).toArray();
    const utcSig = rows.filter((r) => {
        const s = (r.shifts || []).find((x) => x.closeReason === 'shift_end' && x.punchOut);
        if (!s) return false;
        const d = new Date(s.punchOut);
        return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0; // exact UTC hour == :30 IST
    });
    report('CRIT', 'Auto-closed at a UTC-resolved shift end (setHours bug)', utcSig.length,
        `of ${rows.length} shift_end closes. Close time lands 5h30m late because shiftTimeOnDate uses setHours on a UTC server.`,
        utcSig.map((r) => { const s = r.shifts.find((x) => x.closeReason === 'shift_end'); return `${day(r.date)} ${who(r.employeeId)} closed=${ist(s.punchOut)} worked=${h(r.totalWorkMs)} status=${r.status}`; }));

    // 5 ── still open, and old
    const cutoff = new Date(Date.now() - 36 * 3600 * 1000);
    rows = await A.find({ punchIn: { $ne: null }, punchOut: null, date: { $lt: cutoff } }).sort({ date: 1 }).limit(3000).toArray();
    report('HIGH', 'Sessions never punched out (older than 36h)', rows.length,
        'Employee shows permanently on duty; the day can never be graded or paid.',
        rows.map((r) => `${day(r.date)} ${who(r.employeeId)} in=${ist(r.punchIn)} status=${r.status}`));

    // 6 ── duplicate employee-day rows
    const dupes = await A.aggregate([
        { $match: { employeeId: { $ne: null } } },
        { $group: { _id: { e: '$employeeId', d: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: '+05:30' } } }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { n: { $gt: 1 } } }, { $sort: { n: -1 } }, { $limit: 400 },
    ]).toArray();
    report('HIGH', 'Duplicate attendance rows for one employee-day', dupes.length,
        'Two rows for the same day double-count or mask each other depending on which is read first.',
        dupes.map((d) => `${d._id.d} ${who(d._id.e)} ×${d.n}`));

    // 7 ── attendance date not stored at IST midnight
    rows = await A.find({}).project({ date: 1, employeeId: 1 }).limit(20000).toArray();
    const badDate = rows.filter((r) => { const d = new Date(r.date); return !(d.getUTCHours() === 18 && d.getUTCMinutes() === 30); });
    report('HIGH', 'Attendance date not at IST midnight', badDate.length,
        `of ${rows.length} sampled. Written by pre-IST-fix code; exact-match day lookups miss these and create duplicates.`,
        badDate.slice(0, 4).map((r) => `${who(r.employeeId)} date=${new Date(r.date).toISOString()}`));

    // 8 ── implausible session length
    rows = await A.find({ punchIn: { $ne: null }, punchOut: { $ne: null } }).project({ punchIn: 1, punchOut: 1, employeeId: 1, date: 1, totalWorkMs: 1 }).limit(20000).toArray();
    const longDay = rows.filter((r) => new Date(r.punchOut) - new Date(r.punchIn) > 16 * 3600000);
    report('MED', 'Session longer than 16 hours', longDay.length, 'Almost always a missed punch-out later closed by something else.',
        longDay.map((r) => `${day(r.date)} ${who(r.employeeId)} ${((new Date(r.punchOut) - new Date(r.punchIn)) / 3600000).toFixed(1)}h`));

    // 9 ── lunch integrity
    const lunchBad = await A.find({ lunchOutTime: { $ne: null }, lunchInTime: null }).limit(500).toArray();
    report('MED', 'Lunch ended without a lunch start', lunchBad.length,
        'Break length is computed as lunchOut − lunchIn, which needs both.',
        lunchBad.map((r) => `${day(r.date)} ${who(r.employeeId)}`));
    const lunchNeg = await A.find({ lunchInTime: { $ne: null }, lunchOutTime: { $ne: null }, $expr: { $lt: ['$lunchOutTime', '$lunchInTime'] } }).limit(500).toArray();
    report('MED', 'Lunch ended before it started', lunchNeg.length, 'Produces a negative break, which inflates worked time.',
        lunchNeg.map((r) => `${day(r.date)} ${who(r.employeeId)}`));

    // 10 ── open lunch on a closed day
    const openLunch = await A.find({ punchOut: { $ne: null }, lunchInTime: { $ne: null }, lunchOutTime: null }).limit(500).toArray();
    report('MED', 'Day closed while still on lunch', openLunch.length,
        'The break never ended, so the deduction is undefined.',
        openLunch.map((r) => `${day(r.date)} ${who(r.employeeId)}`));

    // 11 ── provisional punch-outs left unresolved
    const prov = await A.countDocuments({ punchOutIsProvisional: true });
    report('MED', 'Device punch-outs still flagged provisional', prov,
        'A device toggle that may only have been a lunch break, never confirmed by an app punch-out.');

    // 12 ── employees with no shift, so hours cannot be graded
    const noShift = await U.countDocuments({ role: 'employee', status: 'active', $or: [{ shiftId: null }, { shiftId: { $exists: false } }] });
    const activeEmp = await U.countDocuments({ role: 'employee', status: 'active' });
    report('MED', 'Active employees with no shift assigned', noShift,
        `of ${activeEmp} active. requiredWorkMs returns null for them, so gradeDay always says "present" regardless of hours.`);

    // 13 ── future punches
    const future = await A.find({ punchIn: { $gt: new Date(Date.now() + 3600000) } }).limit(200).toArray();
    report('MED', 'Punch-in in the future', future.length, 'Clock skew on a device or a bad manual edit.',
        future.map((r) => `${day(r.date)} ${who(r.employeeId)} in=${ist(r.punchIn)}`));

    // 14 ── status the day cannot support
    const openGraded = await A.countDocuments({ punchOut: null, punchIn: { $ne: null }, status: { $in: ['present', 'half-day', 'wfh'] } });
    report('LOW', 'Open day carrying a graded status', openGraded,
        'gradeDay returns null while a day is open, so this is the punch-in placeholder, not a judgement. It reads as fact in the UI.');

    console.log(`\n${'='.repeat(70)}\nSUMMARY`);
    for (const s of ['CRIT', 'HIGH', 'MED', 'LOW']) {
        const g = findings.filter((f) => f.sev === s && f.count);
        if (g.length) console.log(`  ${s}: ` + g.map((f) => `${f.title} (${f.count})`).join('; '));
    }
    await mongoose.disconnect();
})().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
