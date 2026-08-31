// Registre des entreprises du Québec (REQ) — miroir local des données ouvertes.
//
// SENS UNIQUE, LECTURE SEULE : le REQ entre dans l'ERP, rien n'en ressort
// jamais. Aucune écriture sortante, aucun appel authentifié — le jeu de données
// est public (Données Québec, jeu « registre-des-entreprises », licence
// CC BY-NC-SA du Registraire des entreprises).
//
// Source
// ------
// Le portail CKAN de Données Québec ne sert PAS le fichier : il porte un lien
// vers registreentreprises.gouv.qc.ca, d'où un ZIP contenant six CSV reliés par
// le NEQ (Entreprise, Nom, Établissement, FusionScission,
// ContinuationTransformation, DomaineValeur). Le jeu est republié deux fois par
// mois. On n'exploite que les deux premiers : Entreprise (statut, dates,
// adresse du domicile, codes d'activité) et Nom (nom légal + noms d'usage).
//
// ⚠️ Le téléchargement direct est protégé par Cloudflare, qui répond 403 aux
// requêtes venant de ce serveur (vérifié en curl ET en Chromium headless : la
// page de défi « Un instant… » ne se résout jamais depuis cette IP). Le chemin
// automatique est donc implémenté et tenté à chaque import, mais il faut
// aujourd'hui fournir le fichier à la main — d'où les trois sources acceptées,
// dans l'ordre de priorité :
//   1. `csv`      — contenu CSV collé (un seul fichier, format Entreprise)
//   2. `zipPath`  — ZIP déjà déposé sur le serveur (ou REQ_LOCAL_ZIP)
//   3. le téléchargement depuis Données Québec
//
// Idempotence
// -----------
// L'import est un upsert par NEQ, par lots, dans une transaction par lot. Il ne
// fait JAMAIS de DELETE : une entreprise absente d'une livraison garde sa
// dernière version connue (le REQ republie l'intégralité du registre, mais une
// livraison tronquée ne doit pas vider la table). Relancer deux fois le même
// fichier laisse exactement le même contenu.
import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import db from '../db/database.js'
import { fold, nameTokens } from './mapaqImport.js'
import { logSync } from './syncLog.js'

const CKAN_BASE = process.env.REQ_CKAN_BASE || 'https://www.donneesquebec.ca/recherche/api/3/action'
const DATASET = process.env.REQ_DATASET || 'registre-des-entreprises'

const FETCH_TIMEOUT_MS = 15 * 60 * 1000   // le ZIP pèse plusieurs centaines de Mo
const BATCH_SIZE = 2000

const AUTOMATION_ID = 'sys_req_import'

/** Réglages de l'automation système (chemin du ZIP local, filtre horticole). */
export function getReqConfig() {
  try {
    const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(AUTOMATION_ID)
    return JSON.parse(row?.action_config || '{}') || {}
  } catch { return {} }
}

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Clé de rapprochement d'un nom d'entreprise : mêmes règles des deux côtés
 * (registre et `companies.name`), sinon « Les Serres Dupont inc. » et « Serres
 * Dupont » ne se retrouvent jamais. Réutilise le tokeniseur de l'import MAPAQ,
 * qui écarte déjà accents, ponctuation, formes juridiques et mots vides.
 */
export function normalizeName(s) {
  return nameTokens(s).join(' ')
}

function normalizeHeader(h) {
  return fold(h).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** Dates du REQ : `YYYY-MM-DD` (colonne date-only, pas d'heure — cf. CLAUDE.md). */
function toDateOnly(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/)          // 20240131
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)  // 31-01-2024
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  return null
}

const POSTAL_RE = /\b([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)\b/
const PROVINCE_RE = /^(qu[ée]bec|qc|ontario|on|nouveau-brunswick|nb|alberta|ab|canada)$/i

/**
 * Les quatre lignes d'adresse du REQ (`ADR_DOMCL_LIGN1..4_ADR`) sont un bloc
 * libre : l'ordre varie et des lignes sont vides. On repère donc chaque
 * composant par sa forme (code postal, province) plutôt que par sa position, et
 * ce qui reste devient la rue puis la ville.
 */
export function parseAddressLines(lines) {
  const parts = lines.map(l => String(l ?? '').trim()).filter(Boolean)
  let postal = null; let province = null
  const rest = []
  for (const raw of parts) {
    let line = raw
    const pm = line.match(POSTAL_RE)
    if (pm && !postal) {
      postal = `${pm[1].toUpperCase()} ${pm[2].toUpperCase()}`
      line = line.replace(POSTAL_RE, '').trim()
    }
    // « Ville (Québec) » — la province arrive souvent entre parenthèses.
    const paren = line.match(/\(([^)]+)\)\s*$/)
    if (paren && PROVINCE_RE.test(paren[1].trim())) {
      if (!province) province = paren[1].trim()
      line = line.replace(/\(([^)]+)\)\s*$/, '').trim()
    }
    line = line.replace(/[,;]\s*$/, '').trim()
    if (!line) continue
    if (PROVINCE_RE.test(line)) { province ||= line; continue }
    rest.push(line)
  }
  // Ce qui commence par un chiffre est une voie (« 120 rang des Érables »,
  // « 5, 3e Avenue ») ; une municipalité, jamais. C'est ce critère — et non la
  // position — qui sépare la rue de la ville, parce que l'ordre des quatre
  // lignes n'est pas garanti d'une livraison à l'autre.
  const isStreet = l => /^\d/.test(l)
  const streets = rest.filter(isStreet)
  const others = rest.filter(l => !isStreet(l))

  let adresse = null
  let ville = null
  if (!rest.length) {
    // rien à dire
  } else if (streets.length && others.length) {
    adresse = streets.join(', ')
    // La municipalité est la dernière ligne non-voie (les précédentes sont des
    // compléments : bureau, étage, a/s de…).
    ville = others[others.length - 1]
  } else if (streets.length) {
    adresse = streets.join(', ')
  } else if (others.length === 1) {
    ville = others[0]
  } else {
    adresse = others.slice(0, -1).join(', ')
    ville = others[others.length - 1]
  }

  return {
    adresse,
    ville,
    province: province ? (/^(qu[ée]bec|qc)$/i.test(province) ? 'QC' : province) : null,
    code_postal: postal,
  }
}

// ── Lecture CSV en flux ──────────────────────────────────────────────────────

/**
 * Parcourt un CSV volumineux ligne par ligne sans le charger en mémoire.
 * Machine à états RFC 4180 (guillemets, séparateur et sauts de ligne échappés),
 * séparateur auto-détecté sur l'en-tête — le REQ publie en virgule, mais le
 * fichier collé à la main dans l'ERP arrive parfois en point-virgule.
 * `onRow` reçoit un objet { en-tête normalisé → valeur }.
 */
export async function streamCsv(stream, onRow) {
  let delim = null
  let headers = null
  let row = []
  let field = ''
  let quoted = false
  let pendingQuote = false
  let count = 0
  let first = true

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => {
    pushField()
    if (row.length === 1 && row[0] === '') { row = []; return }
    if (!headers) {
      headers = row.map(normalizeHeader)
    } else {
      const obj = {}
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = (row[i] ?? '').trim()
      onRow(obj, count++)
    }
    row = []
  }

  // StringDecoder et non `chunk.toString()` : une lecture par blocs coupe les
  // caract\u00E8res multi-octets en plein milieu, et \u00AB Saint-R\u00E9mi \u00BB ressortait avec
  // un losange noir une fois sur mille.
  const decoder = new StringDecoder('utf8')
  for await (const chunk of stream) {
    let text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (first) { text = text.replace(/^\uFEFF/, ''); first = false }
    if (!text) continue
    if (delim == null) {
      const head = text.split('\n', 1)[0]
      const counts = [',', ';', '\t', '|'].map(d => [d, head.split(d).length - 1])
      counts.sort((a, b) => b[1] - a[1])
      delim = counts[0][1] > 0 ? counts[0][0] : ','
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (pendingQuote) {
        pendingQuote = false
        if (c === '"') { field += '"'; continue }
        quoted = false
        // Retombe dans le traitement normal du caractère courant.
      }
      if (quoted) {
        if (c === '"') { pendingQuote = true; continue }
        field += c
        continue
      }
      if (c === '"' && field === '') { quoted = true; continue }
      if (c === delim) { pushField(); continue }
      if (c === '\n') { pushRow(); continue }
      if (c === '\r') continue
      field += c
    }
  }
  if (field.length || row.length) pushRow()
  return count
}

function csvStreamFromString(text) {
  // Un contenu collé tient déjà en mémoire : on le rend en un seul morceau.
  return (async function* () { yield Buffer.from(String(text), 'utf8') })()
}

// ── Sources du fichier ───────────────────────────────────────────────────────

async function ckan(action, params) {
  const url = `${CKAN_BASE}/${action}?${new URLSearchParams(params)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) return null
    const j = await r.json()
    return j?.success ? j.result : null
  } catch { return null } finally { clearTimeout(timer) }
}

/** URL du ZIP publiée par Données Québec (`null` si le jeu a disparu). */
export async function resolveDownloadUrl() {
  const pkg = await ckan('package_show', { id: DATASET })
  if (!pkg) return null
  const res = (pkg.resources || []).find(r => /zip/i.test(r.format || '') || /\.zip|DonneesOuvertes/i.test(r.url || ''))
  return res?.url || null
}

async function downloadZip(destDir) {
  const url = await resolveDownloadUrl()
  if (!url) throw new Error(`Jeu de données « ${DATASET} » introuvable sur Données Québec`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/zip,application/octet-stream,*/*' },
    })
    if (!r.ok) {
      throw new Error(r.status === 403
        ? `le Registraire refuse le téléchargement automatique (HTTP 403 — protection Cloudflare sur ${new URL(url).host}). `
          + 'Télécharger le ZIP depuis Données Québec et le déposer sur le serveur, puis relancer avec son chemin (ou définir REQ_LOCAL_ZIP).'
        : `téléchargement impossible (HTTP ${r.status})`)
    }
    const zipPath = join(destDir, 'req.zip')
    const { writeFileSync } = await import('fs')
    writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()))
    return { zipPath, url }
  } finally { clearTimeout(timer) }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let out = ''; let err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} a échoué (code ${code})`))))
  })
}

/**
 * Extrait un membre du ZIP par son nom logique. Les noms réels portent des
 * accents et une casse variable d'une livraison à l'autre (« Etablissement.csv »
 * / « Établissement.csv ») : on compare sur la forme repliée.
 */
async function extractMember(zipPath, logicalName, destDir) {
  const listing = await run('unzip', ['-Z1', zipPath])
  const wanted = fold(logicalName)
  const hit = listing.split('\n').map(s => s.trim()).filter(Boolean)
    .find(n => fold(n.split('/').pop()) === wanted)
  if (!hit) return null
  await run('unzip', ['-o', '-j', zipPath, hit, '-d', destDir])
  const local = join(destDir, hit.split('/').pop())
  return existsSync(local) ? local : null
}

// ── Sélection du nom légal / des noms d'usage ────────────────────────────────

// Le type de nom est un code du domaine TYP_NOM_ASSUJ, dont les libellés ne
// vivent que dans DomaineValeur.csv (livré dans le ZIP). On ne dépend donc pas
// d'une valeur précise : est « autre nom » tout type qui le dit, le reste est
// candidat au nom légal. Idem pour le statut (un nom expiré porte une date de
// fin, quel que soit le libellé de STAT_NOM).
const OTHER_NAME_RE = /autre|usage|declar|affaire/i

function pickNames(rows) {
  const active = rows.filter(r => !r.dat_fin)
  const pool = active.length ? active : rows
  const legal = pool.find(r => !OTHER_NAME_RE.test(r.type || '')) || pool[0] || null
  const usage = pool.filter(r => r !== legal).map(r => r.nom).filter(Boolean)
  return { legal: legal?.nom || null, usage: [...new Set(usage)] }
}

// ── Écriture par lots ────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO req_entreprises (
    neq, nom_legal, nom_normalise, noms_usage, statut_immat, date_immat, date_statut_immat,
    forme_juridique, adresse, ville, province, code_postal,
    code_activite, desc_activite, code_activite2, desc_activite2,
    source_version, imported_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(neq) DO UPDATE SET
    nom_legal = excluded.nom_legal,
    nom_normalise = excluded.nom_normalise,
    noms_usage = excluded.noms_usage,
    statut_immat = excluded.statut_immat,
    date_immat = excluded.date_immat,
    date_statut_immat = excluded.date_statut_immat,
    forme_juridique = excluded.forme_juridique,
    adresse = excluded.adresse,
    ville = excluded.ville,
    province = excluded.province,
    code_postal = excluded.code_postal,
    code_activite = excluded.code_activite,
    desc_activite = excluded.desc_activite,
    code_activite2 = excluded.code_activite2,
    desc_activite2 = excluded.desc_activite2,
    source_version = excluded.source_version,
    imported_at = excluded.imported_at,
    updated_at = excluded.updated_at
`

function makeWriter(sourceVersion) {
  const stmt = db.prepare(UPSERT_SQL)
  const now = new Date().toISOString()
  const flush = db.transaction(batch => {
    for (const e of batch) {
      stmt.run(
        e.neq, e.nom_legal, e.nom_normalise, e.noms_usage, e.statut_immat, e.date_immat,
        e.date_statut_immat, e.forme_juridique, e.adresse, e.ville, e.province, e.code_postal,
        e.code_activite, e.desc_activite, e.code_activite2, e.desc_activite2,
        sourceVersion, now, now,
      )
    }
  })
  let buf = []
  let written = 0
  return {
    push(entry) {
      buf.push(entry)
      if (buf.length >= BATCH_SIZE) { flush(buf); written += buf.length; buf = [] }
    },
    done() {
      if (buf.length) { flush(buf); written += buf.length; buf = [] }
      return written
    },
  }
}

// ── Import ───────────────────────────────────────────────────────────────────

function mapEntrepriseRow(r, names) {
  const neq = String(r.neq || '').trim()
  if (!neq) return null
  const nom = names?.legal || r.nom_assuj || null
  const addr = parseAddressLines([
    r.adr_domcl_lign1_adr, r.adr_domcl_lign2_adr, r.adr_domcl_lign3_adr, r.adr_domcl_lign4_adr,
    // Repli pour un CSV « à plat » fourni à la main (colonnes sans le préfixe).
    r.lign1_adr, r.lign2_adr, r.lign3_adr, r.lign4_adr,
  ])
  return {
    neq,
    nom_legal: nom,
    nom_normalise: normalizeName(nom) || null,
    noms_usage: names?.usage?.length ? JSON.stringify(names.usage) : null,
    statut_immat: r.cod_stat_immat || null,
    date_immat: toDateOnly(r.dat_immat),
    date_statut_immat: toDateOnly(r.dat_stat_immat),
    forme_juridique: r.cod_forme_juri || null,
    adresse: addr.adresse,
    ville: addr.ville,
    province: addr.province,
    code_postal: addr.code_postal,
    code_activite: r.cod_act_econ_cae || r.cod_act_econ || null,
    desc_activite: r.desc_act_econ_assuj || r.desc_act_econ_etab || null,
    code_activite2: r.cod_act_econ_cae2 || r.cod_act_econ2 || null,
    desc_activite2: r.desc_act_econ_assuj2 || r.desc_act_econ_etab2 || null,
  }
}

/** Charge Nom.csv en index NEQ → { legal, usage }. */
async function loadNames(path) {
  const byNeq = new Map()
  await streamCsv(createReadStream(path), row => {
    const neq = String(row.neq || '').trim()
    const nom = String(row.nom_assuj || '').trim()
    if (!neq || !nom) return
    if (!byNeq.has(neq)) byNeq.set(neq, [])
    byNeq.get(neq).push({ nom, type: row.typ_nom_assuj || '', dat_fin: toDateOnly(row.dat_fin_nom_assuj) })
  })
  const out = new Map()
  for (const [neq, rows] of byNeq) out.set(neq, pickNames(rows))
  return out
}

/**
 * Import complet, idempotent. Ne supprime jamais.
 * @param {{ trigger?: string, csv?: string, zipPath?: string, apply?: boolean }} opts
 * @returns {Promise<{ source, read, written, skipped, duration_ms, summary }>}
 */
export async function runReqImport(opts = {}) {
  const { trigger = 'manuel', csv = null, apply = true } = opts
  const started = Date.now()
  let tmp = null
  let source = null

  try {
    let entreprisePath = null
    let namesIndex = new Map()
    let stream = null

    if (csv && String(csv).trim()) {
      source = { kind: 'csv', label: 'Fichier CSV fourni manuellement' }
      stream = csvStreamFromString(csv)
    } else {
      tmp = mkdtempSync(join(tmpdir(), 'req-'))
      let zipPath = opts.zipPath || getReqConfig().local_zip_path || process.env.REQ_LOCAL_ZIP || null
      if (zipPath) {
        if (!existsSync(zipPath)) throw new Error(`fichier introuvable : ${zipPath}`)
        source = { kind: 'file', label: `ZIP local — ${zipPath}`, bytes: statSync(zipPath).size }
      } else {
        const dl = await downloadZip(tmp)
        zipPath = dl.zipPath
        source = { kind: 'download', label: `Données Québec — ${DATASET}`, url: dl.url, bytes: statSync(zipPath).size }
      }
      entreprisePath = await extractMember(zipPath, 'Entreprise.csv', tmp)
      if (!entreprisePath) throw new Error("le ZIP ne contient pas Entreprise.csv (jeu de données inattendu)")
      const nomPath = await extractMember(zipPath, 'Nom.csv', tmp)
      if (nomPath) namesIndex = await loadNames(nomPath)
      stream = createReadStream(entreprisePath)
    }

    const version = `${source.kind}:${new Date().toISOString().slice(0, 10)}`
    const writer = apply ? makeWriter(version) : null
    let read = 0
    let skipped = 0
    const preview = []

    await streamCsv(stream, row => {
      read++
      const entry = mapEntrepriseRow(row, namesIndex.get(String(row.neq || '').trim()))
      if (!entry) { skipped++; return }
      if (writer) writer.push(entry)
      else if (preview.length < 20) preview.push(entry)
    })

    const written = writer ? writer.done() : 0
    const duration_ms = Date.now() - started
    const summary = apply
      ? `${written} entreprise(s) importée(s) du registre (${read} ligne(s) lues, ${skipped} ignorée(s)) — ${source.label}`
      : `Simulation : ${read} ligne(s) lues, ${read - skipped} importable(s) — ${source.label}`

    logSync('req', trigger === 'planifié' ? 'scheduled' : 'manual', {
      status: 'success', modified: written, durationMs: duration_ms,
    })
    return { source, read, written, skipped, duration_ms, summary, preview, applied: apply }
  } catch (e) {
    logSync('req', trigger === 'planifié' ? 'scheduled' : 'manual', {
      status: 'error', modified: 0, error: e.message, durationMs: Date.now() - started,
    })
    throw e
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* tmp déjà nettoyé */ } }
  }
}

/**
 * Import mensuel. Court-circuite si l'automation système est désactivée, et
 * journalise dans automation_logs en plus de sync_log (fait par runReqImport).
 */
export async function scheduledReqImport() {
  const { isSystemAutomationActive, logSystemRun } = await import('./systemAutomations.js')
  if (!isSystemAutomationActive('sys_req_import')) return null
  const started = Date.now()
  try {
    const out = await runReqImport({ trigger: 'planifié' })
    logSystemRun('sys_req_import', { status: 'success', result: out.summary, duration_ms: Date.now() - started })
    return out
  } catch (e) {
    logSystemRun('sys_req_import', { status: 'error', error: e, duration_ms: Date.now() - started })
    console.error('req import:', e.message)
    return null
  }
}

// ── Consultation ─────────────────────────────────────────────────────────────

// Un statut « actif » est celui d'une entreprise encore immatriculée. Les
// libellés du domaine STAT_IMMAT vivent dans DomaineValeur.csv (dans le ZIP) :
// on décide donc sur le sens du mot plutôt que sur un code figé — est radiée
// toute entreprise dont le statut parle de radiation ou de dissolution.
const STRUCK_RE = /radi|dissou|dissol|ferm|annul/i

export function isStruckOff(statut) {
  return STRUCK_RE.test(fold(statut || ''))
}

const SELECT_COLS = `neq, nom_legal, noms_usage, statut_immat, date_immat, date_statut_immat,
  forme_juridique, adresse, ville, province, code_postal, code_activite, desc_activite,
  code_activite2, desc_activite2, imported_at`

function decorate(row) {
  if (!row) return null
  let usage = []
  try { usage = row.noms_usage ? JSON.parse(row.noms_usage) : [] } catch { usage = [] }
  return { ...row, noms_usage: usage, struck_off: isStruckOff(row.statut_immat) }
}

/** État du miroir : volumétrie et dernière livraison importée. */
export function getReqStatus() {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, MAX(imported_at) AS last_import, MAX(source_version) AS version
    FROM req_entreprises WHERE deleted_at IS NULL
  `).get()
  const linked = db.prepare("SELECT COUNT(*) AS n FROM companies WHERE deleted_at IS NULL AND neq IS NOT NULL AND neq != ''").get()
  return { total: row?.total || 0, last_import: row?.last_import || null, version: row?.version || null, linked: linked?.n || 0 }
}

/** Recherche libre (picker « Corriger la correspondance ») — NEQ, nom, ville. */
export function searchReq(q, limit = 25) {
  const term = String(q || '').trim()
  if (!term) return []
  const like = `%${term}%`
  const norm = `${normalizeName(term)}%`
  const rows = db.prepare(`
    SELECT ${SELECT_COLS} FROM req_entreprises
    WHERE deleted_at IS NULL AND (neq = ? OR nom_legal LIKE ? OR nom_normalise LIKE ? OR ville LIKE ?)
    ORDER BY (neq = ?) DESC, (nom_normalise LIKE ?) DESC, nom_legal COLLATE NOCASE
    LIMIT ?
  `).all(term, like, norm, like, term, norm, Math.min(100, Math.max(1, limit)))
  return rows.map(decorate)
}

export function getByNeq(neq) {
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM req_entreprises WHERE neq = ? AND deleted_at IS NULL`).get(String(neq || '').trim())
  return decorate(row)
}

/**
 * Correspondance automatique pour une entreprise de l'ERP : nom normalisé, puis
 * la ville pour départager les homonymes (« Les Serres du Nord » existe dans
 * plusieurs municipalités). Retourne le meilleur candidat + les suivants, sans
 * jamais écrire : la liaison reste un geste de l'utilisateur.
 */
export function matchCompany(company) {
  const norm = normalizeName(company?.name)
  if (!norm) return { match: null, candidates: [], exact_city: false }
  const rows = db.prepare(`
    SELECT ${SELECT_COLS} FROM req_entreprises
    WHERE deleted_at IS NULL AND nom_normalise = ? LIMIT 50
  `).all(norm).map(decorate)
  if (!rows.length) return { match: null, candidates: [], exact_city: false }

  const city = fold(company?.city || '')
  const scored = rows.map(r => ({
    ...r,
    city_match: !!(city && r.ville && fold(r.ville) === city),
  })).sort((a, b) => {
    if (a.city_match !== b.city_match) return a.city_match ? -1 : 1
    // À ville égale, l'entreprise encore immatriculée passe devant.
    if (a.struck_off !== b.struck_off) return a.struck_off ? 1 : -1
    return String(a.nom_legal || '').localeCompare(String(b.nom_legal || ''))
  })
  // Un nom qui revient dans plusieurs villes sans que l'une corresponde à celle
  // de la fiche reste ambigu : on propose, on n'affirme pas.
  const ambiguous = scored.length > 1 && !scored[0].city_match
  return {
    match: ambiguous ? null : scored[0],
    candidates: scored.slice(0, 10),
    exact_city: !!scored[0].city_match,
    ambiguous,
  }
}

// ── Prospects « culture en serre & horticulture » ────────────────────────────

// Codes d'activité économique (CAE) retenus par défaut. La table des libellés
// (DomaineValeur.csv) n'est livrée qu'à l'intérieur du ZIP : tant qu'une
// livraison n'a pas été chargée, les codes exacts ne sont pas vérifiables. Le
// filtre ne s'y limite donc pas — il retient AUSSI toute entreprise dont la
// description d'activité déclarée parle de serre ou d'horticulture, ce qui est
// le signal réellement fiable (texte libre saisi par l'entreprise elle-même).
// Les deux listes sont surchargeables par l'automation `sys_req_import`.
export const DEFAULT_ACTIVITY_CODES = ['0126', '0125', '0121']
export const HORTICULTURE_RE = /serre|serricol|horticol|horticultur|pepiniere|floricol|floricultur|jardinerie|maraich|hydroponi/

function prospectFilters({ codes, keywords }) {
  const cfg = getReqConfig()
  const rawCodes = codes && codes.length
    ? codes
    : String(cfg.activity_codes || '').split(/[,;\s]+/).filter(Boolean)
  const codeList = (rawCodes.length ? rawCodes : DEFAULT_ACTIVITY_CODES).map(c => String(c).trim()).filter(Boolean)
  const rawKeywords = keywords || cfg.activity_keywords || null
  let re = HORTICULTURE_RE
  // Une expression mal saisie dans la config ne doit pas casser la page : on
  // retombe alors sur le filtre par défaut.
  if (rawKeywords) { try { re = new RegExp(rawKeywords, 'i') } catch { re = HORTICULTURE_RE } }
  return { codeList, re }
}

/**
 * Entreprises du registre à prospecter : activité serre / horticulture, encore
 * immatriculées, et SANS correspondance dans `companies` — ni par NEQ déjà lié,
 * ni par nom normalisé. Lecture seule.
 */
export function listReqProspects({ search = '', region = '', codes = null, keywords = null, limit = 500 } = {}) {
  const { codeList, re } = prospectFilters({ codes, keywords })
  const placeholders = codeList.map(() => '?').join(',')
  // Le filtre « serre » sur la description ne peut pas se faire en SQL (SQLite
  // n'a pas de REGEXP par défaut) : on présélectionne large sur les codes ou
  // sur un LIKE grossier, puis on tranche en JS avec l'expression complète.
  const rows = db.prepare(`
    SELECT ${SELECT_COLS} FROM req_entreprises
    WHERE deleted_at IS NULL
      AND nom_legal IS NOT NULL AND trim(nom_legal) != ''
      AND (
        code_activite IN (${placeholders}) OR code_activite2 IN (${placeholders})
        OR desc_activite LIKE '%erre%' OR desc_activite LIKE '%orticol%' OR desc_activite LIKE '%orticultur%'
        OR desc_activite LIKE '%pini%' OR desc_activite LIKE '%araich%' OR desc_activite LIKE '%araîch%'
        OR desc_activite2 LIKE '%erre%' OR desc_activite2 LIKE '%orticol%' OR desc_activite2 LIKE '%orticultur%'
      )
  `).all(...codeList, ...codeList).map(decorate)

  const linkedNeq = new Set(
    db.prepare("SELECT neq FROM companies WHERE deleted_at IS NULL AND neq IS NOT NULL AND neq != ''").all().map(r => r.neq),
  )
  const knownNames = new Set(
    db.prepare("SELECT name FROM companies WHERE deleted_at IS NULL AND name IS NOT NULL AND trim(name) != ''")
      .all().map(r => normalizeName(r.name)).filter(Boolean),
  )

  // Éligibles = tout ce qui reste après activité / statut / absence de
  // correspondance. La liste des régions se construit ICI, avant les filtres de
  // l'écran : sinon choisir une région viderait le menu de toutes les autres.
  const eligible = rows.filter(r => {
    if (r.struck_off) return false
    const activity = `${r.code_activite || ''} ${r.desc_activite || ''} ${r.code_activite2 || ''} ${r.desc_activite2 || ''}`
    if (!codeList.includes(r.code_activite) && !codeList.includes(r.code_activite2) && !re.test(fold(activity))) return false
    if (linkedNeq.has(r.neq)) return false
    const norm = normalizeName(r.nom_legal)
    return !(norm && knownNames.has(norm))
  })

  // Le REQ ne publie AUCUNE région administrative — ni sur l'entreprise ni sur
  // l'établissement — et le code postal ne la donne pas non plus pour le monde
  // agricole (les FSA rurales G0…/J0… couvrent chacune plusieurs régions). La
  // municipalité est donc la maille géographique la plus fine qui soit fiable :
  // c'est elle qui alimente le filtre « région » de la page.
  const regions = [...new Set(eligible.map(r => r.ville).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'))

  const term = fold(search).trim()
  const wantRegion = fold(region).trim()
  const filtered = eligible.filter(r => {
    if (wantRegion && fold(r.ville || '') !== wantRegion) return false
    if (term && !fold(`${r.nom_legal} ${r.ville} ${r.neq} ${r.desc_activite}`).includes(term)) return false
    return true
  })

  return {
    data: filtered.slice(0, Math.min(2000, Math.max(1, limit))),
    regions,
    total: filtered.length,
    eligible_total: eligible.length,
  }
}
