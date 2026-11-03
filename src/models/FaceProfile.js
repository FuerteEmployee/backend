const mongoose = require('mongoose');

// One employee's registered face, for the face kiosk (BOTLens).
//
// The kiosk keeps nothing of its own: it loads its company's faces from here
// when it starts, matches camera frames against them in memory, and reports a
// sighting as a tap (POST /api/lens/taps). So there is one copy of every face,
// scoped to one company, backed up with the rest of the database, and switched
// off the moment the employee is.
//
// `embeddings` are the numbers matching uses: OpenCV SFace (sface_2021dec), one
// 128-value vector per scan angle. They are not a photo and cannot be turned
// back into one. `thumbnailUrl` is a single small enrollment picture, kept only
// so an admin can see who is registered; the scan photos themselves are never
// stored.
const FaceProfileSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    embeddings: {
        type: [[Number]],
        validate: {
            validator: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 12
                && v.every((vec) => Array.isArray(vec) && vec.length === 128 && vec.every(Number.isFinite)),
            message: 'A face needs 1 to 12 scans of 128 numbers each.',
        },
    },
    modelVersion: { type: String, default: 'sface_2021dec' },
    thumbnailUrl: { type: String, default: null },
    // Who registered it: the admin the kiosk was set up by, and which kiosk.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    kioskId: { type: mongoose.Schema.Types.ObjectId, ref: 'LensKiosk', default: null },
}, { timestamps: true });

FaceProfileSchema.index({ adminId: 1, employeeId: 1 }, { unique: true });
// The kiosk's "has anything changed?" check reads the newest updatedAt.
FaceProfileSchema.index({ adminId: 1, updatedAt: -1 });

module.exports = mongoose.model('FaceProfile', FaceProfileSchema);
