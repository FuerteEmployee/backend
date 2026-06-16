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

module.exports = { dispatch, sendSubscriptionReminder };
