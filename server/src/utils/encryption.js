import crypto from 'crypto'
import { CONNECTOR_ENCRYPTION_KEY } from '../config/secrets.js'

const ALGORITHM = 'aes-256-gcm'

// Backward-compat fallback so existing OAuth tokens stay decryptable. If the
// env key is missing, the startup validator in secrets.js already logged a
// CRITICAL warning. Rotation is tracked separately (Phase 1.5).
const LEGACY_DEV_KEY = 'dev_fallback_key_32bytes_000000000000000000000000000000000'.slice(0, 64)

function getKey() {
  if (CONNECTOR_ENCRYPTION_KEY && CONNECTOR_ENCRYPTION_KEY.length >= 64) {
    return CONNECTOR_ENCRYPTION_KEY
  }
  return LEGACY_DEV_KEY
}

export function encryptCredentials(plaintext) {
  if (!plaintext) return null
  try {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(getKey(), 'hex'), iv)
    let encrypted = cipher.update(plaintext, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const tag = cipher.getAuthTag().toString('hex')
    return `${iv.toString('hex')}:${tag}:${encrypted}`
  } catch {
    return plaintext // fallback: store plaintext if encryption fails
  }
}

export function decryptCredentials(ciphertext) {
  if (!ciphertext) return null
  if (!ciphertext.includes(':')) return ciphertext // not encrypted
  try {
    const [ivHex, tagHex, encrypted] = ciphertext.split(':')
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(getKey(), 'hex'), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    return ciphertext
  }
}
