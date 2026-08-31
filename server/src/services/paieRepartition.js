// Écriture de répartition de la paie entre les départements (+ assurance AGA).
//
// Réplique le processus de l'onglet Salaires du fichier CTB - Suivi :
//   base à répartir = total de la paie (remises aux organismes incluses)
//                     − remboursements de dépenses − téléphone Martin − repas.
// La paie est initialement comptabilisée en entier dans le compte source
// (Salaires Opérations 62200 — pattern observé dans les JE QB historiques) ;
// l'écriture débite chaque département de sa part (%) et les ajouts standards,
// et crédite le compte source d'autant. Le compte source garde sa propre part.
//
// Idempotence : paies.repartition_je_id. Rien n'est poussé automatiquement —
// la page Paie affiche l'aperçu et publie au clic.
//
// Même mécanique pour l'assurance collective AGA (prorata en nb d'employés
// assurés par département), déclenchée à la demande depuis le Dashboard compta —
// à une différence près : il n'existe aucun compte d'assurance et le prélèvement
// n'est comptabilisé nulle part avant, donc l'écriture débite les comptes de
// salaires par département et crédite la banque (10000) pour le plein montant.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { round2 } from '../utils/money.js'

export const PAIE_REPARTITION_AUTOMATION_ID = 'sys_paie_repartition'

export const PAIE_REPARTITION_DEFAULT_CONFIG = {
  // Répartition de la paie : « acctnum:pourcentage » (total 100).
  splits: '62100:33.6, 62200:5.1, 62201:11.8, 62300:49.5',
  // Compte où la paie est comptabilisée initialement (crédité par l'écriture).
  source_acctnum: '62200',
  // Ajouts standards (déduits de la base avant répartition).
  phone_acctnum: '76000',
  phone_amount: '25',
  meals_acctnum: '75930',
  // Compte du remboursement de dépenses (23XXX). Vide = ligne omise (le
  // remboursement reste dans le compte source, à reclasser à la main).
  reimb_acctnum: '',
  // Comptabilisation de la paie (dépense QB sur le compte de banque) — voir
  // paieSalaryExpense.js. Modèle observé sur les Purchases « Salaires » de QB.
  bank_acctnum: '10000',            // Compte chèques Banque Nationale
  salary_vendor_name: 'Salaires',   // fournisseur QB de la dépense
  salary_taxcode: 'Hors champ',     // code de taxe des lignes salaires / remb.
  phone_taxcode: 'TPS/TVQ QC - 9,975', // code de taxe du téléphone Martin
  // Le 25 $ du téléphone de Martin est TAXES INCLUSES (décision utilisateur du
  // 2026-08-11, qui renverse celle du 2026-08-08) : la taxe ne doit JAMAIS être
  // retirée de la base des salaires — seuls les 25 $ le sont (21,74 + 3,26 = 25
  // à la publication, comme les écritures QB historiques). Mettre à '0' pour
  // traiter le 25 $ hors taxes (TPS/TVQ en sus, 28,74 $ retirés de la base).
  phone_tax_included: '1',
  // Taux total du code de taxe ci-dessus (TPS 5 + TVQ 9,975). Sert à l'aperçu du
  // régime hors taxes ; vérifié contre les taux réels de QuickBooks.
  phone_tax_pct: '14.975',
  // Assurance collective AGA. Il n'y a PAS de compte d'assurance : comme la paie,
  // la prime est ventilée dans les comptes de salaires par département.
  //
  // Les poids sont les MONTANTS RÉELS des dépenses QB d'avril à juillet 2026
  // (Purchases 16848 / 17287 / 17519 / 17667, 2 737,95 $ ventilés à l'identique
  // les 4 fois) et non le nb d'employés assurés arrondi du fichier
  // Prorata_Paie_2026-2027 (2,6/0,9/0,8/3,7) : cet arrondi donnait des écarts de
  // 1 à 14 $ par compte vs l'historique. Décision utilisateur du 2026-08-11 —
  // reproduire QB. Soit 32,5375 / 11,3874 / 9,5002 / 46,575 %.
  aga_splits: '62100:890.86, 62200:311.78, 62201:260.11, 62300:1275.20',
  // Compte de banque débité par la dépense AGA (d'où sort le prélèvement).
  aga_source_acctnum: '10000',
  // La dépense AGA est publiée au patron des 12 comptabilisations historiques :
  // Purchase (Cash) sur le compte de banque, fournisseur Groupe Financier AGA,
  // code de taxe Exonéré sur chaque ligne (assurances = exonéré, aucune taxe).
  aga_vendor_name: 'Groupe Financier AGA',
  aga_taxcode: 'Exonéré',
  aga_memo: 'AGA ASS. COLL. (répartition au prorata entre les départements)',
}

export function getPaieRepartitionConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(PAIE_REPARTITION_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...PAIE_REPARTITION_DEFAULT_CONFIG }
  for (const k of Object.keys(PAIE_REPARTITION_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// « 62100:33.6, 62200:5.1 » → [{acctnum, weight}]. Virgule décimale tolérée
// (« 62100:2,6 ») — on matche les paires compte:poids puis on vérifie que le
// reste du texte n'est que séparateurs. Lève si illisible.
export function parseSplits(text) {
  const src = String(text || '')
  const re = /([0-9A-Za-z.-]{1,20})\s*:\s*([0-9]+(?:[.,][0-9]+)?)/g
  const out = []
  let leftover = src
  for (const m of src.matchAll(re)) {
    out.push({ acctnum: m[1], weight: Number(m[2].replace(',', '.')) })
    leftover = leftover.replace(m[0], '')
  }
  if (!out.length) throw new Error('Aucune répartition configurée')
  const garbage = leftover.replace(/[\s,;]/g, '')
  if (garbage) throw new Error(`Répartition illisible : « ${garbage} » (attendu compte:poids)`)
  return out
}


// Montant saisi côté client (« 2 737,95 », « 2737.95 $ ») → nombre. La virgule
// décimale du clavier fr-CA doit être acceptée par le serveur aussi : le front
// n'est pas la seule porte d'entrée (routes appelées à la main / tests).
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value == null) return null
  let s = String(value).replace(/[\s\u00a0\u202f$]/g, '')
  if (!s) return null
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Répartit `amount` selon les poids, dernière part = reste (somme exacte).
export function allocateByWeights(amount, splits) {
  const totalWeight = splits.reduce((s, x) => s + x.weight, 0)
  if (!(totalWeight > 0)) throw new Error('Poids de répartition nuls')
  const out = []
  let allocated = 0
  for (let i = 0; i < splits.length; i++) {
    const share = i === splits.length - 1
      ? round2(amount - allocated)
      : round2(amount * splits[i].weight / totalWeight)
    allocated = round2(allocated + share)
    out.push({ ...splits[i], amount: share, pct: round2(100 * splits[i].weight / totalWeight) })
  }
  return out
}

// ── Aperçu ───────────────────────────────────────────────────────────────────

// Calcule l'écriture de répartition d'une paie. `overrides` = {phone, meals}
// (montants saisis dans l'aperçu ; défauts : config / 0).
export function computePaieRepartition(paieId, overrides = {}) {
  const paie = db.prepare('SELECT * FROM paies WHERE id=?').get(paieId)
  if (!paie) throw new Error('Paie introuvable')
  const cfg = getPaieRepartitionConfig()
  const warnings = []

  const total = Number(paie.total_with_charges_and_reimb) || 0
  if (!(total > 0)) warnings.push('Total de la paie manquant (colonne Airtable « Total de la paie incluant les remises… ») — synchroniser la paie.')

  // « Téléphone Martin » = le remboursement de dépense de 25 $ de Martin déjà
  // présent dans les items de la paie (récurrent, une fois par mois) — on le
  // sort des remboursements pour ne le déduire qu'une seule fois. Pas de
  // ligne téléphone si la paie ne contient pas ce remboursement.
  const reimbRows = db.prepare(`
    SELECT pi.expense_reimb AS amount,
           TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name
    FROM paie_items pi
    LEFT JOIN employees e ON e.id = pi.employee_id
    WHERE pi.paie_id = ? AND COALESCE(pi.expense_reimb, 0) > 0
  `).all(paieId).map(r => ({ ...r, amount: round2(Number(r.amount) || 0) }))
  const cfgPhone = round2(Number(cfg.phone_amount) || 0)
  const phoneIdx = cfgPhone > 0
    ? reimbRows.findIndex(r => /martin/i.test(r.employee_name || '') && Math.abs(r.amount - cfgPhone) < 0.005)
    : -1
  const phone = overrides.phone != null
    ? round2(parseAmount(overrides.phone) || 0)
    : (phoneIdx >= 0 ? reimbRows[phoneIdx].amount : 0)
  if (phone > 0 && phoneIdx >= 0) reimbRows.splice(phoneIdx, 1)
  if (phone > 0 && phoneIdx < 0) {
    warnings.push(`Téléphone de ${phone.toFixed(2)} $ sans remboursement correspondant dans les items de la paie — vérifier qu'il n'est pas déduit en double.`)
  }
  const reimb = round2(reimbRows.reduce((s, r) => s + r.amount, 0))
  const meals = overrides.meals != null ? round2(parseAmount(overrides.meals) || 0) : 0

  const base = round2(total - reimb - phone - meals)
  if (base < 0) throw new Error('Base de répartition négative — vérifier les montants')

  const splits = parseSplits(cfg.splits)
  const shares = allocateByWeights(base, splits)

  const lines = []
  for (const s of shares) {
    if (s.acctnum === cfg.source_acctnum) continue // le compte source garde sa part
    lines.push({ acctnum: s.acctnum, type: 'Debit', amount: s.amount, label: `Salaires ${s.pct} %` })
  }
  if (phone > 0) lines.push({ acctnum: cfg.phone_acctnum, type: 'Debit', amount: phone, label: 'Téléphone Martin (taxes incluses)' })
  if (meals > 0) lines.push({ acctnum: cfg.meals_acctnum, type: 'Debit', amount: meals, label: 'Repas — séjour à l\'extérieur (taxes incluses)' })
  if (reimb > 0) {
    if (cfg.reimb_acctnum) {
      lines.push({ acctnum: cfg.reimb_acctnum, type: 'Debit', amount: reimb, label: 'Remboursements de dépenses (hors-champ)' })
    } else {
      warnings.push(`Remboursements de dépenses (${reimb.toFixed(2)} $) laissés dans le compte source — configurer « Compte remb. dépenses » pour les reclasser.`)
    }
  }
  const credit = round2(lines.reduce((s, l) => s + l.amount, 0))
  lines.push({ acctnum: cfg.source_acctnum, type: 'Credit', amount: credit, label: 'Paie comptabilisée initialement ici' })

  return {
    paie: {
      id: paie.id, number: paie.number, period_end: paie.period_end,
      repartition_je_id: paie.repartition_je_id || null,
      repartition_je_url: paie.repartition_je_id ? qbEntityUrl('journal', paie.repartition_je_id) : null,
    },
    total, reimb, phone, meals, base,
    shares,
    lines,
    warnings,
    memo: `Répartition de la paie ${paie.number ? '#' + paie.number : ''} (période finissant le ${paie.period_end || '?'}) — générée par l'ERP`,
  }
}

// Répartition AGA : montant du prélèvement → parts par département. Les débits
// vont dans les comptes de salaires (pas de compte d'assurance) et le compte de
// banque est celui d'où sort l'argent — pas une ligne de crédit ici : la dépense
// QB porte le compte de banque sur la transaction elle-même (voir pushAga…).
export function computeAgaRepartition(amount, txnDate = null) {
  const cfg = getPaieRepartitionConfig()
  const parsed = parseAmount(amount)
  if (parsed == null) throw new Error('Montant AGA illisible — ex. 2 737,95')
  const n = round2(parsed)
  if (!(n > 0)) throw new Error('Montant AGA requis')
  const shares = allocateByWeights(n, parseSplits(cfg.aga_splits))
  const warnings = []
  const memo = cfg.aga_memo
  const lines = shares.map(s => ({
    acctnum: s.acctnum, type: 'Debit', amount: s.amount,
    label: `Assurance collective ${s.pct} %`,
    description: memo, taxcode: cfg.aga_taxcode,
  }))
  if (!cfg.aga_source_acctnum) {
    warnings.push('Aucun compte de banque configuré pour l\'AGA — configurer « Compte bancaire AGA » sur l\'automation avant de publier.')
  }
  return {
    amount: n, shares, lines, warnings, memo,
    bank_acctnum: cfg.aga_source_acctnum,
    vendor_name: cfg.aga_vendor_name,
    taxcode: cfg.aga_taxcode,
    txn_date: txnDate || new Date().toISOString().slice(0, 10),
  }
}

// ── Publication QB ───────────────────────────────────────────────────────────

async function buildAndPostJE({ lines, memo, txnDate }) {
  const { resolveAccountByAcctNum } = await import('./quickbooks.js')
  const { qbPost } = await import('../connectors/quickbooks.js')
  const jeLines = []
  for (const l of lines) {
    const account = await resolveAccountByAcctNum(l.acctnum)
    if (!account) throw new Error(`Compte QB introuvable pour le numéro ${l.acctnum}`)
    jeLines.push({
      DetailType: 'JournalEntryLineDetail',
      Amount: l.amount,
      Description: `${memo} — ${l.label}`,
      JournalEntryLineDetail: { PostingType: l.type, AccountRef: { value: account } },
    })
  }
  const je = { TxnDate: txnDate, PrivateNote: memo, Line: jeLines }
  const created = await qbPost('/journalentry', je)
  return created.JournalEntry?.Id || created.Id || null
}

// Publie l'écriture de répartition d'une paie. Idempotent (repartition_je_id).
export async function pushPaieRepartitionJE(paieId, overrides = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(PAIE_REPARTITION_AUTOMATION_ID)) {
      throw new Error('Automation sys_paie_repartition inactive — l\'activer avant de publier')
    }
    const preview = computePaieRepartition(paieId, overrides)
    if (preview.paie.repartition_je_id) {
      return { skipped: 'déjà publiée', qb_journal_entry_id: preview.paie.repartition_je_id, qb_journal_entry_url: preview.paie.repartition_je_url }
    }
    if (!(preview.base > 0)) throw new Error('Base de répartition nulle')
    const txnDate = preview.paie.period_end || new Date().toISOString().slice(0, 10)
    const jeId = await buildAndPostJE({ lines: preview.lines, memo: preview.memo, txnDate })

    db.prepare(`UPDATE paies SET repartition_je_id=?, repartition_pushed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(jeId, paieId)

    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0,
      triggerData: { paieId, overrides },
      result: `JE ${jeId} publiée — base ${preview.base.toFixed(2)} $ répartie sur ${preview.shares.length} département(s) (paie #${preview.paie.number ?? '?'})`,
    })
    return { ok: true, qb_journal_entry_id: jeId, qb_journal_entry_url: qbEntityUrl('journal', jeId), preview }
  } catch (e) {
    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { paieId, overrides }, error: e,
    })
    throw e
  }
}

// Publie la dépense de répartition AGA. Pas d'ancrage ERP → pas d'idempotence
// automatique ; l'utilisateur déclenche pour un prélèvement donné.
//
// Forme calquée sur les 12 comptabilisations historiques (Purchases QB 14791 →
// 17667) : dépense Cash sur le compte de banque, fournisseur Groupe Financier
// AGA, une ligne par département en Exonéré, mémo « AGA ASS. COLL. … ». Ce n'est
// PAS une écriture de journal — l'ancienne voie JE ne laissait ni fournisseur ni
// code de taxe et n'apparaissait pas dans l'historique du fournisseur.
export async function pushAgaRepartition(amount, txnDate = null) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(PAIE_REPARTITION_AUTOMATION_ID)) {
      throw new Error('Automation sys_paie_repartition inactive — l\'activer avant de publier')
    }
    const preview = computeAgaRepartition(amount, txnDate)
    if (preview.warnings.length) throw new Error(preview.warnings[0])

    const { resolveAccountByAcctNum } = await import('./quickbooks.js')
    const { qbGet, qbPost } = await import('../connectors/quickbooks.js')

    const bank = await resolveAccountByAcctNum(preview.bank_acctnum)
    if (!bank) throw new Error(`Compte de banque QB introuvable (numéro ${preview.bank_acctnum})`)

    const vres = await qbGet(`/query?query=${encodeURIComponent(`SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${preview.vendor_name.replace(/'/g, "\\'")}'`)}`)
    const vendor = (vres.QueryResponse?.Vendor || [])[0]
    if (!vendor) throw new Error(`Fournisseur QB « ${preview.vendor_name} » introuvable`)

    const tres = await qbGet(`/query?query=${encodeURIComponent('SELECT Id, Name FROM TaxCode MAXRESULTS 200')}`)
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
    const taxCode = (tres.QueryResponse?.TaxCode || []).find(t => norm(t.Name) === norm(preview.taxcode))
    if (!taxCode) throw new Error(`Code de taxe QB « ${preview.taxcode} » introuvable`)
    // La prime AGA est exonérée : le code doit être à 0 %. Sinon QB ajouterait la
    // taxe PAR-DESSUS les lignes et le total dépasserait le débit bancaire.
    const rateList = (await qbGet(`/taxcode/${taxCode.Id}`)).TaxCode?.PurchaseTaxRateList?.TaxRateDetail || []
    if (rateList.length) {
      const rres = await qbGet(`/query?query=${encodeURIComponent('SELECT Id, RateValue FROM TaxRate MAXRESULTS 200')}`)
      const rateById = new Map((rres.QueryResponse?.TaxRate || []).map(r => [String(r.Id), Number(r.RateValue) || 0]))
      const pct = rateList.reduce((s, d) => s + (rateById.get(String(d.TaxRateRef?.value)) || 0), 0)
      if (pct > 0) throw new Error(`Le code de taxe « ${preview.taxcode} » totalise ${pct} % — l'AGA doit être publiée avec un code à 0 % (Exonéré), sinon le total dépasserait le prélèvement.`)
    }

    const qbLines = []
    for (const l of preview.lines) {
      const account = await resolveAccountByAcctNum(l.acctnum)
      if (!account) throw new Error(`Compte QB introuvable pour le numéro ${l.acctnum}`)
      qbLines.push({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: l.amount,
        Description: l.description,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: account },
          BillableStatus: 'NotBillable',
          TaxCodeRef: { value: taxCode.Id },
        },
      })
    }
    const purchase = {
      PaymentType: 'Cash',
      AccountRef: { value: bank },
      EntityRef: { value: vendor.Id, type: 'Vendor' },
      GlobalTaxCalculation: 'TaxInclusive', // comme l'historique ; taxe nulle (Exonéré)
      TxnDate: preview.txn_date,
      PrivateNote: preview.memo,
      Line: qbLines,
    }
    const created = await qbPost('/purchase', purchase)
    const purchaseId = created.Purchase?.Id || created.Id || null

    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { amount, txnDate },
      result: `Dépense QB ${purchaseId} publiée — AGA ${preview.amount.toFixed(2)} $ réparti sur ${preview.lines.length} département(s), débité du compte ${preview.bank_acctnum}`,
    })
    return { ok: true, qb_purchase_id: purchaseId, qb_purchase_url: qbEntityUrl('expense', purchaseId), preview }
  } catch (e) {
    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { amount, txnDate }, error: e,
    })
    throw e
  }
}
