import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'

// Explicit opt-in, empty by default. Never proxy to the app, LAN or AWS metadata.
export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0))
}
export async function scriptFetch(urlString, options = {}, signal) {
  const url = new URL(urlString)
  const origins = (process.env.SCRIPT_FETCH_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin)) throw new Error('Destination réseau non autorisée')
  const addresses = await lookup(url.hostname, { family: 4, all: true })
  signal.throwIfAborted()
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error('Adresse réseau privée ou réservée interdite')
  const method = String(options.method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error('Méthode réseau interdite')
  const body = options.body ?? ''
  if (typeof body !== 'string' || Buffer.byteLength(body) > 65536) throw new Error('Corps réseau trop volumineux')
  const headers = {}
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (!['authorization', 'content-type', 'accept'].includes(key.toLowerCase()) || typeof value !== 'string' || value.length > 4096) throw new Error('En-tête réseau interdit')
    headers[key] = value
  }
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, signal, timeout: 5000,
      lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4) }, response => {
      const chunks = []; let size = 0
      response.on('error', reject)
      response.on('data', chunk => {
        size += chunk.length
        if (size > 512 * 1024) request.destroy(new Error('Réponse réseau trop volumineuse'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null; try { json = JSON.parse(text) } catch { /* text response */ }
        // Redirects are deliberately not followed: they cannot escape the allowlist.
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text, json })
      })
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(new Error('Délai réseau dépassé')))
    request.end(body)
  })
}
