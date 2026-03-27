import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

function getKey() {
  const key = process.env.CONNECTOR_ENCRYPTION_KEY
  if (!key || key.length < 64) {
    // Use a deterministic fallback for dev (not secure for production)
    return 'dev_fallback_key_32bytes_000000000000000000000000000000000'.slice(0, 64)
  }
  return key
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
