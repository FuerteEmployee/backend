const express = require('express');
const router = express.Router();
const { devicePunch, listDeviceEmployees, listDeviceEmployeeFaces, setDeviceEmployeeFace } = require('../controllers/attendance_controller');

// Guards device endpoints with a shared secret so only trusted devices (e.g.
// the BOTLens camera service) can punch attendance on an employee's behalf,
// without that device holding a per-employee login JWT. Mirrors the
// requireCronSecret pattern in cron_routes.js.
const requireDeviceSecret = (req, res, next) => {
    const secret = process.env.CAMERA_API_KEY;
    if (!secret) {
        return res.status(503).json({ message: 'CAMERA_API_KEY is not configured on the server' });
    }
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const provided = bearer || req.headers['x-camera-api-key'];
    if (provided !== secret) {
        return res.status(401).json({ message: 'Invalid camera API key' });
    }
    next();
};

router.post('/punch', requireDeviceSecret, (req, res, next) => { req.isDevicePunch = true; next(); }, devicePunch);
router.get('/employees', requireDeviceSecret, listDeviceEmployees);
router.get('/employees/faces', requireDeviceSecret, listDeviceEmployeeFaces);
router.put('/employees/:employeeId/face', requireDeviceSecret, setDeviceEmployeeFace);

module.exports = router;
