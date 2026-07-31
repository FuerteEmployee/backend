const express = require('express');
const router = express.Router();
const { handshake, pushData, getRequest, deviceCmdAck } = require('../controllers/iclock_controller');

// Biometric devices (eSSL/ZKTeco ADMS protocol) push plain-text bodies here,
// never JSON — parse as raw text regardless of the Content-Type they send.
router.use(express.text({ type: () => true, limit: '5mb' }));

router.get('/cdata', handshake);
router.post('/cdata', pushData);
router.get('/getrequest', getRequest);
router.post('/devicecmd', deviceCmdAck);

module.exports = router;
