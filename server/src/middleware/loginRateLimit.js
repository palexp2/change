// Bounded, per-process limits. nginx supplies req.ip through the trusted proxy.
export function makeLoginRateLimit({ now = Date.now, windowMs = 15 * 60_000, max = 10 } = {}) {
  const attempts = new Map()
  return (req, res, next) => {
    const time = now()
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key)
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : ''
    const keys = [`ip:${req.ip}`, `account:${email}`]
    if (keys.some(key => (attempts.get(key)?.count || 0) >= max) || attempts.size > 10000) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)))
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez plus tard.' })
    }
    for (const key of keys) {
      const entry = attempts.get(key) || { count: 0, until: time + windowMs }
      entry.count++
      attempts.set(key, entry)
    }
    next()
  }
}
export const loginRateLimit = makeLoginRateLimit()
