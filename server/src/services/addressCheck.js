// Vérificateur d'adresses postales (table `adresses`).
//
// Toute adresse qui entre dans l'ERP — saisie manuelle sur la fiche entreprise,
// appel de qualification, formulaire post-paiement, sync Airtable — est passée
// au crible ici. La vérification est **déterministe et hors-ligne** : aucun
// appel réseau, donc aucune dépendance à la clé Google (qui n'a accès ni à la
// Geocoding API ni au Places New — cf. services/geocode.js). Ce qui est
// contrôlé, c'est ce qui rend une adresse inutilisable pour expédier ou
// facturer : champ manquant, code postal mal formé, province inconnue, code
// postal qui ne correspond pas à la province, valeur bouche-trou (« à venir »).
//
// Le résultat est persisté sur la ligne (`check_status`, `check_issues`,
// `checked_at`) et une notification in-app part quand une adresse devient
// fautive. La signature des problèmes est mémorisée : re-vérifier la même
// adresse fautive ne re-notifie pas (sinon la cloche déborde à chaque sync).

import db from '../db/database.js'
import { createNotification } from './notifications.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const ADDRESS_CHECK_AUTOMATION_ID = 'sys_address_check'

export const ADDRESS_CHECK_DEFAULT_CONFIG = {
  // Code postal obligatoire (0 = simple avertissement s'il manque).
  require_postal_code: '1',
  // Notifie l'auteur de la saisie. Les adresses arrivées sans auteur connu
  // (sync Airtable, formulaire client) vont aux rôles listés ici.
  fallback_roles: 'admin',
  // 0 = vérifie et affiche, mais n'envoie aucune notification.
  notify: '1',
}

// ── Référentiels ─────────────────────────────────────────────────────────────

const CA_PROVINCES = {
  AB: 'Alberta', BC: 'Colombie-Britannique', MB: 'Manitoba', NB: 'Nouveau-Brunswick',
  NL: 'Terre-Neuve-et-Labrador', NS: 'Nouvelle-Écosse', NT: 'Territoires du Nord-Ouest',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Île-du-Prince-Édouard', QC: 'Québec',
  SK: 'Saskatchewan', YT: 'Yukon',
}

const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'])

// Première lettre du code postal canadien → provinces admises (RTA de Poste
// Canada). X couvre les T.N.-O. et le Nunavut ; l'Ontario en consomme cinq.
const FSA_LETTER_PROVINCES = {
  A: ['NL'], B: ['NS'], C: ['PE'], E: ['NB'],
  G: ['QC'], H: ['QC'], J: ['QC'],
  K: ['ON'], L: ['ON'], M: ['ON'], N: ['ON'], P: ['ON'],
  R: ['MB'], S: ['SK'], T: ['AB'], V: ['BC'], X: ['NT', 'NU'], Y: ['YT'],
}

// D, F, I, O, Q, U n'existent pas en première position ; I, O, Q, U jamais
// ailleurs non plus (confusion avec 1 / 0).
const CA_POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/
const US_ZIP_RE = /^\d{5}(\d{4})?$/

const US_COUNTRY_TOKENS = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united states',
  'united states of america', 'etats-unis', 'états-unis', 'etats unis', 'états unis'])
const CA_COUNTRY_TOKENS = new Set(['ca', 'can', 'canada'])

// Valeurs bouche-trou : le champ est rempli, mais ne désigne rien.
const PLACEHOLDERS = new Set(['n/a', 'na', 'n.a.', 'nd', 'n.d.', 's/o', 'so', '-', '--', '---',
  '.', '..', '?', '??', 'x', 'xx', 'xxx', 'xxxx', 'tbd', 'a venir', 'a determiner',
  'inconnu', 'inconnue', 'unknown', 'aucune', 'aucun', 'none', 'null', 'vide', 'test'])

const LABELS = {
  line1: 'Rue / Ligne 1',
  city: 'Ville',
  province: 'Province / État',
  postal_code: 'Code postal',
  country: 'Pays',
}

// ── Normalisation ────────────────────────────────────────────────────────────

const norm = v => String(v ?? '').trim()

/** Retire accents, ponctuation et casse — pour comparer des libellés saisis à la main. */
function fold(v) {
  return norm(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** 'Canada' / 'CA' / 'États-Unis' / 'US' → 'CA' | 'US' | '' (inconnu). */
export function normalizeCountry(value) {
  const f = fold(value)
  if (!f) return ''
  if (CA_COUNTRY_TOKENS.has(f)) return 'CA'
  if (US_COUNTRY_TOKENS.has(f)) return 'US'
  return ''
}

/** 'québec' / 'QC' / 'Quebec' → 'QC'. Retourne '' si non reconnu. */
export function normalizeProvince(value, country) {
  const raw = norm(value)
  if (!raw) return ''
  const up = raw.toUpperCase()
  if (country === 'US') return US_STATES.has(up) ? up : ''
  if (CA_PROVINCES[up]) return up
  const f = fold(raw)
  for (const [code, name] of Object.entries(CA_PROVINCES)) {
    if (fold(name) === f) return code
  }
  // Variantes courantes hors référentiel FR.
  const alias = { quebec: 'QC', 'british columbia': 'BC', 'new brunswick': 'NB',
    'nova scotia': 'NS', 'prince edward island': 'PE', 'newfoundland and labrador': 'NL',
    'northwest territories': 'NT' }
  return alias[f] || ''
}

/** Code postal sans espace ni tiret, en majuscules — forme comparable. */
function compactPostal(value) {
  return norm(value).toUpperCase().replace(/[\s-]/g, '')
}

const isPlaceholder = v => PLACEHOLDERS.has(fold(v).replace(/[.\s]+$/, ''))

// ── Vérification ─────────────────────────────────────────────────────────────

/**
 * Contrôle une adresse. Fonction pure : aucune lecture DB, aucun réseau.
 *
 * @param {{line1,city,province,postal_code,country}} addr
 * @param {{requirePostalCode?:boolean}} [opts]
 * @returns {{status:'ok'|'warning'|'error', issues:Array<{code,field,severity,message}>}}
 */
export function validateAddress(addr, { requirePostalCode = true } = {}) {
  const issues = []
  const add = (severity, code, field, message) => issues.push({ code, field, severity, message })

  const country = normalizeCountry(addr?.country)
  if (!norm(addr?.country)) add('error', 'country_missing', 'country', 'Pays absent')
  else if (!country) add('error', 'country_unknown', 'country', `Pays non reconnu : « ${norm(addr.country)} »`)

  for (const field of ['line1', 'city']) {
    const v = norm(addr?.[field])
    if (!v) add('error', `${field}_missing`, field, `${LABELS[field]} absent`)
    else if (isPlaceholder(v)) add('error', `${field}_placeholder`, field, `${LABELS[field]} bouche-trou : « ${v} »`)
  }

  // Une adresse de rue sans numéro civique ne se livre pas — mais un rang, une
  // route rurale ou un casier postal restent plausibles : avertissement.
  const line1 = norm(addr?.line1)
  if (line1 && !isPlaceholder(line1) && !/\d/.test(line1)) {
    add('warning', 'line1_no_number', 'line1', 'Aucun numéro civique dans la rue')
  }

  const provinceRaw = norm(addr?.province)
  const province = normalizeProvince(provinceRaw, country || 'CA')
  if (!provinceRaw) add('error', 'province_missing', 'province', 'Province / État absent')
  else if (country && !province) {
    add('error', 'province_invalid', 'province',
      `« ${provinceRaw} » n'est pas ${country === 'US' ? 'un État américain' : 'une province canadienne'}`)
  }

  const postalRaw = norm(addr?.postal_code)
  const postal = compactPostal(postalRaw)
  if (!postalRaw) {
    if (requirePostalCode) add('error', 'postal_missing', 'postal_code', 'Code postal absent')
    else add('warning', 'postal_missing', 'postal_code', 'Code postal absent')
  } else if (country === 'CA') {
    if (!CA_POSTAL_RE.test(postal)) {
      add('error', 'postal_format', 'postal_code', `Code postal canadien invalide : « ${postalRaw} » (attendu A1A 1A1)`)
    } else if (province) {
      const allowed = FSA_LETTER_PROVINCES[postal[0]] || []
      if (allowed.length && !allowed.includes(province)) {
        add('error', 'postal_province_mismatch', 'postal_code',
          `Le code postal ${postal.slice(0, 3)} appartient à ${allowed.map(p => CA_PROVINCES[p]).join(' / ')}, pas à ${CA_PROVINCES[province] || province}`)
      }
    }
  } else if (country === 'US' && !US_ZIP_RE.test(postal)) {
    add('error', 'postal_format', 'postal_code', `Code ZIP invalide : « ${postalRaw} » (attendu 12345 ou 12345-6789)`)
  }

  const status = issues.some(i => i.severity === 'error') ? 'error'
    : issues.length ? 'warning' : 'ok'
  return { status, issues }
}

/** Fiche où l'adresse se corrige : son entreprise, sinon son contact. */
function addressOwnerLink(row) {
  if (row?.company_id) return `/companies/${row.company_id}`
  if (row?.contact_id) return `/contacts/${row.contact_id}`
  return null
}

/** Adresse sur une ligne, pour les messages et les listes. */
export function formatAddress(a) {
  return [norm(a?.line1), norm(a?.city), norm(a?.province), norm(a?.postal_code), norm(a?.country)]
    .filter(Boolean).join(', ') || '(adresse vide)'
}

// ── Configuration ────────────────────────────────────────────────────────────

export function getAddressCheckConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(ADDRESS_CHECK_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...ADDRESS_CHECK_DEFAULT_CONFIG }
  for (const k of Object.keys(ADDRESS_CHECK_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return {
    requirePostalCode: merged.require_postal_code !== '0',
    fallbackRoles: merged.fallback_roles.split(/[,\s]+/).filter(Boolean),
    notify: merged.notify !== '0',
  }
}

// ── Persistance + notification ───────────────────────────────────────────────

const signature = issues => issues.map(i => i.code).sort().join('|')

function notifyTargets(actorUserId, fallbackRoles) {
  if (actorUserId) return [actorUserId]
  if (!fallbackRoles.length) return []
  const placeholders = fallbackRoles.map(() => '?').join(',')
  return db.prepare(
    `SELECT id FROM users WHERE active = 1 AND role IN (${placeholders})`
  ).all(...fallbackRoles).map(r => r.id)
}

/**
 * Vérifie une adresse, persiste le verdict, notifie si elle vient de devenir
 * fautive. Ne lève jamais : une adresse invérifiable ne doit pas faire échouer
 * l'écriture qui l'a créée.
 *
 * @returns {{status,issues,notified:boolean}|null} null si l'adresse n'existe pas.
 */
export function checkAddress(addressId, { actorUserId = null, notify = true } = {}) {
  try {
    const row = db.prepare(`
      SELECT a.*, co.name AS company_name,
             TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')) AS contact_name
      FROM adresses a
      LEFT JOIN companies co ON co.id = a.company_id
      LEFT JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.id = ?
    `).get(addressId)
    if (!row) return null
    const cfg = getAddressCheckConfig()
    return persistVerdict(row, cfg, { actorUserId, notify })
  } catch (e) {
    console.error('⚠️  checkAddress:', e.message)
    return null
  }
}

// Valide `row` (adresse jointe à sa company), persiste le verdict et notifie
// si l'adresse vient de devenir fautive — ou si ses problèmes ont changé.
//
// L'écriture n'a lieu QUE si le verdict change. C'est ce qui rend le watcher
// (voir plus bas) structurellement à l'abri d'une boucle : notre propre UPDATE
// retombe dans change_log, mais la passe suivante trouve le même verdict, donc
// n'écrit plus rien et la chaîne s'arrête.
function persistVerdict(row, cfg, { actorUserId = null, notify = true } = {}) {
  const { status, issues } = validateAddress(row, { requirePostalCode: cfg.requirePostalCode })
  let prevIssues = []
  try { prevIssues = JSON.parse(row.check_issues || '[]') } catch {}
  const nextJson = JSON.stringify(issues)
  // Écriture dès que le verdict stocké diffère au caractère près (les messages
  // citent les valeurs saisies : « ZZ » corrigé en « YY » doit se refléter).
  const stale = row.check_status !== status || row.check_issues !== nextJson
  // Notification seulement si la NATURE des problèmes change — reformuler le
  // même problème ne doit pas re-sonner la cloche.
  const changed = row.check_status !== status || signature(prevIssues) !== signature(issues)

  if (stale) {
    db.prepare(`
      UPDATE adresses
         SET check_status = ?, check_issues = ?, checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
    `).run(status, nextJson, row.id)
  }

  let notified = false
  if (notify && cfg.notify && status === 'error' && changed) {
    // Une adresse appartient à une entreprise OU à un contact — la notification
    // doit mener là où on la corrige, sinon elle est inactionnable.
    const owner = row.company_name || norm(row.contact_name)
    const label = owner ? `${owner} — ${row.address_type || 'adresse'}` : formatAddress(row)
    const body = `${formatAddress(row)}\n${issues.filter(i => i.severity === 'error').map(i => `• ${i.message}`).join('\n')}`
    for (const userId of notifyTargets(actorUserId, cfg.fallbackRoles)) {
      // Aucun actorUserId n'est transmis à createNotification : c'est justement
      // l'auteur de la saisie qu'il faut prévenir de son erreur (la règle
      // « pas d'auto-notification » ne s'applique pas ici).
      if (createNotification({ userId, type: 'address_check', title: `Adresse à corriger — ${label}`, body,
        link: addressOwnerLink(row) })) notified = true
    }
  }
  return { status, issues, notified }
}

/**
 * Passe toute la table au crible. `apply: false` = simulation (aucune écriture).
 * Utilisé par le bouton « Vérifier toutes les adresses » de la page Paramètres
 * et par l'automation système.
 *
 * `notify` est FAUX par défaut, à la différence du chemin d'écriture : une passe
 * complète rejouerait tout le passif de la table (des dizaines d'adresses
 * héritées d'Airtable) dans la cloche d'un coup. Le rôle de la passe est
 * d'AFFICHER l'état ; la notification, elle, sert à prévenir de l'adresse
 * fautive qu'on vient de saisir.
 */
export function runAddressCheck({ trigger = 'manuel', apply = true, notify = false, log = true } = {}) {
  const started = Date.now()
  const rows = db.prepare(`
    SELECT a.*, co.name AS company_name,
           TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')) AS contact_name
    FROM adresses a
    LEFT JOIN companies co ON co.id = a.company_id
    LEFT JOIN contacts ct ON ct.id = a.contact_id
  `).all()
  const cfg = getAddressCheckConfig()

  const counts = { total: rows.length, ok: 0, warning: 0, error: 0, notified: 0 }
  const problems = []
  for (const row of rows) {
    const verdict = apply
      ? persistVerdict(row, cfg, { notify })
      : validateAddress(row, { requirePostalCode: cfg.requirePostalCode })
    counts[verdict.status]++
    if (verdict.notified) counts.notified++
    if (verdict.status !== 'ok') {
      problems.push({
        id: row.id,
        company_id: row.company_id,
        company_name: row.company_name,
        contact_id: row.contact_id,
        contact_name: row.contact_name,
        address_type: row.address_type,
        formatted: formatAddress(row),
        check_status: verdict.status,
        check_issues: verdict.issues,
      })
    }
  }

  const summary = `${counts.total} adresse(s) · ${counts.error} fautive(s) · ${counts.warning} à surveiller`
    + (apply ? (notify ? ` · ${counts.notified} notification(s)` : '') : ' · simulation')
  if (log) {
    logSystemRun(ADDRESS_CHECK_AUTOMATION_ID, {
      status: 'success',
      result: { summary, counts, problems: problems.slice(0, 50) },
      duration_ms: Date.now() - started,
      triggerData: { trigger, apply },
    })
  }
  return { summary, counts, problems }
}

/** État courant (lecture des verdicts persistés) pour la page Paramètres. */
export function getAddressCheckSummary() {
  const rows = db.prepare(`
    SELECT a.id, a.company_id, a.contact_id, a.address_type, a.line1, a.city, a.province,
           a.postal_code, a.country, a.check_status, a.check_issues, a.checked_at,
           co.name AS company_name,
           TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')) AS contact_name
    FROM adresses a
    LEFT JOIN companies co ON co.id = a.company_id
    LEFT JOIN contacts ct ON ct.id = a.contact_id
    ORDER BY co.name COLLATE NOCASE, a.address_type
  `).all()

  const counts = { total: rows.length, ok: 0, warning: 0, error: 0, unchecked: 0 }
  const problems = []
  for (const r of rows) {
    const status = r.check_status || 'unchecked'
    if (counts[status] === undefined) counts[status] = 0
    counts[status]++
    if (status === 'error' || status === 'warning') {
      let issues = []
      try { issues = JSON.parse(r.check_issues || '[]') } catch {}
      problems.push({
        id: r.id,
        company_id: r.company_id,
        company_name: r.company_name,
        contact_id: r.contact_id,
        contact_name: r.contact_name,
        address_type: r.address_type,
        formatted: formatAddress(r),
        check_status: status,
        check_issues: issues,
      })
    }
  }
  problems.sort((a, b) => (a.check_status === b.check_status ? 0 : a.check_status === 'error' ? -1 : 1))
  // `checked_at` n'est réécrit que quand un verdict change (cf. persistVerdict) :
  // la date de la dernière PASSE vient donc de l'automation, pas des lignes.
  const auto = db.prepare('SELECT last_run_at FROM automations WHERE id = ?').get(ADDRESS_CHECK_AUTOMATION_ID)
  return {
    counts,
    problems,
    last_run_at: auto?.last_run_at || null,
    enabled: isSystemAutomationActive(ADDRESS_CHECK_AUTOMATION_ID),
  }
}

// ── Watcher universel (change_log) ───────────────────────────────────────────
//
// Plutôt que d'instrumenter chaque route qui écrit une adresse (fiche
// entreprise, appel de qualification, formulaire post-paiement du client, sync
// Airtable…), on tail le change_log : les triggers SQLite de db/changeLog.js y
// inscrivent TOUTE mutation sur `adresses`, quelle qu'en soit l'origine. La
// couverture est donc exhaustive par construction.
//
// Anti-boucle : persistVerdict n'écrit que si le verdict change, donc notre
// propre écriture ne peut produire qu'une seule passe supplémentaire à vide.

const POLL_MS = 5000
const BATCH = 500

let lastSeenId = 0
let timer = null
let polling = false

function maxChangeLogId() {
  return db.prepare("SELECT MAX(id) AS m FROM change_log WHERE table_name = 'adresses'").get()?.m || 0
}

/** Une passe. Exportée pour les tests (déterministe, sans minuterie). */
export function pollAddressChangesOnce() {
  if (polling) return 0
  polling = true
  try {
    if (!isSystemAutomationActive(ADDRESS_CHECK_AUTOMATION_ID)) {
      // Automation désactivée : on avance le curseur pour ne pas rejouer tout
      // le backlog à la réactivation.
      lastSeenId = Math.max(lastSeenId, maxChangeLogId())
      return 0
    }
    const rows = db.prepare(`
      SELECT id, record_id FROM change_log
      WHERE id > ? AND change_type = 'upsert' AND table_name = 'adresses'
      ORDER BY id ASC LIMIT ?
    `).all(lastSeenId, BATCH)

    const seen = new Set()
    for (const row of rows) {
      lastSeenId = row.id
      if (seen.has(row.record_id)) continue
      seen.add(row.record_id)
      checkAddress(row.record_id)
    }
    return seen.size
  } catch (e) {
    console.error('[addressCheck] poll error:', e.message)
    return 0
  } finally {
    polling = false
  }
}

export function startAddressCheckWatcher() {
  if (timer) return
  // Démarre à la pointe : on ne rejoue pas l'historique au boot (la passe
  // complète est disponible à la demande depuis Paramètres → Adresses).
  lastSeenId = maxChangeLogId()
  timer = setInterval(() => { pollAddressChangesOnce() }, POLL_MS)
  if (timer.unref) timer.unref()
  console.log(`[addressCheck] watcher démarré (poll ${POLL_MS}ms sur change_log(adresses))`)
}

export function stopAddressCheckWatcher() {
  if (timer) { clearInterval(timer); timer = null }
}

// Test seams — curseur explicite.
export function _setLastSeenId(n) { lastSeenId = n }
export function _getLastSeenId() { return lastSeenId }

export default { validateAddress, checkAddress, runAddressCheck, getAddressCheckSummary }
