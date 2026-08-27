// Seed des provisions de fin de mois et reprise de l'historique.
//
// Reprend ce que contenaient les fichiers Drive au moment de la bascule :
//   • les deux définitions de provision (grille de calcul + comptes QB) ;
//   • les provisions mensuelles déjà comptabilisées à la main dans QB
//     (source 'import', pushed_at posé sans qb_je_id) — nécessaires pour que
//     les cumulatifs et le plafond de contribution soient justes ;
//   • l'historique des heures R&D (ex-fichier « R&D_Suivi_Feuilles de temps »).
//
// Idempotent et non destructif : rien n'est écrasé si la ligne existe déjà.
// Les valeurs ci-dessous sont celles des fichiers 25-26 et 26-27 lus le
// 2026-08-02 ; les mois suivants sont calculés par l'ERP.
import { randomUUID } from 'crypto'
import db from '../db/database.js'

export const RD_PROVISION_ID = 'prov_rd_credit'
export const LB_PROVISION_ID = 'prov_subv_salariale_lb'

// Provisions mensuelles déjà comptabilisées (fichiers Provisions_mensuelles_CTB).
const RD_HISTORY = {
  '2025-04': 15300, '2025-05': 16200, '2025-06': 18700, '2025-07': 14300,
  '2025-08': 13000, '2025-09': 16500, '2025-10': 14700, '2025-11': 16000,
  '2025-12': 11500, '2026-01': 12600, '2026-02': 13100, '2026-03': 29800,
  '2026-04': 20000, '2026-05': 21700, '2026-06': 19200,
}
const LB_HISTORY = {
  '2025-12': 1842, '2026-01': 1555, '2026-02': 1991, '2026-03': 2580,
  '2026-04': 1719, '2026-05': 1808, '2026-06': 1779,
}

// Heures R&D historiques. Les onglets du suivi annuel utilisaient des noms
// abrégés ; on seede sous le nom complet, celui des onglets des feuilles de
// temps mensuelles, pour que l'import du mois suivant retombe sur la même ligne.
const HOURS_HISTORY = [
  // [nom, sous-traitant, { mois: heures }]
  ['Alicia Talbot-Lanciault', 0, { '2025-04': 142.4, '2025-05': 134.4, '2025-06': 132.8, '2025-07': 152, '2025-08': 64, '2025-09': 136, '2025-10': 104, '2025-11': 128, '2025-12': 96, '2026-01': 128, '2026-02': 120, '2026-03': 120, '2026-04': 136, '2026-05': 110, '2026-06': 132 }],
  ['Charles Joachim', 0, { '2025-04': 168, '2025-05': 168, '2025-06': 144, '2025-07': 64, '2025-08': 144, '2025-09': 168, '2025-10': 184, '2025-11': 160, '2025-12': 144, '2026-01': 152, '2026-02': 160, '2026-03': 176, '2026-04': 164, '2026-05': 168, '2026-06': 128 }],
  ['Martin Audesse', 0, { '2025-06': 32, '2025-07': 8, '2025-10': 18, '2025-11': 35, '2025-12': 16 }],
  ['Guillaume Lambert', 0, { '2025-04': 90, '2025-05': 90, '2025-06': 80, '2025-07': 77, '2025-08': 63, '2025-09': 66, '2025-10': 54, '2025-11': 60, '2025-12': 54, '2026-01': 60, '2026-02': 60, '2026-03': 66, '2026-04': 80, '2026-05': 168, '2026-06': 176 }],
  ['Pierre-Alexandre Papillon', 0, { '2025-04': 12, '2025-05': 28.6, '2025-06': 102, '2025-07': 72, '2025-08': 51, '2025-09': 75, '2025-10': 99, '2025-11': 97, '2025-12': 50, '2026-01': 56, '2026-02': 71, '2026-03': 99, '2026-04': 116, '2026-05': 90.8, '2026-06': 50.8 }],
  ['Marc-Antoine Plante', 0, { '2025-04': 67, '2025-05': 86, '2025-06': 95, '2025-07': 74, '2025-08': 86, '2025-09': 72, '2025-11': 21, '2026-03': 14, '2026-04': 127, '2026-05': 142, '2026-06': 105 }],
  ['Antoine Lambert', 0, { '2026-04': 4, '2026-06': 9.5 }],
  ['Antoine Ratheau', 1, { '2025-04': 40, '2025-05': 40, '2025-06': 40, '2025-07': 31, '2025-08': 32, '2025-09': 32, '2025-10': 40, '2025-11': 32, '2025-12': 12, '2026-01': 24, '2026-02': 32, '2026-03': 32, '2026-04': 35, '2026-05': 28, '2026-06': 28 }],
]

function findEmployeeId(fullName) {
  const parts = fullName.split(' ')
  const row = db.prepare(`
    SELECT id FROM employees
    WHERE lower(first_name || ' ' || last_name) = lower(?) OR lower(last_name) = lower(?)
    LIMIT 1
  `).get(fullName, parts[parts.length - 1])
  return row?.id || null
}

function seedProvision(def) {
  const existing = db.prepare('SELECT id FROM month_end_provisions WHERE id = ?').get(def.id)
  if (existing) return false
  db.prepare(`
    INSERT INTO month_end_provisions (id, label, kind, description, config, debit_acctnum, credit_acctnum, memo, active, sort_order)
    VALUES (?,?,?,?,?,?,?,?,1,?)
  `).run(def.id, def.label, def.kind, def.description, JSON.stringify(def.config),
    def.debit_acctnum, def.credit_acctnum, def.memo, def.sort_order)
  return true
}

// Mois historiques : marqués publiés (pushed_at) sans qb_je_id — l'écriture
// existe dans QB, passée à la main avant la bascule vers l'ERP.
function seedHistory(provisionId, history) {
  const insert = db.prepare(`
    INSERT INTO month_end_provision_months (id, provision_id, month, amount, source, pushed_at, computed)
    VALUES (?,?,?,?,'import',?,?)
  `)
  const stamp = new Date().toISOString()
  let n = 0
  for (const [month, amount] of Object.entries(history)) {
    const exists = db.prepare(`
      SELECT 1 FROM month_end_provision_months WHERE provision_id = ? AND month = ? AND deleted_at IS NULL
    `).get(provisionId, month)
    if (exists) continue
    insert.run(randomUUID(), provisionId, month, amount, stamp,
      JSON.stringify({ note: 'Repris du fichier Provisions_mensuelles_CTB — écriture passée manuellement dans QuickBooks' }))
    n++
  }
  return n
}

function seedHours() {
  const insert = db.prepare(`
    INSERT INTO rd_month_hours (id, month, employee_name, employee_id, hours, contractor, source, notes)
    VALUES (?,?,?,?,?,?,'seed',?)
  `)
  let n = 0
  for (const [name, contractor, months] of HOURS_HISTORY) {
    const employeeId = findEmployeeId(name)
    for (const [month, hours] of Object.entries(months)) {
      const exists = db.prepare(`
        SELECT 1 FROM rd_month_hours WHERE month = ? AND employee_name = ? AND deleted_at IS NULL
      `).get(month, name)
      if (exists) continue
      insert.run(randomUUID(), month, name, employeeId, hours, contractor,
        'Repris du fichier R&D_Suivi_Feuilles de temps')
      n++
    }
  }
  return n
}

export function seedMonthEndProvisions() {
  const lbId = findEmployeeId('Louis-Bernard Frechette')

  const created = []
  if (seedProvision({
    id: RD_PROVISION_ID,
    label: "Provision — crédit d'impôt R&D",
    kind: 'rd_credit',
    description:
      "Provision mensuelle pour les crédits d'impôt R&D (RS&DE). Heures R&D du mois (employés seulement, "
      + 'les sous-traitants sont exclus) × taux horaire moyen × majoration vacances, moins le PARI reçu dans le mois, '
      + 'projeté sur 12 mois, × le taux de réclamation, ramené sur 1 mois et arrondi. '
      + 'Remplace la grille « RSDE » du fichier Provisions_mensuelles_CTB.',
    config: { hourly_rate: 40, uplift_pct: 33, claim_pct: 60, round_to: 100, start_month: '2025-04' },
    debit_acctnum: '15000',
    credit_acctnum: '72000',
    memo: "Pour inscrire la provision mensuelle pour le crédit d'impôt R&D",
    sort_order: 1,
  })) created.push(RD_PROVISION_ID)

  if (seedProvision({
    id: LB_PROVISION_ID,
    label: 'Provision — subvention salariale (Biotalent)',
    kind: 'wage_subsidy',
    description:
      'Provision mensuelle pour la subvention salariale à recevoir : salaire brut du mois (paies débitées, '
      + 'remboursements de dépenses exclus) × le taux de contribution non remboursable. '
      + "Plafonnée à la contribution maximale et bornée à la fenêtre d'admissibilité des dépenses. "
      + 'Remplace la grille « Salaires LB » du fichier Provisions_mensuelles_CTB.',
    config: {
      employee_id: lbId,
      pct: 60,
      cap_total: 20000,
      eligible_from: '2025-12-01',
      eligible_to: '2026-09-30',
      start_month: '2025-12',
      // Détection auto des versements reçus dans le rapprochement bancaire —
      // voir services/wageSubsidyReceipts.js.
      bank_match_label: 'Biotalent',
    },
    debit_acctnum: '12400',
    credit_acctnum: '49000',
    memo: 'Salaire LB - Provision Subv. Biotalent',
    sort_order: 2,
  })) created.push(LB_PROVISION_ID)

  // L'employé peut ne pas encore être synchronisé au premier boot : on complète
  // la config plus tard sans écraser un choix fait à la main dans l'interface.
  if (lbId) {
    const row = db.prepare('SELECT config FROM month_end_provisions WHERE id = ?').get(LB_PROVISION_ID)
    if (row) {
      let cfg = {}
      try { cfg = JSON.parse(row.config || '{}') } catch {}
      if (!cfg.employee_id) {
        cfg.employee_id = lbId
        db.prepare('UPDATE month_end_provisions SET config = ? WHERE id = ?').run(JSON.stringify(cfg), LB_PROVISION_ID)
      }
    }
  }

  const rd = seedHistory(RD_PROVISION_ID, RD_HISTORY)
  const lb = seedHistory(LB_PROVISION_ID, LB_HISTORY)
  const hours = seedHours()
  if (created.length || rd || lb || hours) {
    console.log(`✅ Écritures de fin de mois : ${created.length} provision(s), ${rd + lb} mois historiques, ${hours} lignes d'heures R&D`)
  }
}
