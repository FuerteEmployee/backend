const express = require('express');
const router = express.Router();
const { runSubscriptionLifecycle } = require('../jobs/subscription_lifecycle');

// Guard cron endpoints with a shared secret so only the scheduler (Vercel Cron,
// an external uptime trigger, or an authorised operator) can run them.
const requireCronSecret = (req, res, next) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return res.status(503).json({ message: 'CRON_SECRET is not configured on the server' });
    }
    // Vercel Cron sends `Authorization: Bearer <secret>`; also accept x-cron-secret.
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const provided = bearer || req.headers['x-cron-secret'];
    if (provided !== secret) {
        return res.status(401).json({ message: 'Invalid cron secret' });
    }
    next();
};

// Advance the subscription lifecycle. Exposed as both POST (manual/external
// triggers) and GET (Vercel Cron invokes scheduled paths with a GET request).
const runLifecycle = async (req, res) => {
    try {
        const summary = await runSubscriptionLifecycle();
        res.json({ ok: true, summary });
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
};

router.post('/subscriptions', requireCronSecret, runLifecycle);
router.get('/subscriptions', requireCronSecret, runLifecycle);

module.exports = router;
