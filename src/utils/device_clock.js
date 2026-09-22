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

/**
 * How many samples must agree on the same offset before it is trusted enough
 * to correct punches with. One sample is indistinguishable from one late tap.
 */
const MIN_CORROBORATING_SAMPLES = 3;

/** How far a sample may sit from the minimum and still count as agreeing. */
const CORROBORATION_TOLERANCE_MINUTES = 5;

/** A measured offset is snapped to a real timezone when it is this close. */
const TZ_SNAP_TOLERANCE_MINUTES = 3;

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
    return `The terminal's clock is ${span} ${direction} real time. Every punch it records is wrong by that much.`;
}

/**
 * How much to add to what this terminal reports, so its punches land at the
 * real time.
 *
 * The Device schema says an offset is "never set automatically", and the reason
 * given was right: a STORED offset keeps being applied after somebody fixes the
 * clock, and every punch is then corrected twice with nothing on screen to say
 * why. That objection is specific to a stored number, though. What this returns
 * is MEASURED, from the device's own recent samples, every time it is asked --
 * so it is self-cancelling by construction. The moment the terminal starts
 * reporting the right time, its next live tap contributes a ~0 sample, the
 * minimum collapses to ~0, and the correction stops on its own. Nobody has to
 * remember to turn it off.
 *
 * That property is what makes this usable on a terminal with no NTP and a dead
 * RTC battery, which loses its clock on every power cut. Asking somebody to
 * re-set it by hand after each outage is not a fix, and a stored offset would
 * be wrong again the moment the clock moved.
 *
 * Deliberately conservative -- it would rather leave a punch visibly wrong than
 * silently move a correct one:
 *
 *  - A MANUAL clockOffsetMinutes always wins. Somebody set that on purpose.
 *  - The minimum is used, never the average, for the reason in the file header:
 *    a backlog flush inflates recent samples but cannot lower the minimum.
 *  - The minimum must be CORROBORATED by several samples agreeing with it.
 *    One large gap is far more likely to be a single late tap than a clock
 *    that is wrong by exactly that much.
 *  - The result snaps to a real timezone offset when it is within a few
 *    minutes of one, because that is what the failure actually is -- a
 *    terminal left on the wrong timezone, not a clock that drifted to 329.
 *
 * @returns {{minutes: number, source: 'manual'|'measured'|'none', confident: boolean}}
 */
function resolveClockCorrection(device) {
    const manual = Number(device?.clockOffsetMinutes) || 0;
    if (manual !== 0) return { minutes: manual, source: 'manual', confident: true };

    const samples = Array.isArray(device?.clockSkewSamples) ? device.clockSkewSamples : [];
    const usable = samples.filter((s) => s && Number.isFinite(Number(s.minutes)));
    if (usable.length < MIN_CORROBORATING_SAMPLES) return { minutes: 0, source: 'none', confident: false };

    // Smallest absolute skew seen: the closest this device has come to being
    // observed live, which is the best available estimate of the pure clock
    // offset with queue latency removed.
    let best = null;
    for (const s of usable) {
        const m = Number(s.minutes);
        if (best === null || Math.abs(m) < Math.abs(best)) best = m;
    }
    if (best === null || Math.abs(best) <= SKEW_SUSPECT_MINUTES) {
        // Within ordinary latency -- nothing to correct, and this is the branch
        // a freshly-fixed clock falls into on its very next tap.
        return { minutes: 0, source: 'none', confident: false };
    }

    // Does the rest of the evidence agree, or is this one odd sample?
    const agreeing = usable.filter(
        (s) => Math.abs(Math.abs(Number(s.minutes)) - Math.abs(best)) <= CORROBORATION_TOLERANCE_MINUTES,
    ).length;
    if (agreeing < MIN_CORROBORATING_SAMPLES) return { minutes: 0, source: 'none', confident: false };

    const tz = KNOWN_TZ_OFFSETS.find((o) => Math.abs(Math.abs(best) - o) <= TZ_SNAP_TOLERANCE_MINUTES);
    const magnitude = tz !== undefined ? tz : Math.abs(best);

    // skew = receivedAt - deviceTime, so a POSITIVE skew means the terminal is
    // running behind and its timestamps must be pushed forward by that much.
    return { minutes: best > 0 ? magnitude : -magnitude, source: 'measured', confident: true };
}

module.exports = {
    recordClockSkew,
    describeSkew,
    resolveClockCorrection,
    SKEW_SUSPECT_MINUTES,
    KNOWN_TZ_OFFSETS,
    MIN_CORROBORATING_SAMPLES,
};
