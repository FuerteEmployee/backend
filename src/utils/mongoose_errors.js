// Turn raw Mongoose/Mongo errors into clean, user-facing messages.
// Keeps internal index names (e.g. "E11000 ... phone_1 dup key") out of the UI.

const FIELD_LABELS = {
    phone: 'phone number',
    email: 'email address',
    aadhaarNo: 'Aadhaar number',
    panNo: 'PAN number',
};

function label(field) {
    return FIELD_LABELS[field] || field || 'value';
}

/**
 * Map a thrown error to { status, message } suitable for res.status().json().
 * - Duplicate unique key (code 11000) -> 409 with a "already registered" message
 * - Mongoose ValidationError -> 400 with the first field's validation message
 * - Anything else -> 400 with the original message (or a generic fallback)
 */
function friendlyMongooseError(error) {
    if (error && error.code === 11000) {
        const key = error.keyValue
            ? Object.keys(error.keyValue)[0]
            : Object.keys(error.keyPattern || {})[0];
        const value = error.keyValue ? error.keyValue[key] : '';
        const name = label(key);
        return {
            status: 409,
            message: `This ${name}${value ? ` (${value})` : ''} is already registered. Please use a different ${name}.`,
        };
    }

    if (error && error.name === 'ValidationError' && error.errors) {
        const first = Object.values(error.errors)[0];
        return { status: 400, message: first?.message || 'Please check the form and try again.' };
    }

    return { status: 400, message: (error && error.message) || 'Something went wrong. Please try again.' };
}

module.exports = { friendlyMongooseError };
