// Import MAPAQ — exploitations agricoles de la catégorie « cultures en serre ».
//
// Sens unique : externe → ERP, déclenchement manuel uniquement (aucune sync
// automatique). Ce module ne fait QUE de la lecture et du classement : produire
// le rapport n'écrit jamais en base. La création des prospects est un second
// geste explicite (voir createProspects ci-dessous, appelé par la route).
//
// Source des données
// ------------------
// Données Québec est un portail CKAN public : ses endpoints `package_show` /
// `datastore_search` répondent sans clé d'API (vérifié — aucune clé gratuite à
// demander). En revanche le registre nominatif des exploitations agricoles du
// MAPAQ (« fiches d'enregistrement ») n'y est PAS publié : l'organisation
// `mapaq` n'expose que 6 jeux (inspection, permis, LiDAR, sites maricoles…), et
// aucun des 1670 jeux du portail ne contient la liste des exploitations avec
// leur nom et leur adresse. Le module tente donc la résolution automatique du
// jeu (au cas où il serait publié plus tard, ou sous un autre slug via
// MAPAQ_DATASET) et, à défaut, accepte un fichier CSV fourni à la main —
// c'est aujourd'hui le seul chemin qui donne des lignes.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'

const CKAN_BASE = process.env.MAPAQ_CKAN_BASE || 'https://www.donneesquebec.ca/recherche/api/3/action'
// Slug pressenti du jeu sur Données Québec. Surchargeable sans redéploiement.
const DEFAULT_DATASET = process.env.MAPAQ_DATASET || 'exploitations-agricoles-enregistrees'
// Requête de repli quand le slug n'existe pas : on cherche un jeu dont le titre
// parle d'exploitations agricoles.
const FALLBACK_QUERY = 'exploitations agricoles enregistrées MAPAQ'

const FETCH_TIMEOUT_MS = 45000
const MAX_BYTES = 30 * 1024 * 1024
const MAX_ROWS = 20000

// ── Utilitaires texte ────────────────────────────────────────────────────────

export function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function normalizeHeader(h) {
  return fold(h).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

// Formes juridiques et mots vides : « Les Serres Dupont inc. » et « Serres
// Dupont » désignent la même entreprise.
const NAME_STOPWORDS = new Set([
  'inc', 'ltee', 'ltd', 'limitee', 'limited', 'enr', 'senc', 'sencrl', 'srl',
  'cie', 'co', 'corp', 'corporation', 'societe', 'entreprise', 'entreprises',
  'le', 'la', 'les', 'l', 'de', 'des', 'du', 'd', 'et', 'the',
])

export function nameTokens(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && !NAME_STOPWORDS.has(t))
}

// Types de voie : bruit pur pour la comparaison d'adresses.
const STREET_STOPWORDS = new Set([
  'rue', 'rang', 'chemin', 'ch', 'boulevard', 'boul', 'bd', 'avenue', 'av',
  'route', 'rte', 'montee', 'cote', 'place', 'pl', 'saint', 'sainte', 'st', 'ste',
  'qc', 'quebec', 'canada', 'ca',
])

function addressTokens(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && !STREET_STOPWORDS.has(t))
}

function civicNumber(s) {
  const m = fold(s).match(/\b(\d{1,6})\b/)
  return m ? m[1] : null
}

function bigrams(s) {
  const t = s.replace(/\s+/g, '')
  const map = new Map()
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    map.set(g, (map.get(g) || 0) + 1)
  }
  return map
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const ga = bigrams(a); const gb = bigrams(b)
  let total = 0; let shared = 0
  for (const n of ga.values()) total += n
  for (const [g, n] of gb) { total += n; shared += Math.min(n, ga.get(g) || 0) }
  return total ? (2 * shared) / total : 0
}

function tokenOverlap(a, b) {
  if (!a.length || !b.length) return 0
  const sa = new Set(a); const sb = new Set(b)
  let shared = 0
  for (const t of sa) if (sb.has(t)) shared++
  return (2 * shared) / (sa.size + sb.size)
}

// ── Analyse CSV (RFC 4180, séparateur auto-détecté) ──────────────────────────

export function parseCsv(text) {
  const clean = String(text ?? '').replace(/^\ufeff/, '')
  if (!clean.trim()) return []
  // Séparateur : celui qui apparaît le plus souvent hors guillemets sur la
  // première ligne (le MAPAQ et Données Québec publient tantôt `,` tantôt `;`).
  const firstLine = clean.split(/\r?\n/, 1)[0]
  const counts = [',', ';', '\t', '|'].map(d => [d, firstLine.split(d).length - 1])
  const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ','

  const rows = []
  let row = []; let field = ''; let quoted = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === delim) { row.push(field); field = ''; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (c === '\r') continue
    field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  if (!rows.length) return []

  const headers = rows[0].map(h => h.trim())
  return rows.slice(1)
    .filter(r => r.some(v => String(v).trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])))
}

// ── Détection des colonnes ───────────────────────────────────────────────────

// Ordre = priorité : le premier motif qui trouve une colonne gagne.
const FIELD_PATTERNS = {
  name: [/^raison_sociale/, /nom_.*(exploitation|entreprise|ferme|etablissement)/, /^nom_exploitant/, /^nom$/, /^exploitation$/, /entreprise/, /etablissement/, /\bnom\b/],
  address: [/^adresse$/, /adresse_(civique|complete|exploitation|principale)/, /^adresse/, /^rue$/, /no_civique/, /^lieu$/],
  city: [/^municipalite/, /^ville$/, /localite/, /municipalite/],
  postal_code: [/^code_postal/, /code_postal/, /^cp$/],
  region: [/region_administrative/, /^region/, /region/, /^mrc$/],
  category: [/categorie.*production/, /^categorie/, /type_.*production/, /^production/, /production/, /^culture/, /culture/, /secteur/],
  phone: [/^telephone/, /telephone/, /^tel$/],
  email: [/^courriel/, /courriel/, /email/, /^adresse_electronique/],
  website: [/site_web/, /site_internet/, /^website$/, /^url$/],
}

export function detectColumns(rows) {
  const headers = rows.length ? Object.keys(rows[0]) : []
  const normalized = headers.map(h => ({ raw: h, key: normalizeHeader(h) }))
  const out = {}
  for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
    for (const re of patterns) {
      const hit = normalized.find(h => re.test(h.key) && !Object.values(out).includes(h.raw))
      if (hit) { out[field] = hit.raw; break }
    }
  }
  return out
}

const GREENHOUSE_RE = /serre|serricole/i

// ── Chargement des lignes ────────────────────────────────────────────────────

async function ckan(action, params) {
  const url = `${CKAN_BASE}/${action}?${new URLSearchParams(params)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return null
    const j = await r.json()
    return j?.success ? j.result : null
  } catch { return null } finally { clearTimeout(timer) }
}

async function fetchText(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const len = Number(r.headers.get('content-length') || 0)
    if (len > MAX_BYTES) throw new Error('fichier trop volumineux')
    const text = await r.text()
    if (text.length > MAX_BYTES) throw new Error('fichier trop volumineux')
    return text
  } finally { clearTimeout(timer) }
}

/**
 * Résout le jeu de données sur le portail CKAN. Retourne `null` s'il n'existe
 * pas (cas actuel du registre MAPAQ, non publié).
 */
export async function resolveDataset(slug = DEFAULT_DATASET) {
  const direct = await ckan('package_show', { id: slug })
  if (direct) return direct
  const search = await ckan('package_search', { q: FALLBACK_QUERY, rows: '10' })
  const hit = (search?.results || []).find(p => /exploitation/i.test(p.title || '') && /agricol/i.test(p.title || ''))
  return hit || null
}

function pickResource(pkg) {
  const res = pkg?.resources || []
  return res.find(r => r.datastore_active)
    || res.find(r => /csv/i.test(r.format || ''))
    || res.find(r => /json/i.test(r.format || ''))
    || null
}

/**
 * Charge les lignes brutes depuis la meilleure source disponible.
 * Priorité : CSV fourni (`csv`) → portail Données Québec.
 * Ne jette pas : les échecs remontent dans `warnings` avec `rows: []`.
 */
export async function loadRows({ csv, dataset } = {}) {
  const warnings = []

  if (csv && String(csv).trim()) {
    const rows = parseCsv(csv).slice(0, MAX_ROWS)
    return {
      rows,
      warnings,
      source: { kind: 'csv', label: 'Fichier CSV fourni manuellement', available: true, row_count: rows.length },
    }
  }

  const slug = dataset || DEFAULT_DATASET
  const pkg = await resolveDataset(slug)
  if (!pkg) {
    return {
      rows: [],
      warnings,
      source: {
        kind: 'ckan', available: false, dataset: slug, portal: CKAN_BASE,
        label: 'Données Québec (portail CKAN public — aucune clé requise)',
        reason: "Le registre des exploitations agricoles du MAPAQ n'est pas publié sur Données Québec "
          + "(l'organisation « mapaq » n'y expose que l'inspection des aliments, les permis, le relief LiDAR "
          + 'et les sites maricoles). Fournir le fichier CSV du MAPAQ pour obtenir un aperçu.',
      },
    }
  }

  const resource = pickResource(pkg)
  if (!resource) {
    return {
      rows: [], warnings,
      source: {
        kind: 'ckan', available: false, dataset: pkg.name, portal: CKAN_BASE,
        label: pkg.title || pkg.name,
        reason: 'Le jeu de données existe mais ne publie aucune ressource CSV / JSON exploitable.',
      },
    }
  }

  try {
    let rows = []
    if (resource.datastore_active) {
      const ds = await ckan('datastore_search', { resource_id: resource.id, limit: String(MAX_ROWS) })
      rows = (ds?.records || []).map(r => { const { _id, ...rest } = r; return rest })
    } else if (/json/i.test(resource.format || '')) {
      const parsed = JSON.parse(await fetchText(resource.url))
      rows = Array.isArray(parsed) ? parsed : (parsed.records || parsed.data || [])
    } else {
      rows = parseCsv(await fetchText(resource.url))
    }
    rows = rows.slice(0, MAX_ROWS)
    return {
      rows, warnings,
      source: {
        kind: 'ckan', available: true, dataset: pkg.name, portal: CKAN_BASE,
        label: pkg.title || pkg.name, resource: resource.name || resource.id,
        url: resource.url, row_count: rows.length,
      },
    }
  } catch (e) {
    return {
      rows: [], warnings,
      source: {
        kind: 'ckan', available: false, dataset: pkg.name, portal: CKAN_BASE,
        label: pkg.title || pkg.name,
        reason: `Téléchargement de la ressource impossible : ${e.message}`,
      },
    }
  }
}

// ── Normalisation d'une ligne source ─────────────────────────────────────────

function pick(row, col) {
  const v = col ? row[col] : null
  const s = v == null ? '' : String(v).trim()
  return s || null
}

export function normalizeEntries(rows, cols) {
  return rows.map((row, i) => ({
    ref: `mapaq-${i + 1}`,
    name: pick(row, cols.name),
    address: pick(row, cols.address),
    city: pick(row, cols.city),
    postal_code: pick(row, cols.postal_code),
    region: pick(row, cols.region),
    production: pick(row, cols.category),
    phone: pick(row, cols.phone),
    email: pick(row, cols.email),
    website: pick(row, cols.website),
    raw: row,
  })).filter(e => e.name)
}

// ── Rapprochement flou avec les entreprises existantes ───────────────────────

// Index inversé par token de nom : sans lui, N entrées × 6600 entreprises font
// exploser le coût du bigramme. On ne compare qu'aux entreprises partageant au
// moins un token significatif.
function buildCompanyIndex() {
  const companies = db.prepare(`
    SELECT id, name, address, city, province
    FROM companies WHERE deleted_at IS NULL AND name IS NOT NULL AND trim(name) != ''
  `).all()
  const byToken = new Map()
  const enriched = companies.map(c => {
    const tokens = nameTokens(c.name)
    const rec = { ...c, tokens, key: tokens.join(' '), addrTokens: addressTokens(c.address), civic: civicNumber(c.address) }
    for (const t of new Set(tokens)) {
      if (t.length < 3) continue
      if (!byToken.has(t)) byToken.set(t, [])
      byToken.get(t).push(rec)
    }
    return rec
  })
  return { all: enriched, byToken }
}

function scoreCandidate(entry, cand) {
  const eTokens = nameTokens(entry.name)
  const nameSim = Math.max(
    diceCoefficient(eTokens.join(' '), cand.key),
    tokenOverlap(eTokens, cand.tokens),
  )
  const eAddr = addressTokens(entry.address)
  let addrSim = null
  if (eAddr.length && cand.addrTokens.length) {
    addrSim = tokenOverlap(eAddr, cand.addrTokens)
    const eCivic = civicNumber(entry.address)
    if (eCivic && cand.civic && eCivic === cand.civic) addrSim = Math.min(1, addrSim + 0.2)
  }
  const cityMatch = entry.city && cand.city
    ? fold(entry.city) === fold(cand.city)
    : null
  // L'adresse et la ville sont souvent absentes côté ERP (champs hérités) : on
  // retombe alors sur le nom seul plutôt que de pénaliser la correspondance.
  const score = nameSim * 0.7 + (addrSim ?? nameSim) * 0.2 + (cityMatch == null ? nameSim : (cityMatch ? 1 : 0)) * 0.1
  return { nameSim, addrSim, cityMatch, score }
}

const EXISTING_THRESHOLD = 0.90
const DUPLICATE_THRESHOLD = 0.62

export function matchEntry(entry, index) {
  const tokens = new Set(nameTokens(entry.name).filter(t => t.length >= 3))
  const seen = new Set()
  const candidates = []
  for (const t of tokens) {
    for (const c of (index.byToken.get(t) || [])) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      candidates.push(c)
    }
  }
  const scored = candidates
    .map(c => ({ id: c.id, name: c.name, address: c.address, city: c.city, ...scoreCandidate(entry, c) }))
    .filter(c => c.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  const best = scored[0] || null
  let category = 'nouvelle'
  if (best && (best.score >= EXISTING_THRESHOLD || best.nameSim >= 0.97)) category = 'existante'
  else if (best && best.score >= DUPLICATE_THRESHOLD) category = 'doublon'
  return { category, match: best, candidates: scored }
}

export const CATEGORY_LABELS = {
  nouvelle: 'Nouvelle',
  doublon: 'Doublon probable',
  existante: 'Déjà existante',
}

/**
 * Rapport d'import en mode APERÇU — aucune écriture en base.
 * @param {{ region?: string, csv?: string, dataset?: string, limit?: number }} opts
 */
export async function buildPreviewReport(opts = {}) {
  const { rows, source, warnings } = await loadRows(opts)
  const cols = detectColumns(rows)
  const report = {
    generated_at: new Date().toISOString(),
    source,
    columns: cols,
    region: opts.region || null,
    warnings: [...warnings],
    counts: { total_source: rows.length, greenhouse: 0, nouvelle: 0, doublon: 0, existante: 0 },
    entries: [],
  }
  if (!rows.length) return report

  if (!cols.name) {
    report.warnings.push("Aucune colonne de nom d'exploitation reconnue dans le fichier — impossible de rapprocher.")
    return report
  }

  // Filtre « cultures en serre ».
  let kept = rows
  if (cols.category) {
    kept = rows.filter(r => GREENHOUSE_RE.test(String(r[cols.category] ?? '')))
  } else {
    const anySerre = rows.filter(r => GREENHOUSE_RE.test(Object.values(r).join(' ')))
    if (anySerre.length) {
      kept = anySerre
      report.warnings.push('Aucune colonne « catégorie de production » reconnue : le filtre serre a été appliqué sur la ligne entière.')
    } else {
      report.warnings.push('Aucune colonne « catégorie de production » reconnue et aucune mention de serre : toutes les lignes sont conservées.')
    }
  }

  // Filtre région (seulement si une colonne région existe).
  if (opts.region && cols.region) {
    const want = fold(opts.region)
    kept = kept.filter(r => fold(r[cols.region] ?? '').includes(want))
  } else if (opts.region) {
    report.warnings.push(`Aucune colonne « région » dans la source : le filtre « ${opts.region} » n'a pas été appliqué.`)
  }

  const entries = normalizeEntries(kept, cols)
  report.counts.greenhouse = entries.length

  const index = buildCompanyIndex()
  for (const entry of entries) {
    const { category, match, candidates } = matchEntry(entry, index)
    report.counts[category]++
    const { raw: _raw, ...rest } = entry
    report.entries.push({
      ...rest,
      category,
      category_label: CATEGORY_LABELS[category],
      match_company_id: match?.id || null,
      match_company_name: match?.name || null,
      match_score: match ? Math.round(match.score * 100) : null,
      candidates: candidates.map(c => ({ id: c.id, name: c.name, score: Math.round(c.score * 100) })),
      // Présélection : seules les entrées franchement nouvelles.
      suggested: category === 'nouvelle',
    })
  }
  if (opts.limit) report.entries = report.entries.slice(0, opts.limit)
  return report
}

// ── Création des prospects (second geste, explicite) ─────────────────────────

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/**
 * Crée les companies + projets de prospection pour les entrées validées.
 * Ne met JAMAIS à jour une entreprise existante : une entrée qui retombe sur un
 * match « déjà existante » est ignorée (`skipped`), l'enrichissement manuel du
 * record en place n'est pas écrasé.
 */
export function createProspects(entries, userId) {
  const index = buildCompanyIndex()
  const created = []
  const skipped = []

  const insertCompany = db.prepare(`
    INSERT INTO companies (id, name, type, lifecycle_phase, phone, email, website,
      address, city, province, country, notes, source, currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MAPAQ', 'CAD', ${NOW}, ${NOW})
  `)
  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, company_id, type, status, probability, notes, creation, created_at, updated_at)
    VALUES (?, ?, ?, 'Nouveau client', 'Ouvert', 0, ?, ?, ${NOW}, ${NOW})
  `)

  for (const raw of entries) {
    const entry = {
      name: String(raw?.name || '').trim(),
      address: raw?.address || null,
      city: raw?.city || null,
      postal_code: raw?.postal_code || null,
      region: raw?.region || null,
      production: raw?.production || null,
      phone: raw?.phone || null,
      email: raw?.email || null,
      website: raw?.website || null,
      ref: raw?.ref || null,
    }
    if (!entry.name) { skipped.push({ ref: entry.ref, name: raw?.name || '', reason: 'Nom manquant' }); continue }

    // Re-vérification côté serveur : l'aperçu peut dater, on ne se fie pas au
    // classement envoyé par le client.
    const { category, match } = matchEntry(entry, index)
    if (category === 'existante') {
      skipped.push({
        ref: entry.ref, name: entry.name, reason: 'Entreprise déjà présente dans l\'ERP — non écrasée',
        company_id: match?.id || null, company_name: match?.name || null,
      })
      continue
    }

    const companyId = newRecordId()
    const notesLines = ['Prospect importé du registre MAPAQ (cultures en serre).']
    if (entry.production) notesLines.push(`Catégorie MAPAQ : ${entry.production}`)
    if (entry.region) notesLines.push(`Région : ${entry.region}`)
    if (entry.postal_code) notesLines.push(`Code postal : ${entry.postal_code}`)

    const tx = db.transaction(() => {
      insertCompany.run(
        companyId, entry.name, 'Prospect', 'Lead',
        entry.phone, entry.email, entry.website,
        entry.address, entry.city, 'QC', 'Canada',
        notesLines.join('\n'),
      )
      const projectId = newRecordId()
      insertProject.run(
        projectId, `Prospection MAPAQ — ${entry.name}`, companyId,
        'Créé automatiquement par l\'import MAPAQ (cultures en serre). Stade initial de prospection.',
        new Date().toISOString(),
      )
      return projectId
    })
    const projectId = tx()

    created.push({ ref: entry.ref, name: entry.name, company_id: companyId, project_id: projectId })
    // L'index suit les créations : deux lignes MAPAQ quasi identiques dans le
    // même lot ne doivent pas produire deux entreprises.
    const tokens = nameTokens(entry.name)
    const rec = {
      id: companyId, name: entry.name, address: entry.address, city: entry.city,
      tokens, key: tokens.join(' '), addrTokens: addressTokens(entry.address), civic: civicNumber(entry.address),
    }
    index.all.push(rec)
    for (const t of new Set(tokens)) {
      if (t.length < 3) continue
      if (!index.byToken.has(t)) index.byToken.set(t, [])
      index.byToken.get(t).push(rec)
    }
  }

  return { created, skipped, user_id: userId || null }
}
