import { randomUUID } from 'node:crypto'
import db from '../db/database.js'
import { normalizeVendorKey } from './vendorProfiles.js'
import { logSync } from './syncLog.js'

// Détection d'anomalies sur les transactions fournisseurs (sale_receipts).
//
// Filet de sécurité contre les erreurs de comptabilisation : chaque reçu extrait est
// comparé à l'historique pour repérer :
//   - duplicate_number : même numéro de facture déjà comptabilisé (ex. facture Axxess
//     1180634591-01 uploadée manuellement PUIS re-reçue par courriel → deux Bills QB).
//     Le dédoublonnage par Message-ID ne couvre pas ce cas inter-canaux.
//   - duplicate_amount : même fournisseur, même total, dates proches, sans numéro
//     commun — doublon probable d'un document sans numéro fiable.
//   - already_in_qb / possible_duplicate_in_qb : la facture existe DÉJÀ au grand livre
//     QuickBooks (miroir achats_fournisseurs), typiquement saisie à la main dans QB ou
//     via le module Achats avant d'arriver dans l'extracteur. La comparaison reçu↔reçu
//     ne voyait pas ce cas : la facture était re-comptabilisée, donc payable deux fois.
//   - amount_outlier : total ≥ 3× la médiane des 12 derniers mois du fournisseur.
//   - currency_mismatch : devise différente de la devise dominante du fournisseur
//     (aurait attrapé le bug AWS : montants USD stockés avec currency CAD).
//   - zero_total : document à 0,00 $ (ex. facture mensuelle Google Cloud sans frais,
//     confirmation de solde nul) — rien à payer ni à publier sur QB. Non bloquant :
//     le reçu est signalé « sans objet comptable » et l'archivage est proposé.
//   - extraction_incomplete : le document n'a RIEN donné à l'extraction (ni date,
//     ni ligne, ni montant) — page d'erreur capturée par un collecteur de portail,
//     PDF illisible. À ne pas confondre avec un vrai 0,00 $ : il n'y a rien à
//     archiver, il faut re-récupérer le document.
//   - qb_entry_missing : le reçu se dit publié sous QB #X, mais l'écriture n'existe
//     plus dans QuickBooks (supprimée après coup). Le reçu paraît comptabilisé alors
//     qu'il ne l'est plus — vérifié par appel API, pas par déduction.
//
// Chaque anomalie candidate passe ensuite une vérification approfondie qui écarte
// les faux positifs connus AVANT de la remonter — le but est que tout ce qui reste
// mérite vraiment un regard humain :
//   - copie « inerte » (archivée, jamais publiée sur QB) : doublon déjà classé par
//     l'opérateur, aucun risque comptable → jamais comparée ni signalée ;
//   - numéro réutilisé avec des totaux différents chez le même fournisseur (numéro
//     de compte Bell, numéro de client…) : pas un vrai numéro de facture → ne vaut
//     un doublon qu'à quelques jours d'écart, pas d'un mois à l'autre ;
//   - périodes de service distinctes (« juillet 2026 » vs « août 2026 ») : deux
//     factures d'abonnement consécutives, pas un doublon ;
//   - ventilation de taxes différente à total égal : deux documents distincts ;
//   - lignes différentes (même nombre de lignes, montants différents) : idem ;
//   - montant récurrent chez le fournisseur (recharge automatique, forfait fixe) :
//     deux occurrences à quelques jours d'écart sont la norme — seul le jour même
//     reste suspect ;
//   - fournisseur aux montants très dispersés (marketplace type Amazon) : la
//     médiane n'y est pas une référence, pas de détection d'outlier.
//
// Les anomalies vivent dans transaction_anomalies, dédupliquées par fingerprint :
// une anomalie « dismissed » par un opérateur n'est jamais recréée, une anomalie
// qui n'est plus détectée (reçu corrigé/supprimé/archivé) passe à « resolved ».
// Les doublons OPEN de sévérité high bloquent le push QB (voir pushSaleReceiptToQB).

const DUP_AMOUNT_WINDOW_DAYS = 5
const OUTLIER_FACTOR = 3
const OUTLIER_MIN_DELTA = 100 // $ d'écart minimal pour éviter le bruit sur petits montants
const OUTLIER_MIN_SAMPLES = 4
// MAD/médiane au-delà → montants trop variables pour juger. Les fournisseurs à
// tarif fixe (abonnements) sont proches de 0 ; Amazon tourne autour de 0,5.
const OUTLIER_MAX_DISPERSION = 0.35
const CURRENCY_MIN_SAMPLES = 4
const RECURRING_MIN_OTHERS = 2 // occurrences historiques du même montant pour parler de récurrence

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

// Numéro de facture normalisé : minuscules, sans espaces ni ponctuation.
function normalizeInvoiceNumber(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Les noms extraits varient d'un canal à l'autre (« Axxess » vs « Axxess
// International Inc. ») : deux clés matchent si l'une préfixe l'autre (≥ 4 chars).
function vendorKeysMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(short)
}

function daysBetween(d1, d2) {
  const t1 = Date.parse(d1), t2 = Date.parse(d2)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null
  return Math.abs(t1 - t2) / 86_400_000
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function fetchReceipt(id) {
  return db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id) || null
}

// Colonnes présentes selon l'âge du schéma (les tests créent des tables minimales).
let _receiptColumns = null
function receiptColumns() {
  if (!_receiptColumns) {
    const cols = new Set(db.prepare(`PRAGMA table_info(sale_receipts)`).all().map(c => c.name))
    _receiptColumns = ['archived_at', 'tps', 'tvq', 'service_period', 'items'].filter(c => cols.has(c))
  }
  return _receiptColumns
}

// Reçus candidats à la comparaison : non supprimés, extraits, autres que le reçu courant.
function fetchPeers(receiptId) {
  const extra = receiptColumns().map(c => `, ${c}`).join('')
  return db.prepare(`
    SELECT id, company, receipt_number, receipt_date, total, currency, quickbooks_id, source, created_at${extra}
    FROM sale_receipts
    WHERE deleted_at IS NULL AND status='done' AND id != ?
  `).all(receiptId)
}

// Copie « inerte » : archivée sans jamais avoir été publiée sur QB. L'opérateur a
// déjà classé ce doublon — il ne sera pas poussé, il n'a pas été poussé, aucun
// risque comptable. La signaler encore ne produirait que du bruit à rejeter.
function isInert(r) {
  return Boolean(r.archived_at) && !r.quickbooks_id
}

// Écritures du grand livre QB (miroir importFromQB) comparables à ce reçu : tout
// achat porteur d'un quickbooks_id, à ±400 jours de la date du document. On exclut
// l'écriture issue de la publication de CE reçu (même quickbooks_id), sinon un reçu
// publié se signalerait lui-même comme doublon au scan suivant.
function fetchQbLedgerPeers(rec) {
  // Reçu archivé = document déjà traité et classé par l'opérateur (typiquement
  // « je l'avais déjà comptabilisé à la main »). Le signaler après coup n'apporte
  // rien et noierait le dashboard sous l'historique.
  if (rec.archived_at) return []
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='achats_fournisseurs'").get()
  if (!hasTable) return []
  const anchor = rec.receipt_date || (rec.created_at || '').slice(0, 10)
  if (!anchor) return []
  return db.prepare(`
    SELECT id, type, vendor, vendor_invoice_number, reference, date_achat, total_cad,
           amount_paid_cad, currency, status, quickbooks_id
    FROM achats_fournisseurs
    WHERE quickbooks_id IS NOT NULL
      AND (? IS NULL OR quickbooks_id != ?)
      AND date_achat BETWEEN date(?, '-400 days') AND date(?, '+400 days')
  `).all(rec.quickbooks_id || null, rec.quickbooks_id || null, anchor, anchor)
}

// Numéro de pièce d'un achat : DocNumber côté Bill (vendor_invoice_number) ou
// côté Purchase (reference).
function achatDocNumber(a) {
  return normalizeInvoiceNumber(a.vendor_invoice_number || a.reference)
}

// Fingerprint de doublon symétrique : la même paire (a,b) produit la même clé quel
// que soit le reçu scanné en premier — une seule anomalie par paire.
function pairFingerprint(kind, idA, idB) {
  const [x, y] = [idA, idB].sort()
  return `${kind}:${x}:${y}`
}

// ── Vérification approfondie des paires candidates ───────────────────────────

function normalizeServicePeriod(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Périodes de service distinctes = deux factures d'abonnement consécutives
// (« juillet 2026 » vs « août 2026 »), pas un doublon.
function distinctServicePeriods(a, b) {
  const pa = normalizeServicePeriod(a?.service_period)
  const pb = normalizeServicePeriod(b?.service_period)
  return Boolean(pa && pb && pa !== pb)
}

// Ventilation de taxes incompatible à total égal = deux documents différents dont
// les totaux coïncident, pas le même document reçu deux fois.
function taxBreakdownsDiffer(a, b) {
  for (const f of ['tps', 'tvq']) {
    const x = a?.[f], y = b?.[f]
    if (x == null || y == null) continue
    const rx = round2(x), ry = round2(y)
    if ((rx !== 0 || ry !== 0) && Math.abs(rx - ry) > 0.02) return true
  }
  return false
}

function taxBreakdownsMatch(a, b) {
  return ['tps', 'tvq'].some(f => a?.[f] != null && b?.[f] != null && round2(a[f]) > 0 && Math.abs(round2(a[f]) - round2(b[f])) <= 0.02)
}

function parseItems(json) {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

// Multiset trié des montants de lignes ; null si trop peu de lignes pour juger.
function lineAmountsKey(itemsJson) {
  const amounts = parseItems(itemsJson)
    .map(i => round2(i?.total ?? i?.amount))
    .filter(n => n !== 0)
  if (amounts.length < 2) return null
  return amounts.sort((a, b) => a - b).map(n => n.toFixed(2)).join('|')
}

// Même nombre de lignes mais montants différents = deux documents distincts. Un
// nombre de lignes différent reste NON concluant : deux extractions du même
// document peuvent fusionner ou éclater des lignes selon le canal.
function lineItemsDiffer(a, b) {
  const ka = lineAmountsKey(a?.items), kb = lineAmountsKey(b?.items)
  if (!ka || !kb || ka === kb) return false
  return ka.split('|').length === kb.split('|').length
}

// Numéro réutilisé avec des totaux différents chez le même fournisseur (numéro de
// compte Bell, numéro de client…) : pas un numéro de facture distinctif. Deux
// pièces qui le partagent ne sont un doublon probable qu'à quelques jours d'écart.
function numberIsReused(num, rec, peers, vendorKey) {
  if (!num) return false
  const totals = new Set([Math.abs(round2(rec.total)).toFixed(2)])
  for (const p of peers) {
    if (normalizeInvoiceNumber(p.receipt_number) !== num) continue
    if (!vendorKeysMatch(vendorKey, normalizeVendorKey(p.company))) continue
    totals.add(Math.abs(round2(p.total)).toFixed(2))
  }
  return totals.size >= 2
}

// Montant récurrent chez ce fournisseur : au moins RECURRING_MIN_OTHERS autres
// documents au même montant, à d'autres dates que la paire examinée (recharge
// automatique Twilio, forfait fixe…). Deux occurrences à quelques jours d'écart
// sont alors la norme — seul le jour même reste suspect.
function amountIsRecurring(total, rec, otherId, otherDate, peers, vendorKey) {
  let others = 0
  for (const h of peers) {
    if (h.id === otherId) continue
    if (!vendorKeysMatch(vendorKey, normalizeVendorKey(h.company))) continue
    if (Math.abs(Math.abs(round2(h.total)) - Math.abs(total)) >= 0.01) continue
    const gapRec = daysBetween(h.receipt_date, rec.receipt_date)
    const gapOther = daysBetween(h.receipt_date, otherDate)
    if (gapRec != null && gapRec > DUP_AMOUNT_WINDOW_DAYS && gapOther != null && gapOther > DUP_AMOUNT_WINDOW_DAYS) others++
  }
  return others >= RECURRING_MIN_OTHERS
}

// Extraction sans résultat : aucune donnée exploitable n'a été tirée du document
// (ni date, ni ligne, ni numéro, ni montant). C'est une capture ratée — typiquement
// la page « We're unable to load your order details » enregistrée par un collecteur
// de portail — pas une facture à 0,00 $. La distinction compte : un vrai 0 $ peut
// être archivé, une capture ratée doit être re-téléchargée.
function extractionLooksEmpty(rec) {
  return round2(rec.total) === 0 && !rec.receipt_date && parseItems(rec.items).length === 0
    && !normalizeInvoiceNumber(rec.receipt_number)
}

// Raisons d'écarter une paire « même fournisseur + même montant » sans numéro
// commun. Retourne null si aucun signal ne disculpe la paire.
function amountPairExoneration(rec, peer, gap, peers, vendorKey) {
  if (distinctServicePeriods(rec, peer)) return 'périodes de service distinctes'
  if (taxBreakdownsDiffer(rec, peer)) return 'ventilations de taxes différentes'
  if (lineItemsDiffer(rec, peer)) return 'lignes différentes'
  if (gap >= 1 && amountIsRecurring(round2(rec.total), rec, peer.id, peer.receipt_date, peers, vendorKey)) return 'montant récurrent chez ce fournisseur'
  return null
}

// Signaux qui corroborent un doublon par montant — affichés dans le message pour
// que l'opérateur voie POURQUOI la paire a survécu à la vérification.
function amountPairEvidence(rec, peer, gap) {
  const signals = []
  if (gap === 0) signals.push('même date')
  if (taxBreakdownsMatch(rec, peer)) signals.push('même ventilation de taxes')
  const ka = lineAmountsKey(rec.items), kb = lineAmountsKey(peer.items)
  if (ka && kb && ka === kb) signals.push('mêmes lignes')
  if (!distinctServicePeriods(rec, peer) && normalizeServicePeriod(rec.service_period) && normalizeServicePeriod(peer.service_period)) signals.push('même période de service')
  return signals
}

export function detectReceiptAnomalies(rec) {
  if (!rec || rec.deleted_at || rec.status !== 'done') return []
  // Copie inerte (archivée, jamais publiée) : déjà classée par l'opérateur, rien à signaler.
  if (isInert(rec)) return []
  const anomalies = []
  const total = round2(rec.total)
  const vendorKey = normalizeVendorKey(rec.company)
  const num = normalizeInvoiceNumber(rec.receipt_number)
  const allPeers = fetchPeers(rec.id)
  // Les copies inertes ne valent pas une anomalie mais restent de l'historique
  // utile (numéros réutilisés, montants récurrents).
  const peers = allPeers.filter(p => !isInert(p))
  const ledger = fetchQbLedgerPeers(rec)

  // Historique combiné reçus + grand livre pour les heuristiques de contexte, en
  // excluant les achats miroirs de reçus déjà comptés (même quickbooks_id).
  const peerQbIds = new Set(allPeers.map(p => p.quickbooks_id).filter(Boolean))
  const historyDocs = [
    ...allPeers,
    ...ledger.filter(a => !peerQbIds.has(a.quickbooks_id)).map(a => ({
      id: `achat:${a.id}`, company: a.vendor, receipt_date: a.date_achat,
      total: a.total_cad, receipt_number: a.vendor_invoice_number || a.reference,
    })),
  ]
  const numReused = numberIsReused(num, rec, historyDocs, vendorKey)

  // Document à 0,00 $ : facture réelle mais sans objet comptable (frais nuls, solde
  // déjà débité). `total != null` distingue le vrai zéro extrait d'une extraction
  // incomplète. Non bloquant — le but est de proposer l'archivage, pas d'alerter.
  if (rec.total != null && total === 0 && !rec.quickbooks_id) {
    const context = [rec.company, normalizeServicePeriod(rec.service_period) ? rec.service_period : null].filter(Boolean).join(', ')
    if (extractionLooksEmpty(rec)) {
      anomalies.push({
        kind: 'extraction_incomplete',
        severity: 'medium',
        fingerprint: `extraction_incomplete:${rec.id}`,
        message: `Extraction sans résultat${context ? ` (${context})` : ''} : ni date, ni ligne, ni montant — document illisible ou capture ratée du collecteur. Ce n'est PAS un document à 0,00 $ : relancer l'extraction ou récupérer le vrai document.`,
        details: { source: rec.source || null, original_name: rec.original_name || null },
      })
    } else {
      anomalies.push({
        kind: 'zero_total',
        severity: 'low',
        fingerprint: `zero_total:${rec.id}`,
        message: `Document à 0,00 ${rec.currency || 'CAD'}${context ? ` (${context})` : ''} — rien à payer ni à comptabiliser. Il peut être archivé.`,
        details: {},
      })
    }
  }

  for (const p of peers) {
    const pNum = normalizeInvoiceNumber(p.receipt_number)
    const sameVendor = vendorKeysMatch(vendorKey, normalizeVendorKey(p.company))
    const sameTotal = total !== 0 && Math.abs(round2(p.total) - total) < 0.01
    const gap = daysBetween(rec.receipt_date, p.receipt_date)

    // Même numéro de facture + même total. Numéro long (≥ 6 chars) = assez distinctif
    // seul ; numéro court (« 14 » chez BTTH) exige aussi le même fournisseur ET des
    // dates proches (la numérotation de certains fournisseurs recommence chaque année).
    // Numéro réutilisé (numéro de compte, pas de facture) : seul un écart de quelques
    // jours reste suspect — d'un mois à l'autre c'est la facturation courante.
    const shortNumOk = sameVendor && (gap ?? Infinity) <= 60
    const numOk = numReused
      ? sameVendor && (gap ?? Infinity) <= DUP_AMOUNT_WINDOW_DAYS
      : (num.length >= 6 || shortNumOk)
    if (num && pNum === num && sameTotal && numOk) {
      anomalies.push({
        kind: 'duplicate_number',
        severity: 'high',
        fingerprint: pairFingerprint('duplicate_number', rec.id, p.id),
        message: `Doublon probable : facture nº ${rec.receipt_number} (${total.toFixed(2)} ${rec.currency || 'CAD'}) déjà présente — « ${p.company || '?'} » du ${p.receipt_date || '?'}${p.quickbooks_id ? `, déjà publiée sur QB (#${p.quickbooks_id})` : ''}.`,
        details: { other_receipt_id: p.id, other_qb_id: p.quickbooks_id, other_source: p.source },
      })
      continue
    }

    // Même fournisseur + même total à quelques jours près, sans numéro commun fiable.
    // Ignoré si les DEUX documents portent des numéros distincts (récurrences
    // légitimes type ménage aux deux semaines), puis soumis à la vérification
    // approfondie (périodes de service, taxes, lignes, montant récurrent).
    if (sameVendor && sameTotal && !(num && pNum && pNum !== num)) {
      if (gap != null && gap <= DUP_AMOUNT_WINDOW_DAYS) {
        const exoneration = amountPairExoneration(rec, p, gap, historyDocs, vendorKey)
        if (!exoneration) {
          const evidence = amountPairEvidence(rec, p, gap)
          anomalies.push({
            kind: 'duplicate_amount',
            severity: 'medium',
            fingerprint: pairFingerprint('duplicate_amount', rec.id, p.id),
            message: `Doublon possible : ${rec.company || '?'} — deux documents de ${total.toFixed(2)} ${rec.currency || 'CAD'} à ${Math.round(gap)} jour(s) d'écart (${rec.receipt_date || '?'} et ${p.receipt_date || '?'})${evidence.length ? `, ${evidence.join(', ')}` : ''}.`,
            details: { other_receipt_id: p.id, other_qb_id: p.quickbooks_id, gap_days: gap, evidence },
          })
        }
      }
    }
  }

  // ── Comparaison au grand livre QuickBooks ──────────────────────────────────
  // Couvre le cas que la comparaison reçu↔reçu rate : la facture a été saisie
  // directement dans QB (ou via le module Achats) avant d'arriver dans l'extracteur.
  // La re-comptabiliser crée une seconde dette fournisseur → risque de double paiement.
  for (const a of ledger) {
    // L'achat est le miroir QB d'un AUTRE reçu du système : la paire reçu↔reçu a
    // déjà été jugée plus haut (signalée, exonérée, ou rejetée par l'opérateur).
    // La resignaler ici raconte deux fois le même fait sous deux fingerprints — et
    // un « rejeté » posé sur l'une laissait l'autre ouverte.
    if (peerQbIds.has(a.quickbooks_id)) continue
    const aNum = achatDocNumber(a)
    const sameVendor = vendorKeysMatch(vendorKey, normalizeVendorKey(a.vendor))
    const sameTotal = total !== 0 && Math.abs(round2(a.total_cad) - Math.abs(total)) < 0.01
    const gap = daysBetween(rec.receipt_date, a.date_achat)
    const paid = round2(a.amount_paid_cad) > 0
    const paidNote = paid
      ? ` ⚠️ L'écriture existante est déjà payée (${round2(a.amount_paid_cad).toFixed(2)} $)${rec.quickbooks_id ? '.' : " — la comptabiliser une seconde fois exposerait à un double paiement."}`
      : ''
    const label = `${a.vendor || '?'} · ${round2(a.total_cad).toFixed(2)} ${a.currency || 'CAD'} du ${a.date_achat || '?'} (QB ${a.type === 'bill' ? 'facture' : 'dépense'} #${a.quickbooks_id})`

    // Même numéro de pièce + même total : quasi certain. Numéro court → exiger
    // aussi le même fournisseur et des dates proches (cf. duplicate_number).
    // Numéro réutilisé → seul un écart de quelques jours reste suspect.
    const numOk = numReused
      ? sameVendor && (gap ?? Infinity) <= DUP_AMOUNT_WINDOW_DAYS
      : (num.length >= 6 || (sameVendor && (gap ?? Infinity) <= 60))
    if (num && aNum === num && sameTotal && numOk) {
      anomalies.push({
        kind: 'already_in_qb',
        severity: 'high',
        fingerprint: `already_in_qb:${rec.id}:${a.id}`,
        // Reçu déjà publié : l'avertissement n'est plus préventif mais constate une
        // double écriture dans QB — c'est l'écriture en trop qu'il faut aller annuler.
        message: rec.quickbooks_id
          ? `Double écriture dans QuickBooks : la facture nº ${rec.receipt_number} (${total.toFixed(2)} ${rec.currency || 'CAD'}), publiée ici sous #${rec.quickbooks_id}, existe AUSSI sous — ${label}.${paidNote}`
          : `Déjà comptabilisée dans QuickBooks : la facture nº ${rec.receipt_number} (${total.toFixed(2)} ${rec.currency || 'CAD'}) correspond à une écriture existante — ${label}. Ne pas la publier une seconde fois.${paidNote}`,
        details: { achat_id: a.id, qb_id: a.quickbooks_id, qb_type: a.type, amount_paid: round2(a.amount_paid_cad), match: 'number' },
      })
      continue
    }

    // Pas de numéro commun : même fournisseur, même total, dates proches. Écarté
    // si les deux pièces portent des numéros distincts (récurrences légitimes) ou
    // si le montant est récurrent chez ce fournisseur (hors même jour).
    if (sameVendor && sameTotal && !(num && aNum && aNum !== num) && gap != null && gap <= DUP_AMOUNT_WINDOW_DAYS) {
      if (gap >= 1 && amountIsRecurring(total, rec, `achat:${a.id}`, a.date_achat, historyDocs, vendorKey)) continue
      anomalies.push({
        kind: 'possible_duplicate_in_qb',
        severity: 'medium',
        fingerprint: `possible_duplicate_in_qb:${rec.id}:${a.id}`,
        message: `Peut-être déjà comptabilisée dans QuickBooks : une écriture du même fournisseur et du même montant existe à ${Math.round(gap)} jour(s) d'écart — ${label}.${paidNote}`,
        details: { achat_id: a.id, qb_id: a.quickbooks_id, qb_type: a.type, amount_paid: round2(a.amount_paid_cad), gap_days: gap, match: 'amount' },
      })
    }
  }

  // Historique 12 mois du fournisseur (hors reçu courant) pour outlier + devise.
  // Les copies archivées comptent : c'est de l'historique, pas des candidates.
  if (vendorKey) {
    const history = allPeers.filter(p =>
      vendorKeysMatch(vendorKey, normalizeVendorKey(p.company)) &&
      p.receipt_date && rec.receipt_date &&
      daysBetween(rec.receipt_date, p.receipt_date) <= 365,
    )

    const totals = history.map(p => Math.abs(round2(p.total))).filter(t => t > 0)
    if (totals.length >= OUTLIER_MIN_SAMPLES) {
      const med = median(totals)
      // Fournisseur aux montants très dispersés (marketplace type Amazon : 4 $ à
      // 200 $ selon la commande) : la médiane n'y est pas une référence, un gros
      // achat légitime n'est pas une anomalie. MAD/médiane borne la dispersion.
      const mad = median(totals.map(t => Math.abs(t - med)))
      const stable = med > 0 && mad / med <= OUTLIER_MAX_DISPERSION
      // Reçu déjà publié sur QuickBooks : le montant est passé sous les yeux d'un
      // opérateur au moment du push. L'outlier sert à attraper une extraction
      // fautive (575 au lieu de 5,75) AVANT comptabilisation ; après, il ne dit
      // plus rien qu'un humain n'ait tranché (cautionnement douanier annuel de
      // 575 $ chez un fournisseur facturé 40 $/mois).
      if (!rec.quickbooks_id && stable && Math.abs(total) >= med * OUTLIER_FACTOR && Math.abs(total) - med >= OUTLIER_MIN_DELTA) {
        anomalies.push({
          kind: 'amount_outlier',
          severity: 'medium',
          fingerprint: `amount_outlier:${rec.id}`,
          message: `Montant inhabituel : ${total.toFixed(2)} ${rec.currency || 'CAD'} pour ${rec.company}, soit ${(total / med).toFixed(1)}× la médiane des 12 derniers mois (${med.toFixed(2)} $, ${totals.length} documents).`,
          details: { median: med, samples: totals.length },
        })
      }
    }

    const currencies = history.map(p => (p.currency || 'CAD').toUpperCase())
    const recCurrency = (rec.currency || 'CAD').toUpperCase()
    if (currencies.length >= CURRENCY_MIN_SAMPLES) {
      const counts = {}
      for (const c of currencies) counts[c] = (counts[c] || 0) + 1
      const [dominant, share] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
      if (share / currencies.length >= 0.9 && dominant !== recCurrency) {
        anomalies.push({
          kind: 'currency_mismatch',
          severity: 'medium',
          fingerprint: `currency_mismatch:${rec.id}`,
          message: `Devise inhabituelle : ${recCurrency} pour ${rec.company}, alors que ${share}/${currencies.length} documents des 12 derniers mois sont en ${dominant}. Vérifier que les montants ne sont pas dans la mauvaise devise.`,
          details: { dominant, share, samples: currencies.length },
        })
      }
    }
  }

  return anomalies
}

// Recalcule et persiste les anomalies d'un reçu : crée les nouvelles (sauf fingerprint
// déjà dismissed), résout celles qui ne sont plus détectées.
export function syncReceiptAnomalies(receiptId) {
  const rec = fetchReceipt(receiptId)
  const detected = rec ? detectReceiptAnomalies(rec) : []
  const detectedFps = new Set(detected.map(a => a.fingerprint))

  const upsert = db.prepare(`
    INSERT INTO transaction_anomalies (id, entity_type, entity_id, kind, severity, message, details, fingerprint)
    VALUES (?, 'sale_receipt', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      message=excluded.message,
      details=excluded.details,
      severity=excluded.severity,
      entity_id=excluded.entity_id,
      status=CASE WHEN transaction_anomalies.status='dismissed' THEN 'dismissed' ELSE 'open' END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
  const tx = db.transaction(() => {
    for (const a of detected) {
      upsert.run(randomUUID(), receiptId, a.kind, a.severity, a.message, JSON.stringify(a.details || {}), a.fingerprint)
    }
    // Anomalies ouvertes de ce reçu qui ne sont plus détectées → resolved. Les
    // fingerprints de paire mentionnent les deux ids : on résout aussi celles où ce
    // reçu est le pair (entity_id = l'autre) si la paire n'est plus détectée.
    const open = db.prepare(`
      SELECT id, fingerprint FROM transaction_anomalies
      WHERE status='open' AND entity_type='sale_receipt'
        AND (entity_id = ? OR fingerprint LIKE '%' || ? || '%')
    `).all(receiptId, receiptId)
    for (const row of open) {
      if (!detectedFps.has(row.fingerprint)) {
        // Une anomalie de paire portée par l'autre reçu reste valide si l'autre reçu
        // la re-détecte encore ; on ne résout ici que si elle implique ce reçu.
        db.prepare(`UPDATE transaction_anomalies SET status='resolved', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(row.id)
      }
    }
  })
  tx()
  return detected
}

// Obsolescence d'un reçu : document sans objet comptable, dérivée des anomalies
// OUVERTES à haute confiance (un dismiss fait donc disparaître le statut). Deux causes :
//   - duplicate_published : copie d'un document déjà PUBLIÉ sur QuickBooks
//     (duplicate_number reçu↔reçu dont le pair est publié, ou already_in_qb au grand
//     livre) — qb_id/qb_entity pointent la transaction QB EXISTANTE, pas ce reçu ;
//   - zero_total : total 0,00 $, rien à publier.
// Les états publiés (quickbooks_id/type) sont relus en DB au moment de l'appel : les
// details persistés dans l'anomalie peuvent dater d'avant la publication du pair.
// Retourne null, ou { reason, anomaly_id, message, qb_id, qb_entity, other_receipt_id, achat_id }.
export function receiptObsolescence(receiptId) {
  const rows = db.prepare(`
    SELECT * FROM transaction_anomalies
    WHERE status='open' AND entity_type='sale_receipt'
      AND (entity_id = ? OR fingerprint LIKE '%' || ? || '%')
      AND kind IN ('zero_total','duplicate_number','already_in_qb')
  `).all(receiptId, receiptId)
  if (!rows.length) return null
  // Un reçu lui-même publié n'est jamais obsolète : en cas de double écriture, c'est
  // la copie NON publiée (ou l'écriture en trop dans QB) qu'il faut traiter.
  const mine = db.prepare('SELECT quickbooks_id FROM sale_receipts WHERE id=?').get(receiptId)
  if (!mine || mine.quickbooks_id) return null

  let zero = null
  for (const row of rows) {
    let details = {}
    try { details = JSON.parse(row.details || '{}') } catch {}

    if (row.kind === 'zero_total' && row.entity_id === receiptId) {
      zero = { reason: 'zero_total', anomaly_id: row.id, message: row.message, qb_id: null, qb_entity: null, other_receipt_id: null, achat_id: null }
      continue
    }

    // Écriture existante au grand livre QB (miroir achats_fournisseurs).
    if (row.kind === 'already_in_qb' && row.entity_id === receiptId && details.achat_id) {
      const achat = db.prepare('SELECT quickbooks_id, type FROM achats_fournisseurs WHERE id=?').get(details.achat_id)
      if (!achat?.quickbooks_id) continue
      return {
        reason: 'duplicate_published', anomaly_id: row.id, message: row.message,
        qb_id: achat.quickbooks_id, qb_entity: achat.type === 'bill' ? 'bill' : 'expense',
        other_receipt_id: null, achat_id: details.achat_id,
      }
    }

    // Paire reçu↔reçu : l'anomalie peut être portée par l'un ou l'autre (entity_id =
    // dernier scanné) — l'autre reçu est celui de la paire qui n'est pas receiptId.
    if (row.kind === 'duplicate_number') {
      const otherId = row.entity_id === receiptId ? details.other_receipt_id : row.entity_id
      if (!otherId || otherId === receiptId) continue
      const other = db.prepare('SELECT quickbooks_id, quickbooks_type FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(otherId)
      if (!other?.quickbooks_id) continue
      return {
        reason: 'duplicate_published', anomaly_id: row.id, message: row.message,
        qb_id: other.quickbooks_id,
        qb_entity: other.quickbooks_type === 'bill' ? 'bill' : other.quickbooks_type === 'cc_credit' ? 'creditcardcredit' : 'expense',
        other_receipt_id: otherId, achat_id: null,
      }
    }
  }
  return zero
}

// Anomalies ouvertes bloquantes pour la publication QB d'un reçu. Les anomalies de
// paire portent les deux ids dans leur fingerprint : elles bloquent les DEUX reçus,
// pas seulement celui qui a été scanné en dernier (entity_id).
export function openBlockingAnomalies(receiptId) {
  return db.prepare(`
    SELECT * FROM transaction_anomalies
    WHERE status='open' AND entity_type='sale_receipt'
      AND (entity_id = ? OR fingerprint LIKE '%' || ? || '%')
      AND kind IN ('duplicate_number','duplicate_amount','already_in_qb','possible_duplicate_in_qb')
  `).all(receiptId, receiptId)
}

// ── Vérification des liens QuickBooks ────────────────────────────────────────
// Un reçu porte `quickbooks_id` dès qu'il a été publié — et le garde même si
// l'écriture est supprimée dans QuickBooks ensuite (nettoyage d'un doublon, push
// refait après correction : QB attribue alors un NOUVEL Id). Le reçu continue
// d'afficher « publié #17887 » alors que plus rien ne porte ce numéro : la dépense
// paraît comptabilisée sans l'être. Aucune déduction ici — on interroge QuickBooks.
//
// Ne sont interrogés que les reçus dont l'Id n'apparaît PAS dans le miroir
// achats_fournisseurs (une écriture miroir prouve l'existence côté QB) : quelques
// appels par scan au lieu de cent.

const QB_ENTITY_BY_TYPE = {
  bill: 'bill',
  purchase: 'purchase',
  vendor_credit: 'vendorcredit',
  cc_credit: 'creditcardcredit',
  journal_entry: 'journalentry',
  deposit: 'deposit',
}

function upsertAnomaly(receiptId, a) {
  db.prepare(`
    INSERT INTO transaction_anomalies (id, entity_type, entity_id, kind, severity, message, details, fingerprint)
    VALUES (?, 'sale_receipt', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      message=excluded.message, details=excluded.details, severity=excluded.severity,
      entity_id=excluded.entity_id,
      status=CASE WHEN transaction_anomalies.status='dismissed' THEN 'dismissed' ELSE 'open' END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(randomUUID(), receiptId, a.kind, a.severity, a.message, JSON.stringify(a.details || {}), a.fingerprint)
}

function resolveAnomaly(fingerprint) {
  db.prepare(`
    UPDATE transaction_anomalies SET status='resolved', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE fingerprint=? AND status='open'
  `).run(fingerprint)
}

// Écriture équivalente au grand livre (même montant, ±15 j) : la dépense a été
// recomptabilisée ailleurs, le lien du reçu est simplement périmé. Sans elle, la
// dépense n'est plus dans les livres du tout — c'est un trou, pas un lien mort.
function equivalentLedgerEntry(rec) {
  const anchor = rec.receipt_date || (rec.created_at || '').slice(0, 10)
  if (!anchor) return null
  const rows = db.prepare(`
    SELECT id, type, vendor, date_achat, total_cad, quickbooks_id
    FROM achats_fournisseurs
    WHERE quickbooks_id IS NOT NULL AND quickbooks_id != ?
      AND date_achat BETWEEN date(?, '-15 days') AND date(?, '+15 days')
  `).all(rec.quickbooks_id, anchor, anchor)
  const total = Math.abs(round2(rec.total))
  const vendorKey = normalizeVendorKey(rec.company)
  const sameAmount = rows.filter(r => Math.abs(round2(r.total_cad) - total) < 0.01)
  // Le nom du fournisseur ne suffit pas à disqualifier : QuickBooks porte souvent
  // un autre libellé que le document (« Entretien ménager » = BTTH, Akamai facturé
  // par Linode, « Axxess International - USD » vs « Axxess International Inc »).
  // Même montant + même quinzaine reste un remplacement crédible — le nom QB est
  // affiché dans le message pour que l'opérateur tranche.
  const exact = sameAmount.find(r => vendorKeysMatch(vendorKey, normalizeVendorKey(r.vendor)))
  if (exact) return { ...exact, sameVendor: true }
  return sameAmount.length ? { ...sameAmount[0], sameVendor: false } : null
}

export async function verifyPublishedQbLinks({ fetchEntity, sinceDays = 400 } = {}) {
  const rows = db.prepare(`
    SELECT id, company, receipt_number, receipt_date, created_at, total, currency,
           quickbooks_id, quickbooks_type
    FROM sale_receipts
    WHERE deleted_at IS NULL AND quickbooks_id IS NOT NULL
      AND COALESCE(receipt_date, substr(created_at,1,10)) >= strftime('%Y-%m-%d','now',?)
      AND quickbooks_id NOT IN (SELECT quickbooks_id FROM achats_fournisseurs WHERE quickbooks_id IS NOT NULL)
  `).all(`-${sinceDays} days`)

  let get = fetchEntity
  if (!get) {
    const { qbGet } = await import('../connectors/quickbooks.js')
    get = async (entity, id) => Object.values(await qbGet(`/${entity}/${id}`))[0]
  }

  let missing = 0
  for (const rec of rows) {
    const entity = QB_ENTITY_BY_TYPE[rec.quickbooks_type] || null
    if (!entity) continue // type inconnu : ne rien conclure plutôt que d'alerter à tort
    const fingerprint = `qb_entry_missing:${rec.id}:${rec.quickbooks_id}`
    let exists = null
    try {
      exists = Boolean(await get(entity, rec.quickbooks_id))
    } catch (e) {
      // Seule une réponse « objet introuvable » vaut une conclusion : une panne
      // réseau ou un token expiré ne doit JAMAIS créer une anomalie.
      if (!/introuvable|not found|610/i.test(e.message || '')) continue
      exists = false
    }
    if (exists) { resolveAnomaly(fingerprint); continue }
    missing++
    const twin = equivalentLedgerEntry(rec)
    const label = `${rec.company || '?'} · ${round2(rec.total).toFixed(2)} ${rec.currency || 'CAD'} du ${rec.receipt_date || '?'}`
    upsertAnomaly(rec.id, {
      kind: 'qb_entry_missing',
      severity: twin ? 'medium' : 'high',
      fingerprint,
      message: twin
        ? `Lien QuickBooks périmé : ${label} se dit publiée sous #${rec.quickbooks_id}, mais cette écriture n'existe plus dans QuickBooks. Le même montant est comptabilisé sous #${twin.quickbooks_id} du ${twin.date_achat}${twin.sameVendor ? '' : ` (au nom de « ${twin.vendor} »)`} — à confirmer, puis rattacher le reçu.`
        : `Écriture disparue de QuickBooks : ${label} se dit publiée sous #${rec.quickbooks_id}, mais cette écriture n'existe plus et aucune écriture du même montant n'a été trouvée à ±15 jours. La dépense n'est plus comptabilisée — la republier.`,
      details: {
        qb_id: rec.quickbooks_id, qb_type: rec.quickbooks_type,
        replacement_qb_id: twin?.quickbooks_id || null, achat_id: twin?.id || null,
        replacement_same_vendor: twin ? twin.sameVendor : null,
      },
    })
  }
  return { checked: rows.length, missing }
}

// Passe asynchrone du scan : appels QuickBooks, donc séparée de runAnomalyScan
// (synchrone, appelé depuis les hooks d'extraction). Best-effort.
export async function runQbLinkVerification(trigger = 'scheduled') {
  const t0 = Date.now()
  try {
    const out = await verifyPublishedQbLinks()
    logSync('qb_link_verification', trigger, { status: 'success', modified: out.missing, durationMs: Date.now() - t0 })
    return out
  } catch (e) {
    logSync('qb_link_verification', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    return { checked: 0, missing: 0, error: e.message }
  }
}

// Scan périodique : reçus extraits des 120 derniers jours. Les anomalies de type
// « paire » couvrent tout l'historique (fetchPeers ne filtre pas par date).
export function runAnomalyScan(trigger = 'scheduled') {
  const t0 = Date.now()
  try {
    const ids = db.prepare(`
      SELECT id FROM sale_receipts
      WHERE deleted_at IS NULL AND status='done'
        AND COALESCE(receipt_date, substr(created_at,1,10)) >= strftime('%Y-%m-%d','now','-120 days')
    `).all().map(r => r.id)
    let found = 0
    for (const id of ids) found += syncReceiptAnomalies(id).length
    logSync('transaction_anomalies', trigger, { status: 'success', modified: found, durationMs: Date.now() - t0 })
    return { scanned: ids.length, anomalies: found }
  } catch (e) {
    logSync('transaction_anomalies', trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    throw e
  }
}
