// Ce que la fiche d'un fournisseur apprend toute seule.
//
// La fiche (`vendor_profiles`) est censée être LE dossier de référence d'un
// fournisseur : sa devise, son compte de dépense, son code de taxe, sa manière
// d'être payé, et le visage qu'il prend sur le relevé bancaire. Jusqu'ici elle
// n'apprenait qu'à un seul instant — la publication d'un achat dans QuickBooks
// (`learnFromPush`) — et un seul canal ne suffit pas : 190 fiches, 64 avec un
// compte de dépense, 3 avec un motif de relevé.
//
// Ce module ajoute les canaux manquants, tous avec la même discipline :
//   - on ne remplit QUE ce qui est vide (une saisie humaine ne s'écrase jamais) ;
//   - on n'invente rien : sans preuve dans les données, le champ reste vide ;
//   - en cas d'ambiguïté (deux fournisseurs revendiquent le même libellé), on
//     ne tranche pas — on laisse la fiche telle quelle.
import db from '../db/database.js'
import { findVendorProfile, serializeProfile } from './vendorProfiles.js'
import { stripBankNoise, resolveVendorFromBankLabel, invalidateBankLabelCache } from './scrapers/vendorFromBankLabel.js'
import { patternStrength } from './bankRules/verify.js'
import { ruleLabelOf } from './bankRules/match.js'

// Écrit uniquement les colonnes encore vides. Rend la liste de ce qui a été
// rempli (vide = rien à faire).
function fillEmpty(profileId, values) {
  const row = db.prepare('SELECT * FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(profileId)
  if (!row) return []
  const sets = []
  const params = []
  const filled = []
  for (const [col, val] of Object.entries(values)) {
    if (val == null || val === '') continue
    const current = row[col]
    if (current != null && current !== '' && current !== '[]') continue
    sets.push(`${col}=?`)
    params.push(val)
    filled.push(col)
  }
  if (!sets.length) return []
  sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  params.push(profileId)
  db.prepare(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id=?`).run(...params)
  return filled
}

// La valeur la plus fréquente d'une colonne, à condition qu'elle domine
// vraiment (2 cas sur 3 au moins). Sinon rien : un fournisseur qui facture
// moitié CAD moitié USD n'a pas de « devise habituelle ».
function dominant(values, share = 2 / 3) {
  const counts = new Map()
  for (const v of values) {
    if (v == null || v === '') continue
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  if (!counts.size) return null
  const total = [...counts.values()].reduce((s, n) => s + n, 0)
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return n / total >= share ? best : null
}

// ── Canal 1 : l'historique déjà comptabilisé ────────────────────────────────
// Tout ce qui a été publié porte la réponse : le compte de dépense utilisé, le
// code de taxe, la devise, le délai de paiement, le moyen de paiement. On relit
// cet historique et on complète les fiches vides. Idempotent : rejouable sans
// effet une fois les fiches remplies.
export function backfillProfilesFromHistory() {
  const receipts = db.prepare(`
    SELECT company, currency, payment_terms_days, transaction_type, vendor_id
    FROM sale_receipts
    WHERE deleted_at IS NULL AND quickbooks_id IS NOT NULL
      AND company IS NOT NULL AND TRIM(company) != ''
    ORDER BY COALESCE(receipt_date, created_at) DESC
  `).all()
  const bills = db.prepare(`
    SELECT vendor, currency, payment_method, expense_account_id, tax_code_id, lines, date_achat, due_date
    FROM achats_fournisseurs
    WHERE quickbooks_id IS NOT NULL AND vendor IS NOT NULL AND TRIM(vendor) != ''
    ORDER BY date_achat DESC
  `).all()

  const byVendor = new Map()
  const bucket = (name) => {
    const p = findVendorProfile(name)
    if (!p) return null
    if (!byVendor.has(p.id)) byVendor.set(p.id, { profile: p, currency: [], terms: [], method: [], account: [], tax: [], type: [], vendorCad: [], vendorUsd: [] })
    return byVendor.get(p.id)
  }
  for (const r of receipts) {
    const b = bucket(r.company)
    if (!b) continue
    b.currency.push(String(r.currency || 'CAD').toUpperCase())
    if (Number.isInteger(r.payment_terms_days) && r.payment_terms_days > 0) b.terms.push(r.payment_terms_days)
    b.type.push(r.transaction_type)
    // Le vendor QB réellement utilisé, par devise — y compris pour un document saisi
    // dans QB puis rattaché, que learnFromPush ne voit jamais passer.
    ;(String(r.currency || 'CAD').toUpperCase() === 'USD' ? b.vendorUsd : b.vendorCad).push(r.vendor_id)
  }
  for (const a of bills) {
    const b = bucket(a.vendor)
    if (!b) continue
    b.currency.push(String(a.currency || 'CAD').toUpperCase())
    b.method.push(a.payment_method)
    // Le compte et le code de taxe d'une facture vivent presque toujours sur sa
    // PREMIÈRE LIGNE, pas dans l'entête (2 factures sur 8 734 portent l'entête).
    // Sans ce repli, l'historique le plus volumineux de l'ERP n'apprenait rien.
    let line = null
    try { line = JSON.parse(a.lines || '[]')[0] || null } catch { line = null }
    b.account.push(a.expense_account_id || line?.account_id || null)
    b.tax.push(a.tax_code_id || line?.tax_code_id || null)
    // Le délai de paiement d'une facture : l'écart entre sa date et son échéance.
    if (a.date_achat && a.due_date) {
      const days = Math.round((Date.parse(`${String(a.due_date).slice(0, 10)}T12:00:00Z`)
        - Date.parse(`${String(a.date_achat).slice(0, 10)}T12:00:00Z`)) / 86400000)
      if (days > 0 && days <= 180) b.terms.push(days)
    }
  }

  let touched = 0
  const columns = new Map()
  for (const b of byVendor.values()) {
    const usd = dominant(b.currency) === 'USD'
    const filled = fillEmpty(b.profile.id, {
      usual_currency: dominant(b.currency),
      payment_terms_days: dominant(b.terms),
      payment_method: dominant(b.method),
      default_transaction_type: dominant(b.type),
      default_expense_account_id: dominant(b.account),
      [usd ? 'default_tax_code_id_usd' : 'default_tax_code_id_cad']: dominant(b.tax),
      qb_vendor_id_cad: dominant(b.vendorCad),
      qb_vendor_id_usd: dominant(b.vendorUsd),
    })
    if (filled.length) touched++
    for (const c of filled) columns.set(c, (columns.get(c) || 0) + 1)
  }
  return { vendors_seen: byVendor.size, profiles_filled: touched, columns: Object.fromEntries(columns) }
}

// ── Canal 2 : le relevé bancaire ────────────────────────────────────────────
// Chaque fois qu'une ligne de relevé est appariée à un document, on connaît
// gratuitement le visage bancaire du fournisseur (« DKC*DIGI-KEY CORP » pour
// Digi-Key). C'est le motif qui manquait pour le reconnaître la fois suivante,
// AVANT d'avoir le document — et donc pour lui proposer une règle et préparer
// sa dépense tout seul.
//
// Prudence : un motif faux ferait attribuer la dépense d'un tiers. D'où quatre
// garde-fous — vu au moins deux fois, un seul fournisseur revendiqué, motif
// assez distinctif, et pas déjà reconnu sans lui.
export function learnBankLabelsFromMatches({ minSeen = 2, limit = 6000 } = {}) {
  const rows = db.prepare(`
    SELECT t.details, t.description, t.matched_type, t.matched_id
    FROM bank_transactions t
    WHERE t.deleted_at IS NULL AND t.matched_id IS NOT NULL
      AND t.matched_type IN ('achat', 'receipt')
    ORDER BY t.txn_date DESC LIMIT ?
  `).all(limit)

  const vendorOf = (row) => {
    if (row.matched_type === 'achat') {
      const a = db.prepare('SELECT vendor FROM achats_fournisseurs WHERE id=?').get(row.matched_id)
      return (a?.vendor || '').trim() || null
    }
    const r = db.prepare('SELECT company FROM sale_receipts WHERE id=?').get(row.matched_id)
    return (r?.company || '').trim() || null
  }

  // Un noyau de libellé → les fournisseurs qui le revendiquent.
  const cores = new Map()
  for (const row of rows) {
    const core = stripBankNoise(ruleLabelOf(row))
    if (!core) continue
    const vendor = vendorOf(row)
    if (!vendor) continue
    const profile = findVendorProfile(vendor)
    if (!profile) continue
    if (!cores.has(core)) cores.set(core, new Map())
    const claims = cores.get(core)
    claims.set(profile.id, (claims.get(profile.id) || 0) + 1)
  }

  const learned = []
  const conflicts = []
  const corrected = []
  for (const [core, claims] of cores) {
    // Deux fournisseurs sous le même libellé : on ne devine pas.
    if (claims.size > 1) { conflicts.push(core); continue }
    const [profileId, seen] = [...claims.entries()][0]
    if (seen < minSeen) continue
    const strength = patternStrength(core)
    if (!strength.ok) continue
    // Le motif retenu ne garde que les mots : un numéro de téléphone ou un code
    // de succursale collé au nom rendrait le motif inutilisable dès que la
    // banque change un chiffre.
    const pattern = strength.tokens.filter(t => /[a-z]/i.test(t)).join(' ')
    if (!patternStrength(pattern).ok) continue
    // Déjà reconnu sans motif (le nom ou un alias suffit) : rien à ajouter.
    const already = resolveVendorFromBankLabel(pattern)
    if (already?.profile?.id === profileId) continue
    if (already && already.profile.id !== profileId) {
      // Le libellé est actuellement attribué à QUELQU'UN D'AUTRE. C'est le cas
      // le plus dangereux — et le plus utile à réparer : « DKC*DIGI-KEY CORP »
      // tombait sur « Li-Cor » par la seule syllabe « cor », alors que 25
      // documents comptabilisés disent Digi-Key. On ne corrige que si la
      // reconnaissance actuelle est une simple ressemblance de NOM (jamais un
      // motif déclaré à la main) et que la preuve comptable est franche.
      if (already.via !== 'nom' || seen < 3) { conflicts.push(pattern); continue }
      corrected.push({ from: already.profile.name, pattern })
    }

    const row = db.prepare('SELECT id, name, bank_label_patterns FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(profileId)
    if (!row) continue
    const profile = serializeProfile(row)
    if (profile.bank_label_patterns.some(p => stripBankNoise(p) === pattern)) continue
    db.prepare(`UPDATE vendor_profiles SET bank_label_patterns=?,
                updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(JSON.stringify([...profile.bank_label_patterns, pattern]), profileId)
    learned.push({ vendor: profile.name, pattern, seen })
    invalidateBankLabelCache()
  }
  return { candidates: cores.size, learned, corrected, conflicts: conflicts.length }
}

// ── Canal 3 : la lecture d'un document ──────────────────────────────────────
// L'extracteur lit une devise, un délai de paiement et une nature fiscale bien
// avant qu'on publie quoi que ce soit. Si la facture n'est jamais publiée, tout
// cela était perdu. On le pose sur la fiche dès la lecture — champs vides
// seulement.
export function learnFromExtractedReceipt({ company, currency, termsDays, transactionType }) {
  const profile = findVendorProfile(company)
  if (!profile) return null
  const filled = fillEmpty(profile.id, {
    usual_currency: currency ? String(currency).toUpperCase() : null,
    payment_terms_days: Number.isInteger(termsDays) && termsDays > 0 ? termsDays : null,
    default_transaction_type: transactionType || null,
  })
  return filled.length ? { profile_id: profile.id, filled } : null
}
