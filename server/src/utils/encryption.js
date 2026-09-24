import crypto from 'crypto'
import { CONNECTOR_ENCRYPTION_KEY } from '../config/secrets.js'

const ALGORITHM = 'aes-256-gcm'

function getKey() {
  if (!/^[a-f0-9]{64}$/i.test(CONNECTOR_ENCRYPTION_KEY || '')) {
    throw new Error('CONNECTOR_ENCRYPTION_KEY must be 64 hexadecimal characters')
  }
  return CONNECTOR_ENCRYPTION_KEY
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
    throw new Error('Credential encryption failed')
  }
}

export function decryptCredentials(ciphertext) {
  if (!ciphertext) return null
  if (!/^[a-f0-9]{32}:[a-f0-9]{32}:/i.test(ciphertext)) return ciphertext // legacy plaintext, migrated separately
  try {
    const [ivHex, tagHex, encrypted] = ciphertext.split(':')
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(getKey(), 'hex'), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    throw new Error('Credential decryption failed')
  }
}
