import { test } from 'node:test'
import assert from 'node:assert/strict'
import xlsx from 'xlsx'
import {
  rdCreditFromHours, wageSubsidyFromSalary, lastDayOfMonth,
  hoursPlausibilityFromSeries, provisionDocNumber, hoursFileDivergence,
} from './monthEnd.js'
import { sumSheetHours, timesheetFileName, parseContractors } from './rdTimesheetImport.js'

const RD_CFG = { hourly_rate: 40, uplift_pct: 33, claim_pct: 60, round_to: 100 }

// ── Grille RSDE ─────────────────────────────────────────────────────────────

// Les trois mois de l'exercice 26-27 déjà comptabilisés dans le fichier
// Provisions_mensuelles_CTB, onglet « RSDE 26-27 ». Les heures sont celles du
// suivi (arrondies à la décimale dans le fichier) ; les provisions attendues
// sont les valeurs de la ligne « Ramené sur 1 mois (E/J mensuelle) ».
test('grille RSDE : reproduit les provisions publiées du fichier 26-27', () => {
  assert.equal(rdCreditFromHours(RD_CFG, 627, 0).amount, 20000)     // avril
  assert.equal(rdCreditFromHours(RD_CFG, 678.8, 0).amount, 21700)   // mai
  assert.equal(rdCreditFromHours(RD_CFG, 601.3, 0).amount, 19200)   // juin
})

test('grille RSDE : les paliers intermédiaires correspondent au fichier', () => {
  const c = rdCreditFromHours(RD_CFG, 627, 0)
  assert.equal(c.gross, 33356.4)          // 627 h × 40 $ × 1,33
  assert.equal(c.projected_12m, 400276.8) // × 12
  assert.equal(c.claimable, 240166.08)    // × 60 %
  assert.equal(c.before_rounding, 20013.84)
  assert.equal(c.amount, 20000)           // arrondi au 100 $
})

// Mars 2026 : seul mois avec du PARI (15 607 $ saisis, déjà à 50 %).
// Le fichier affiche 49 590 $ de RS&DE à soumettre pour 1 226 h.
test('grille RSDE : le PARI du mois est retranché de la dépense R&D', () => {
  const c = rdCreditFromHours(RD_CFG, 1226, 15607)
  assert.equal(c.gross, 65223.2)
  assert.equal(c.rsde_month, 49616.2)
  assert.equal(rdCreditFromHours(RD_CFG, 1226, 0).rsde_month, 65223.2)
})

test('grille RSDE : un PARI supérieur à la dépense ne rend pas la provision négative', () => {
  const c = rdCreditFromHours(RD_CFG, 100, 999999)
  assert.equal(c.rsde_month, 0)
  assert.equal(c.amount, 0)
})

test('grille RSDE : aucune heure → aucune provision', () => {
  assert.equal(rdCreditFromHours(RD_CFG, 0, 0).amount, 0)
})

test('grille RSDE : les paramètres sont configurables (arrondi au dollar)', () => {
  const c = rdCreditFromHours({ ...RD_CFG, round_to: 1 }, 627, 0)
  assert.equal(c.amount, 20014)
})

// ── Subvention salariale ────────────────────────────────────────────────────

const LB_CFG = { pct: 60, cap_total: 20000, eligible_from: '2025-12-01', eligible_to: '2026-09-30' }

test('subvention salariale : reproduit les provisions publiées du fichier 26-27', () => {
  assert.equal(wageSubsidyFromSalary(LB_CFG, 2864.92, '2026-04', 0).amount, 1718.95)
  assert.equal(wageSubsidyFromSalary(LB_CFG, 3014.04, '2026-05', 0).amount, 1808.42)
  assert.equal(wageSubsidyFromSalary(LB_CFG, 2964.5, '2026-06', 0).amount, 1778.7)
})

test('subvention salariale : plafonnée à la contribution maximale restante', () => {
  const out = wageSubsidyFromSalary(LB_CFG, 3498.52, '2026-07', 19000)
  assert.equal(out.amount, 1000)
  assert.equal(out.detail.capped, true)
  assert.match(out.warnings[0], /Plafonn/)
})

test('subvention salariale : plafond atteint → provision nulle', () => {
  const out = wageSubsidyFromSalary(LB_CFG, 3498.52, '2026-07', 20000)
  assert.equal(out.amount, 0)
  assert.equal(out.detail.cap_remaining, 0)
})

test('subvention salariale : hors de la fenêtre d\'admissibilité → provision nulle', () => {
  const avant = wageSubsidyFromSalary(LB_CFG, 3000, '2025-11', 0)
  const apres = wageSubsidyFromSalary(LB_CFG, 3000, '2026-10', 0)
  assert.equal(avant.amount, 0)
  assert.equal(apres.amount, 0)
  assert.match(apres.warnings[0], /admissibilit/)
})

test('subvention salariale : sans plafond ni fenêtre, le taux s\'applique tel quel', () => {
  const out = wageSubsidyFromSalary({ pct: 60 }, 1000, '2030-01', 999999)
  assert.equal(out.amount, 600)
  assert.deepEqual(out.warnings, [])
})

// ── Lecture des feuilles de temps ───────────────────────────────────────────

function makeSheet(rows) {
  return xlsx.utils.aoa_to_sheet([
    ['Guillaume Lambert', '', ''],
    ['Dates', 'Heures RSDE', 'Description RSDE'],
    ...rows,
  ])
}

test('feuille de temps : l\'ERP refait le total à partir des lignes, la ligne « total » n\'est lue que pour comparer', () => {
  // Cas réel de feuille_de_temps_7_2026 : la formule SUM du fichier n'englobait
  // pas la dernière ligne (total 16 h pour 24 h de lignes datées). C'est
  // l'addition des lignes qui est retenue — la formule du fichier est signalée.
  const sheet = makeSheet([
    ['2026/07/01', 8, 'R&D'],
    ['2026/07/02', 8, 'R&D'],
    ['2026/07/03', 8, 'R&D'],
    ['total', 16, ''],
  ])
  assert.deepEqual(sumSheetHours(sheet), { hours: 24, day_hours: 24, file_total: 16, days: 3, recognized: true })
})

test('feuille de temps : sans ligne « total », l\'addition des lignes suffit', () => {
  const sheet = makeSheet([
    ['2026/07/01', 8, 'R&D'],
    ['2026/07/02', 4, 'R&D'],
  ])
  const out = sumSheetHours(sheet)
  assert.equal(out.hours, 12)
  assert.equal(out.file_total, null)
})

test('feuille de temps : les jours à zéro et les cellules vides ne cassent rien', () => {
  const sheet = makeSheet([
    ['2026/07/01', 0, ''],
    ['2026/07/02', 3.5, 'ERP'],
    ['2026/07/03', '', ''],
    ['total', 3.5, ''],
  ])
  assert.equal(sumSheetHours(sheet).hours, 3.5)
})

test('feuille de temps : onglet sans colonne « Heures RSDE » → non reconnu', () => {
  const sheet = xlsx.utils.aoa_to_sheet([['Notes'], ['Rien à voir ici']])
  assert.equal(sumSheetHours(sheet).recognized, false)
})

test('heures R&D : une formule de total incomplète dans le fichier est signalée', () => {
  const warnings = hoursFileDivergence([
    // Total recalculé retenu (184 h) alors que la formule du fichier dit 176 h.
    { employee_name: 'Guillaume Lambert', hours: 184, day_hours: 184, file_total_hours: 176, source: 'import' },
    { employee_name: 'Alicia Talbot-Lanciault', hours: 144, day_hours: 144, file_total_hours: 144, source: 'import' },
    { employee_name: 'Corrigé à la main', hours: 10, day_hours: 20, file_total_hours: 20, source: 'manuel' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Guillaume Lambert/)
  assert.match(warnings[0], /176 h/)
  assert.match(warnings[0], /184 h/)
  assert.match(warnings[0], /formule du fichier/)
})

test('heures R&D : une valeur retenue qui ne suit plus les lignes invite au réimport', () => {
  const warnings = hoursFileDivergence([
    { employee_name: 'Guillaume Lambert', hours: 176, day_hours: 184, file_total_hours: 176, source: 'import' },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /réimporter/)
})

test('heures R&D : sans lecture des lignes (mois importé avant), aucun avertissement', () => {
  assert.deepEqual(hoursFileDivergence([
    { employee_name: 'Alicia Talbot-Lanciault', hours: 144, day_hours: null, file_total_hours: null, source: 'import' },
  ]), [])
})

test('feuille de temps : nom de fichier par mois, sans zéro initial', () => {
  assert.equal(timesheetFileName('2026-07'), 'feuille_de_temps_7_2026.xlsx')
  assert.equal(timesheetFileName('2026-12'), 'feuille_de_temps_12_2026.xlsx')
  assert.equal(timesheetFileName('2027-01'), 'feuille_de_temps_1_2027.xlsx')
})

// ── Plausibilité des heures ─────────────────────────────────────────────────

const series = rows => ({
  rows: rows.map(([name, hours]) => ({ employee_name: name, hours })),
  employee_hours: rows.reduce((s, [, h]) => s + h, 0),
})

test('plausibilité : une personne avec des heures le mois passé mais absente ce mois-ci est signalée', () => {
  const w = hoursPlausibilityFromSeries(
    series([['Alicia Talbot-Lanciault', 144], ['Charles Joachim', 176]]),
    series([['Alicia Talbot-Lanciault', 132], ['Charles Joachim', 128], ['Guillaume Lambert', 176]]),
  )
  assert.equal(w.length, 1)
  assert.match(w[0], /Guillaume Lambert/)
  assert.match(w[0], /onglet manquant/)
})

test('plausibilité : un écart de plus de 40 % d\'un mois à l\'autre est signalé', () => {
  const w = hoursPlausibilityFromSeries(
    series([['Charles Joachim', 60]]),
    series([['Charles Joachim', 176]]),
  )
  assert.equal(w.length, 1)
  assert.match(w[0], /d'heures employés de moins/)
})

test('plausibilité : des heures stables ne déclenchent rien', () => {
  const w = hoursPlausibilityFromSeries(
    series([['Charles Joachim', 170]]),
    series([['Charles Joachim', 176]]),
  )
  assert.deepEqual(w, [])
})

test('plausibilité : pas de mois précédent (premier mois) → aucun avertissement', () => {
  assert.deepEqual(hoursPlausibilityFromSeries(series([['A', 100]]), series([])), [])
  assert.deepEqual(hoursPlausibilityFromSeries(series([]), series([['A', 100]])), [])
})

test('plausibilité : les accents et la casse ne créent pas de faux manquants', () => {
  const w = hoursPlausibilityFromSeries(
    series([['antoine ratheau', 100]]),
    series([['Antoine Rathéau', 100]]),
  )
  assert.deepEqual(w, [])
})

// ── Numéro d'écriture déterministe (anti-doublon QB) ────────────────────────

test('DocNumber : stable, distinct par provision et ≤ 21 caractères (limite QB)', () => {
  const rd = provisionDocNumber('prov_rd_credit', '2026-07')
  const lb = provisionDocNumber('prov_subv_salariale_lb', '2026-07')
  assert.equal(rd, 'FDM-2026-07-rdcredit')
  assert.equal(rd, provisionDocNumber('prov_rd_credit', '2026-07'))
  assert.notEqual(rd, lb)
  assert.ok(rd.length <= 21 && lb.length <= 21)
  assert.notEqual(rd, provisionDocNumber('prov_rd_credit', '2026-08'))
})

// ── Liste des sous-traitants (config de l'automation) ───────────────────────

test('parseContractors : chaîne de la config, tableau, ou rien', () => {
  assert.deepEqual(parseContractors('Antoine Ratheau, Jean Untel'), ['Antoine Ratheau', 'Jean Untel'])
  assert.deepEqual(parseContractors(['Antoine Ratheau']), ['Antoine Ratheau'])
  assert.deepEqual(parseContractors('  '), [])
  assert.equal(parseContractors(null), null)
  assert.equal(parseContractors(undefined), null)
})

// ── Date de l'écriture ──────────────────────────────────────────────────────

test("l'écriture est datée du dernier jour du mois", () => {
  assert.equal(lastDayOfMonth('2026-07'), '2026-07-31')
  assert.equal(lastDayOfMonth('2026-02'), '2026-02-28')
  assert.equal(lastDayOfMonth('2028-02'), '2028-02-29')
})
