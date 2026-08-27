import crypto from 'crypto'

// TOTP (RFC 6238) — permet de brancher la 2FA d'un portail sur un secret
// d'application d'authentification plutôt que sur un code reçu par SMS/courriel.
// Sans ça, chaque tournée nocturne réveillerait quelqu'un pour taper 6 chiffres.

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = String(input || '').toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out = []
  for (const char of clean) {
    const idx = alphabet.indexOf(char)
    if (idx === -1) throw new Error('Secret TOTP invalide (base32 attendu)')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotp(secret, { step = 30, digits = 6, at = Date.now() } = {}) {
  const key = base32Decode(secret)
  const counter = Math.floor(at / 1000 / step)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3])
    % 10 ** digits
  return String(code).padStart(digits, '0')
}
