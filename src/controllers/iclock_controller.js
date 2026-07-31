const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { punchIn, punchOut } = require('./attendance_controller');

// Maps a device serial number to the admin (tenant) it belongs to, via
// ESSL_DEVICES="SN:adminPhone,SN2:adminPhone2" in env. The device itself has
// no concept of tenants — it only ever sends its own SN and a raw PIN — so
// this is the one place that decides which company's data a push lands in.
function parseDeviceMap() {
    const raw = process.env.ESSL_DEVICES || '';
    const map = {};
    raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
        const [sn, phone] = pair.split(':').map(s => s.trim());
        if (sn && phone) map[sn] = phone;
    });
    return map;
}

// adminPhone rarely changes once configured, so cache the resolved adminId
// in memory rather than re-querying on every device push/heartbeat.
const adminIdCache = new Map();

async function resolveAdminId(serialNumber) {
    const deviceMap = parseDeviceMap();
    const phone = deviceMap[serialNumber];
    if (!phone) return null;

    if (adminIdCache.has(phone)) return adminIdCache.get(phone);

    const admin = await User.findOne({ phone, role: 'admin' }).select('_id');
    if (!admin) return null;

    adminIdCache.set(phone, admin._id);
    return admin._id;
}

// Determines whether a pushed punch event should be treated as a punch-in or
// punch-out, based on today's existing Attendance record — the device's own
// Status field (0/1) is unreliable across configs, so we derive it the same
// way the employee-facing app effectively does: no open record → punch in;
// an open (not-yet-punched-out) record → punch out.
async function resolveAction(adminId, employeeId) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const existing = await Attendance.findOne({ adminId, employeeId, date: today }).select('punchOut');
    if (!existing || existing.punchOut) return 'punch-in';
    return 'punch-out';
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
        return res.type('text/plain').send('OK');
    }

    const adminId = await resolveAdminId(sn);
    if (!adminId) {
        console.error(`[iclock] unrecognized device SN=${sn} — check ESSL_DEVICES env var`);
        return res.type('text/plain').send('OK');
    }

    const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let processed = 0;

    for (const line of lines) {
        const [pin, time] = line.split('\t');
        if (!pin || !time) continue;

        try {
            const employee = await User.findOne({ adminId, deviceUserId: pin, role: 'employee' }).select('_id');
            if (!employee) {
                console.warn(`[iclock] no employee with deviceUserId=${pin} for adminId=${adminId}`);
                continue;
            }

            const action = await resolveAction(adminId, employee._id);
            const handler = action === 'punch-in' ? punchIn : punchOut;
            const result = await callHandler(handler, adminId, employee._id);

            if (result.ok) {
                processed++;
            } else {
                console.warn(`[iclock] ${action} rejected for deviceUserId=${pin}: ${result.body?.message}`);
            }
        } catch (err) {
            console.error(`[iclock] failed to process line "${line}":`, err.message);
        }
    }

    console.log(`[iclock] processed ${processed}/${lines.length} ATTLOG line(s) from SN=${sn}`);
    res.type('text/plain').send(`OK: ${processed}`);
};

// GET /iclock/getrequest — device polls for pending commands. We never queue
// any, so always reply with no-op.
exports.getRequest = (req, res) => {
    res.type('text/plain').send('OK');
};

// POST /iclock/devicecmd — device reports back the result of a command we
// issued. We never issue any, but must still ack whatever it sends.
exports.deviceCmdAck = (req, res) => {
    res.type('text/plain').send('OK');
};
