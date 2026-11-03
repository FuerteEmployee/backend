const mongoose = require('mongoose');

// Errors the employee actually saw, reported by the app so the team can fix
// what users hit rather than what gets reproduced in the office.
//
// This collection is written by clients on an authenticated but otherwise
// unprivileged route, so it is the one place in the schema where volume is
// driven by something outside our control — a crash loop on one handset could
// otherwise write until the disk fills. Two defences: the TTL index below, and
// a per-employee rate limit in the controller.
const ClientErrorSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    installId: { type: String, default: null },

    // Repeated so an error stays interpretable after the device row is gone
    // (reinstall, employee deleted) — the version is the whole point of the
    // report and must not depend on a join that may no longer resolve.
    appVersion: { type: String, default: null },
    appBuild: { type: String, default: null },
    platform: { type: String, default: null },

    // What the user was shown. `message` is required; everything else is
    // best-effort, since a hard crash may not leave much behind.
    message: { type: String, required: true, maxlength: 2000 },
    // 'ui' = a toast/error screen the employee saw, 'network' = a failed API
    // call, 'unhandled' = window.onerror / unhandledrejection.
    // 'tracker' is the background location service failing to start. It is
    // its own kind because it is the one failure the employee cannot see and
    // cannot report -- the app looks fine, they are punched in, and nothing is
    // being recorded. Lumping it under 'unhandled' is how an employee lost a
    // whole afternoon of location history with no trace but a gap.
    kind: { type: String, enum: ['ui', 'network', 'unhandled', 'tracker'], default: 'unhandled' },
    stack: { type: String, default: null, maxlength: 8000 },
    // Route the employee was on, plus the API call if this was a network error.
    route: { type: String, default: null },
    requestUrl: { type: String, default: null },
    statusCode: { type: Number, default: null },

    // Client clock — trusted only as a hint, since a phone's time can be wrong.
    // `createdAt` from timestamps is the server-side truth.
    occurredAt: { type: Date, default: Date.now },
}, { timestamps: true });

// 90-day retention. Diagnostic data with no long-term value, and leaving it
// unbounded would grow the tenant's storage for no benefit.
ClientErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
// The two ways this gets read: one employee's recent errors, and a tenant-wide
// feed for triage.
ClientErrorSchema.index({ adminId: 1, employeeId: 1, createdAt: -1 });
ClientErrorSchema.index({ adminId: 1, createdAt: -1 });

module.exports = mongoose.model('ClientError', ClientErrorSchema);
