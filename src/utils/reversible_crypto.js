const crypto = require('crypto');

// Reversible (not hashed) storage for the BOTLens confirm-identity password,
// so the super admin can view the exact current value later. AES-256-GCM
// with a server-side key from BOTLENS_CRED_ENC_KEY (32-byte hex).
const KEY = process.env.BOTLENS_CRED_ENC_KEY ? Buffer.from(process.env.BOTLENS_CRED_ENC_KEY, 'hex') : null;

function encrypt(plainText) {
    if (!KEY) throw new Error('BOTLENS_CRED_ENC_KEY is not configured on the server');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decrypt(stored) {
    if (!stored) return null;
    if (!KEY) throw new Error('BOTLENS_CRED_ENC_KEY is not configured on the server');
    const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
    if (!ivHex || !authTagHex || !ciphertextHex) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
