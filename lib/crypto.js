// AES-256-GCM encryption for provider secrets
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const key = process.env.FUEL_ENCRYPTION_KEY;
  if (!key) {
    // Auto-generate and warn
    console.warn('  ⚠️  FUEL_ENCRYPTION_KEY not set — using fallback. Set in .env for production!');
    return crypto.createHash('sha256').update('itforge-fuel-default-key-change-me').digest();
  }
  // Hash the key to ensure 32 bytes
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all hex)
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedStr) {
  if (!encryptedStr) return null;
  try {
    const key = getKey();
    const parts = encryptedStr.split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch(e) {
    console.error('Decryption failed:', e.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
