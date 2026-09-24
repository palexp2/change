// Vérification « comptabilisé dans QuickBooks » — le moteur UNIQUE.
//
// Avant le 2026-09-15 il y en avait deux, et ils reconstruisaient le MÊME index
// de grand livre à trente secondes d'intervalle : la sync du fichier TRX_Orisha
// (tous les comptes, aux 20 min) et l'audit des comptes Plaid (9 comptes, aux
// 20 min). Soit ~72 rapports GeneralLedger par heure, pour rien. Ce service les
// remplace tous les deux :
//
//   • il couvre TOUS les comptes mappés à QuickBooks (11), pas seulement les 9
//     branchés à Plaid — la recherche approfondie devient disponible partout ;
//   • il ne lit AUCUN fichier : les relevés entrent par le dépôt de fichiers
//     (services/bankStatementImport.js) et c'est Boréal qui écrit le classeur
//     (services/trxSheetMirror.js) ;
//   • son index de grand livre est mis en cache 5 minutes et partagé : deux
//     passages simultanés font UN seul aller-retour QuickBooks, et l'écart
//     affiché à l'ouverture d'un compte (compareWithQb) devient quasi gratuit.
//
// Le verdict s'écrit sur `qb_txn_id` / `qb_match_*`, l'une des deux preuves
// retenues par deriveStatus() pour peindre une ligne en « comptabilisé ».
import db from '../db/database.js'
import { refreshStatuses } from './bankReconciliation.js'
import {
  buildLedgerIndex, searchAccount, persistMatches, verifyConversions, MATCH_LABELS,
} from './bankQbSearch.js'
import { pickQbProposals, parseAutoMethods } from './bankProposals/qbLink.js'
import { reconcileAndPersist } from './bankProposals/store.js'
import { onQbMutation } from '../connectors/quickbooks.js'
import { COLOR_MEANS_IN_QB } from './bankTrxSheet.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { shiftDate, daysBetween as dayDiff } from '../utils/datetime.js'

export const QB_VERIFY_AUTOMATION_ID = 'sys_bank_qb_verify'

// Fenêtre glissante du passage horaire. Jamais moins de MIN_WINDOW_DAYS :
// detectSign (bankQbSearch.js) vote sur le pool d'écritures pour orienter les
// signes — sur une fenêtre courte le vote s'inverse et on apparie à l'envers.
export const ROLLING_WINDOW_DAYS = 90
export const MIN_WINDOW_DAYS = 30

// Plancher de l'historique importé dans l'ERP. Un vrai « 2000-01-01 » fait
// répondre 500 au rapport GeneralLedger (trop large sur 12 identifiants) sans
// rien couvrir de réel avant cette date de toute façon.
export const FLOOR_DATE = '2024-01-01'

// Hors passage profond, le rapport de grand livre est plafonné : au-delà,
// QuickBooks répond 500 — déjà observé.
const MAX_LEDGER_DAYS = 90

export const QB_VERIFY_DEFAULT_CONFIG = {
  // Fenêtre du passage horaire (jours). Plancher dur : MIN_WINDOW_DAYS.
  window_days: String(ROLLING_WINDOW_DAYS),
  // Délai de grâce avant de déclarer un écart sur une transaction fraîche.
  grace_days: '4',
  // Méthodes d'appariement posées SANS demander. Les autres deviennent des
  // propositions à confirmer (services/bankProposals/). Vider = tout demander.
  auto_apply_methods: 'exact,conversion',
  // Date de départ du passage profond quotidien. Tout ce qui précède est clos :
  // ces écarts avec QuickBooks ne seront plus corrigés, les signaler chaque
  // nuit n'aide personne (Charles, 2026-09-19).
  deep_since: '2026-06-01',
}

export function qbVerifyConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(QB_VERIFY_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...QB_VERIFY_DEFAULT_CONFIG }
  for (const k of Object.keys(QB_VERIFY_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// TOUS les comptes mappés à QuickBooks — plus seulement ceux branchés à Plaid.
export function mappedAccounts() {
  return db.prepare(`
    SELECT * FROM bank_accounts
    WHERE deleted_at IS NULL AND qb_account_id IS NOT NULL AND qb_account_id != ''
    ORDER BY sort_order, name COLLATE NOCASE
  `).all()
}

// ── Index de grand livre : cache 5 min + promesse partagée ───────────────────
//
// Un rapport GeneralLedger coûte un aller-retour Intuit par identifiant de
// compte QB (12 chez nous). Deux appelants qui demandent la même fenêtre en
// même temps doivent attendre LE MÊME appel, pas en lancer deux.

const LEDGER_TTL_MS = 5 * 60 * 1000
const ledgerCache = new Map() // clé → { at, promise }

export function invalidateLedgerCache() { ledgerCache.clear() }

// Une écriture publiée depuis l'ERP change le grand livre : le cache doit
// tomber, sinon la ligne qu'on vient de comptabiliser resterait introuvable
// jusqu'à cinq minutes.
onQbMutation(() => invalidateLedgerCache())

function ledgerKey(accounts, from, to) {
  return `${from}|${to}|${accounts.map((a) => a.id).sort().join(',')}`
}

/**
 * Fenêtre CANONIQUE. Sans elle le cache ne servirait jamais : le passage
 * horaire demanderait « 2026-06-14 → 2026-09-20 » et l'écart d'un compte
 * « 2026-06-17 → 2026-09-19 », deux clés différentes pour le même rapport. On
 * arrondit donc au 1er du mois en amont, et à « aujourd'hui + 5 » en aval.
 */
export function canonicalWindow(from, to = null) {
  const todayIso = new Date().toISOString().slice(0, 10)
  let start = (from && from > FLOOR_DATE ? from : FLOOR_DATE).slice(0, 8) + '01'
  if (start < FLOOR_DATE) start = FLOOR_DATE
  const horizon = shiftDate(todayIso, 5)
  const end = to && to > horizon ? to : horizon
  return { from: start, to: end }
}

/**
 * L'index partagé par TOUT le rapprochement : les passages de vérification et
 * l'écart affiché à l'ouverture d'un compte lisent le même rapport.
 */
export async function getSharedLedgerIndex(from, to = null) {
  const w = canonicalWindow(from, to)
  return getLedgerIndex(mappedAccounts(), w.from, w.to)
}

/**
 * Index partagé du grand livre. Même signature que buildLedgerIndex, mais
 * mémorisé : c'est LE point de passage de tout ce qui lit QuickBooks pour le
 * rapprochement.
 */
export async function getLedgerIndex(accounts, from, to) {
  const key = ledgerKey(accounts, from, to)
  const hit = ledgerCache.get(key)
  if (hit && Date.now() - hit.at < LEDGER_TTL_MS) return hit.promise
  const t0 = Date.now()
  const promise = buildLedgerIndex(accounts, from, to).then((index) => {
    // Chronométré ici : la durée de construction de l'index était jusqu'ici
    // exclue du journal, d'où une moyenne de 10 ms parfaitement trompeuse.
    index.buildMs = Date.now() - t0
    return index
  }).catch((e) => {
    ledgerCache.delete(key) // un échec ne se met pas en cache
    throw e
  })
  ledgerCache.set(key, { at: Date.now(), promise })
  return promise
}

// ── Explications (reprises de l'audit du fichier, qui ne lit plus rien) ──────

const fmt = (n) => `${Number(n).toFixed(2)} $`

function explainMissingBank(txn, unmatchedQb) {
  const near = unmatchedQb
    .map((e) => ({ e, gap: dayDiff(txn.txn_date, e.date), diff: Math.abs(Math.abs(e.amount) - Math.abs(txn.amount)) }))
    .sort((a, b) => (a.diff - b.diff) || (a.gap - b.gap))[0]
  if (near && near.diff < 0.011) {
    return `Écriture QB au même montant le ${near.e.date}, à ${Math.round(near.gap)} j — trop loin pour être appariée automatiquement : même transaction avec une date erronée d'un côté, ou vraie écriture manquante`
  }
  if (near && near.diff <= Math.max(5, Math.abs(txn.amount) * 0.05)) {
    return `Écriture QB de ${fmt(near.e.amount)} le ${near.e.date}${near.e.name ? ` (${near.e.name})` : ''} — ${fmt(near.diff)} d'écart, frais ou conversion ?`
  }
  if (txn.sheet_color === 'vert') {
    return 'Marquée « rapprochée avec la banque », mais aucune écriture QuickBooks ne correspond — sur ce compte ni sur les autres, à ±30 jours, montant exact ou approché'
  }
  return 'Marquée « comptabilisée », mais aucune écriture QuickBooks ne correspond'
}

function explainMissingQb(entry, unmatchedBank) {
  const near = unmatchedBank
    .map((t) => ({ t, gap: dayDiff(t.txn_date, entry.date), diff: Math.abs(Math.abs(t.amount) - Math.abs(entry.amount)) }))
    .sort((a, b) => (a.diff - b.diff) || (a.gap - b.gap))[0]
  if (near && near.diff < 0.011) {
    return `Ligne de relevé au même montant le ${near.t.txn_date} — même transaction, date à corriger d'un côté`
  }
  return 'QuickBooks la dit passée à la banque (compensée) mais elle n\'apparaît pas au relevé — mauvais compte, ou compensée à tort dans QuickBooks'
}

// Un lien posé À LA MAIN (virement publié depuis l'ERP) ou CONFIRMÉ par un
// humain (proposition acceptée) n'est pas une trace périmée : il ne se défait
// qu'au clic « Ce n'est pas ça ».
function clearStaleLinks(unmatchedBank) {
  const KEPT = new Set(['manuel', 'proposition'])
  const stale = unmatchedBank.filter((t) => t.qb_txn_id && !KEPT.has(t.qb_match_method))
  if (!stale.length) return 0
  const clear = db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=NULL, qb_txn_id=NULL, qb_match_method=NULL, qb_match_delta=NULL,
        qb_match_account=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `)
  db.transaction(() => { for (const t of stale) clear.run(t.id) })()
  return stale.length
}

// ── Vérification d'un compte contre l'index ──────────────────────────────────

async function verifyOneAccount(account, index, { from, to, graceDays, autoMethods, clearStale }) {
  const todayIso = new Date().toISOString().slice(0, 10)
  const cutoff = shiftDate(todayIso, -graceDays)

  // Les lignes DÉJÀ rapprochées sont chargées elles aussi. Elles n'ont plus
  // rien à apprendre, mais elles CONSOMMENT leur écriture du grand livre :
  // sans elles, les 190 écritures d'un trimestre déjà rapproché ressortaient
  // toutes en « compensée dans QuickBooks, absente du relevé ». Elles sont
  // ensuite exclues du rapport d'anomalies (un humain les a validées).
  const bankTxns = db.prepare(`
    SELECT id, txn_date, COALESCE(NULLIF(details,''), description) AS description, details, reference,
           amount, status, matched_id, matched_type, sheet_color, qb_txn_id, qb_match_method, transfer_txn_id
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status != 'ignore'
      AND COALESCE(pending, 0) = 0 AND txn_date >= ? AND txn_date <= ?
    ORDER BY txn_date
  `).all(account.id, from, to)

  if (!bankTxns.length) {
    return {
      account_id: account.id, account_name: account.name, scanned: 0, matched: 0,
      linked: 0, proposed: 0, cleared: 0, anomalies: [], to_book: [], gaps: [], methods: {},
    }
  }

  const txnById = new Map(bankTxns.map((t) => [t.id, t]))
  const { matches, unmatchedBank, unmatchedQb } = searchAccount(account, bankTxns, index)
  await verifyConversions(matches, txnById)

  // Ce qui est certain se pose ; le reste devient une proposition à confirmer
  // (« elle prépare, vous confirmez » — services/bankProposals/).
  const { auto, proposals } = pickQbProposals(matches, { autoMethods, account, txnById })
  const linked = persistMatches(auto)
  let proposed = 0
  try {
    proposed = reconcileAndPersist(proposals, { accountId: account.id, kinds: ['qb_link'] }).inserted
  } catch (e) {
    console.error('bankProposals(qb_link):', e.message)
  }

  // Un lien que la recherche approfondie ne retrouve PLUS pointe vers une
  // écriture supprimée dans QuickBooks ou vers un mauvais appariement. On ne
  // l'efface QUE dans le passage complet : sur une fenêtre courte, une écriture
  // tombée hors fenêtre ferait effacer un lien parfaitement valide.
  const cleared = clearStale ? clearStaleLinks(unmatchedBank) : 0
  refreshStatuses(account.id)

  const { anomalies, toBook, gaps, uncleared } = deriveFindings(account, {
    bankTxns, matches, unmatchedBank, unmatchedQb, txnById, from, cutoff, todayIso,
  })

  const methods = {}
  for (const [, m] of matches) methods[m.method] = (methods[m.method] || 0) + 1
  return {
    account_id: account.id, account_name: account.name,
    scanned: bankTxns.length, matched: matches.size, linked, proposed, cleared,
    ledger_count: (index.byAccount.get(account.id) || []).length,
    qb_uncleared: uncleared,
    anomalies, to_book: toBook, gaps, methods,
  }
}

/**
 * Ce que l'appariement RACONTE — sans rien écrire. Séparé de la vérification
 * pour que les contrôles comptables (services/audit/) mémorisent exactement les
 * mêmes constats que ceux affichés sur la page Rapprochement, plutôt que d'en
 * réinventer une seconde version qui finirait par diverger.
 */
export function deriveFindings(account, {
  bankTxns, matches, unmatchedBank, unmatchedQb, txnById, from, cutoff, todayIso,
}) {
  const anomalies = []
  const toBook = []
  const gaps = []

  for (const [txnId, m] of matches) {
    if (!m.delta) continue // conversion vérifiée : montant × taux retombe juste
    const t = txnById.get(txnId)
    gaps.push({
      account_id: account.id, account_name: account.name, txn_id: t.id,
      date: t.txn_date, amount: t.amount, label: t.description || '(sans description)',
      delta: m.delta, rate: m.rate || null, verified: !!m.verified,
      qb_date: m.entries[0].date, qb_name: m.entries[0].name || null,
      qb_entity: m.entries[0].entity || null, qb_id: m.entries[0].qbId || null,
      method: m.method, method_label: MATCH_LABELS[m.method] || m.method,
    })
  }

  // Une ligne introuvable dont la JUMELLE (même montant, ±3 jours) est
  // appariée, elle, est presque toujours la même transaction saisie deux fois.
  const twinMatched = (t) => bankTxns.some((o) => o.id !== t.id && matches.has(o.id)
    && Math.abs(o.amount - t.amount) < 0.011 && dayDiff(o.txn_date, t.txn_date) <= 3)
  // Aller-retour du même jour : l'argent entre et ressort. Si les DEUX jambes
  // manquent, c'est un mouvement de passage, pas deux écritures oubliées.
  const washPair = (t) => unmatchedBank.find((o) => o.id !== t.id
    && Math.abs(o.amount + t.amount) < 0.011 && dayDiff(o.txn_date, t.txn_date) <= 1)

  for (const t of unmatchedBank) {
    if (t.status === 'rapproche') continue // validée par un humain : plus rien à dire
    if (t.txn_date > cutoff) continue // trop fraîche : délai normal de saisie
    const base = {
      account_id: account.id, account_name: account.name, txn_id: t.id,
      date: t.txn_date, amount: t.amount, label: t.description || '(sans description)',
      sheet_color: t.sheet_color || null,
    }
    if (COLOR_MEANS_IN_QB.has(t.sheet_color)) {
      const wash = washPair(t)
      if (twinMatched(t)) {
        anomalies.push({
          ...base,
          key: `doublon_releve|${account.id}|${t.id}`,
          kind: 'doublon_releve',
          explanation: 'Une ligne du même montant à ±3 jours est, elle, appariée à QuickBooks — cette ligne-ci est probablement le même mouvement saisi deux fois. À supprimer ou à ignorer après vérification du solde.',
        })
      } else {
        anomalies.push({
          ...base,
          key: `comptabilisee_introuvable|${account.id}|${t.id}`,
          kind: 'comptabilisee_introuvable',
          explanation: wash
            ? `Aller-retour du même jour avec ${fmt(wash.amount)} (« ${(wash.description || '').slice(0, 40)} ») : aucune des deux jambes n'est dans QuickBooks — mouvement de passage jamais comptabilisé`
            : explainMissingBank(t, unmatchedQb),
        })
      }
    } else {
      toBook.push({
        ...base,
        key: `a_comptabiliser|${account.id}|${t.id}`,
        kind: 'a_comptabiliser',
        age_days: Math.round(dayDiff(todayIso, t.txn_date)),
        explanation: t.matched_id
          ? 'Un document ERP est apparié mais rien dans QuickBooks — document pas encore poussé'
          : 'Pas encore comptabilisée et aucun document ERP apparié',
      })
    }
  }

  // Avant la première ligne de relevé du compte, il n'y a RIEN à quoi apparier :
  // 645 des 749 « écritures absentes du relevé » du premier passage profond sur
  // BNC CAD étaient antérieures au 2024-10-15, date de son plus vieux relevé.
  // Ce n'est pas un écart de rapprochement, c'est de l'historique qu'on n'a pas.
  const firstStatementDate = db.prepare(`
    SELECT MIN(txn_date) AS d FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
  `).get(account.id)?.d || from

  let uncleared = 0
  for (const e of unmatchedQb) {
    // L'index déborde volontairement la fenêtre du relevé (dates décalées) :
    // hors fenêtre, il n'y a pas de ligne chargée à apparier — pas un écart.
    if (e.date < from || e.date > cutoff) continue
    if (e.date < firstStatementDate) continue
    // Non compensée = saisie dans QB, jamais vue à la banque (chèque non
    // encaissé, paiement post-daté) : pas un écart de rapprochement.
    if (e.cleared !== 'C' && e.cleared !== 'R') { uncleared++; continue }
    anomalies.push({
      key: `qb_sans_releve|${account.id}|${e.entity || e.type}:${e.qbId}|${e.amount.toFixed(2)}`,
      kind: 'qb_sans_releve',
      account_id: account.id, account_name: account.name,
      date: e.date, amount: e.amount,
      label: `${e.type || 'Écriture QB'}${e.name ? ` — ${e.name}` : ''}`,
      qb_entity: e.entity, qb_id: e.qbId,
      explanation: explainMissingQb(e, unmatchedBank),
    })
  }

  return { anomalies, toBook, gaps, uncleared }
}

/**
 * Vérifie une liste de comptes contre QuickBooks.
 *
 * @param {object[]} accounts  comptes à vérifier (déjà mappés QB)
 * @param {string}  [opts.from]  plancher des transactions examinées
 * @param {string}  [opts.to]    plafond (défaut : aujourd'hui + 5 j)
 * @param {boolean} [opts.clearStale]  effacer les liens devenus introuvables
 *                  — RÉSERVÉ au passage complet (voir clearStaleLinks)
 */
export async function verifyAccounts(accounts, {
  from = null, to = null, clearStale = false, trigger = 'manuel',
} = {}) {
  if (!accounts.length) return { accounts: [], summary: 'aucun compte mappé à QuickBooks' }
  const cfg = qbVerifyConfig()
  const graceDays = Number(cfg.grace_days) || 4
  const autoMethods = parseAutoMethods(cfg.auto_apply_methods)
  const todayIso = new Date().toISOString().slice(0, 10)

  let start = from || shiftDate(todayIso, -Math.max(MIN_WINDOW_DAYS, Number(cfg.window_days) || ROLLING_WINDOW_DAYS))
  const end = to || shiftDate(todayIso, 5)
  // Plancher dur : detectSign a besoin d'un pool d'écritures pour voter.
  const minStart = shiftDate(end, -MIN_WINDOW_DAYS)
  if (start > minStart) start = minStart
  if (start < FLOOR_DATE) start = FLOOR_DATE

  // L'index du grand livre déborde la fenêtre des transactions (une écriture
  // peut porter une date décalée), sans dépasser le plafond hors passage complet.
  let ledgerFrom = shiftDate(start, -35)
  if (!clearStale) {
    const capped = shiftDate(end, -MAX_LEDGER_DAYS)
    if (ledgerFrom < capped) ledgerFrom = capped
  }
  if (ledgerFrom < FLOOR_DATE) ledgerFrom = FLOOR_DATE
  // Le plafond peut avoir repoussé le début du grand livre APRÈS celui des
  // transactions : on examinerait alors des lignes sans aucune écriture en face,
  // et elles ressortiraient toutes en « introuvable dans QuickBooks ». On ne
  // regarde jamais plus loin que ce que le grand livre couvre — la marge perdue
  // au bord de la fenêtre est rattrapée par le passage profond quotidien.
  if (start < ledgerFrom) start = ledgerFrom

  // Index construit sur TOUS les comptes mappés, pas seulement ceux demandés :
  // un virement interne BNC ↔ Desjardins se résout du côté de l'autre compte.
  const index = await getSharedLedgerIndex(ledgerFrom, end)

  const results = []
  for (const account of accounts) {
    const t0 = Date.now()
    try {
      const out = await verifyOneAccount(account, index, { from: start, to: end, graceDays, autoMethods, clearStale })
      logSync('bank:qb-verify', trigger === 'planifie' ? 'scheduled' : 'manual',
        { status: 'success', modified: out.linked, durationMs: Date.now() - t0 })
      results.push(out)
    } catch (e) {
      logSync('bank:qb-verify', trigger === 'planifie' ? 'scheduled' : 'manual',
        { status: 'error', error: e.message, durationMs: Date.now() - t0 })
      results.push({ account_id: account.id, account_name: account.name, error: e.message })
    }
  }

  const linked = results.reduce((s, r) => s + (r.linked || 0), 0)
  const proposed = results.reduce((s, r) => s + (r.proposed || 0), 0)
  const anomalies = results.flatMap((r) => r.anomalies || [])
  return {
    from: start, to: end, ledger_from: ledgerFrom,
    ledger_ms: index.buildMs ?? null,
    accounts: results,
    linked, proposed, cleared: results.reduce((s, r) => s + (r.cleared || 0), 0),
    anomalies, anomalies_total: anomalies.length,
    to_book: results.flatMap((r) => r.to_book || []),
    gaps: results.flatMap((r) => r.gaps || []),
    summary: `${results.length} compte(s) · ${linked} lien(s) posé(s) · ${proposed} proposition(s) · ${anomalies.length} anomalie(s)`
      + (index.buildMs != null ? ` · grand livre ${Math.round(index.buildMs / 100) / 10} s` : ''),
  }
}

/** Vérification d'UN compte, à la demande (bouton « Mettre à jour »). */
export async function verifyAccount(accountId, { from = null, to = null, deep = false, trigger = 'manuel' } = {}) {
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(accountId)
  if (!account) throw new Error('Compte introuvable')
  if (!account.qb_account_id) throw new Error('Compte non mappé à QuickBooks')
  const out = await verifyAccounts([account], {
    from: from || (deep ? qbVerifyConfig().deep_since || FLOOR_DATE : null),
    to, clearStale: deep, trigger,
  })
  const one = out.accounts[0]
  if (one?.error) throw new Error(one.error)
  return { ...one, ledger_ms: out.ledger_ms, from: out.from, to: out.to }
}

// ── Passages planifiés ───────────────────────────────────────────────────────

let running = false

/**
 * @param {boolean} [deep]  passage profond : tout l'historique depuis
 *   `deep_since`, et les liens devenus introuvables sont effacés.
 */
export async function scheduledQbVerify({ deep = false, trigger = 'planifie', force = false } = {}) {
  if (!force && !isSystemAutomationActive(QB_VERIFY_AUTOMATION_ID)) return null
  if (running) return null
  running = true
  const t0 = Date.now()
  try {
    const cfg = qbVerifyConfig()
    const out = await verifyAccounts(mappedAccounts(), {
      from: deep ? (cfg.deep_since || FLOOR_DATE) : null,
      clearStale: deep,
      trigger,
    })
    // Le journal ne porte que les premières anomalies : un passage profond sur
    // onze comptes en produit des centaines, et la ligne de journal pèserait
    // plusieurs mégaoctets pour une information qu'on lit par le haut.
    const cap = (list) => (list || []).slice(0, 40)
    logSystemRun(QB_VERIFY_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0,
      result: {
        ...out, deep,
        accounts: (out.accounts || []).map((a) => ({
          ...a, anomalies: cap(a.anomalies), to_book: cap(a.to_book), gaps: cap(a.gaps),
        })),
        anomalies: cap(out.anomalies), to_book: cap(out.to_book), gaps: cap(out.gaps),
        anomalies_total: (out.anomalies || []).length,
        summary: `${deep ? 'Passage profond' : 'Passage horaire'} — ${out.summary}`,
      },
      triggerData: { trigger, deep },
    })
    return out
  } catch (e) {
    logSystemRun(QB_VERIFY_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, error: e, triggerData: { trigger, deep },
    })
    throw e
  } finally { running = false }
}
