const mongoose = require('mongoose');

// Real login/logout history, replacing the fabricated client-side access log
// that used to be seeded in the frontend's lib/auth.ts with invented IPs.
//
// Field names deliberately mirror the frontend's existing `AccessLog` shape
// (name/role/phone/action/timestamp/ipAddress/userAgent) so the Settings table
// that renders it needs no restructuring — but every value here is observed
// server-side rather than made up.
const LoginSessionSchema = new mongoose.Schema({
    // The tenant this event belongs to. For an `admin` logging in this is their
    // own id; for a subadmin/employee it is their parent admin — matching how
    // every other collection scopes, so the Settings table can only ever show
    // the viewer's own company.
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Denormalised identity. A login record has to stay readable after the user
    // is renamed or deleted — an audit trail that silently rewrites itself when
    // the underlying row changes is not an audit trail.
    name: { type: String, default: null },
    role: { type: String, default: null },
    phone: { type: String, default: null },

    action: { type: String, enum: ['login', 'logout'], required: true },

    // Observed from the request, not supplied by the client.
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    // Which client the login came from: 'web' | 'botlens' | 'app'.
    appName: { type: String, default: null },
    installId: { type: String, default: null },
    appVersion: { type: String, default: null },
}, { timestamps: true });

// 180-day retention — long enough to investigate a disputed access, short
// enough that it doesn't accumulate forever.
LoginSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
LoginSessionSchema.index({ adminId: 1, createdAt: -1 });
LoginSessionSchema.index({ adminId: 1, userId: 1, createdAt: -1 });

module.exports = mongoose.model('LoginSession', LoginSessionSchema);
