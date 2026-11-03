const mongoose = require('mongoose');

// A face kiosk (BOTLens) set up for one company.
//
// The kiosk runs on a shared device -- a tablet at reception -- so it must not
// hold an admin's own sign-in: that is 30 days of full panel access to anyone
// who picks the tablet up. Instead the admin signs in once on the kiosk, and
// this record is created; the kiosk gets a key (a JWT with scope 'lens' naming
// this record) that can only report sightings and register faces. Switching the
// kiosk off in the admin panel (`revokedAt`) stops that key at once.
const LensKioskSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastSeenAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('LensKiosk', LensKioskSchema);
