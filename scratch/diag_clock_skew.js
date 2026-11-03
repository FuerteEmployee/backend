// Clock skew per terminal.
//
// A CONSTANT skew across taps means the terminal's clock is wrong. A VARIABLE
// skew that returns to ~0 means the device was offline and flushed a backlog,
// which is legitimate and must not be "corrected".
require('dotenv').config();
const dns = require('dns'); dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const PunchLog = require('../src/models/PunchLog');
const Device = require('../src/models/Device');

(async () => {
    await mongoose.connect(process.env.MONGO_URI);

    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const rows = await PunchLog.aggregate([
        { $match: { receivedAt: { $gte: since }, deviceTime: { $ne: null } } },
        {
            $project: {
                serialNumber: 1,
                skewMin: { $divide: [{ $subtract: ['$receivedAt', '$deviceTime'] }, 60000] },
            },
        },
        {
            $group: {
                _id: '$serialNumber',
                taps: { $sum: 1 },
                minSkew: { $min: '$skewMin' },
                maxSkew: { $max: '$skewMin' },
                avgSkew: { $avg: '$skewMin' },
            },
        },
        { $sort: { taps: -1 } },
    ]);

    console.log('skew = receivedAt - deviceTime, in minutes (330 = exactly 5h30m = IST offset)\n');
    for (const r of rows) {
        const device = await Device.findOne({ serialNumber: r._id }).select('name status adminId').lean();
        const constant = Math.abs(r.maxSkew - r.minSkew) < 5;
        console.log(
            `serial ${r._id}  (${device?.name || 'unregistered'}, ${device?.status || '-'})\n` +
            `  taps=${r.taps}  avg=${r.avgSkew.toFixed(1)}min  range=[${r.minSkew.toFixed(1)} .. ${r.maxSkew.toFixed(1)}]\n` +
            `  -> ${constant ? 'CONSTANT skew: clock offset' : 'VARIABLE skew: backlog flushes, clock probably fine'}` +
            `${Math.abs(r.avgSkew - 330) < 10 ? '  *** ~5h30m: terminal is set to UTC, not IST ***' : ''}\n`
        );
    }

    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
