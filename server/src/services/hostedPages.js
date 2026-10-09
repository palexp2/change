// Pages HTML hébergées (Fichiers publics) avec acceptation et paiement — remplace
// l'outil Contrats (Charles, 2026-10-09). Une page s'y prête en contenant un
// élément marqué `data-orisha-accept` ; l'ERP y injecte le bloc « Nom + J'accepte
// + Payer » (client/public/page-accept.js). Les prix sont écrits DANS la page :
//   <div data-orisha-accept
//        data-price-new-usd="price_…" data-price-new-cad="price_…"
//        data-price-existing-usd="price_…" data-price-existing-cad="price_…"
//        data-billing-start="2027-11-01"></div>
// data-billing-start (facultatif) : rien n'est facturé avant cette date (essai
// Stripe jusqu'à minuit, heure de Montréal ; Charles, 2026-10-09).
// et relus ici dans le fichier enregistré (jamais pris du navigateur).
// Le client est reconnu par ?contact=<id du contact> dans le lien envoyé
// (variable [Contact ID] des modèles de courriel) : l'id, aléatoire, est la preuve.

import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import db from '../db/database.js'
import { APP_URL } from '../config/appUrl.js'
import { ensureUploadsDir } from '../config/uploads.js'

const uploadsDir = ensureUploadsDir('public')
const MARKER_RE = /<[^>]*\bdata-orisha-accept\b[^>]*>/i
export const PRICE_KEYS = ['price_new_usd', 'price_new_cad', 'price_existing_usd', 'price_existing_cad']

export const pagePublicUrl = token => `${APP_URL}/erp/p/${token}`

const isHtml = row => /html/i.test(row?.mime_type || '') || /\.html?$/i.test(row?.original_name || '')

export function pageContent(row) {
  if (!row || !isHtml(row)) return null
  const path = join(uploadsDir, row.stored_name)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Réglages écrits dans la page : langue et prix du bloc d'acceptation. */
export function pageConfig(html) {
  const tag = html && html.match(MARKER_RE)?.[0]
  if (!tag) return null
  const attr = name => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]?.trim() || null
  const prices = Object.fromEntries(PRICE_KEYS.map(k => [k, attr(`data-${k.replace(/_/g, '-')}`)]))
  const lang = attr('data-lang') || html.match(/<html[^>]*\blang\s*=\s*["']([a-z]{2})/i)?.[1] || 'fr'
  return { prices, language: lang.toLowerCase().startsWith('en') ? 'en' : 'fr', hasPayment: PRICE_KEYS.some(k => prices[k]),
    billingStart: billingStartOf(attr('data-billing-start')) }
}

// Date de premier paiement (AAAA-MM-JJ) → secondes Unix à minuit à Montréal.
// Ignorée si passée ou trop proche : Stripe exige un essai d'au moins 48 h.
export function billingStartOf(v, now = Date.now()) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const utcMidnight = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montreal', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(utcMidnight)).find(p => p.type === 'timeZoneName')?.value || 'GMT-5'
  const off = Number(tz.replace('GMT', '') || 0)
  const ts = Math.floor((utcMidnight - off * 3600e3) / 1000)
  return ts * 1000 > now + 48 * 3600e3 ? { ts, date: `${m[1]}-${m[2]}-${m[3]}` } : null
}

export function getPageByToken(token) {
  const row = db.prepare('SELECT * FROM public_files WHERE token=?').get(String(token || ''))
  if (!row) return null
  const html = pageContent(row)
  const config = pageConfig(html)
  return config ? { ...row, html, config, hash: createHash('sha256').update(html).digest('hex') } : null
}

/** Recalcule le drapeau « page avec acceptation » d'un fichier. */
export function refreshAcceptFlag(id) {
  const row = db.prepare('SELECT * FROM public_files WHERE id=?').get(id)
  if (!row) return
  const html = pageContent(row)
  const accept = !!pageConfig(html)
  db.prepare('UPDATE public_files SET accept_page=? WHERE id=?').run(accept ? 1 : 0, id)
  syncServedCopy(row, accept ? injectAcceptScript(html) : null)
}

// Copie servie par nginx : /erp/p/<jeton> → uploads/public-served/<jeton>/f.<ext>
// — le fichier s'affiche même quand Node est occupé (4 s de page blanche vues
// sur le contrat partenaire ; Charles, 2026-10-09 : tous les fichiers publics,
// ils sont vus par les clients). Page avec acceptation : vraie copie avec le
// script injecté ; sinon lien vers le fichier déposé. PDF, ZIP… restent servis
// par Node, qui leur donne leur nom d'origine au téléchargement.
// Pas de copie → nginx retombe sur Node.
const SERVED_EXT = new Set(['html', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg'])
const servedRoot = ensureUploadsDir('public-served')
export function syncServedCopy(row, acceptHtml = null) {
  if (!/^[0-9a-f]{32}$/.test(String(row?.token || ''))) return
  const dir = join(servedRoot, row.token)
  rmSync(dir, { recursive: true, force: true })
  if (row.deleted) return
  const ext = String(row.stored_name || '').split('.').pop().toLowerCase()
  if (!acceptHtml && !SERVED_EXT.has(ext)) return
  const src = join(uploadsDir, row.stored_name)
  if (!existsSync(src)) return
  mkdirSync(dir, { recursive: true })
  if (acceptHtml) {
    writeFileSync(join(dir, 'f.html.tmp'), acceptHtml)
    renameSync(join(dir, 'f.html.tmp'), join(dir, 'f.html'))
  } else {
    symlinkSync(src, join(dir, `f.${ext}`))
  }
}

export function refreshAllAcceptFlags() {
  rmSync(join(uploadsDir, '..', 'accept-pages'), { recursive: true, force: true }) // ancien emplacement
  for (const { id } of db.prepare('SELECT id FROM public_files').all()) refreshAcceptFlag(id)
}

/** Page servie : le bloc d'acceptation est ajouté en fin de page. */
export function injectAcceptScript(html) {
  const tag = `<script src="${APP_URL}/erp/page-accept.js" defer></script>`
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag
}

// Copie de la version acceptée (une par empreinte) : preuve de ce qui a été lu.
export function archiveAcceptedVersion(page) {
  const dir = join(uploadsDir, 'accepted')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, `${page.hash}.html`)
  if (!existsSync(path)) writeFileSync(path, page.html)
}

/**
 * Client existant (même règle que le paiement) : entreprise du contact en phase
 * « Customer » ou avec un abonnement actif. Choisit la variante
 * `data-orisha-if="existing|new"` affichée dans la page.
 */
export function isExistingCustomer(contactId) {
  const co = contactCompanyId(contactId)
  return !!co && !!db.prepare(`SELECT 1 FROM companies co WHERE co.id = ? AND (co.lifecycle_phase = 'Customer'
      OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.company_id = co.id AND s.status IN ('active','trialing','past_due')))`).get(co)
}

/**
 * Entreprise d'un contact : son entreprise principale, ses liens
 * « entreprises » (contact_companies), et ceux de ses doublons au même
 * courriel. Une entreprise cliente (phase Customer ou abonnement actif) passe
 * d'abord (Charles, 2026-10-09 : James Douglass vu comme nouveau client).
 */
export function contactCompanyId(contactId) {
  if (!contactId) return null
  return db.prepare(`
    WITH me AS (SELECT id, LOWER(TRIM(email)) AS em FROM contacts WHERE id = ?),
    peers AS (
      SELECT id FROM me
      UNION SELECT c.id FROM contacts c, me WHERE me.em <> '' AND LOWER(TRIM(c.email)) = me.em AND c.deleted_at IS NULL
    ),
    cos AS (
      SELECT c.company_id AS id, 1 AS prim FROM contacts c JOIN peers p ON p.id = c.id WHERE c.company_id IS NOT NULL
      UNION ALL SELECT cc.company_id, COALESCE(cc.is_primary, 0) FROM contact_companies cc JOIN peers p ON p.id = cc.contact_id
    )
    SELECT co.id FROM cos JOIN companies co ON co.id = cos.id AND co.deleted_at IS NULL
    ORDER BY (co.lifecycle_phase = 'Customer'
      OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.company_id = co.id AND s.status IN ('active','trialing','past_due'))) DESC,
      cos.prim DESC
    LIMIT 1`).get(contactId)?.id || null
}

// Retire la variante que ce visiteur ne voit pas (texte signé = texte lu).
export function pageVariant(html, existing) {
  const drop = existing ? 'new' : 'existing'
  return String(html || '').replace(new RegExp(`<(\\w+)\\b[^>]*\\bdata-orisha-if\\s*=\\s*["']${drop}["'][^>]*>[\\s\\S]*?<\\/\\1>`, 'gi'), '')
}

/** Texte lisible d'une page (sans scripts, styles ni balises) : version signée. */
export function pageText(html) {
  return String(html || '')
    .replace(/<(head|script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim()
}
