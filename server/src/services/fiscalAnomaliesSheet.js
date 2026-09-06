// Synchronisation de l'onglet « Fournisseurs_TPS_TVQ_Anomalies » du Google Sheet
// « Sommaire_Statut fiscal des taxes » vers les PROFILS FOURNISSEURS.
//
// Cet onglet est le journal de corrections tenu par le mentor comptable : une ligne
// par transaction mal comptabilisée, avec le statut fiscal utilisé (« Ce qui a été
// fait ») et celui qui aurait dû l'être (« Ce qui aurait dû être fait »). Jusqu'ici
// ces corrections étaient reportées à la main dans l'ERP (cas Simplex). La sync les
// applique désormais au profil du fournisseur — code de taxe QB par devise et, quand
// l'explication le permet, type de transaction — pour que les PROCHAINES factures du
// même fournisseur partent du bon statut (voir services/fiscalDetection.js : le
// profil est le signal le plus prioritaire).
//
// Prudence délibérée :
//   - une correction « Taxable » n'est jamais appliquée (le code dépend des taxes
//     réellement facturées : TPS seule, TPS+TVQ, repas… — l'onglet ne le dit pas) ;
//   - deux lignes du même fournisseur/devise qui pointent vers des statuts différents
//     (Amazon : café détaxé vs remboursement taxable) = CONFLIT → rien n'est appliqué,
//     c'est rapporté ;
//   - une ligne déjà traitée n'est jamais rejouée : une édition faite ensuite dans
//     /fournisseurs ne peut pas être réécrasée par la sync. Seule une ligne NOUVELLE
//     (ou modifiée dans le Sheet) déclenche une mise à jour.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { fetchPmtSuiviGrid } from './pmtSuiviImport.js'
import { findVendorProfile, normalizeVendorKey } from './vendorProfiles.js'
import { getTransactionType, FISCAL_STATUS } from './fiscalStatus.js'
import { resolveTaxCodeIdsByName } from './quickbooks.js'
import { nowIso } from '../utils/datetime.js'

export const FISCAL_ANOMALIES_AUTOMATION_ID = 'sys_fiscal_anomalies_sheet'

export const FISCAL_ANOMALIES_DEFAULT_CONFIG = {
  spreadsheet_id: '1ZJafa3fuuQwfuROyLfWlLPzg99k8jLqlv9jnNao8Ed0', // Sommaire_Statut fiscal des taxes
  sheet_name: 'Fournisseurs_TPS_TVQ_Anomalies',
  google_account_email: 'pap@orisha.io',
}

export function getFiscalAnomaliesConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(FISCAL_ANOMALIES_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...FISCAL_ANOMALIES_DEFAULT_CONFIG }
  for (const k of Object.keys(FISCAL_ANOMALIES_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Parsing (pur, testable) ──────────────────────────────────────────────────

const strip = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

// Statut fiscal écrit à la main par le mentor → clé de fiscalStatus.js. Le texte
// varie (« Hors-champ », « Hors champ (frais de conversion) », « Détaxée ») : on
// reconnaît le mot-racine, jamais une égalité stricte.
export function parseStatusLabel(label) {
  const s = strip(label)
  if (!s) return null
  if (s.includes('hors')) return 'hors_champ'
  if (s.includes('detax')) return 'detaxe'
  if (s.includes('exoner')) return 'exonere'
  if (s.includes('taxable')) return 'taxable'
  return null
}

// Statut → nom de code de taxe QB à poser par défaut sur le profil. « Taxable » n'y
// est pas : le code dépend des taxes facturées, l'onglet ne les donne pas.
const CODE_BY_STATUS = {
  detaxe: 'Détaxé',
  exonere: 'Exonéré',
  hors_champ: 'Hors champ',
}

// Type de transaction déduit de l'EXPLICATION du mentor (colonne G). Le type est plus
// précis que le statut (« Détaxé » couvre B2B, transport export, courtage, aliments…)
// et c'est lui que l'ERP vérifie au push QB. Retenu seulement si son statut concorde
// avec la correction — sinon on ne pose que le code de taxe.
const TYPE_HINTS = [
  { match: /business to business|\bb2b\b/, type: 'achat_num_inscrit_b2b_exempte' },
  { match: /courtage/, type: 'courtage_export' },
  { match: /transport de marchandises|transport dont le point/, type: 'transport_export' },
  { match: /alimentaire|\bcafe\b|epicerie/, type: 'produits_alimentaires_base' },
  { match: /service financier|conversion de devises|operations de change/, type: 'frais_conversion' },
  { match: /eteindre une dette|solde de carte|remboursement de (la )?dette/, type: 'remboursement_dette' },
  { match: /assurance/, type: 'assurances' },
]

export function typeFromExplanation(explanation, status) {
  const s = strip(explanation)
  if (!s) return null
  for (const h of TYPE_HINTS) {
    if (!h.match.test(s)) continue
    const t = getTransactionType(h.type)
    if (t && t.status === status) return h.type
  }
  return null
}

// Devise de la transaction : la colonne « Compte/facture à payer » nomme le compte
// (« Visa USD », « Venn USD », « Mastercard »), sinon le montant peut la porter
// (« 40 USD »). Défaut CAD.
export function currencyFromRow(accountLabel, amountText) {
  const hay = `${strip(accountLabel)} ${strip(amountText)}`
  if (/\busd\b|\$\s*us/.test(hay)) return 'USD'
  return 'CAD'
}

const HEADER_HINTS = ['date', 'fournisseur']

// L'onglet a un titre et des lignes vides avant l'entête. On repère la ligne d'entête
// (contient « Date » et « Fournisseur »), puis on lit jusqu'à la fin des lignes
// remplies. Colonnes : A=date, B=compte, C=fournisseur, D=montant, E=ce qui a été
// fait, F=ce qui aurait dû être fait, G=explication.
export function parseAnomalyRows(rows) {
  const grid = Array.isArray(rows) ? rows : []
  const headerIdx = grid.findIndex(r => {
    const cells = (r || []).map(strip)
    return HEADER_HINTS.every(h => cells.some(c => c.includes(h)))
  })
  if (headerIdx < 0) return []
  const out = []
  for (const r of grid.slice(headerIdx + 1)) {
    const cells = r || []
    const vendor = String(cells[2] ?? '').trim()
    const correct = String(cells[5] ?? '').trim()
    if (!vendor || !correct) continue
    const sheetDate = String(cells[0] ?? '').trim()
    const amountText = String(cells[3] ?? '').trim()
    const usedStatus = parseStatusLabel(cells[4])
    const correctStatus = parseStatusLabel(correct)
    out.push({
      // Clé stable d'une ligne : date + fournisseur + montant. Corriger le statut
      // d'une ligne existante change son contenu, pas sa clé — la sync la voit alors
      // comme MODIFIÉE et la rejoue (c'est voulu : le mentor a changé d'avis).
      rowKey: `${sheetDate}|${normalizeVendorKey(vendor)}|${amountText}`,
      sheetDate,
      accountLabel: String(cells[1] ?? '').trim(),
      vendorName: vendor,
      amountText,
      currency: currencyFromRow(cells[1], amountText),
      usedStatus,
      usedLabel: String(cells[4] ?? '').trim(),
      correctStatus,
      correctLabel: correct,
      explanation: String(cells[6] ?? '').trim(),
    })
  }
  return out
}

// Regroupe les lignes par fournisseur + devise et décide de la cible du profil.
// Retourne { key, vendorName, currency, rows, status, type, conflict } — `status` null
// quand rien n'est applicable (conflit, statut taxable, statut illisible).
export function planUpdates(anomalies) {
  const groups = new Map()
  for (const a of anomalies) {
    const key = `${normalizeVendorKey(a.vendorName)}|${a.currency}`
    if (!groups.has(key)) groups.set(key, { key, vendorName: a.vendorName, currency: a.currency, rows: [] })
    groups.get(key).rows.push(a)
  }
  return [...groups.values()].map(g => {
    const statuses = [...new Set(g.rows.map(r => r.correctStatus).filter(Boolean))]
    if (statuses.length > 1) {
      return { ...g, status: null, type: null, conflict: statuses }
    }
    const status = statuses[0] || null
    if (!status) return { ...g, status: null, type: null, unreadable: true }
    if (!CODE_BY_STATUS[status]) return { ...g, status, type: null, ambiguous: true }
    let type = null
    for (const r of g.rows) {
      type = typeFromExplanation(r.explanation, status)
      if (type) break
    }
    return { ...g, status, type, codeName: CODE_BY_STATUS[status] }
  })
}

// Le mentor écrit le fournisseur en raccourci (« Simplex » pour « Simplex Wireless »,
// « Postmark » pour « Postmark (ActiveCampaign) ») : après le match exact/alias de
// findVendorProfile, on tente un repli par PRÉFIXE — accepté seulement s'il désigne
// UN SEUL profil. « Amazon » (Amazon.ca vs Amazon Web Services) reste donc non résolu
// plutôt que rattaché au mauvais fournisseur.
export function resolveProfileForSheetName(name, profiles) {
  const exact = profiles.find(p => normalizeVendorKey(p.name) === normalizeVendorKey(name))
  if (exact) return { profile: exact, matchedBy: 'exact' }
  const key = normalizeVendorKey(name)
  if (key.length < 4) return { profile: null, matchedBy: null }
  const candidates = profiles.filter(p => normalizeVendorKey(p.name).startsWith(key))
  if (candidates.length === 1) return { profile: candidates[0], matchedBy: 'prefixe' }
  if (candidates.length > 1) {
    return { profile: null, matchedBy: null, ambiguousNames: candidates.map(p => p.name) }
  }
  return { profile: null, matchedBy: null }
}

// ── Sync ─────────────────────────────────────────────────────────────────────


function loadKnownRows() {
  const rows = db.prepare('SELECT * FROM fiscal_anomalies WHERE deleted_at IS NULL').all()
  return new Map(rows.map(r => [r.row_key, r]))
}

// Une ligne est « à traiter » si elle est inconnue, ou si son contenu utile a changé
// dans le Sheet depuis le dernier passage, ou si elle n'a jamais pu être appliquée.
function isPending(known, a) {
  if (!known) return true
  if (!known.applied_at) return true
  return known.correct_status !== a.correctStatus || (known.explanation || '') !== a.explanation
}

function upsertRow(a, { profileId, outcome, detail, applied }) {
  const known = db.prepare('SELECT id FROM fiscal_anomalies WHERE row_key=?').get(a.rowKey)
  const vals = [
    a.sheetDate, a.accountLabel, a.vendorName, a.amountText, a.currency,
    a.usedStatus, a.correctStatus, a.explanation, profileId || null, outcome, detail || null,
    applied ? nowIso() : null,
  ]
  if (known) {
    db.prepare(`
      UPDATE fiscal_anomalies SET sheet_date=?, account_label=?, vendor_name=?, amount_text=?, currency=?,
        used_status=?, correct_status=?, explanation=?, vendor_profile_id=?, outcome=?, outcome_detail=?,
        applied_at=COALESCE(?, applied_at), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(...vals, known.id)
    return known.id
  }
  const id = newRecordId()
  db.prepare(`
    INSERT INTO fiscal_anomalies (id, row_key, sheet_date, account_label, vendor_name, amount_text, currency,
      used_status, correct_status, explanation, vendor_profile_id, outcome, outcome_detail, applied_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, a.rowKey, ...vals)
  return id
}

const statusLabel = s => FISCAL_STATUS[s]?.label || s

// Sync complète. `apply: false` = simulation (lecture du Sheet + plan, aucune écriture).
export async function syncFiscalAnomalies({ trigger = 'scheduled', apply = true } = {}) {
  const started = Date.now()
  // sync_log n'accepte que webhook|manual|scheduled (CHECK en base).
  const logTrigger = trigger === 'scheduled' || trigger === 'webhook' ? trigger : 'manual'
  const cfg = getFiscalAnomaliesConfig()
  const report = { rows: 0, pending: 0, applied: [], skipped: [], errors: [] }
  try {
    const { rows } = await fetchPmtSuiviGrid({
      googleAccountEmail: cfg.google_account_email,
      fileId: cfg.spreadsheet_id,
      tab: cfg.sheet_name,
    })
    const anomalies = parseAnomalyRows(rows)
    report.rows = anomalies.length
    const known = loadKnownRows()
    const pending = anomalies.filter(a => isPending(known.get(a.rowKey), a))
    report.pending = pending.length

    // Le plan se calcule sur TOUTES les lignes du fournisseur (pas seulement les
    // nouvelles) : un conflit ancien doit continuer de bloquer une ligne récente.
    const plans = planUpdates(anomalies)
    const pendingKeys = new Set(pending.map(a => `${normalizeVendorKey(a.vendorName)}|${a.currency}`))

    // Un seul appel QB pour tous les codes nécessaires (et seulement si besoin).
    const neededCodes = [...new Set(plans
      .filter(p => p.codeName && pendingKeys.has(p.key))
      .map(p => p.codeName))]
    let codeIds = new Map()
    if (neededCodes.length) {
      try {
        codeIds = await resolveTaxCodeIdsByName(neededCodes)
      } catch (e) {
        report.errors.push(`Codes de taxe QB non résolus (${e.message}) — aucune mise à jour de profil ce tour-ci`)
      }
    }

    for (const plan of plans) {
      if (!pendingKeys.has(plan.key)) continue
      const rowsOfPlan = plan.rows.filter(a => isPending(known.get(a.rowKey), a))
      const record = (outcome, detail, { profileId = null, applied = false } = {}) => {
        for (const a of rowsOfPlan) if (apply) upsertRow(a, { profileId, outcome, detail, applied })
        const line = `${plan.vendorName} (${plan.currency}) — ${detail}`
        if (applied) report.applied.push(line); else report.skipped.push(line)
      }

      if (plan.conflict) {
        record('conflit', `lignes contradictoires dans le Sheet (${plan.conflict.map(statusLabel).join(' vs ')}) — profil inchangé`)
        continue
      }
      if (plan.unreadable) { record('illisible', `statut « ${rowsOfPlan[0]?.correctLabel || '?'} » non reconnu — profil inchangé`); continue }
      if (plan.ambiguous) { record('ambigu', 'correction « Taxable » : le code dépend des taxes facturées — profil inchangé'); continue }

      let profile = findVendorProfile(plan.vendorName)
      let matchNote = ''
      if (!profile) {
        const all = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL').all()
        const res = resolveProfileForSheetName(plan.vendorName, all)
        if (res.ambiguousNames) {
          record('fournisseur_ambigu', `« ${plan.vendorName} » désigne plusieurs profils (${res.ambiguousNames.join(', ')}) — profil inchangé`)
          continue
        }
        profile = res.profile
        if (profile) matchNote = ` (rapproché du profil « ${profile.name} »)`
      }
      if (!profile) { record('fournisseur_inconnu', 'aucun profil fournisseur correspondant — profil inchangé'); continue }

      const taxCodeId = codeIds.get(plan.codeName)
      if (!taxCodeId) { record('code_introuvable', `code de taxe QB « ${plan.codeName} » non résolu — profil inchangé`, { profileId: profile.id }); continue }

      const col = plan.currency === 'USD' ? 'default_tax_code_id_usd' : 'default_tax_code_id_cad'
      const sets = [`${col}=?`]
      const values = [taxCodeId]
      const parts = [`code de taxe ${plan.currency} → ${plan.codeName}`]
      if (plan.type && plan.type !== profile.default_transaction_type) {
        sets.push('default_transaction_type=?')
        values.push(plan.type)
        parts.push(`type de transaction → ${getTransactionType(plan.type)?.label || plan.type}`)
      }
      if (apply) {
        sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
        db.prepare(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id=?`).run(...values, profile.id)
      }
      record('applique', `${statusLabel(plan.status)}${matchNote} — ${parts.join(', ')}`, { profileId: profile.id, applied: true })
    }

    const summary = `${report.rows} ligne(s) lue(s), ${report.pending} à traiter — `
      + `${report.applied.length} profil(s) mis à jour, ${report.skipped.length} laissée(s) de côté`
    const result = { summary, ...report }
    if (apply) {
      logSync('fiscal_anomalies', logTrigger, { status: 'success', modified: report.applied.length, durationMs: Date.now() - started })
      logSystemRun(FISCAL_ANOMALIES_AUTOMATION_ID, { status: 'success', result, duration_ms: Date.now() - started })
    }
    return result
  } catch (e) {
    if (apply) {
      logSync('fiscal_anomalies', logTrigger, { status: 'error', error: e.message, durationMs: Date.now() - started })
      logSystemRun(FISCAL_ANOMALIES_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - started })
    }
    throw e
  }
}

// Sync horaire (index.js) — coupe-circuit si l'automation est désactivée.
export async function scheduledFiscalAnomaliesSync() {
  if (!isSystemAutomationActive(FISCAL_ANOMALIES_AUTOMATION_ID)) return
  await syncFiscalAnomalies({ trigger: 'scheduled', apply: true })
}
