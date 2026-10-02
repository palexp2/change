import crypto from 'node:crypto'
import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'

// Suivi d'un courriel envoyé depuis Boréal : chaque lien http(s) du corps
// passe par /api/track/click/:linkId (une ligne email_links par lien, qui
// garde l'adresse d'origine) et un pixel /api/track/email/:emailId.gif est
// ajouté s'il n'y est pas déjà. N'appliquer qu'au corps ENVOYÉ : le corps
// consigné garde ses liens d'origine (l'ouvrir dans l'ERP ne doit rien compter).

const pixelUrl = emailId => `${APP_URL}/erp/api/track/email/${emailId}.gif`
const clickUrl = linkId => `${APP_URL}/erp/api/track/click/${linkId}`

const decodeAttr = s => s.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
const anchorLabel = inner => decodeAttr(inner.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200) || null

export function trackEmailHtml(html, emailId) {
  let body = String(html || '')
  db.prepare(`INSERT OR IGNORE INTO email_tracked (email_id, tracked_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(emailId)
  const insert = db.prepare('INSERT INTO email_links (id, email_id, url, label, position) VALUES (?, ?, ?, ?, ?)')
  let position = 0
  body = body.replace(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi, (whole, pre, q, href, post, inner) => {
    const url = decodeAttr(href.trim())
    if (!/^https?:\/\//i.test(url) || url.includes('/erp/api/track/')) return whole
    const id = crypto.randomBytes(9).toString('base64url')
    insert.run(id, emailId, url, anchorLabel(inner), position++)
    return `<a${pre}href=${q}${clickUrl(id)}${q}${post}>${inner}</a>`
  })
  if (!body.includes(`${emailId}.gif`)) {
    const pixel = `<img src="${pixelUrl(emailId)}" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px">`
    body = body.includes('</body>') ? body.replace('</body>', `${pixel}</body>`) : body + pixel
  }
  return body
}

// Une requête partie de Boréal lui-même (aperçu d'un courriel dont le corps
// consigné contient encore le pixel, clic dans la fiche) n'est pas une lecture
// du destinataire.
export function isSelfHit(req) {
  if (req.get('sec-fetch-site') === 'same-origin') return true
  const ref = req.get('referer')
  if (!ref) return false
  try { return new URL(ref).host === new URL(APP_URL).host && new URL(ref).pathname.startsWith('/erp') } catch { return false }
}

// Clic sur un lien suivi : une ligne par clic + compteur. Rend l'adresse
// d'origine (null si le lien est inconnu). Ne lève jamais.
export function recordEmailClick(linkId, { count = true } = {}) {
  try {
    const link = db.prepare('SELECT id, email_id, url FROM email_links WHERE id = ?').get(linkId)
    if (!link) return null
    if (count) {
      db.prepare(`INSERT INTO email_clicks (link_id, email_id, clicked_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
        .run(link.id, link.email_id)
      db.prepare('UPDATE emails SET click_count = COALESCE(click_count, 0) + 1 WHERE id = ?').run(link.email_id)
    }
    return link.url
  } catch { return null }
}

// Ouvertures et clics d'un courriel, pour sa fiche dans le fil d'activité.
// Un même lien présent deux fois dans le corps est regroupé par adresse.
export function emailTrackingSummary(emailId) {
  const opens = db.prepare('SELECT opened_at FROM email_opens WHERE email_id = ? ORDER BY opened_at DESC')
    .all(emailId).map(o => o.opened_at)
  const rows = db.prepare('SELECT id, url, label FROM email_links WHERE email_id = ? ORDER BY position').all(emailId)
  const clicksOf = db.prepare('SELECT clicked_at FROM email_clicks WHERE link_id = ? ORDER BY clicked_at DESC')
  const byUrl = new Map()
  for (const r of rows) {
    const cur = byUrl.get(r.url) || { url: r.url, label: null, clicks: [] }
    cur.label = cur.label || r.label
    cur.clicks.push(...clicksOf.all(r.id).map(c => c.clicked_at))
    byUrl.set(r.url, cur)
  }
  const links = [...byUrl.values()].map(l => ({ ...l, clicks: l.clicks.sort().reverse() }))
  // Suivi actif = marqué à l'envoi (ou repris des envois d'avant, schema.js).
  // Un courriel synchronisé de Gmail n'en a pas : rien à afficher.
  const tracked = opens.length > 0 || !!db.prepare('SELECT 1 FROM email_tracked WHERE email_id = ?').get(emailId)
  return { tracked, opens, links }
}
