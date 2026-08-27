// Import du relevé de transactions du portail CARM (GCRA) de l'ASFC.
//
// Le portail (connexion GCKey + MFA) n'offre aucune API publique aux
// importateurs : le relevé — historique de transactions ou relevé de compte —
// est téléchargé à la main puis collé/déposé dans l'onglet Douanes des comptes
// prépayés (/comptes-prepayes?onglet=douanes). Le parseur est volontairement
// tolérant : CSV / TSV / point-virgule / Excel converti, en-têtes EN ou FR
// (exactes ou approchées), colonnes débit/crédit, préambule de plusieurs
// lignes, lignes de totaux ; et à défaut d'en-têtes exploitables il infère les
// colonnes (date, montants, numéro de transaction) par leur contenu.
//
// Idempotent : chaque ligne porte une clé naturelle (date + type + numéro +
// montant + solde + rang d'occurrence) — ré-importer le même relevé n'insère
// rien, et une ligne supprimée dans l'ERP ne ressuscite pas.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { getCarmConfig } from './carmAccount.js'
import { classifyCarmLine } from './carmRules.js'
import { recomputeCarm } from './carmPosting.js'

const strip = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

const MONTHS = {
  jan: 1, janv: 1, january: 1, janvier: 1,
  feb: 2, fev: 2, february: 2, fevrier: 2,
  mar: 3, mars: 3, march: 3,
  apr: 4, avr: 4, april: 4, avril: 4,
  may: 5, mai: 5,
  jun: 6, juin: 6, june: 6,
  jul: 7, juil: 7, july: 7, juillet: 7,
  aug: 8, aout: 8, august: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, decembre: 12,
}

const pad = n => String(n).padStart(2, '0')
const validYmd = (y, m, d) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31

// « 2026-08-03 », « 03/08/2026 » (jour d'abord, convention maison — voir
// parseFrDate de pmtSuiviImport), « August 3, 2026 », « 3 août 2026 »,
// « 03-AUG-2026 », « 2026-08-03 14:22 » → ISO.
export function parseCarmDate(v) {
  const raw = String(v ?? '').trim().replace(/^["']|["']$/g, '')
  if (!raw) return null
  let m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(raw)
  if (m && validYmd(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\D|$)/.exec(raw)
  if (m) {
    let d = +m[1], mo = +m[2]
    if (mo > 12 && d <= 12) [d, mo] = [mo, d] // clairement mois/jour → on répare
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3] // « 15/07/26 » (export Excel)
    if (validYmd(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`
    return null
  }
  m = /^(\d{1,2})[\s-]([a-zA-ZÀ-ÿ.]{3,})[\s-](\d{4})/.exec(raw) // 03-AUG-2026 / 3 août 2026
  if (m) m = [m[0], m[2], m[1], m[3]]
  if (!m) m = /^([a-zA-ZÀ-ÿ.]+)\s+(\d{1,2})(?:er)?,?\s+(\d{4})/.exec(raw) // August 3, 2026
  if (!m) {
    const m2 = /^(\d{1,2})(?:er)?\s+([a-zA-ZÀ-ÿ.]+),?\s+(\d{4})/.exec(raw) // 3 août 2026
    if (m2) m = [m2[0], m2[2], m2[1], m2[3]]
  }
  if (m) {
    const mo = MONTHS[strip(m[1]).replace(/\.$/, '')]
    if (mo && validYmd(+m[3], mo, +m[2])) return `${m[3]}-${pad(mo)}-${pad(+m[2])}`
  }
  return null
}

// « 1,234.56 $ » / « 1 234,56 » / « (500.00) » / « -500 » / « 500.00 CR » → nombre signé.
export function parseCarmAmount(v) {
  let raw = String(v ?? '').trim().replace(/^["']|["']$/g, '')
  if (!raw || /^-+$/.test(raw)) return null
  let neg = false
  if (/^\(.*\)$/.test(raw)) { neg = true; raw = raw.slice(1, -1) }
  if (/\bcr\b/i.test(raw)) { neg = true }
  raw = raw.replace(/\bcr\b|\bdr\b|cad|usd|\$/gi, '').replace(/[\s\u00a0\u202f]/g, '')
  if (raw.startsWith('-')) { neg = true; raw = raw.slice(1) }
  if (raw.endsWith('-')) { neg = true; raw = raw.slice(0, -1) } // 500.00- (export mainframe)
  if (!raw) return null
  const lastComma = raw.lastIndexOf(','), lastDot = raw.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    // Les deux présents : le dernier est le séparateur décimal.
    raw = lastComma > lastDot
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '')
  } else if (lastComma >= 0) {
    // Virgule seule : décimale si elle isole 1-2 chiffres, sinon milliers.
    raw = /,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

// Découpe une ligne CSV en respectant les guillemets.
function splitLine(line, delim) {
  const out = []
  let cur = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (c === delim && !inQuotes) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map(s => s.trim())
}

// Découpe le texte en enregistrements : un saut de ligne à l'intérieur de
// guillemets (description multi-lignes du portail) ne coupe pas la ligne.
function splitRecords(text) {
  const out = []
  let cur = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { inQuotes = !inQuotes; cur += c }
    else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && text[i + 1] === '\n') i++
      out.push(cur); cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

const DELIMS = ['\t', ';', ',', '|']

// Le délimiteur retenu est celui qui donne le découpage le plus large ET le
// plus régulier sur l'échantillon — un « ; » isolé dans une description ne
// suffit plus à faire basculer un CSV à virgules.
function detectDelimiter(lines) {
  const sample = lines.slice(0, 40)
  let best = ',', bestScore = 0
  for (const d of DELIMS) {
    const freq = new Map()
    for (const l of sample) {
      const n = splitLine(l, d).length
      if (n > 1) freq.set(n, (freq.get(n) || 0) + 1)
    }
    for (const [n, hits] of freq) {
      const score = n * hits
      if (score > bestScore) { bestScore = score; best = d }
    }
  }
  return best
}

// Colonnes reconnues dans la ligne d'en-têtes (EN et FR, accents ignorés).
// Les listes servent de correspondance exacte ; à défaut, matchHeader retombe
// sur des mots-clés — le portail varie ses libellés (« Total amount (CAD) »,
// « Montant de la transaction ($ CA) », « Amount owing »…).
const HEADERS = {
  date: ['transaction date', 'date de transaction', 'date de la transaction', 'posting date', 'date d\'affichage', 'date'],
  due_date: ['due date', 'date d\'echeance', 'echeance', 'payment due date'],
  type: ['transaction type', 'type de transaction', 'type', 'activity', 'activite'],
  number: ['transaction number', 'numero de transaction', 'no de transaction', 'transaction no', 'reference number', 'numero de reference', 'reference', 'numero', 'no'],
  description: ['description', 'details', 'libelle', 'sub type', 'sous-type'],
  detail: ['description detaillee', 'detailed description', 'transaction description', 'nature', 'nature de la transaction'],
  party: ['fournisseur', 'nom du fournisseur', 'supplier', 'vendor', 'payeur', 'payer', 'trade chain partner', 'partenaire de la chaine commerciale', 'client'],
  amount: ['amount', 'montant', 'amount (cad)', 'montant ($ ca)', 'transaction amount', 'montant de la transaction', 'total'],
  balance: ['balance', 'solde', 'account balance', 'solde du compte', 'running balance'],
  debit: ['debit', 'debits', 'charge', 'charges', 'withdrawal', 'retrait'],
  credit: ['credit', 'credits', 'payment', 'paiement', 'deposit', 'depot'],
}

// Normalise un libellé : accents, guillemets, parenthèses de devise, symboles.
// « Transaction amount (CAD $) » → « transaction amount ».
function normHeader(cell) {
  return strip(cell)
    .replace(/["']/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\$|\bcad\b|\bcan\b|\busd\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Mots-clés de repli, testés dans l'ordre (le plus spécifique d'abord).
const HEADER_KEYWORDS = [
  ['due_date', /due|echeance|exigib/],
  ['date', /\bdate[ds]?\b|\bjour\b/],
  ['debit', /\bdebit|\bcharge|retrait/],
  ['credit', /\bcredit|paiement|\bpayment\b|depot|deposit/],
  ['balance', /balance|solde/],
  ['amount', /amount|montant|\btotal\b|owing|somme|valeur|\bvalue\b/],
  ['type', /\btype\b|activit|categor|nature/],
  ['party', /fournisseur|supplier|vendor|payeur|\bpayer\b|trade chain|partenaire/],
  ['number', /number|numero|\bno\b|\bnum\b|reference|\bref\b|\bid\b|declaration/],
  ['detail', /descript\w* detaill|detailed descript|\bnature\b/],
  ['description', /descript|detail|libelle|remark|note|commentaire|sub type|sous type/],
]

function matchHeader(cell) {
  const s = normHeader(cell)
  if (!s) return null
  for (const [key, names] of Object.entries(HEADERS)) {
    if (names.some(n => normHeader(n) === s)) return key
  }
  for (const [key, re] of HEADER_KEYWORDS) {
    if (re.test(s)) return key
  }
  return null
}

// Pieds de page et lignes de sommaire du relevé : ignorés sans erreur.
const NOISE_ROW = /^(total|totaux|sous-total|subtotal|solde d'ouverture|opening balance|closing balance|solde de cloture|page \d|generated|genere|imprime|printed|fin du|end of|aucune|no records|no data)/

// Ressemble à un numéro de transaction CARM (ex. « CAD-2026-0812345 », « 24BSF123456 »).
const looksLikeNumber = s => /^[A-Z0-9][A-Z0-9/-]{4,}$/i.test(s) && /\d{3,}/.test(s) && !parseCarmDate(s)

// Inférence d'une ligne par son seul contenu : date = première cellule-date ;
// montants = cellules numériques restantes (1re = montant, dernière = solde) ;
// numéro = cellule qui y ressemble ; le reste du texte = type/description.
function inferRow(cells) {
  const dateIdx = cells.findIndex(c => parseCarmDate(c))
  if (dateIdx < 0) return null
  const rest = cells.filter((_, j) => j !== dateIdx)
  const nums = [], texts = []
  for (const c of rest) {
    const n = parseCarmAmount(c)
    if (n != null && !looksLikeNumber(c)) nums.push(n)
    else if (c) texts.push(c)
  }
  if (!nums.length) return null
  const numberIdx = texts.findIndex(looksLikeNumber)
  const transaction_number = numberIdx >= 0 ? texts.splice(numberIdx, 1)[0] : null
  return {
    transaction_date: parseCarmDate(cells[dateIdx]),
    due_date: null,
    transaction_type: texts[0] || null,
    transaction_number,
    description: texts.slice(1).join(' · ') || null,
    amount: nums[0],
    balance: nums.length > 1 ? nums[nums.length - 1] : null,
  }
}

const isNoiseRow = cells => {
  const joined = strip(cells.join(' '))
  return !joined || NOISE_ROW.test(joined)
}

const MAX_ERRORS = 25

// Analyse le texte du relevé. Pur : aucune écriture, aucune lecture DB.
// Retourne aussi `columns` (correspondance de colonnes retenue) et `notes`
// (réparations faites en chemin) — affichés dans l'aperçu avant import.
export function parseCarmStatement(text) {
  const clean = String(text || '').replace(/^\ufeff/, '')
  const records = splitRecords(clean)
    .map(l => l.replace(/[\u00a0\u202f]/g, ' '))
    .filter(l => l.trim())
  if (!records.length) return { rows: [], errors: ['relevé vide'], header_found: false, columns: {}, notes: [] }
  const delim = detectDelimiter(records)
  const notes = []

  // Ligne d'en-têtes = la ligne (parmi les 30 premières) qui reconnaît le plus
  // de colonnes, avec au moins une date ou un montant, et qui n'est pas déjà
  // une ligne de données (une cellule-date la disqualifie). Les colonnes
  // reconnues en double (deux « Amount ») sont gardées comme alternatives.
  let headerIdx = -1, cols = null, alts = {}
  for (let i = 0; i < Math.min(records.length, 30); i++) {
    const cells = splitLine(records[i], delim)
    if (cells.some(c => parseCarmDate(c))) continue
    const found = {}, extra = {}
    cells.forEach((c, j) => {
      const k = matchHeader(c)
      if (!k) return
      if (found[k] == null) found[k] = j
      else (extra[k] ||= []).push(j)
    })
    const hasMoney = found.amount != null || found.debit != null || found.credit != null
    const score = Object.keys(found).length
    if (score >= 2 && (found.date != null || hasMoney)) {
      if (!cols || score > Object.keys(cols).length) { headerIdx = i; cols = found; alts = extra }
      if (score >= 4) break // en-tête franche : inutile de chercher plus loin
    }
  }

  const dataLines = records.slice(headerIdx + 1).map(raw => ({ raw, cells: splitLine(raw, delim) }))

  // Vérification des colonnes contre les données : le portail exporte parfois
  // une colonne « Amount » vide (le montant vit alors dans « Total », dans une
  // colonne sans en-tête reconnue, ou dans une paire débit/crédit). On mesure
  // par colonne la proportion de cellules lisibles comme montant ou comme date,
  // et on répare la correspondance quand la colonne déclarée est muette.
  const body = dataLines.filter(d => !isNoiseRow(d.cells))
  const width = Math.max(0, ...body.map(d => d.cells.length))
  const ratioOf = fn => {
    const out = []
    for (let j = 0; j < width; j++) {
      let ok = 0
      for (const d of body) if (fn(d.cells[j] ?? '')) ok++
      out[j] = body.length ? ok / body.length : 0
    }
    return out
  }
  const amountRatio = ratioOf(c => !!c && !looksLikeNumber(c) && parseCarmAmount(c) != null)
  const dateRatio = ratioOf(c => parseCarmDate(c) != null)
  const headerCells = headerIdx >= 0 ? splitLine(records[headerIdx], delim) : []
  const label = j => headerCells[j] || `colonne ${j + 1}`

  let dateCols = [], amountCols = [], balanceCols = []
  if (cols) {
    dateCols = [cols.date, ...(alts.date || [])].filter(j => j != null)
    balanceCols = [cols.balance, ...(alts.balance || [])].filter(j => j != null)
    amountCols = [cols.amount, ...(alts.amount || [])].filter(j => j != null)

    if (!dateCols.length || dateRatio[dateCols[0]] < 0.5) {
      const better = dateRatio.map((r, j) => ({ r, j }))
        .filter(x => x.r >= 0.7 && !dateCols.includes(x.j))
        .sort((a, b) => b.r - a.r)[0]
      if (better) {
        notes.push(dateCols.length
          ? `colonne de date « ${label(dateCols[0])} » vide — date lue dans « ${label(better.j)} »`
          : `aucune colonne de date nommée — date lue dans « ${label(better.j)} »`)
        dateCols = [better.j, ...dateCols]
      }
    }
    const declared = amountCols[0]
    if (declared == null || amountRatio[declared] < 0.5) {
      const excluded = new Set([...dateCols, ...balanceCols])
      const better = amountRatio.map((r, j) => ({ r, j }))
        .filter(x => x.r >= 0.6 && !excluded.has(x.j) && !amountCols.includes(x.j))
        .sort((a, b) => b.r - a.r)
      if (better.length) amountCols = [...better.map(x => x.j), ...amountCols]
      // Colonne effectivement porteuse : la première qui contient vraiment des
      // montants (une colonne « Amount » vide se fait doubler par sa voisine).
      const effective = amountCols.find(j => amountRatio[j] >= 0.5)
      if (effective != null && effective !== declared) {
        notes.push(declared != null
          ? `colonne de montant « ${label(declared)} » vide — montant lu dans « ${label(effective)} »`
          : `aucune colonne de montant nommée — montant lu dans « ${label(effective)} »`)
      }
    }
    if (cols.debit != null || cols.credit != null) notes.push('colonnes débit/crédit combinées en un montant signé')
  }

  const rows = []
  const errors = []
  const seen = new Map()
  let dropped = 0
  for (let i = 0; i < dataLines.length; i++) {
    const { raw, cells } = dataLines[i]
    const lineNo = headerIdx + 2 + i
    if (!cells.some(c => c)) continue
    if (isNoiseRow(cells)) continue
    let row = null
    if (cols) {
      const at = j => (j != null && cells[j] != null ? cells[j] : '')
      const pick = k => at(cols[k])
      const firstOf = (idxs, fn) => { for (const j of idxs) { const v = fn(at(j)); if (v != null) return v } return null }
      const transaction_date = firstOf(dateCols, parseCarmDate)
        ?? parseCarmDate(cells.find(c => parseCarmDate(c)))
      let amount = firstOf(amountCols, c => (looksLikeNumber(c) ? null : parseCarmAmount(c)))
      if (amount == null && (cols.debit != null || cols.credit != null)) {
        const debit = parseCarmAmount(pick('debit'))
        const credit = parseCarmAmount(pick('credit'))
        if (debit) amount = Math.abs(debit)
        else if (credit) amount = -Math.abs(credit)
        else if (debit != null || credit != null) amount = 0
      }
      if (amount == null && transaction_date != null) {
        // Dernier recours : n'importe quelle cellule numérique de la ligne qui
        // n'est ni la date, ni le solde, ni un numéro de transaction.
        const excluded = new Set([...dateCols, ...balanceCols, cols.number].filter(j => j != null))
        for (let j = 0; j < cells.length; j++) {
          if (excluded.has(j)) continue
          const c = cells[j]
          if (!c || looksLikeNumber(c)) continue
          const n = parseCarmAmount(c)
          if (n != null) { amount = n; break }
        }
      }
      if (transaction_date != null && amount != null) {
        row = {
          transaction_date,
          due_date: parseCarmDate(pick('due_date')),
          transaction_type: pick('type') || null,
          transaction_number: pick('number') || null,
          description: pick('description') || null,
          detail: pick('detail') || null,
          party: pick('party') || null,
          amount,
          balance: balanceCols.length ? firstOf(balanceCols, parseCarmAmount) : null,
        }
      } else {
        // En-têtes prises en défaut sur cette ligne : on retente en inférant
        // tout par le contenu avant de la déclarer illisible.
        row = inferRow(cells)
        if (row) {
          if (pick('type')) row.transaction_type = pick('type')
          if (pick('number')) row.transaction_number = pick('number')
          if (pick('detail')) row.detail = pick('detail')
          if (pick('party')) row.party = pick('party')
        } else {
          if (transaction_date == null && amount == null) continue // ligne de bruit
          const what = transaction_date == null ? 'date' : 'montant'
          const cell = transaction_date == null ? at(dateCols[0]) : at(amountCols[0])
          if (errors.length < MAX_ERRORS) errors.push(`ligne ${lineNo} : ${what} illisible « ${cell} » — ${raw.slice(0, 100)}`)
          else dropped++
          continue
        }
      }
    } else {
      row = inferRow(cells)
      if (!row) {
        const hasDate = cells.some(c => parseCarmDate(c))
        const hasAmount = cells.some(c => c && !looksLikeNumber(c) && parseCarmAmount(c) != null)
        // Ni date ni montant : en-tête non reconnue, titre de rapport, séparateur…
        // Rien à signaler — seule une ligne à moitié lisible est une erreur.
        if (!hasDate && !hasAmount) continue
        const what = hasDate ? 'montant introuvable' : 'date introuvable'
        if (errors.length < MAX_ERRORS) errors.push(`ligne ${lineNo} : ${what} — ${raw.slice(0, 100)}`)
        else dropped++
        continue
      }
    }
    const base = `${row.transaction_date}|${strip(row.transaction_type)}|${strip(row.transaction_number)}|${row.amount.toFixed(2)}|${row.balance == null ? '' : row.balance.toFixed(2)}`
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    row.import_key = `carm:${base}|${n}`
    rows.push(row)
  }
  if (dropped) errors.push(`… et ${dropped} autre(s) ligne(s) illisible(s)`)

  const columns = {}
  if (cols) {
    for (const [k, j] of Object.entries(cols)) columns[k] = label(j)
    if (dateCols.length) columns.date = label(dateCols[0])
    if (amountCols.length) columns.amount = label(amountCols[0])
  }
  return { rows, errors, header_found: !!cols, columns, notes, delimiter: delim }
}

// ── Reçus ASFC dans l'extracteur ─────────────────────────────────────────────
// Les factures/reçus du portail CARM arrivent par l'extracteur de données
// (sale_receipts) sous « Canada Border Services Agency ». Le filtre couvre les
// variantes EN/FR du nom, via le profil fournisseur ou le champ company.
const CBSA_LIKE = ['%border services%', '%frontaliers%', '%cbsa%', '%asfc%', '%carm%', '%gcra%']

export function cbsaReceipts() {
  const conds = CBSA_LIKE.map(() => 'LOWER(COALESCE(vp.name, \'\')) LIKE ?')
    .concat(CBSA_LIKE.map(() => 'LOWER(COALESCE(sr.company, \'\')) LIKE ?')).join(' OR ')
  return db.prepare(`
    SELECT sr.id, sr.receipt_date, sr.total, sr.currency, sr.company, sr.original_name,
           sr.quickbooks_id, sr.quickbooks_type, sr.created_at
    FROM sale_receipts sr
    LEFT JOIN vendor_profiles vp ON vp.id = sr.vendor_profile_id
    WHERE sr.deleted_at IS NULL AND sr.status = 'done' AND (${conds})
    ORDER BY sr.receipt_date DESC, sr.created_at DESC
  `).all(...CBSA_LIKE, ...CBSA_LIKE)
}

// Appariement automatique transaction ↔ reçu : même montant (au cent près, en
// valeur absolue — le relevé signe les paiements en négatif) et dates à ≤ 30
// jours d'écart ; le reçu le plus proche en date gagne. Jamais de ré-appariement
// d'une ligne déjà liée (auto ou manuel).
export function autoMatchCarm() {
  // match_source 'dissocié' = délié à la main : on respecte le choix de
  // l'utilisateur et on ne ré-apparie jamais cette ligne automatiquement.
  const txns = db.prepare(`
    SELECT id, transaction_date, amount FROM carm_transactions
    WHERE deleted_at IS NULL AND sale_receipt_id IS NULL
      AND COALESCE(match_source, '') != 'dissocié'
  `).all()
  if (!txns.length) return 0
  const linked = new Set(db.prepare(`
    SELECT sale_receipt_id FROM carm_transactions
    WHERE deleted_at IS NULL AND sale_receipt_id IS NOT NULL
  `).all().map(r => r.sale_receipt_id))
  const receipts = cbsaReceipts().filter(r => r.total != null && r.receipt_date)
  const upd = db.prepare(`
    UPDATE carm_transactions SET sale_receipt_id = ?, match_source = 'auto',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `)
  let matched = 0
  const used = new Set()
  const bestReceipt = (target, dateIso) => {
    const days = r => Math.abs((new Date(r.receipt_date) - new Date(dateIso)) / 86400000)
    return receipts
      .filter(r => !linked.has(r.id) && Math.abs(r.total - target) < 0.005 && days(r) <= 30)
      .sort((a, b) => days(a) - days(b))[0]
  }

  // 1) Ligne à ligne : un reçu = une ligne du relevé.
  for (const t of txns) {
    const best = bestReceipt(Math.abs(t.amount), t.transaction_date)
    if (!best) continue
    upd.run(best.id, t.id)
    linked.add(best.id)
    used.add(t.id)
    matched++
  }

  // 2) Par groupe : l'ASFC éclate un versement en autant d'applications que de
  // charges réglées — le paiement de 500 $ du 3 août 2026 apparaît en −297,32
  // et −202,68, et aucune ligne seule n'égale le montant du reçu. Les lignes
  // qui partagent la même date et le même numéro de transaction forment donc
  // un groupe, apparié sur la somme ; toutes pointent alors le même reçu.
  const groups = new Map()
  for (const t of txns) {
    if (used.has(t.id)) continue
    const key = `${t.transaction_date}|${(t.transaction_number || '').trim().toLowerCase()}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  for (const [, lines] of groups) {
    if (lines.length < 2) continue
    const sum = lines.reduce((s, t) => s + t.amount, 0)
    const best = bestReceipt(Math.abs(sum), lines[0].transaction_date)
    if (!best) continue
    for (const t of lines) { upd.run(best.id, t.id); matched++ }
    linked.add(best.id)
  }
  return matched
}

// Aperçu avant import : ce que le parseur a compris (colonnes, réparations,
// premières lignes) et ce qui serait créé vs déjà connu. Aucune écriture.
export function previewCarmStatement(text) {
  const { rows, errors, header_found, columns, notes } = parseCarmStatement(text)
  const brokerNames = String(getCarmConfig().broker_names || '').split(',').map(x => x.trim()).filter(Boolean)
  const exists = db.prepare('SELECT id FROM carm_transactions WHERE import_key = ?')
  let known = 0
  const sample = []
  for (const r of rows) {
    const dup = !!exists.get(r.import_key)
    if (dup) known++
    // L'aperçu montre déjà la nature et la ventilation que l'import va poser :
    // l'utilisateur voit ce que le moteur a compris AVANT toute écriture.
    if (sample.length < 12) sample.push({ ...r, already_known: dup, ...classifyCarmLine(r, { brokerNames }) })
  }
  return {
    parsed: rows.length,
    to_create: rows.length - known,
    already_known: known,
    errors,
    header_found,
    columns,
    notes,
    sample,
  }
}

// Import complet d'un relevé collé/déposé. Les lignes déjà connues (même clé,
// y compris supprimées dans l'ERP) sont ignorées.
export function importCarmStatement(text, userId = null) {
  const { rows, errors, header_found, columns, notes } = parseCarmStatement(text)
  const brokerNames = String(getCarmConfig().broker_names || '').split(',').map(x => x.trim()).filter(Boolean)
  let created = 0, skipped = 0
  const exists = db.prepare('SELECT id FROM carm_transactions WHERE import_key = ?')
  const insert = db.prepare(`
    INSERT INTO carm_transactions (id, transaction_date, due_date, transaction_type,
      transaction_number, description, detail, party, amount, balance, import_key, source, created_by,
      category, kind, payer, broker, duty_amount, gst_amount, split_source, split_rule)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'import',?,?,?,?,?,?,?,'auto',?)
  `)
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (exists.get(r.import_key)) { skipped++; continue }
      // La nature et la ventilation droits/TPS sont posées dès l'insertion : le
      // relevé dit lui-même ce qu'est chaque ligne, rien à saisir à la main.
      const c = classifyCarmLine(r, { brokerNames })
      insert.run(randomUUID(), r.transaction_date, r.due_date, r.transaction_type,
        r.transaction_number, r.description, r.detail || null, r.party || null,
        r.amount, r.balance, r.import_key, userId,
        c.category, c.kind, c.payer, c.broker, c.duty_amount, c.gst_amount, c.rule)
      created++
    }
  })
  tx()
  const matched = created ? autoMatchCarm() : 0
  // Imputation : paires courtier, lettrage FIFO, états de comptabilisation.
  const imputation = recomputeCarm()
  return { created, skipped, matched, imputation, parsed: rows.length, errors, header_found, columns, notes }
}
