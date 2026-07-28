import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { logSync } from './syncLog.js'

// Google Doc « Fournisseurs_Particularités » (Drive) — tenu par la comptabilité.
// Tableau : Fournisseur | CAD/USD | Paiement | Catégorie ctb | Description | Particularités
const VENDOR_DOC_ID = process.env.VENDOR_DIRECTORY_DOC_ID
  || '1uyOKRREXeYcBWu-URNHMIhM-KA5EQyAVD-f-SWox7X0'

// Entités nommées rencontrées dans les exports HTML de Google Docs (contenu FR/EN).
// Sensible à la casse (&Eacute; ≠ &eacute;). Une entité inconnue est laissée telle quelle.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä',
  icirc: 'î', iuml: 'ï',
  ocirc: 'ô', ouml: 'ö',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', oelig: 'œ', aelig: 'æ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â',
  Ccedil: 'Ç', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…', deg: '°', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', euro: '€', plusmn: '±', times: '×',
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
}

function cellText(cellHtml) {
  const text = cellHtml
    .replace(/<br[^>]*>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

// Parse l'export HTML du Google Doc : chaque <tr> du tableau devient un fournisseur.
// L'HTML est généré par Google (pas de balises imbriquées exotiques) — un parsing
// par regex suffit et évite une dépendance. La ligne d'en-tête (« Fournisseur ») et
// les lignes sans nom sont ignorées.
export function parseVendorTableHtml(html) {
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []
  const vendors = []
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(cellText)
    if (cells.length < 2) continue
    const name = cells[0]
    if (!name || name.toLowerCase() === 'fournisseur') continue
    vendors.push({
      name,
      currency: cells[1] || null,
      payment_method: cells[2] || null,
      qb_category: cells[3] || null,
      description: cells[4] || null,
      particularites: cells[5] || null,
    })
  }
  return vendors
}

// Clé de comparaison de noms de fournisseurs : minuscules, sans accents ni ponctuation.
export function normalizeVendorKey(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

// Cherche un nom identique (à la normalisation près) dans une liste de fournisseurs.
// Volontairement conservateur (pas de match partiel) : le fuzzy matching est fait par
// le modèle d'extraction, qui reçoit la liste des noms canoniques en contexte.
export function findVendorMatch(name, vendors) {
  const key = normalizeVendorKey(name)
  if (!key) return null
  return vendors.find(v => normalizeVendorKey(v.name) === key) || null
}

// Nom canonique du répertoire pour un nom extrait, ou null si inconnu.
export function findVendorDirectoryName(name) {
  if (!name) return null
  const rows = db.prepare('SELECT name FROM vendor_directory WHERE deleted_at IS NULL').all()
  const match = findVendorMatch(name, rows)
  return match ? match.name : null
}

// Contexte injecté dans le prompt d'extraction des reçus : liste des fournisseurs
// connus (nom canonique + devise habituelle + catégorie comptable). null si le
// répertoire est vide (jamais synchronisé) — l'extraction fonctionne alors sans.
export function buildVendorExtractionContext() {
  const rows = db.prepare(`
    SELECT name, currency, qb_category FROM vendor_directory
    WHERE deleted_at IS NULL ORDER BY name
  `).all()
  // Union avec les profils fournisseurs (vendor_profiles) : fournisseurs déjà
  // comptabilisés mais absents du doc Drive, + leurs alias (variantes de raison
  // sociale apprises) pour aider la canonisation du modèle.
  const seen = new Set(rows.map(r => normalizeVendorKey(r.name)))
  try {
    const profiles = db.prepare('SELECT name, aliases FROM vendor_profiles WHERE deleted_at IS NULL ORDER BY name').all()
    for (const p of profiles) {
      if (seen.has(normalizeVendorKey(p.name))) continue
      seen.add(normalizeVendorKey(p.name))
      let aliases = []
      try { aliases = JSON.parse(p.aliases || '[]') } catch {}
      rows.push({ name: p.name, currency: null, qb_category: null, aliases })
    }
  } catch {}
  if (!rows.length) return null
  const lines = rows.map(r => {
    const extra = [r.currency, r.qb_category].filter(Boolean).join(' | ')
    const alias = Array.isArray(r.aliases) && r.aliases.length ? ` [aussi vu sous : ${r.aliases.join(', ')}]` : ''
    return `- ${r.name}${extra ? ` (${extra})` : ''}${alias}`
  })
  return `RÉPERTOIRE INTERNE DES FOURNISSEURS CONNUS (nom canonique, devise habituelle | catégorie comptable) :
Si l'émetteur du document correspond à l'un de ces fournisseurs — même sous une variante de raison sociale, une marque ou un domaine de courriel — utilise EXACTEMENT le nom canonique ci-dessous comme "company". La devise indiquée est celle habituellement facturée par ce fournisseur : sers-t'en pour trancher quand le document est ambigu (ex. « $ » sans mention CAD/USD).
${lines.join('\n')}`
}

/**
 * Resynchronise la table vendor_directory depuis le Google Doc.
 * Utilise n'importe quel compte Google connecté (scope drive.readonly).
 * Upsert par nom ; les fournisseurs disparus du doc sont soft-deletés.
 * @param {'scheduled'|'manual'} [trigger]
 */
export async function syncVendorDirectory(trigger = 'scheduled') {
  const t0 = Date.now()
  const module = 'vendor_directory'
  try {
    const account = db.prepare(`
      SELECT id FROM connector_oauth
      WHERE connector='google' AND refresh_token IS NOT NULL
      ORDER BY account_email LIMIT 1
    `).get()
    if (!account) throw new Error('aucun compte Google connecté')

    const drive = await getDriveClient(account.id)
    const res = await drive.files.export({ fileId: VENDOR_DOC_ID, mimeType: 'text/html' })
    const vendors = parseVendorTableHtml(res.data)
    // Un doc vide/illisible ne doit pas rayer tout le répertoire : on s'arrête.
    if (!vendors.length) throw new Error('aucune ligne fournisseur extraite du doc Drive')

    const now = new Date().toISOString()
    const upsert = db.prepare(`
      INSERT INTO vendor_directory (id, name, currency, payment_method, qb_category, description, particularites, synced_at, deleted_at)
      VALUES (?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(name) DO UPDATE SET
        currency=excluded.currency, payment_method=excluded.payment_method,
        qb_category=excluded.qb_category, description=excluded.description,
        particularites=excluded.particularites, synced_at=excluded.synced_at,
        deleted_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
    db.transaction(() => {
      for (const v of vendors) {
        upsert.run(uuid(), v.name, v.currency, v.payment_method, v.qb_category, v.description, v.particularites, now)
      }
      db.prepare(`
        UPDATE vendor_directory SET deleted_at=?, updated_at=?
        WHERE deleted_at IS NULL AND (synced_at IS NULL OR synced_at <> ?)
      `).run(now, now, now)
    })()

    logSync(module, trigger, { status: 'success', modified: vendors.length, durationMs: Date.now() - t0 })
    return { status: 'success', imported: vendors.length }
  } catch (e) {
    console.error('❌ Vendor directory sync:', e.message)
    logSync(module, trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    return { status: 'error', imported: 0, error: e.message }
  }
}
