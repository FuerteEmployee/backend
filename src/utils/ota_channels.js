// Which AppRelease channel names this server publishes to and serves from.
//
// Production runs two backends on one database (CLAUDE.md, "Production runs
// two releases"). The frozen previous release reads AppRelease rows with
// channel 'production' (everyone) or 'pilot' (listed companies), and it has no
// "never older than the APK" guard. So a bundle for the current app must never
// carry either name there: a 'pilot' row for a company would also reach that
// company's phones still on the old APK through the old API, and a
// 'production' row would reach the frozen company's phones.
//
// OTA_CHANNEL_SET=v2 (set only in production's ~/backend-v2/.env) makes this
// server use 'v2' / 'v2-pilot' instead: the old code never queries those, and
// this server never serves the old names. Unset everywhere else, so staging and
// local development keep 'production' / 'pilot'.
//
// The super admin screen keeps speaking 'production' / 'pilot'; toUi/fromUi
// translate, so it needs no change.

function channelNames() {
    const v2 = String(process.env.OTA_CHANNEL_SET || '').trim().toLowerCase() === 'v2';
    return v2 ? { everyone: 'v2', pilot: 'v2-pilot' } : { everyone: 'production', pilot: 'pilot' };
}

const ALL_CHANNELS = ['production', 'pilot', 'v2', 'v2-pilot'];

/** Stored name -> what the screen shows ('production' | 'pilot'). */
function toUi(channel) {
    if (channel === 'v2') return 'production';
    if (channel === 'v2-pilot') return 'pilot';
    return channel;
}

/** What the screen sent ('production' | 'pilot') -> this server's stored name. */
function fromUi(channel) {
    const n = channelNames();
    if (channel === 'production') return n.everyone;
    if (channel === 'pilot') return n.pilot;
    return null;
}

module.exports = { channelNames, toUi, fromUi, ALL_CHANNELS };
