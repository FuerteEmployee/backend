const mongoose = require('mongoose');

// Why background tracking stopped, in the employee's own words — except the
// employee cannot tell you, so the phone says it instead.
//
// The recurring support case this exists for is "the app is not working". That
// sentence covers at least six different faults, and until now none of them
// could be told apart after the fact: an employee who turned GPS off at lunch,
// one whose phone dropped to 2% and went into power-save, one whose OEM battery
// manager reaped the process, and one who never granted a permission all look
// identical from the server — a gap in the location history and nothing else.
//
// Each row here is one observable device-state transition, stamped when it
// happened. Read as a timeline against the same day's location gaps, it turns
// "the app is broken" into "GPS was off from 13:04 to 14:12".
//
// NOT an audit trail and not payroll input. It is diagnostic, it is written by
// the client on an unprivileged route, and its contents are a phone's own
// report about itself — treat it as evidence to interpret, not as fact.
const TrackerEventSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Which install reported it. Kept so a reinstall (which mints a new
    // installId) reads as a new device rather than silently continuing the old
    // device's timeline.
    installId: { type: String, default: null },
    appVersion: { type: String, default: null },

    // A closed set on purpose. An open string field would fill with typos and
    // one-off event names, and the admin UI could never group or colour them.
    // Anything not in this list is rejected at the controller rather than
    // stored as a mystery.
    type: {
        type: String,
        required: true,
        enum: [
            // Things the employee did to the phone.
            'gps_on',           // location services switched on
            'gps_off',          // ...and off. The single most common cause.
            'network_on',
            'network_off',
            'power_save_on',    // battery saver — Android throttles our updates
            'power_save_off',
            'doze_on',          // device entered idle; updates are deferred
            'doze_off',
            'airplane_on',
            'airplane_off',

            // Things that happened to us.
            'service_start',
            'service_stop',     // deliberate: punch-out or an explicit stop
            'task_removed',     // app swiped out of recents
            'boot_restart',     // BootReceiver brought us back after a reboot.
                                // Also the ONLY hard evidence that the OEM
                                // autostart permission is actually granted.
            'watchdog_restart', // the process had been killed; WorkManager healed it
            'permission_lost',  // location permission revoked while on duty
            'fg_denied',        // the system refused us a foreground service
            'fix_gap',          // a silence far longer than the capture interval

            // Sampled state, not a transition.
            'battery',
        ],
        index: true,
    },

    // Device clock at the moment of the event. Trusted as a hint only — a phone
    // can be hours out — but it is the only source for an event that happened
    // while the device was offline and queued. `createdAt` is when we received
    // it, and the two together show how long a device was out of contact.
    at: { type: Date, required: true },

    // Small, free-form, and deliberately unvalidated beyond a size cap: the
    // useful detail differs per type (battery percent, network transport, which
    // provider changed) and pinning a schema to it would mean a migration every
    // time a new Android release exposes something worth recording.
    meta: { type: mongoose.Schema.Types.Mixed, default: null },

    // Battery is denormalised onto every row rather than left in `meta`,
    // because "what was the battery doing when this happened" is the question
    // asked of almost every other event type, and a Mixed field cannot be
    // indexed or charted.
    batteryLevel: { type: Number, default: null, min: 0, max: 100 },
    charging: { type: Boolean, default: null },
}, { timestamps: true });

// 30-day retention, shorter than ClientError's 90. These arrive at a much
// higher rate and go stale faster: nobody diagnoses last month's GPS toggle,
// and the volume is driven by how often employees touch their phone settings.
TrackerEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// The one query the UI makes: this employee's timeline, newest first, usually
// narrowed to a day. Ordered on `at` rather than `createdAt` so a batch that
// was queued offline and arrived late still sorts where it belongs.
TrackerEventSchema.index({ adminId: 1, employeeId: 1, at: -1 });

module.exports = mongoose.model('TrackerEvent', TrackerEventSchema);
