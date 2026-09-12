/**
 * Single integration point for outbound subscription notifications.
 *
 * There is no SMS/email provider wired up yet (OTP is mocked), so this currently
 * logs the message. To go live, implement the send inside `dispatch()` using your
 * provider of choice (Twilio / MSG91 / Fast2SMS / nodemailer) — every reminder and
 * lifecycle alert already flows through here, so nothing else needs to change.
 */

async function dispatch({ to, name, channel, message }) {
    // TODO: replace with a real provider call, e.g.:
    //   await axios.post('https://api.msg91.com/...', { mobiles: to, message });
    //   await mailer.sendMail({ to, subject, text: message });
    console.log(`[notify] (${channel}) → ${name || ''} <${to}>: ${message}`);
    return { ok: true, mocked: true };
}

/**
 * Notify a tenant that their trial/subscription is approaching its deadline.
 * @param {Object} opts
 * @param {Object} opts.admin   - the tenant admin User (needs phone/email/name)
 * @param {'trial'|'grace'|'active'} opts.kind
 * @param {number} opts.daysRemaining
 */
async function sendSubscriptionReminder({ admin, kind, daysRemaining }) {
    const company = admin.companyName || admin.name || 'there';
    const dayLabel = daysRemaining <= 0 ? 'today' : `in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;

    let message;
    if (kind === 'trial') {
        message = `Hi ${company}, your BOT free trial ends ${dayLabel}. Subscribe to keep your admin panel running. Call +91 97240 00697.`;
    } else if (kind === 'grace') {
        message = `Hi ${company}, your BOT subscription has lapsed and access will be suspended ${dayLabel}. Renew now: +91 97240 00697.`;
    } else {
        message = `Hi ${company}, your BOT subscription renews ${dayLabel}. Contact us for any changes: +91 97240 00697.`;
    }

    return dispatch({
        to: admin.phone,
        name: company,
        channel: admin.email ? 'sms+email' : 'sms',
        message,
    });
}

/**
 * Tell a tenant that one of their biometric terminals has stopped reporting.
 *
 * This is the failure mode nobody notices on their own: the terminal keeps
 * matching fingers and beeping locally, so employees believe attendance is
 * being recorded, while nothing reaches the server. Without an alert the
 * discovery point is month-end payroll.
 *
 * @param {Object} opts
 * @param {Object} opts.admin        - tenant admin User (needs phone/email/name)
 * @param {Object} opts.device       - the Device that went quiet
 * @param {number} opts.minutesQuiet - how long since any contact
 */
async function sendDeviceOfflineAlert({ admin, device, minutesQuiet }) {
    const company = admin.companyName || admin.name || 'there';
    const label = device.label || device.serialNumber;
    const forLabel = minutesQuiet >= 1440
        ? `${Math.floor(minutesQuiet / 1440)} day(s)`
        : `${Math.floor(minutesQuiet / 60)} hour(s)`;

    const message =
        `Hi ${company}, your attendance machine "${label}" has not reported to BOT for ${forLabel}. ` +
        `Punches made on it are NOT being recorded. Please check its power and network. ` +
        `Support: +91 97240 00697.`;

    return dispatch({
        to: admin.phone,
        name: company,
        channel: admin.email ? 'sms+email' : 'sms',
        message,
    });
}

/**
 * Alert a tenant that a terminal's clock is wrong.
 *
 * Deliberately phrased as an instruction rather than a measurement: the person
 * who reads this has to walk to the machine and change a setting, and "clock
 * skew 330 minutes" does not tell them to do that.
 *
 * @param {Object} opts.admin       - tenant admin User
 * @param {Object} opts.device      - the Device with the bad clock
 * @param {string} opts.description - plain-language cause, from device_clock.js
 */
async function sendDeviceClockAlert({ admin, device, description }) {
    const company = admin.companyName || admin.name || 'there';
    const label = device.label || device.serialNumber;

    const message =
        `Hi ${company}, the clock on your attendance machine "${label}" is wrong. ${description} ` +
        `Until it is corrected, every punch recorded on that machine has the wrong time and can affect attendance and salary. ` +
        `Support: +91 97240 00697.`;

    return dispatch({
        to: admin.phone,
        name: company,
        channel: admin.email ? 'sms+email' : 'sms',
        message,
    });
}

/**
 * Tell an employee their session was closed automatically.
 *
 * This is not a nicety. A punch-out nobody made, discovered days later on a
 * payslip, is indistinguishable from the system losing their hours -- and by
 * then the evidence is cold and the argument is unwinnable. Told the same hour,
 * it is a thirty-second correction.
 *
 * The message therefore carries the MEASUREMENT, not just the verdict: the
 * distance and the branch are what let someone immediately say "no, I was in
 * the back office" and get it reversed.
 */
async function sendAutoPunchOutNotice({ employee, attendance, branchName, distanceM, closedAt }) {
    const when = closedAt
        ? new Date(closedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
        : 'just now';

    const message =
        `Hi ${employee.name || 'there'}, you were automatically punched out at ${when} because your phone was ` +
        `${distanceM != null ? `${distanceM}m` : 'outside the allowed radius'} from ` +
        `${branchName || 'your branch'}. If that is wrong, tell your manager today and they can restore it. ` +
        `Support: +91 97240 00697.`;

    return dispatch({
        to: employee.phone,
        name: employee.name,
        channel: employee.email ? 'sms+email' : 'sms',
        message,
    });
}

module.exports = {
    dispatch,
    sendSubscriptionReminder,
    sendDeviceOfflineAlert,
    sendDeviceClockAlert,
    sendAutoPunchOutNotice,
};
