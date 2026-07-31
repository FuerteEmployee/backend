const express = require('express');
const router = express.Router();
const { handshake, pushData, getRequest, deviceCmdAck } = require('../controllers/iclock_controller');

// Biometric devices (eSSL/ZKTeco ADMS protocol) push plain-text bodies here,
// never JSON — parse as raw text regardless of the Content-Type they send.
router.use(express.text({ type: () => true, limit: '5mb' }));

// Some eSSL/ZKTeco firmware (e.g. this MB20+ID's "iClock Proxy" client) calls
// these with a trailing ".aspx" (an ASP.NET-era holdover), others call them
// extension-less — register both so either firmware variant is served.
router.get(['/cdata', '/cdata.aspx'], handshake);
router.post(['/cdata', '/cdata.aspx'], pushData);
router.get(['/getrequest', '/getrequest.aspx'], getRequest);
router.post(['/devicecmd', '/devicecmd.aspx'], deviceCmdAck);

module.exports = router;
