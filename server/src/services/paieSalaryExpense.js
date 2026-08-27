// Comptabilisation de la paie — réplique la section « SALAIRES » de l'onglet
// Paie & Ass. coll. du fichier CTB - Suivi, et le modèle exact des transactions
// QB historiques (Purchase « Salaires », ex. Id 17670 du 2026-07-07) :
//
//   Dépense (Cash) sur le compte BNC, fournisseur « Salaires », taxes incluses.
//   Mémo : « Paie – <début> au <fin> ».
//   Lignes : salaires par département (prorata de la config sys_paie_repartition,
//   code de taxe Hors champ, description = la période), téléphone Martin
//   (76000, 25 $ taxes incluses, code TPS/TVQ — c'est le remboursement de
//   dépense de Martin dans la paie, reclassé, jamais compté en double) et les
//   autres remboursements de dépenses (compte « <Employé> (rembourser à) »,
//   Hors champ).
//
//   base à répartir = montant passé au compte de banque
//                     − remboursements de dépenses (items de la paie)
//                     − téléphone Martin (25 $ taxes incluses — la taxe ne sort
//                       JAMAIS de la base, décision utilisateur du 2026-08-11).
//
// Idempotence : paies.salary_purchase_id. Rien n'est poussé automatiquement —
// le dashboard comptabilité affiche l'aperçu et publie au clic.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import {
  PAIE_REPARTITION_AUTOMATION_ID, getPaieRepartitionConfig, parseSplits, allocateByWeights,
} from './paieRepartition.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'

const round2 = n => Math.round(n * 100) / 100

// Remboursements de dépenses de la paie, par employé (source : paie_items).
export function paieReimbursements(paieId) {
  return db.prepare(`
    SELECT pi.employee_id, pi.expense_reimb AS amount,
           TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name
    FROM paie_items pi
    LEFT JOIN employees e ON e.id = pi.employee_id
    WHERE pi.paie_id = ? AND COALESCE(pi.expense_reimb, 0) > 0
    ORDER BY e.last_name, e.first_name
  `).all(paieId).map(r => ({ ...r, amount: round2(Number(r.amount) || 0) }))
}

// Estimation du débit bancaire d'une paie à partir de ses items (section RH).
// Σ paie_items.total_pay (salaires + remb., SANS remises aux organismes) × un
// ratio de charges employeur observé sur les dernières paies comptabilisées
// (total confirmé ÷ Σ items). Le ratio varie (~3–9 % selon plafonds RRQ/AE/
// CNESST) — c'est un pré-remplissage à confirmer au relevé BNC, pas un montant
// comptable exact.
export function estimatePaieBankAmount(paieId) {
  const itemsTotal = round2(Number(db.prepare(
    'SELECT SUM(total_pay) t FROM paie_items WHERE paie_id=?'
  ).get(paieId)?.t) || 0)
  if (!(itemsTotal > 0)) return null

  const samples = db.prepare(`
    SELECT p.period_end, p.total_with_charges_and_reimb AS total,
           (SELECT SUM(pi.total_pay) FROM paie_items pi WHERE pi.paie_id = p.id) AS items
    FROM paies p
    WHERE p.id != ? AND p.total_with_charges_and_reimb > 0 AND p.period_end IS NOT NULL
    ORDER BY p.period_end DESC LIMIT 3
  `).all(paieId).filter(s => Number(s.items) > 0)

  const ratio = samples.length
    ? samples.reduce((s, x) => s + x.total / x.items, 0) / samples.length
    : 1
  return {
    items_total: itemsTotal,
    charge_ratio_pct: round2((ratio - 1) * 100),
    ratio_sample_periods: samples.map(s => s.period_end),
    estimate: round2(itemsTotal * ratio),
  }
}

// Déductions du montant passé au compte de banque, avant répartition des
// salaires : remboursements de dépenses par employé (compte « <Employé>
// (rembourser à) ») + téléphone Martin. Indépendant du montant bancaire, donc
// consultable dès qu'une paie est choisie (encadré du dashboard compta).
//
// « Téléphone Martin » = le remboursement de dépense de 25 $ de Martin déjà
// présent dans les items de la paie (récurrent, une fois par mois). C'est la
// MÊME dépense : on la sort des remboursements pour ne la compter qu'une fois,
// sur le compte téléphone (76000, code TPS/TVQ). Pas de ligne téléphone si la
// paie ne contient pas ce remboursement.
export function paieDeductions(paieId, input = {}) {
  const cfg = getPaieRepartitionConfig()
  const warnings = []

  const reimbs = paieReimbursements(paieId)
  const paie = db.prepare('SELECT period_end FROM paies WHERE id=?').get(paieId)
  const cfgPhone = round2(Number(cfg.phone_amount) || 0)
  const phoneIdx = cfgPhone > 0
    ? reimbs.findIndex(r => /martin/i.test(r.employee_name || '') && Math.abs(r.amount - cfgPhone) < 0.005)
    : -1
  const phone = input.phone != null && input.phone !== ''
    ? round2(Number(input.phone) || 0)
    : (phoneIdx >= 0 ? reimbs[phoneIdx].amount : 0)
  let phoneEmployee = null
  if (phone > 0 && phoneIdx >= 0) phoneEmployee = reimbs.splice(phoneIdx, 1)[0].employee_name
  if (phone > 0 && phoneIdx < 0) {
    warnings.push(`Ligne téléphone de ${phone.toFixed(2)} $ sans remboursement correspondant dans les items de la paie — vérifier qu'elle n'est pas comptée en double.`)
  }
  const reimbTotal = round2(reimbs.reduce((s, r) => s + r.amount, 0))

  // Le 25 $ est taxes INCLUSES (config phone_tax_included='1', décision
  // utilisateur du 2026-08-11) : la taxe ne sort jamais de la base des salaires
  // — seuls les 25 $ en sortent (base = débit BNC − remb. − 25). La TPS/TVQ est
  // extraite du 25 $ à la publication (21,74 + 3,26), donc le total de la
  // dépense QB reste égal au débit bancaire.
  const taxIncluded = String(cfg.phone_tax_included) === '1'
  const taxPct = Number(String(cfg.phone_tax_pct).replace(',', '.')) || 0
  const phoneTax = phone > 0 && !taxIncluded ? round2(phone * taxPct / 100) : 0
  const phoneGross = round2(phone + phoneTax)

  // Remboursement mensuel du téléphone : signaler son absence plutôt que de
  // l'inventer — la paie est aux 2 semaines, donc on ne s'alarme que si aucune
  // paie du même mois ne le porte.
  if (phone <= 0 && Number(cfg.phone_amount) > 0 && paie?.period_end) {
    const month = paie.period_end.slice(0, 7)
    const siblings = db.prepare(`
      SELECT COUNT(*) n FROM paie_items pi
      JOIN paies p ON p.id = pi.paie_id
      LEFT JOIN employees e ON e.id = pi.employee_id
      WHERE substr(p.period_end, 1, 7) = ? AND p.id != ?
        AND ABS(COALESCE(pi.expense_reimb, 0) - ?) < 0.005
        AND (e.first_name LIKE '%Martin%' OR e.last_name LIKE '%Martin%')
    `).get(month, paieId, round2(Number(cfg.phone_amount)))?.n || 0
    if (!siblings) {
      warnings.push(`Aucun remboursement de ${round2(Number(cfg.phone_amount)).toFixed(2)} $ pour le téléphone de Martin ce mois-ci — c'est normalement mensuel : vérifier la colonne « Remb. dépenses » des items de paie dans Airtable, puis rafraîchir.`)
    }
  }

  return {
    // Remboursements restants (téléphone exclu), destinés aux comptes employés.
    reimbs: reimbs.map(r => ({
      ...r,
      account_label: `${r.employee_name} (rembourser à)`,
      taxcode: cfg.salary_taxcode,
    })),
    reimb_total: reimbTotal,
    phone,
    phone_tax: phoneTax,
    phone_gross: phoneGross,
    phone_tax_included: taxIncluded,
    phone_employee: phoneEmployee,
    phone_acctnum: cfg.phone_acctnum,
    phone_taxcode: cfg.phone_taxcode,
    reimb_taxcode: cfg.salary_taxcode,
    total: round2(reimbTotal + phoneGross),
    // Fraîcheur de la donnée source (items de paie Airtable) — c'est elle qui
    // porte la colonne « Remb. dépenses ».
    synced_at: db.prepare("SELECT last_synced_at v FROM airtable_module_config WHERE module='paie_items'").get()?.v || null,
    warnings,
  }
}

// Calcule la dépense de comptabilisation d'une paie.
// input = { bank_amount, phone?, txn_date? } (phone : défaut config, tx incl.).
export function computePaieSalaryExpense(paieId, input = {}) {
  const paie = db.prepare('SELECT * FROM paies WHERE id=?').get(paieId)
  if (!paie) throw new Error('Paie introuvable')
  const cfg = getPaieRepartitionConfig()

  const bank = round2(Number(input.bank_amount) || 0)
  if (!(bank > 0)) throw new Error('Montant passé au compte de banque requis')

  const deductions = paieDeductions(paieId, input)
  const {
    reimbs, phone, phone_employee: phoneEmployee, reimb_total: reimbTotal,
    phone_tax: phoneTax, phone_gross: phoneGross, phone_tax_included: phoneTaxIncluded,
  } = deductions
  const warnings = [...deductions.warnings]

  const base = round2(bank - reimbTotal - phoneGross)
  if (!(base > 0)) throw new Error('Base de répartition nulle ou négative — vérifier les montants')

  const expected = Number(paie.total_with_charges_and_reimb) || 0
  if (expected > 0 && Math.abs(expected - bank) > 0.01) {
    warnings.push(`Le montant saisi (${bank.toFixed(2)} $) diffère du total de la paie synchronisé (${expected.toFixed(2)} $) — à la publication, le montant saisi remplacera le total sur la paie et dans Airtable.`)
  }

  // Paie aux 2 semaines : si le début de période n'est pas renseigné (cas
  // courant côté Airtable), le déduire (fin − 13 jours).
  let periodStart = paie.period_start
  if (!periodStart && paie.period_end) {
    const d = new Date(`${paie.period_end}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 13)
    periodStart = d.toISOString().slice(0, 10)
    warnings.push(`Début de période déduit (${periodStart}, paie aux 2 semaines) — renseigner « Début de période » sur la paie si différent.`)
  }
  const period = periodStart && paie.period_end
    ? `${periodStart} au ${paie.period_end}`
    : `paie #${paie.number ?? '?'}`
  if (!paie.period_end) warnings.push('Fin de période manquante sur la paie — mémo QB incomplet.')

  const shares = allocateByWeights(base, parseSplits(cfg.splits))
  const lines = shares.map(s => ({
    kind: 'salary', acctnum: s.acctnum, amount: s.amount, pct: s.pct,
    taxcode: cfg.salary_taxcode, description: period,
  }))
  if (phone > 0) {
    lines.push({
      kind: 'phone', acctnum: cfg.phone_acctnum, amount: phone,
      // Taxes incluses par défaut : la TPS/TVQ est extraite du montant de la
      // ligne à la publication (tax_included=false → elle s'ajouterait).
      tax_included: phoneTaxIncluded, tax: phoneTax,
      taxcode: cfg.phone_taxcode, employee_name: phoneEmployee,
      description: phoneEmployee
        ? `Téléphone Martin (remboursement de dépense de ${phoneEmployee})`
        : 'Téléphone Martin',
    })
  }
  for (const r of reimbs) {
    lines.push({
      kind: 'reimb', employee_name: r.employee_name, amount: r.amount,
      taxcode: cfg.salary_taxcode, description: 'Remboursement des dépenses',
    })
  }

  return {
    paie: {
      id: paie.id, number: paie.number,
      period_start: paie.period_start, period_end: paie.period_end,
      salary_purchase_id: paie.salary_purchase_id || null,
      salary_purchase_url: paie.salary_purchase_id ? qbEntityUrl('expense', paie.salary_purchase_id) : null,
    },
    bank_amount: bank, phone, reimbs, reimb_total: reimbTotal, base,
    deductions,
    // = bank_amount. Régime taxes incluses (défaut) : phoneTax = 0 et la TPS/TVQ
    // est extraite du 25 $ à la publication. Régime hors taxes : elle s'ajoute
    // dans TxnTaxDetail, et son montant a déjà été retiré de la base.
    total: round2(lines.reduce((s, l) => s + l.amount, 0) + phoneTax),
    lines, warnings,
    memo: `Paie – ${period}`,
    txn_date: input.txn_date || new Date().toISOString().slice(0, 10),
  }
}

// ── Résolution des références QB ─────────────────────────────────────────────

const strip = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase()

async function resolveRefs(preview) {
  const { resolveAccountByAcctNum } = await import('./quickbooks.js')
  const { qbGet } = await import('../connectors/quickbooks.js')
  const cfg = getPaieRepartitionConfig()

  const bank = await resolveAccountByAcctNum(cfg.bank_acctnum)
  if (!bank) throw new Error(`Compte de banque QB introuvable (numéro ${cfg.bank_acctnum})`)

  const vres = await qbGet(`/query?query=${encodeURIComponent(`SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${cfg.salary_vendor_name.replace(/'/g, "\\'")}'`)}`)
  const vendor = (vres.QueryResponse?.Vendor || [])[0]
  if (!vendor) throw new Error(`Fournisseur QB « ${cfg.salary_vendor_name} » introuvable`)

  const tres = await qbGet(`/query?query=${encodeURIComponent('SELECT Id, Name FROM TaxCode MAXRESULTS 200')}`)
  const taxCodes = tres.QueryResponse?.TaxCode || []
  const findTaxCode = name => {
    const t = taxCodes.find(t => strip(t.Name) === strip(name))
    if (!t) throw new Error(`Code de taxe QB « ${name} » introuvable`)
    return t
  }
  const taxByName = name => findTaxCode(name).Id

  // Taux d'achat d'un code de taxe ({rateRef, pct}[]) — pour ventiler
  // explicitement la taxe (QB ignore TaxInclusive sur les lignes de Purchase et
  // recalcule la taxe PAR-DESSUS le montant).
  //
  // Gotcha : la requête « SELECT … FROM TaxCode » ne renvoie PAS
  // PurchaseTaxRateList — seul le GET direct /taxcode/:id le contient. Sans ça,
  // la liste des taux est vide et la taxe disparaît silencieusement.
  const rres = await qbGet(`/query?query=${encodeURIComponent('SELECT Id, RateValue FROM TaxRate MAXRESULTS 200')}`)
  const rateById = new Map((rres.QueryResponse?.TaxRate || []).map(r => [String(r.Id), Number(r.RateValue) || 0]))
  const ratesByCode = new Map()
  for (const name of new Set(preview.lines.map(l => l.taxcode).filter(Boolean))) {
    const detail = (await qbGet(`/taxcode/${findTaxCode(name).Id}`)).TaxCode
    ratesByCode.set(strip(name), (detail?.PurchaseTaxRateList?.TaxRateDetail || [])
      .map(d => ({ rateRef: String(d.TaxRateRef?.value), pct: rateById.get(String(d.TaxRateRef?.value)) || 0 }))
      .filter(r => r.pct > 0))
  }
  const purchaseRatesFor = name => ratesByCode.get(strip(name)) || []

  // Comptes « <Employé> (rembourser à) » appariés par nom normalisé.
  const ares = await qbGet(`/query?query=${encodeURIComponent("SELECT Id, Name, FullyQualifiedName FROM Account WHERE Name LIKE '%(rembourser à)%' MAXRESULTS 200")}`)
  const reimbAccounts = ares.QueryResponse?.Account || []
  const reimbAccountFor = (employeeName) => {
    const key = strip(employeeName)
    return reimbAccounts.find(a => strip(a.Name.replace(/\(rembourser à\)/i, '')) === key) || null
  }

  const accounts = {}
  for (const l of preview.lines) {
    if (l.acctnum && !accounts[l.acctnum]) {
      const a = await resolveAccountByAcctNum(l.acctnum)
      if (!a) throw new Error(`Compte QB introuvable pour le numéro ${l.acctnum}`)
      accounts[l.acctnum] = a
    }
  }
  return { bank, vendor, taxByName, purchaseRatesFor, reimbAccountFor, accounts }
}

// ── Publication QB ───────────────────────────────────────────────────────────

// Construit le corps de la dépense QB à partir de l'aperçu.
//
// QB ignore GlobalTaxCalculation:TaxInclusive sur les Purchase et recalcule la
// taxe PAR-DESSUS le montant de ligne. On ventile donc nous-mêmes : montant net
// sur la ligne + TxnTaxDetail explicite (gotcha : Purchase QB exige des TaxLine
// pour un montant exact). Deux régimes selon la ligne :
//   • taxes incluses (défaut) — le HT est extrait du montant ;
//   • taxes en sus (`tax_included: false`, cas du 25 $ du téléphone) — le
//     montant EST le net, la taxe s'ajoute ; le brut a déjà été retiré de la
//     base des salaires, donc le total reste égal au débit bancaire.
function buildPurchaseBody(preview, refs, cfg) {
  const taxTotals = new Map() // rateRef → {pct, net, tax}
  const qbLines = preview.lines.map(l => {
    let accountRef
    if (l.kind === 'reimb') {
      const a = refs.reimbAccountFor(l.employee_name)
      if (!a) throw new Error(`Compte « ${l.employee_name} (rembourser à) » introuvable dans QuickBooks`)
      accountRef = { value: a.Id, name: a.FullyQualifiedName }
    } else {
      accountRef = { value: refs.accounts[l.acctnum] }
    }
    let amount = l.amount
    const rates = refs.purchaseRatesFor(l.taxcode)
    if (rates.length) {
      const totalPct = rates.reduce((s, r) => s + r.pct, 0)
      let net, taxes
      if (l.tax_included === false) {
        // L'aperçu a calculé la taxe avec phone_tax_pct : elle doit correspondre
        // aux taux réels du code de taxe QB, sinon le total dériverait du débit.
        const cfgPct = Number(String(cfg.phone_tax_pct).replace(',', '.')) || 0
        if (Math.abs(totalPct - cfgPct) > 0.01) {
          throw new Error(`Le code de taxe QB « ${l.taxcode} » totalise ${totalPct} % alors que la configuration annonce ${cfgPct} % — corriger phone_tax_pct sur l'automation sys_paie_repartition.`)
        }
        net = l.amount
        taxes = rates.map(r => ({ ...r, tax: round2(net * r.pct / 100) }))
      } else {
        net = round2(l.amount / (1 + totalPct / 100))
        taxes = rates.map(r => ({ ...r, tax: round2(net * r.pct / 100) }))
        net = round2(l.amount - taxes.reduce((s, t) => s + t.tax, 0)) // dérive d'arrondi → HT
      }
      for (const t of taxes) {
        const cur = taxTotals.get(t.rateRef) || { pct: t.pct, net: 0, tax: 0 }
        cur.net = round2(cur.net + net); cur.tax = round2(cur.tax + t.tax)
        taxTotals.set(t.rateRef, cur)
      }
      amount = net
    }
    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: amount,
      Description: l.description,
      AccountBasedExpenseLineDetail: {
        AccountRef: accountRef,
        BillableStatus: 'NotBillable',
        TaxCodeRef: { value: refs.taxByName(l.taxcode) },
      },
    }
  })
  const taxLines = [...taxTotals.entries()].map(([rateRef, t]) => ({
    Amount: t.tax, DetailType: 'TaxLineDetail',
    TaxLineDetail: { TaxRateRef: { value: rateRef }, PercentBased: true, TaxPercent: t.pct, NetAmountTaxable: t.net },
  }))
  const totalTax = round2(taxLines.reduce((s, t) => s + t.Amount, 0))
  const body = {
    PaymentType: 'Cash',
    AccountRef: { value: refs.bank },
    EntityRef: { value: refs.vendor.Id, type: 'Vendor' },
    GlobalTaxCalculation: 'TaxExcluded',
    TxnDate: preview.txn_date,
    PrivateNote: preview.memo,
    Line: qbLines,
    ...(taxLines.length ? { TxnTaxDetail: { TotalTax: totalTax, TaxLine: taxLines } } : {}),
  }
  const total = round2(qbLines.reduce((s, l) => s + l.Amount, 0) + totalTax)
  return { body, total }
}

// Publie la dépense de comptabilisation de la paie. Idempotent (salary_purchase_id).
export async function pushPaieSalaryExpense(paieId, input = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(PAIE_REPARTITION_AUTOMATION_ID)) {
      throw new Error('Automation sys_paie_repartition inactive — l\'activer avant de publier')
    }
    const preview = computePaieSalaryExpense(paieId, input)
    if (preview.paie.salary_purchase_id) {
      return { skipped: 'déjà publiée', qb_purchase_id: preview.paie.salary_purchase_id, qb_purchase_url: preview.paie.salary_purchase_url }
    }
    const refs = await resolveRefs(preview)
    const { body: purchase } = buildPurchaseBody(preview, refs, getPaieRepartitionConfig())

    const { qbPost } = await import('../connectors/quickbooks.js')
    const created = await qbPost('/purchase', purchase)
    const purchaseId = created.Purchase?.Id || created.Id || null

    // Le montant débité EST le « Total de la paie incluant les remises aux
    // organismes et les remboursements de dépenses » : on le pose sur la paie
    // et on le pousse dans la colonne Airtable correspondante (onglet Paies, RH).
    db.prepare(`UPDATE paies SET salary_purchase_id=?, salary_purchase_pushed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                total_with_charges_and_reimb=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(purchaseId, preview.bank_amount, paieId)
    const { writeBackRecord } = await import('./airtableWriteback.js')
    writeBackRecord('paies', paieId, ['total_with_charges_and_reimb'])
      .catch(e => console.error('Paie salary-expense write-back error:', e.message))

    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0,
      triggerData: { paieId, input },
      result: `Dépense QB ${purchaseId} publiée — paie ${preview.memo.replace('Paie – ', '')}, ${preview.bank_amount.toFixed(2)} $ (base ${preview.base.toFixed(2)} $, remb. ${preview.reimb_total.toFixed(2)} $)`,
    })
    return { ok: true, qb_purchase_id: purchaseId, qb_purchase_url: qbEntityUrl('expense', purchaseId), preview }
  } catch (e) {
    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { paieId, input }, error: e,
    })
    throw e
  }
}

// Corrige une dépense DÉJÀ publiée : recalcule les lignes depuis les données
// courantes (items de paie Airtable) et met à jour la transaction QB en place.
// Sert quand la paie a été comptabilisée avec des items incomplets — ex. le
// remboursement du téléphone de Martin arrivé après coup.
//
// Le montant total est verrouillé sur le débit bancaire déjà enregistré : un
// écart bloque la correction, sauf si un nouveau montant est fourni
// explicitement (le débit réel a changé).
export async function updatePaieSalaryExpense(paieId, input = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(PAIE_REPARTITION_AUTOMATION_ID)) {
      throw new Error('Automation sys_paie_repartition inactive — l\'activer avant de corriger')
    }
    const paie = db.prepare('SELECT * FROM paies WHERE id=?').get(paieId)
    if (!paie) throw new Error('Paie introuvable')
    if (!paie.salary_purchase_id) throw new Error('Cette paie n\'a pas encore de dépense QuickBooks — utiliser la publication')

    const { qbGet, qbPost } = await import('../connectors/quickbooks.js')
    const existing = (await qbGet(`/purchase/${paie.salary_purchase_id}`)).Purchase
    if (!existing) throw new Error(`Dépense QB ${paie.salary_purchase_id} introuvable`)

    const explicitAmount = input.bank_amount != null && input.bank_amount !== ''
    const preview = computePaieSalaryExpense(paieId, {
      ...input,
      bank_amount: explicitAmount ? input.bank_amount : Number(existing.TotalAmt),
      txn_date: input.txn_date || existing.TxnDate,
    })
    const refs = await resolveRefs(preview)
    const { body, total } = buildPurchaseBody(preview, refs, getPaieRepartitionConfig())
    if (!explicitAmount && Math.abs(total - Number(existing.TotalAmt)) > 0.01) {
      throw new Error(`Le total recalculé (${total.toFixed(2)} $) diffère du montant de la dépense QB (${Number(existing.TotalAmt).toFixed(2)} $) — corriger le montant passé au compte BNC avant de republier.`)
    }

    // Mise à jour complète (sparse absent) : QB remplace les lignes. Le total
    // reste identique, donc l'appariement bancaire éventuel tient.
    const updated = await qbPost('/purchase', {
      ...body, Id: existing.Id, SyncToken: existing.SyncToken,
    })
    const purchaseId = updated.Purchase?.Id || existing.Id

    if (explicitAmount) {
      db.prepare(`UPDATE paies SET total_with_charges_and_reimb=?,
                  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(preview.bank_amount, paieId)
      const { writeBackRecord } = await import('./airtableWriteback.js')
      writeBackRecord('paies', paieId, ['total_with_charges_and_reimb'])
        .catch(e => console.error('Paie salary-expense write-back error:', e.message))
    }

    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0,
      triggerData: { paieId, input },
      result: `Dépense QB ${purchaseId} corrigée — paie ${preview.memo.replace('Paie – ', '')}, ${preview.bank_amount.toFixed(2)} $ (base ${preview.base.toFixed(2)} $, remb. ${preview.reimb_total.toFixed(2)} $, téléphone ${preview.phone.toFixed(2)} $ + ${preview.deductions.phone_tax.toFixed(2)} $ de taxes)`,
    })
    return { ok: true, qb_purchase_id: purchaseId, qb_purchase_url: qbEntityUrl('expense', purchaseId), preview }
  } catch (e) {
    logSystemRun(PAIE_REPARTITION_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { paieId, input }, error: e,
    })
    throw e
  }
}
