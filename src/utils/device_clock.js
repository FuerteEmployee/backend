// ─────────────────────────────────────────────────────────────────────────────
// Terminal clock-skew detection.
//
// A biometric terminal reports its OWN wall clock and nothing else. If that
// clock is set to the wrong timezone, every punch it sends is wrong by a whole
// offset -- and nothing downstream can tell, because a plausible timestamp is
// indistinguishable from a correct one.
//
// This is not hypothetical. Device EUF7254400194 shipped configured to UTC:
// every tap it ever sent arrived exactly 330 minutes (the IST offset) after the
// time it claimed. The punch-out landed BEFORE the punch-in, worked time came
// out as zero, and the day graded itself Half Day. Nobody would have found that
// from the attendance screen.
//
// The hard part is telling a wrong clock from an offline backlog, because both
// produce a large receivedAt − deviceTime gap. They differ in shape:
//
//   • A backlog flush has VARYING skew. The oldest queued tap is hours stale,
//     but the newest one is near zero, because the device is live again by the
//     time it finishes flushing.
//   • A wrong clock has CONSTANT skew. Every tap, including one tapped while
//     we watch, is off by the same amount.
//
// So the discriminator is the MINIMUM skew over a window, not the latest or the
// average. A device that has been genuinely live at any point in the last day
// will have contributed a near-zero sample; one whose clock is wrong never can.
// ─────────────────────────────────────────────────────────────────────────────

/** Below this, treat the gap as ordinary network/queue latency. */
const SKEW_SUSPECT_MINUTES = Number(process.env.DEVICE_SKEW_SUSPECT_MINUTES) || 45;

/** How many samples to keep, and how far back the minimum is taken over. */
const MAX_SAMPLES = 20;
const SAMPLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Offsets a misconfigured terminal realistically lands on, in minutes. */
const KNOWN_TZ_OFFSETS = [330, 300, 270, 240, 210, 180, 120, 60, 360, 420, 480, 540, 570, 600, 660, 720];

/** Live-push jitter: two taps this close in offset are the same clock. */
const OFFSET_TOLERANCE_MS = 2 * 60 * 1000;

/** An offset nothing has confirmed for this long is relearned from scratch. */
const OFFSET_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A LARGER offset (the clock fell further behind) is only believed once this
 * many taps agree on it, received over at least this long. An offline backlog
 * also arrives "later than the clock says", but all in one burst when the
 * network returns -- never spread across half an hour of live taps.
 */
const CANDIDATE_MIN_TAPS = 3;
const CANDIDATE_MIN_SPAN_MS = 30 * 60 * 1000;

/**
 * Fold one tap's skew into the device's rolling sample set.
 *
 * Mutates `device` but does not save it -- the caller is already writing the
 * device for lastSeenAt/punchCount and one write is better than two.
 *
 * @returns {{minMinutes: number|null, suspected: boolean, description: string|null}}
 */
function recordClockSkew(device, deviceTime, receivedAt = new Date()) {
    if (!device || !deviceTime) return { minMinutes: null, suspected: false, description: null };

    const skewMs = new Date(receivedAt).getTime() - new Date(deviceTime).getTime();
    if (!Number.isFinite(skewMs)) return { minMinutes: null, suspected: false, description: null };

    const minutes = Math.round(skewMs / 60000);
    const samples = (Array.isArray(device.clockSkewSamples) ? device.clockSkewSamples : [])
        .filter((s) => s && s.at && (receivedAt - new Date(s.at)) < SAMPLE_WINDOW_MS);

    samples.push({ minutes, at: receivedAt });
    device.clockSkewSamples = samples.slice(-MAX_SAMPLES);

    // The minimum ABSOLUTE skew: a device that was live at any point in the
    // window contributed a near-zero sample, so a high minimum means the clock
    // itself is wrong rather than the network having been down.
    const minMinutes = device.clockSkewSamples
        .reduce((lo, s) => Math.min(lo, Math.abs(s.minutes)), Infinity);

    device.clockSkewMinutes = Number.isFinite(minMinutes) ? minMinutes : null;
    const suspected = Number.isFinite(minMinutes) && minMinutes > SKEW_SUSPECT_MINUTES;

    return {
        minMinutes: device.clockSkewMinutes,
        suspected,
        description: suspected ? describeSkew(minutes) : null,
    };
}

/**
 * Plain-language account of a skew, for the alert an admin actually reads.
 *
 * Naming the timezone when the number matches one turns "your device clock is
 * off by 330 minutes" into an instruction someone can act on without knowing
 * what 330 means.
 */
function describeSkew(minutes) {
    const abs = Math.abs(minutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const span = h > 0 ? `${h}h ${m}m` : `${m}m`;
    const direction = minutes > 0 ? 'behind' : 'ahead of';
    const tz = KNOWN_TZ_OFFSETS.find((o) => Math.abs(abs - o) <= 3);

    if (tz === 330 && minutes > 0) {
        return `The terminal's clock is ${span} ${direction} real time — exactly India's UTC+5:30 offset, so its timezone is almost certainly still set to UTC/GMT. Set it to GMT+5:30 on the device.`;
    }
    if (tz) {
        return `The terminal's clock is ${span} ${direction} real time — that matches a whole timezone offset, so its timezone setting is wrong rather than its clock having drifted.`;
    }
    return `The terminal's clock is ${span} ${direction} real time. Punches are still stored at the server's time, but its display is wrong by that much.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server time for every tap.
//
// The client's rule: a punch is stored on the SERVER's clock, never on the
// terminal's. A terminal left on UTC (5h30m behind) is accepted as it is.
//
// Storing the arrival time would do that for a tap that arrives at once, but a
// terminal with no network keeps its taps and sends them later: tapped at 10:45,
// delivered at 11:12, stored as 11:12 and late. So instead each terminal's
// clock is converted: server time = terminal time + offset, where the offset is
// how far that terminal's clock is from ours, learned from its own taps.
//
// What makes the offset learnable is that a tap can never arrive before it was
// made. For every tap, (arrival − terminal time) = offset + delay, delay ≥ 0.
// A live tap has a delay of seconds, so its value IS the offset; a held-back tap
// only ever reads LARGER. Hence:
//   • a smaller reading is always believed at once -- only a live tap, or a
//     clock that was put right, can produce one;
//   • a reading within jitter of the offset confirms it;
//   • a larger reading is a held-back tap, unless several live taps agree on it
//     over half an hour, which only a clock that fell further behind can do.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold one tap into the terminal's learned offset. Mutates `device` (the
 * caller persists the serverOffset* fields). Feed a batch's taps NEWEST first,
 * so a live tap at the end of an offline backlog anchors the older ones.
 *
 * @returns {boolean} whether the offset fields changed
 */
function observeServerOffset(device, deviceTime, receivedAt = new Date()) {
    if (!device || !deviceTime) return false;
    const at = new Date(receivedAt);
    const reading = at.getTime() - new Date(deviceTime).getTime();
    if (!Number.isFinite(reading)) return false;

    const known = Number.isFinite(device.serverOffsetMs) ? device.serverOffsetMs : null;
    const confirmedAt = device.serverOffsetConfirmedAt ? new Date(device.serverOffsetConfirmedAt).getTime() : 0;
    const stale = known === null || at.getTime() - confirmedAt > OFFSET_STALE_MS;

    const adopt = (ms) => {
        device.serverOffsetMs = ms;
        device.serverOffsetConfirmedAt = at;
        device.serverOffsetCandidate = undefined;
        return true;
    };

    if (stale || reading < known - OFFSET_TOLERANCE_MS) return adopt(reading);

    if (reading <= known + OFFSET_TOLERANCE_MS) {
        // A live tap. Keep the smaller of the two: delay only ever adds.
        device.serverOffsetConfirmedAt = at;
        if (reading < known) device.serverOffsetMs = reading;
        device.serverOffsetCandidate = undefined;
        return true;
    }

    // Arrived later than the known offset allows: a held-back tap, or the
    // clock fell behind. Only taps agreeing over time can say it was the clock.
    const c = device.serverOffsetCandidate;
    if (c && Number.isFinite(c.ms) && Math.abs(reading - c.ms) <= OFFSET_TOLERANCE_MS) {
        const count = (c.count || 1) + 1;
        const ms = Math.min(c.ms, reading);
        if (count >= CANDIDATE_MIN_TAPS && at.getTime() - new Date(c.firstAt).getTime() >= CANDIDATE_MIN_SPAN_MS) {
            return adopt(ms);
        }
        device.serverOffsetCandidate = { ms, firstAt: c.firstAt, count };
        return true;
    }
    device.serverOffsetCandidate = { ms: reading, firstAt: at, count: 1 };
    return true;
}

/**
 * The server-clock instant of a tap the terminal stamped `deviceTime`.
 *
 * A manual Clock correction (Super admin > Machines) wins -- somebody set it on
 * purpose. Otherwise the learned offset. With neither, the terminal's own time.
 */
function toServerTime(device, deviceTime) {
    const t = new Date(deviceTime).getTime();
    const manual = Number(device?.clockOffsetMinutes) || 0;
    if (manual !== 0) return new Date(t + manual * 60 * 1000);
    if (Number.isFinite(device?.serverOffsetMs)) return new Date(t + device.serverOffsetMs);
    return new Date(t);
}

module.exports = {
    recordClockSkew,
    describeSkew,
    observeServerOffset,
    toServerTime,
    SKEW_SUSPECT_MINUTES,
    KNOWN_TZ_OFFSETS,
    OFFSET_TOLERANCE_MS,
};
