const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Settings = require('../models/Settings');
const { punchIn, punchOut, lunchIn, lunchOut } = require('./attendance_controller');
const {
    resolveDevice,
    markSeen,
    markPunch,
    recordUnresolved,
} = require('../utils/device_registry');
const punchSequence = require('../utils/punch_sequence');

// Maps a resolved action name to the handler that records it.
const HANDLERS = {
    'punch-in': punchIn,
    'punch-out': punchOut,
    'lunch-in': lunchIn,
    'lunch-out': lunchOut,
};

// A device has no concept of tenants — it only ever sends its own serial number
// and a raw PIN. Which company a push belongs to is decided entirely by the
// Device registry (see utils/device_registry.js), which the super admin manages
// from the Machines screen. Serial numbers are unique platform-wide, so a given
// machine can only ever resolve to one tenant.

// Decides what a pushed punch event MEANS. The device's own Status field (0/1)
// is unreliable across configs, so we never trust it.
//
// Two modes:
//  • Sequence configured (Settings.attendance.punchSequence.enabled) — the tap
//    becomes the first step of the tenant's sequence that hasn't happened yet,
//    so four taps can mean in / leave for lunch / back / out.
//  • Otherwise, the legacy toggle: no open record → punch in, open → punch out.
//
// Returns { action, reason }. A null action means "don't record this tap".
async function resolveAction(adminId, employeeId, seqConfig) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const existing = await Attendance.findOne({ adminId, employeeId, date: today })
        .select('punchIn punchOut lunchInTime lunchOutTime');

    const legacyToggle = () =>
        (!existing || existing.punchOut) ? 'punch-in' : 'punch-out';

    if (!seqConfig || !seqConfig.enabled) {
        return { action: legacyToggle(), reason: 'toggle' };
    }

    const next = punchSequence.nextAction(existing, seqConfig);
    if (next) return { action: next, reason: 'sequence' };

    // Every configured step is done for today.
    if (seqConfig.afterLast === 'toggle') {
        // Second shift: re-open the day the legacy way.
        return { action: legacyToggle(), reason: 'sequence-complete-toggle' };
    }
    return { action: null, reason: 'sequence_complete' };
}

function callHandler(handler, adminId, employeeId) {
    const req = { adminId: String(adminId), userId: String(employeeId), body: {}, isDevicePunch: true };
    return new Promise(resolve => {
        let statusCode = 200;
        const fakeRes = {
            status(code) { statusCode = code; return fakeRes; },
            json(body) { resolve({ ok: statusCode < 400, statusCode, body }); },
        };
        handler(req, fakeRes);
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

    for (const line of lines) {
        const [pin, deviceTime] = line.split('\t');
        if (!pin || !deviceTime) continue;

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

            const { action, reason } = await resolveAction(adminId, employee._id, seqConfig);

            // Sequence finished for today and the tenant chose to ignore extras.
            // Discarding beats guessing: without this an accidental second tap
            // after punch-out would reopen the day and corrupt the hours.
            if (!action) {
                console.log(
                    `[iclock] ${employee.name} (PIN ${pin}) has completed today's punch sequence — extra tap ignored`
                );
                recordUnresolved(sn, { pin, reason: 'sequence_complete', deviceTime });
                continue;
            }

            const handler = HANDLERS[action];
            if (!handler) {
                console.error(`[iclock] no handler for action "${action}" — skipping PIN ${pin}`);
                continue;
            }

            const result = await callHandler(handler, adminId, employee._id);

            if (result.ok) {
                processed++;
                markPunch(sn);
                console.log(`[iclock] ${employee.name} (PIN ${pin}) → ${action} [${reason}]`);
            } else {
                console.warn(`[iclock] ${action} rejected for deviceUserId=${pin}: ${result.body?.message}`);
            }
        } catch (err) {
            console.error(`[iclock] failed to process line "${line}":`, err.message);
        }
    }

    console.log(`[iclock] processed ${processed}/${lines.length} ATTLOG line(s) from SN=${sn} (adminId=${adminId})`);
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
