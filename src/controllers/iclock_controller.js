const User = require('../models/User');
const Settings = require('../models/Settings');
const {
    resolveDevice,
    markSeen,
    markPunch,
    recordUnresolved,
    isDuplicateLog,
    forgetLog,
} = require('../utils/device_registry');
const punchSequence = require('../utils/punch_sequence');
const { recordTap } = require('../utils/tap_ingest');
const { parseDeviceTimestamp } = require('../utils/attendance_helpers');
const { withEmployeeLock } = require('../utils/employee_lock');
const Device = require('../models/Device');
const { recordClockSkew, observeServerOffset, toServerTime } = require('../utils/device_clock');
const { isFrozenTenant } = require('../utils/frozen_tenants');
const { sendDeviceClockAlert } = require('../jobs/notify');

// A device has no concept of tenants — it only ever sends its own serial number
// and a raw PIN. Which company a push belongs to is decided entirely by the
// Device registry (see utils/device_registry.js), which the super admin manages
// from the Machines screen. Serial numbers are unique platform-wide, so a given
// machine can only ever resolve to one tenant.

/**
 * Fold this tap into the terminal's clock-health samples, and alert once a
 * day for as long as the clock stays wrong.
 *
 * Fire-and-forget like the event logger: a punch must never fail because a
 * diagnostic about the machine that sent it could not be written.
 */
async function checkDeviceClock(device, tapTime) {
    const { suspected, description, minMinutes } = recordClockSkew(device, tapTime, new Date());

    const update = {
        clockSkewSamples: device.clockSkewSamples,
        clockSkewMinutes: minMinutes,
    };

    const lastAlert = device.clockSkewAlertedAt ? new Date(device.clockSkewAlertedAt).getTime() : 0;
    const dueAgain = Date.now() - lastAlert > 24 * 60 * 60 * 1000;

    if (suspected && dueAgain) {
        update.clockSkewAlertedAt = new Date();
        console.warn(`[iclock] SN=${device.serialNumber} clock is off by ~${minMinutes} min. ${description}`);
        if (device.adminId) {
            const admin = await User.findById(device.adminId).select('name companyName phone email').lean();
            if (admin) await sendDeviceClockAlert({ admin, device, description }).catch(() => {});
        }
    } else if (!suspected && device.clockSkewAlertedAt) {
        // Clock corrected on site -- clear the latch so the next genuine
        // problem alerts immediately instead of waiting out the repeat window.
        update.clockSkewAlertedAt = null;
    }

    await Device.updateOne({ _id: device._id }, { $set: update });
}

/**
 * Store one raw tap, then re-derive the employee's whole day from every tap
 * recorded for it (see utils/punch_reconcile.js).
 *
 * Three rejections, all of which store the tap rather than dropping it, so
 * "I tapped and it didn't count" is answerable from the data:
 *  - `debounced`  — inside the tenant's minimum gap, i.e. pressed twice
 *  - `duplicate`  — the unique index caught a resent ATTLOG line. Unlike the
 *    in-memory guard this survives a restart, which is what previously let a
 *    re-push after a deploy silently re-count taps.
 *  - unparseable device clock — falls back to receive time, which is the old
 *    behaviour and still better than discarding the punch entirely.
 */
/**
 * When this tap happened, on the SERVER's clock -- never the terminal's.
 *
 * The terminal's timestamp is converted with its learned offset (see
 * utils/device_clock.js): a tap that arrives at once lands at its arrival time,
 * and one the terminal held back while the network was down lands at the
 * server time it was actually made (tapped 10:45, delivered 11:12 -> 10:45).
 * pushData must have folded the batch into the offset first (learnBatchOffset).
 *
 * Used by both paths -- day reconciliation and the punch sequence -- so the two
 * cannot disagree about when a tap happened.
 */
function resolveTapTime({ sn, pin, rawDeviceTime, device }) {
    const now = new Date();
    const rawParsed = parseDeviceTimestamp(rawDeviceTime, now, 0);

    if (!rawParsed) {
        console.warn(
            `[iclock] SN=${sn} PIN=${pin} sent an unusable timestamp ("${rawDeviceTime}") — ` +
            'using the time it arrived.'
        );
        return now;
    }

    const tapTime = device ? toServerTime(device, rawParsed) : rawParsed;
    if (device) {
        // Logged when it moves a tap by more than a minute: a punch time that
        // does not match what the terminal displayed must be explainable from
        // the logs, or nobody can tell a conversion from a bug.
        if (Math.abs(tapTime - rawParsed) > 60 * 1000) {
            console.log(
                `[iclock] SN=${sn} PIN=${pin} terminal time ${rawDeviceTime} -> server time ${tapTime.toISOString()}`
            );
        }
        checkDeviceClock(device, rawParsed).catch((err) =>
            console.error('[iclock] clock check failed:', err.message));
    }
    return tapTime;
}

/**
 * Fold a whole ATTLOG batch into the terminal's clock offset BEFORE any of it
 * is converted, newest tap first. An offline backlog usually ends with a tap
 * made after the network returned; that one anchors the older lines. Fed
 * oldest-first, the oldest line would set the offset and be stored late.
 */
function learnBatchOffset(device, lines) {
    if (!device) return;
    const now = new Date();
    const taps = lines
        .map((line) => parseDeviceTimestamp(line.split('\t')[1], now, 0))
        .filter(Boolean)
        .sort((a, b) => b - a);
    let changed = false;
    for (const t of taps) changed = observeServerOffset(device, t, now) || changed;
    if (!changed) return;
    Device.updateOne({ _id: device._id }, {
        $set: {
            serverOffsetMs: device.serverOffsetMs,
            serverOffsetConfirmedAt: device.serverOffsetConfirmedAt,
            serverOffsetCandidate: device.serverOffsetCandidate || null,
        },
    }).catch((err) => console.error('[iclock] could not save clock offset:', err.message));
}

async function recordTapAndReconcile({ adminId, employee, sn, pin, rawDeviceTime, settings, device }) {
    const tapTime = resolveTapTime({ sn, pin, rawDeviceTime, device });
    return recordTap({
        adminId, employeeId: employee._id, tapTime,
        source: 'biometric', serialNumber: sn, pin: String(pin), settings,
    });
}

// GET /iclock/cdata — device handshake on connect (options=all). Tells the
// device to stream attendance logs in real time.
exports.handshake = (req, res) => {
    const sn = req.query.SN || 'unknown';
    console.log(`[iclock] handshake from SN=${sn}`);

    // Register/refresh the machine on handshake, not just on its first punch —
    // this is what makes a newly plugged-in device appear in the Machines screen
    // straight away, before anybody has punched on it.
    resolveDevice(sn).catch(err => console.error('[iclock] handshake device resolve failed:', err.message));

    // TimeZone is how a terminal that syncs to us turns our HTTP `Date` header
    // (GMT) into its own clock. Per the PUSH protocol -12..12 is hours and a
    // value beyond ±60 is minutes, so India would be 330.
    //
    // Deliberately left at 0. A client may keep a terminal on UTC (a 5h30m gap
    // on its display) and does not want us resetting it. Its punches are put
    // on the SERVER's clock on our side instead: resolveTapTime converts every
    // tap with the terminal's learned offset (utils/device_clock.js), whatever
    // its clock says. Only a manual "Clock correction" (Super admin > Machines)
    // would double-count if the terminal's clock were changed under it.
    res.type('text/plain').send(
        `GET OPTION FROM: ${sn}\r\n` +
        `Stamp=9999\r\n` +
        `OpStamp=9999\r\n` +
        `ErrorDelay=60\r\n` +
        `Delay=30\r\n` +
        `TransFlag=111111111-0\r\n` +
        `TransInterval=1\r\n` +
        `TimeZone=0\r\n` +
        `Realtime=1\r\n` +
        `Encrypt=0\r\n`
    );
};

// POST /iclock/cdata — device pushes data tables here. We only act on
// table=ATTLOG (attendance logs); everything else is acknowledged and logged
// so real device traffic can inform what else we may need to handle later.
exports.pushData = async (req, res) => {
    const sn = req.query.SN || 'unknown';
    const table = req.query.table || '';
    const body = typeof req.body === 'string' ? req.body : '';

    if (table !== 'ATTLOG') {
        console.log(`[iclock] ignoring table=${table || '(none)'} from SN=${sn}`);
        markSeen(sn);
        return res.type('text/plain').send('OK');
    }

    const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // Resolve which company this machine belongs to. Unknown serials are
    // auto-registered as unassigned rather than thrown away, so the machine
    // shows up in the Machines screen ready to claim.
    const device = await resolveDevice(sn);

    if (!device) {
        console.error(`[iclock] push with no usable serial number (SN=${sn}) — ignoring`);
        return res.type('text/plain').send('OK');
    }

    // Not yet claimed, or deliberately switched off. Log each dropped punch
    // against the device so the reason is visible in the UI instead of only in
    // a server log line — otherwise the device beeps and accepts the employee
    // while nothing is recorded anywhere.
    if (!device.adminId || device.status !== 'active') {
        const reason = !device.adminId ? 'unassigned_device' : 'disabled_device';
        for (const line of lines) {
            const [pin, deviceTime] = line.split('\t');
            if (pin) recordUnresolved(sn, { pin, reason, deviceTime });
        }
        console.warn(
            `[iclock] SN=${sn} is ${reason === 'unassigned_device' ? 'not assigned to any customer' : 'disabled'} — ` +
            `dropped ${lines.length} punch(es). Assign it under Super admin → Machines.`
        );
        return res.type('text/plain').send('OK');
    }

    const adminId = device.adminId;

    // A company kept on the previous release records its taps there. Not
    // acknowledged (500), so the machine keeps the batch instead of losing it.
    if (isFrozenTenant(adminId)) {
        console.warn(`[iclock] SN=${sn} belongs to a frozen company; not recording ${lines.length} punch(es) here`);
        return res.status(500).type('text/plain').send('ERROR');
    }

    // One Settings read per push batch, not per line.
    const settings = await Settings.findOne({ adminId }).select('attendance');
    const seqConfig = punchSequence.resolveConfig(settings);
    if (seqConfig.configInvalid) {
        console.warn(
            `[iclock] adminId=${adminId} has an invalid punch sequence saved — ` +
            'falling back to the in/out toggle so attendance keeps recording.'
        );
    }

    let processed = 0;
    let failed = 0;

    // Before converting any line, learn this terminal's clock offset from the
    // whole batch -- see learnBatchOffset.
    learnBatchOffset(device, lines);

    for (const line of lines) {
        const [pin, deviceTime] = line.split('\t');
        if (!pin || !deviceTime) continue;

        if (isDuplicateLog(sn, pin, deviceTime)) {
            console.log(`[iclock] duplicate resend ignored: SN=${sn} PIN=${pin} deviceTime=${deviceTime}`);
            continue;
        }

        try {
            // Scoped by adminId, always. This is what guarantees a punch on this
            // machine can only ever resolve to an employee of the company that
            // owns it — another firm reusing the same PIN is unreachable from here.
            const matches = await User.find({
                adminId,
                deviceUserId: String(pin).trim(),
                role: 'employee',
            }).select('_id name status').limit(2);

            if (matches.length === 0) {
                console.warn(`[iclock] no employee with deviceUserId=${pin} for adminId=${adminId}`);
                recordUnresolved(sn, { pin, reason: 'unknown_pin', deviceTime });
                continue;
            }

            // Belt-and-braces against a pre-existing duplicate that slipped in
            // before the unique index existed. Attributing a punch to an
            // arbitrary one of two people is worse than not recording it, since
            // it silently corrupts both employees' payroll.
            if (matches.length > 1) {
                console.error(
                    `[iclock] AMBIGUOUS PIN: deviceUserId=${pin} matches ${matches.length} employees ` +
                    `for adminId=${adminId} — refusing to guess. Fix the duplicate Biometric Device ID.`
                );
                recordUnresolved(sn, { pin, reason: 'duplicate_pin', deviceTime });
                continue;
            }

            const employee = matches[0];

            // Store the raw tap and rebuild the whole day from every tap plus
            // what the app already wrote. A company's own tap order
            // (punchSequence) is applied inside that rebuild, in tap-time order:
            // deciding a tap's meaning on ARRIVAL turned a tap held by an
            // offline machine into a new punch-in inside a later session.
            // One person's taps one at a time: the debounce check, the tap store
            // and the day rebuild read then write.
            const outcome = await withEmployeeLock(`punch:${employee._id}`, () => recordTapAndReconcile({
                adminId, employee, sn, pin, rawDeviceTime: deviceTime, settings, device,
            }));
            if (outcome.recorded) {
                processed++;
                markPunch(sn);
                console.log(
                    `[iclock] ${employee.name} (PIN ${pin}) tap @ ${outcome.tapTime.toISOString()} ` +
                    `→ day ${outcome.dayKey} rebuilt from ${outcome.tapCount} tap(s)${seqConfig.enabled ? ' [sequence]' : ''}`
                );
            } else {
                console.log(`[iclock] ${employee.name} (PIN ${pin}) tap ignored [${outcome.reason}]`);
            }
        } catch (err) {
            // An unexpected failure — the database was unreachable, a write
            // threw. Distinct from every `continue` above, which are decisions
            // (unknown PIN, debounced, sequence complete): those are correctly
            // final and must be acknowledged, or the device would retry them
            // forever. This one should be retried.
            failed++;
            // Un-mark it, or the re-push this 500 asks for would be skipped
            // as a duplicate resend and the line lost after all.
            forgetLog(sn, pin, deviceTime);
            console.error(`[iclock] failed to process line "${line}":`, err.message);
        }
    }

    console.log(
        `[iclock] processed ${processed}/${lines.length} ATTLOG line(s) from SN=${sn} (adminId=${adminId})` +
        (failed ? ` — ${failed} line(s) FAILED to store` : '')
    );

    // Only acknowledge a batch we actually stored. The ADMS ack is per-batch,
    // not per-line, so a device that receives OK clears its whole buffer —
    // which previously meant a line that failed to store was lost for good.
    // Replying 500 makes the terminal keep the batch and re-push it; the
    // unique index on (serial, pin, deviceTime) discards whatever already
    // landed, so the retry is idempotent. That safety is new: before durable
    // dedupe existed, a re-push would have double-counted taps, which is why
    // acknowledging unconditionally used to be the lesser evil.
    if (failed > 0) {
        return res.status(500).type('text/plain').send('RETRY');
    }

    res.type('text/plain').send(`OK: ${processed}`);
};

// GET /iclock/getrequest — device polls for pending commands. We never queue
// any, so always reply with no-op.
exports.getRequest = (req, res) => {
    // This is the ~30s heartbeat, so it doubles as the liveness signal behind
    // "last seen" in the Machines screen.
    if (req.query.SN) markSeen(req.query.SN);
    res.type('text/plain').send('OK');
};

// POST /iclock/devicecmd — device reports back the result of a command we
// issued. We never issue any, but must still ack whatever it sends.
exports.deviceCmdAck = (req, res) => {
    res.type('text/plain').send('OK');
};
