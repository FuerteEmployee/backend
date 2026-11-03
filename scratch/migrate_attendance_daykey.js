#!/usr/bin/env node
/**
 * Give every attendance row a canonical IST dayKey, then make duplicate
 * employee-days structurally impossible.
 *
 *   node scratch/migrate_attendance_daykey.js             # report only
 *   node scratch/migrate_attendance_daykey.js --backfill  # write dayKey
 *   node scratch/migrate_attendance_daykey.js --fix-root  # sync stale root punchOut
 *   node scratch/migrate_attendance_daykey.js --index     # build the unique index
 *
 * Run them in that order. --index refuses while duplicates remain, because a
 * unique index cannot be built over them and a half-applied migration that
 * *looks* finished is worse than one that plainly stopped.
 *
 * Duplicates are NOT merged automatically. Two rows for one employee-day
 * disagree about what somebody did that day, and only a person who can ask
 * them knows which punch was real. The script prints them for a human.
 */
require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const { istDateKey } = require('../src/utils/attendance_helpers');
const { openSessionIndex, syncRootPunchOut } = require('../src/utils/shift_status');

const BACKFILL = process.argv.includes('--backfill');
const FIXROOT = process.argv.includes('--fix-root');
const INDEX = process.argv.includes('--index');

const ist = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19) : '-');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
    const db = mongoose.connection.db;
    const A = db.collection('attendances');
    const names = new Map((await db.collection('users').find({}).project({ name: 1 }).toArray()).map((u) => [String(u._id), u.name]));
    const who = (id) => names.get(String(id)) || String(id).slice(-6);

    console.log(`cluster: ${(process.env.MONGO_URI.match(/@([^/]+)/) || [])[1]}`);
    const total = await A.countDocuments();
    const missing = await A.countDocuments({ $or: [{ dayKey: null }, { dayKey: { $exists: false } }] });
    console.log(`rows: ${total} | without dayKey: ${missing}`);

    // ── 1. backfill ──────────────────────────────────────────────────────────
    if (BACKFILL) {
        console.log('\n== backfilling dayKey ==');
        const cur = A.find({ $or: [{ dayKey: null }, { dayKey: { $exists: false } }] }).project({ date: 1 });
        let ops = [], n = 0;
        while (await cur.hasNext()) {
            const d = await cur.next();
            if (!d.date) continue;
            ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { dayKey: istDateKey(d.date) } } } });
            if (ops.length === 500) { await A.bulkWrite(ops); n += ops.length; ops = []; process.stdout.write(`  ${n}\r`); }
        }
        if (ops.length) { await A.bulkWrite(ops); n += ops.length; }
        console.log(`  wrote dayKey on ${n} rows`);
    }

    // ── 2. stale root punchOut ───────────────────────────────────────────────
    //
    // Two shapes, one cause -- the root not following the day's final session:
    //
    //   null  : the root was never written, so every query filtering on
    //           punchOut still treats a finished day as open. This is the one
    //           that makes the nightly close job re-examine a row forever.
    //   wrong : the root WAS written, but from the wrong session, so the day
    //           reports the wrong finishing time. A null is easy to spot; this
    //           one reads as a perfectly ordinary day that simply ended early.
    //
    // The second shape is invisible to a `punchOut: null` query, which is why
    // it survived the first pass. Scan every closed day and compare.
    const staleRoot = [];
    const wrongRoot = [];
    const backwardRoot = [];
    const candidates = await A.find({ punchIn: { $ne: null }, shifts: { $ne: [] } })
        .project({ shifts: 1, punchIn: 1, punchOut: 1, employeeId: 1, date: 1 }).toArray();
    for (const a of candidates) {
        if (openSessionIndex(a) === -1) {
            if (!a.punchOut) { staleRoot.push(a); continue; }
            const final = (a.shifts || [])
                .filter((s) => s && s.punchOut)
                .sort((x, y) => new Date(y.punchOut) - new Date(x.punchOut))[0];
            if (final && new Date(final.punchOut).getTime() !== new Date(a.punchOut).getTime()) {
                // Only ever move the root FORWARD.
                //
                // A root LATER than every session is not a stale mirror -- it is
                // a real punch-out from before shifts[] existed, on a row whose
                // array was only partially backfilled. Syncing those would throw
                // away the later time and shorten somebody's day: one row here
                // would go from 18:42 back to 11:16. A day ending too early is
                // the expensive direction, so these go to a human instead.
                const target = new Date(final.punchOut).getTime();
                const current = new Date(a.punchOut).getTime();
                if (target > current) wrongRoot.push({ row: a, shouldBe: final.punchOut });
                else backwardRoot.push({ row: a, wouldBe: final.punchOut });
            }
        }
    }
    console.log(`\n== closed days whose ROOT punchOut is still null: ${staleRoot.length} ==`);
    console.log('   (every session is closed, but the root field says otherwise, so');
    console.log('    any query filtering on punchOut still treats the day as open)');
    for (const a of staleRoot.slice(0, 6)) console.log(`   · ${istDateKey(a.date)} ${who(a.employeeId)}`);

    console.log(`\n== closed days whose ROOT punchOut names the WRONG session: ${wrongRoot.length} ==`);
    console.log('   (the day reports a finishing time that is not when it finished)');
    for (const w of wrongRoot.slice(0, 8)) {
        console.log(`   · ${istDateKey(w.row.date)} ${who(w.row.employeeId)}  root=${ist(w.row.punchOut)} -> ${ist(w.shouldBe)}`);
    }

    console.log(`\n== closed days whose ROOT is LATER than every session: ${backwardRoot.length} ==`);
    console.log('   (NOT touched. The root is probably a real pre-shifts[] punch-out that');
    console.log('    the array never received; syncing would shorten the day. Check by hand.)');
    for (const w of backwardRoot.slice(0, 8)) {
        console.log(`   · ${istDateKey(w.row.date)} ${who(w.row.employeeId)}  root=${ist(w.row.punchOut)}  sessions end ${ist(w.wouldBe)}`);
    }
    // Mirror from the day's FINAL session, not session 1.
    //
    // This used to read allSessions(a)[0].punchOut, which is wrong twice over
    // on exactly the rows it is meant to repair: a day whose second session was
    // the one auto-closed would have the root stamped with the FIRST session's
    // punch-out -- so a day that ran to 18:58 was recorded as ending at 14:41.
    // And shifts[] is not stored in chronological order, so even "the last
    // element" is not reliably the last session. syncRootPunchOut sorts by
    // timestamp and is the same helper the live close paths now use.
    if (FIXROOT && (staleRoot.length || wrongRoot.length)) {
        let fixed = 0;
        for (const a of [...staleRoot, ...wrongRoot.map((w) => w.row)]) {
            // Compare by value, not identity: syncRootPunchOut always assigns a
            // fresh reference, so `!==` would report every row as changed.
            const before = a.punchOut ? new Date(a.punchOut).getTime() : null;
            syncRootPunchOut(a);
            if (!a.punchOut || new Date(a.punchOut).getTime() === before) continue;
            await A.updateOne({ _id: a._id }, {
                $set: {
                    punchOut: a.punchOut,
                    punchOutLocation: a.punchOutLocation ?? null,
                    punchOutCoordinates: a.punchOutCoordinates ?? null,
                    punchOutDistance: a.punchOutDistance ?? null,
                },
            });
            fixed++;
        }
        console.log(`   synced ${fixed} root punchOut fields from each day's final session`);
    }

    // ── 3. duplicates ────────────────────────────────────────────────────────
    const dupes = await A.aggregate([
        { $match: { employeeId: { $ne: null }, dayKey: { $ne: null } } },
        { $group: { _id: { a: '$adminId', e: '$employeeId', d: '$dayKey' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { n: { $gt: 1 } } },
    ]).toArray();
    console.log(`\n== duplicate employee-days: ${dupes.length} ==`);
    for (const d of dupes) {
        console.log(`   · ${d._id.d} ${who(d._id.e)} ×${d.n}`);
        for (const id of d.ids) {
            const r = await A.findOne({ _id: id });
            console.log(`       ${id}  in=${ist(r.punchIn)} out=${ist(r.punchOut)} status=${r.status} source=${r.source}`);
        }
    }
    if (dupes.length) console.log('   -> merge these by hand before --index. Keep the row with the real punches.');

    // ── 4. the unique index ──────────────────────────────────────────────────
    if (INDEX) {
        console.log('\n== building unique index ==');
        if (missing && !BACKFILL) { console.log('  REFUSED: rows still have no dayKey. Run --backfill first.'); }
        else if (dupes.length) { console.log(`  REFUSED: ${dupes.length} duplicate employee-days remain. Merge them first.`); }
        else {
            await A.createIndex({ adminId: 1, employeeId: 1, dayKey: 1 }, { unique: true, name: 'uniq_admin_employee_daykey' });
            console.log('  created uniq_admin_employee_daykey — a duplicate employee-day is now impossible');
        }
    }

    if (!BACKFILL && !INDEX && !FIXROOT) console.log('\n(report only — pass --backfill / --fix-root / --index to change anything)');
    await mongoose.disconnect();
})().catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
