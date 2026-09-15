/**
 * Lire le fichier de règles exporté de QuickBooks.
 *
 * Vérifié le 2026-09-12 : **l'API QuickBooks ne donne pas les règles bancaires**
 * (`select * from Rule` → « invalid context declaration: Rule »). Aucune
 * synchronisation n'est possible ; le seul chemin est le fichier que QuickBooks
 * exporte (Banque → Règles → Exporter), en Excel ou en CSV.
 *
 * Comme on ne connaît pas d'avance l'ordre ni la langue des colonnes, la
 * reconnaissance est TOLÉRANTE (même esprit que la lecture de TRX_Orisha), et
 * rien n'est importé sans aperçu : chaque règle du fichier s'affiche à côté de
 * ce qu'elle deviendrait dans Boréal, et **ce qui ne se résout pas est signalé,
 * jamais inventé**.
 */
import * as XLSX from 'xlsx'
import { decodeQbConditions, extractJsonBlob } from './qbConditions.js'

const strip = (v) => String(v ?? '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()

// Un en-tête → le rôle qu'il joue. Les libellés QuickBooks varient selon la
// langue de l'entreprise et la version de l'export : on accepte les deux.
const ROLES = [
  ['name', /^(nom|rule name|name|nom de la regle|regle)$/],
  ['condition_text', /(condition|si|when|criteres?|criteria)/],
  ['amount_text', /(montant|amount)/],
  ['direction', /(argent|money|type de transaction|transaction type|sens|depenses? ou revenus?)/],
  ['account_name', /(compte|account|categorie|category)/],
  ['vendor_name', /(fournisseur|beneficiaire|payee|vendor|client|customer|nom du tiers)/],
  ['tax_name', /(taxe|tax|tva|tps)/],
  ['memo', /(memo|note|description|libelle)/],
  ['bank_account', /(compte bancaire|bank account|compte de banque)/],
  ['priority', /(priorite|priority|ordre|order|rang)/],
]

export function mapRuleColumns(headerCells) {
  const cols = {}
  headerCells.forEach((raw, i) => {
    const c = strip(raw)
    if (!c) return
    for (const [role, re] of ROLES) {
      if (cols[role] == null && re.test(c)) { cols[role] = i; return }
    }
  })
  return cols
}

// L'en-tête est la première ligne qui porte au moins deux rôles reconnus : les
// exports QuickBooks commencent souvent par un titre et une ligne vide.
export function findRuleHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cols = mapRuleColumns(Array.from(rows[i] || []))
    if (Object.keys(cols).length >= 2 && cols.name != null) return { index: i, cols }
  }
  return { index: -1, cols: {} }
}

const MONEY = /-?[\d\s.,]+/

export function parseAmountRange(text) {
  const t = String(text || '').trim()
  if (!t) return { amount_min: null, amount_max: null }
  const nums = (t.match(new RegExp(MONEY, 'g')) || [])
    .map((x) => Number(x.replace(/\s/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(/,/g, '.')))
    .filter((n) => Number.isFinite(n) && n !== 0)
  if (!nums.length) return { amount_min: null, amount_max: null }
  if (/entre|between/i.test(t) && nums.length >= 2) return { amount_min: Math.min(...nums), amount_max: Math.max(...nums) }
  if (/plus (grand|de)|greater|superieur|>/i.test(t)) return { amount_min: nums[0], amount_max: null }
  if (/moins|less|inferieur|</i.test(t)) return { amount_min: null, amount_max: nums[0] }
  // « est égal à 149,00 » : une égalité devient une fourchette d'un cent.
  return { amount_min: Math.abs(nums[0]) - 0.01, amount_max: Math.abs(nums[0]) + 0.01 }
}

// La condition QuickBooks s'écrit « La description contient NOVO EXPRESS ».
// On ne garde que la valeur — c'est elle qui devient le motif par jetons.
export function parseCondition(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const m = /(?:contient|contains|est|is|equals|commence par|starts with)\s+(.+)$/i.exec(t)
  return (m ? m[1] : t).replace(/^["']|["']$/g, '').trim() || null
}

export function parseDirection(text) {
  const t = strip(text)
  if (!t) return 'sortie'
  if (/(revenu|money in|depot|entree|income|deposit|received)/.test(t)) return 'entree'
  return 'sortie'
}

/**
 * Le fichier → des règles candidates, chacune avec ce qui n'a PAS pu être
 * résolu. Rien n'est écrit : c'est l'aperçu.
 *
 * @param buffer        contenu du fichier (xlsx, xls ou csv)
 * @param resolve       { account(name) → id|null, taxCode(name) → id|null,
 *                        vendor(name) → {id,name}|null, bankAccount(name) → id|null }
 */
export function readQbRulesFile(buffer, resolve = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return { rules: [], warnings: ['Fichier vide'] }
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false })
  const { index, cols } = findRuleHeader(grid)
  if (index < 0) {
    return { rules: [], warnings: ['Aucune ligne d\'entêtes reconnue — est-ce bien l\'export des règles de QuickBooks ?'] }
  }

  const warnings = []
  const rules = []
  for (let r = index + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const cell = (role) => (cols[role] == null ? '' : String(row[cols[role]] ?? '').trim())
    const name = cell('name')
    if (!name) continue

    // QuickBooks n'exporte pas une phrase mais sa structure interne, parfois
    // éclatée sur plusieurs cellules : on la rassemble depuis la ligne entière.
    const decoded = decodeQbConditions(extractJsonBlob(row) || cell('condition_text'))
    const pattern = decoded ? decoded.summary : (parseCondition(cell('condition_text')) || name)
    const range = decoded ? { amount_min: null, amount_max: null } : parseAmountRange(cell('amount_text'))
    const { amount_min, amount_max } = range
    const accountName = cell('account_name')
    const taxName = cell('tax_name')
    const vendorName = cell('vendor_name')
    const bankName = cell('bank_account')

    const account = accountName ? (resolve.account?.(accountName) || null) : null
    const taxCode = taxName ? (resolve.taxCode?.(taxName) || null) : null
    const vendor = vendorName ? (resolve.vendor?.(vendorName) || null) : null
    const bankAccount = bankName ? (resolve.bankAccount?.(bankName) || null) : null

    // Ce qu'on n'a pas su traduire : affiché, jamais deviné.
    const unresolved = []
    if (accountName && !account) unresolved.push(`compte « ${accountName} » introuvable`)
    if (taxName && !taxCode) unresolved.push(`code de taxe « ${taxName} » introuvable`)
    if (vendorName && !vendor) unresolved.push(`fournisseur « ${vendorName} » sans profil`)
    if (bankName && !bankAccount) unresolved.push(`compte bancaire « ${bankName} » non reconnu`)
    for (const u of decoded?.unknown || []) unresolved.push(u)
    if (!decoded && extractJsonBlob(row)) unresolved.push('conditions illisibles — règle à réécrire à la main')

    rules.push({
      source_row: r + 1,
      source: { name, condition: cell('condition_text'), amount: cell('amount_text'), account: accountName, tax: taxName, vendor: vendorName, bank: bankName },
      rule: {
        name,
        label_pattern: pattern,
        // La liste détaillée fait autorité ; le motif ci-dessus n'en est que le
        // résumé lisible.
        conditions: decoded ? JSON.stringify({ mode: decoded.mode, terms: decoded.terms }) : null,
        direction: decoded?.direction || parseDirection(cell('direction')),
        amount_min, amount_max,
        account_id: bankAccount,
        vendor_name: vendor?.name || vendorName || null,
        vendor_profile_id: vendor?.id || null,
        expense_account_id: account,
        tax_code_id: taxCode,
        memo: cell('memo') || null,
        priority: Number(cell('priority')) || 100,
        origin: 'quickbooks',
      },
      unresolved,
    })
  }
  if (!rules.length) warnings.push('Entêtes reconnues, mais aucune règle lisible dans le fichier')
  return { rules, warnings, columns: Object.keys(cols) }
}
