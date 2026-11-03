const FaceProfile = require('../models/FaceProfile');
const { checkFace } = require('./face_match');

// Does an app punch selfie show the employee who is punching?
//
// Logging in proves someone has the phone number (and the OTP is shown on
// screen), not that they are the employee -- a colleague logged in as someone
// else could punch for them with their own face. For an employee who registered
// a face at the kiosk, the selfie is compared with that face here, in this
// server (utils/face_match.js: the kiosk's own YuNet + SFace models and its
// scoring), and a different face refuses the punch.
//
// It runs in this process rather than asking the BOTLens server, so it does not
// depend on a kiosk server being hosted, reachable or up. Checked on real
// stored selfies (14 Oct): every employee's own face accepted (15 of 15), every
// selfie of someone else on their account refused (9 of 9).
//
// An employee with no registered face punches as before. If the check itself
// cannot run (models missing and not downloadable), the punch is refused
// rather than let through unchecked.

async function checkPunchFace(req, photo, action) {
    const profile = await FaceProfile.findOne({ adminId: req.adminId, employeeId: req.userId }, { embeddings: 1 }).lean();
    if (!profile?.embeddings?.length) return { ok: true };

    let result;
    try {
        result = await checkFace(photo, profile.embeddings);
    } catch (err) {
        console.error('[face-check] could not verify punch selfie:', err.message);
        return {
            ok: false,
            status: 503,
            message: `Your face could not be checked right now, so the ${action} was not recorded. Please try again in a moment.`,
        };
    }

    if (result.result === 'match') return { ok: true, faceScore: result.score };
    if (result.result === 'no_face') {
        return {
            ok: false,
            status: 400,
            message: `No face was found in your photo. Look straight at the camera in good light and try to ${action} again.`,
        };
    }
    console.warn(`[face-check] ${action} refused for employee ${req.userId}: score ${result.score}`);
    return {
        ok: false,
        status: 403,
        faceMismatch: true,
        message: `This face does not match the face registered for your account, so the ${action} was not recorded. Only you can ${action} for yourself.`,
    };
}

module.exports = { checkPunchFace };
