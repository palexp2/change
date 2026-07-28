import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { normalizeVendorKey } from './vendorDirectory.js'

// Profils fournisseurs : défauts comptables par fournisseur, appris automatiquement
// à chaque publication QB et éditables dans la page /fournisseurs. C'est ce qui permet
// à l'extraction de pré-remplir le bon vendor QB (dans la bonne devise), le compte de
// dépense, le compte de paiement, le type de transaction, le code de taxe et l'échéance
// — au lieu de redemander les mêmes choix à chaque facture.

function parseAliases(raw) {
  try {
    const a = JSON.parse(raw || '[]')
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()) : []
  } catch { return [] }
}

export function serializeProfile(row) {
  if (!row) return null
  return { ...row, aliases: parseAliases(row.aliases) }
}

// Cherche le profil correspondant à un nom extrait : match exact (à la normalisation
// près — accents/casse/ponctuation) sur le nom canonique OU l'un des alias.
export function findVendorProfile(name) {
  const key = normalizeVendorKey(name)
  if (!key) return null
  const rows = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL').all()
  for (const row of rows) {
    if (normalizeVendorKey(row.name) === key) return serializeProfile(row)
    if (parseAliases(row.aliases).some(a => normalizeVendorKey(a) === key)) return serializeProfile(row)
  }
  return null
}

// Défauts applicables pour une devise donnée (les champs par devise sont résolus).
export function profileDefaultsForCurrency(profile, currency) {
  if (!profile) return null
  const usd = String(currency || 'CAD').toUpperCase() === 'USD'
  return {
    qb_vendor_id: usd ? profile.qb_vendor_id_usd : profile.qb_vendor_id_cad,
    qb_type: profile.default_qb_type || null,
    expense_account_id: profile.default_expense_account_id || null,
    payment_account_id: usd ? profile.default_payment_account_id_usd : profile.default_payment_account_id_cad,
    transaction_type: profile.default_transaction_type || null,
    tax_code_id: usd ? profile.default_tax_code_id_usd : profile.default_tax_code_id_cad,
    payment_terms_days: profile.payment_terms_days ?? null,
  }
}

// Enregistre (upsert) ce qui vient d'être effectivement publié sur QB : le profil du
// fournisseur apprend le vendor QB de la devise de la transaction, le type d'entité,
// les comptes, le type de transaction et le code de taxe. Appelé après CHAQUE push
// réussi — la prochaine facture du même fournisseur arrive donc pré-remplie.
// `company` = nom canonique extrait ; `usedName` = nom saisi si nouveau vendor créé.
export function learnFromPush({ company, txnCurrency, type, expenseAccountId, paymentAccountId, taxCodeId, transactionType, vendorId, termsDays }) {
  const name = String(company || '').trim()
  if (!name) return null
  const usd = String(txnCurrency || 'CAD').toUpperCase() === 'USD'
  let profile = findVendorProfile(name)
  if (!profile) {
    const id = uuid()
    db.prepare('INSERT INTO vendor_profiles (id, name) VALUES (?,?)').run(id, name)
    profile = serializeProfile(db.prepare('SELECT * FROM vendor_profiles WHERE id=?').get(id))
  } else if (normalizeVendorKey(profile.name) !== normalizeVendorKey(name)
    && !profile.aliases.some(a => normalizeVendorKey(a) === normalizeVendorKey(name))) {
    // Nom rencontré sous une variante non répertoriée → mémorisé comme alias.
    db.prepare('UPDATE vendor_profiles SET aliases=? WHERE id=?')
      .run(JSON.stringify([...profile.aliases, name]), profile.id)
  }

  const sets = []
  const values = []
  const set = (col, val) => { if (val != null && val !== '') { sets.push(`${col}=?`); values.push(val) } }
  set(usd ? 'qb_vendor_id_usd' : 'qb_vendor_id_cad', vendorId)
  set('default_qb_type', ['purchase', 'bill', 'cc_credit'].includes(type) ? type : null)
  set('default_expense_account_id', expenseAccountId)
  if (type !== 'bill') set(usd ? 'default_payment_account_id_usd' : 'default_payment_account_id_cad', paymentAccountId)
  set('default_transaction_type', transactionType)
  // taxCodeId null = « aucune taxe » choisie explicitement — mémorisée via le sentinel.
  set(usd ? 'default_tax_code_id_usd' : 'default_tax_code_id_cad', taxCodeId || '__none__')
  if (Number.isInteger(termsDays) && termsDays > 0) set('payment_terms_days', termsDays)
  if (sets.length) {
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    values.push(profile.id)
    db.prepare(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id=?`).run(...values)
  }
  return profile.id
}

// Amorçage : crée un profil pour chaque fournisseur du répertoire Drive et chaque
// fournisseur déjà comptabilisé (sale_receipts publiés), puis remplit les défauts
// depuis la transaction publiée la plus récente PAR DEVISE. Idempotent : ne crée pas
// de doublon et ne remplit que les champs encore vides (n'écrase jamais une édition).
export function seedVendorProfiles() {
  const existing = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL').all().map(serializeProfile)
  const byKey = new Map()
  for (const p of existing) {
    byKey.set(normalizeVendorKey(p.name), p)
    for (const a of p.aliases) byKey.set(normalizeVendorKey(a), p)
  }
  let created = 0

  const ensure = (name) => {
    const key = normalizeVendorKey(name)
    if (!key) return null
    let p = byKey.get(key)
    if (p) return p
    const id = uuid()
    db.prepare('INSERT INTO vendor_profiles (id, name) VALUES (?,?)').run(id, String(name).trim())
    p = serializeProfile(db.prepare('SELECT * FROM vendor_profiles WHERE id=?').get(id))
    byKey.set(key, p)
    created++
    return p
  }

  for (const r of db.prepare('SELECT name FROM vendor_directory WHERE deleted_at IS NULL').all()) ensure(r.name)

  // Fournisseurs déjà comptabilisés + apprentissage des défauts depuis l'historique.
  // La devise du reçu sert de proxy de la devise de transaction (exacte au prochain push).
  const receipts = db.prepare(`
    SELECT company, currency, quickbooks_type, expense_account_id, payment_account_id,
           tax_code_id, vendor_id, transaction_type
    FROM sale_receipts
    WHERE deleted_at IS NULL AND quickbooks_id IS NOT NULL AND company IS NOT NULL AND TRIM(company) != ''
    ORDER BY COALESCE(receipt_date, created_at) DESC
  `).all()
  let filled = 0
  for (const r of receipts) {
    const p = ensure(r.company)
    if (!p) continue
    const usd = String(r.currency || 'CAD').toUpperCase() === 'USD'
    const sets = []
    const values = []
    const fillIfEmpty = (col, current, val) => {
      if ((current == null || current === '') && val != null && val !== '') { sets.push(`${col}=?`); values.push(val); p[col] = val }
    }
    fillIfEmpty(usd ? 'qb_vendor_id_usd' : 'qb_vendor_id_cad', usd ? p.qb_vendor_id_usd : p.qb_vendor_id_cad, r.vendor_id)
    fillIfEmpty('default_qb_type', p.default_qb_type, ['purchase', 'bill', 'cc_credit'].includes(r.quickbooks_type) ? r.quickbooks_type : null)
    fillIfEmpty('default_expense_account_id', p.default_expense_account_id, r.expense_account_id)
    if (r.quickbooks_type !== 'bill') {
      fillIfEmpty(usd ? 'default_payment_account_id_usd' : 'default_payment_account_id_cad',
        usd ? p.default_payment_account_id_usd : p.default_payment_account_id_cad, r.payment_account_id)
    }
    fillIfEmpty('default_transaction_type', p.default_transaction_type, r.transaction_type)
    fillIfEmpty(usd ? 'default_tax_code_id_usd' : 'default_tax_code_id_cad',
      usd ? p.default_tax_code_id_usd : p.default_tax_code_id_cad, r.tax_code_id)
    if (sets.length) {
      sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      values.push(p.id)
      db.prepare(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id=?`).run(...values)
      filled++
    }
  }
  return { created, filled, total: db.prepare('SELECT COUNT(*) c FROM vendor_profiles WHERE deleted_at IS NULL').get().c }
}

// Fusion de profils doublons : les profils sources sont absorbés par le profil
// cible — leurs noms et alias deviennent des alias de la cible, les champs encore
// vides de la cible sont remplis depuis les sources (jamais d'écrasement), les
// références sale_receipts.vendor_profile_id sont repointées, puis les sources
// sont soft-deletées. Transactionnel.
const MERGE_FILL_COLUMNS = [
  'qb_vendor_id_cad', 'qb_vendor_id_usd', 'default_qb_type',
  'default_expense_account_id', 'default_payment_account_id_cad', 'default_payment_account_id_usd',
  'default_transaction_type', 'default_tax_code_id_cad', 'default_tax_code_id_usd',
  'payment_terms_days',
]

export function mergeVendorProfiles(targetId, sourceIds) {
  const get = (id) => serializeProfile(db.prepare('SELECT * FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(id))
  const target = get(targetId)
  if (!target) throw new Error('Profil cible introuvable')
  const sources = sourceIds.map(get)
  if (sources.some(s => !s)) throw new Error('Profil source introuvable')

  const run = db.transaction(() => {
    const targetKey = normalizeVendorKey(target.name)
    const aliasKeys = new Set(target.aliases.map(normalizeVendorKey))
    const aliases = [...target.aliases]
    const addAlias = (name) => {
      const key = normalizeVendorKey(name)
      if (!key || key === targetKey || aliasKeys.has(key)) return
      aliasKeys.add(key)
      aliases.push(String(name).trim())
    }

    const sets = []
    const values = []
    const notes = [target.notes].filter(Boolean)
    for (const src of sources) {
      addAlias(src.name)
      for (const a of src.aliases) addAlias(a)
      for (const col of MERGE_FILL_COLUMNS) {
        if ((target[col] == null || target[col] === '') && src[col] != null && src[col] !== '') {
          target[col] = src[col]
          sets.push(`${col}=?`); values.push(src[col])
        }
      }
      if (src.notes && !notes.includes(src.notes)) notes.push(src.notes)
    }
    sets.push('aliases=?'); values.push(JSON.stringify(aliases))
    sets.push('notes=?'); values.push(notes.length ? notes.join('\n') : null)
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    values.push(target.id)
    db.prepare(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id=?`).run(...values)

    const repoint = db.prepare('UPDATE sale_receipts SET vendor_profile_id=? WHERE vendor_profile_id=?')
    for (const src of sources) {
      repoint.run(target.id, src.id)
      db.prepare(`UPDATE vendor_profiles SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`).run(src.id)
    }
  })
  run()
  return serializeProfile(db.prepare('SELECT * FROM vendor_profiles WHERE id=?').get(target.id))
}

// Groupes de doublons probables : profils dont la clé normalisée de l'un est un
// préfixe de celle de l'autre (ex. « digikey » / « digikeyelectronics »), ou dont
// un alias entre en collision avec le nom/alias d'un autre profil.
export function findDuplicateProfileGroups() {
  const profiles = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE').all().map(serializeProfile)
  const entries = profiles.map(p => ({
    p,
    keys: [normalizeVendorKey(p.name), ...p.aliases.map(normalizeVendorKey)].filter(Boolean),
  }))
  const parent = new Map(profiles.map(p => [p.id, p.id]))
  const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id }
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra) }

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const match = entries[i].keys.some(ka => entries[j].keys.some(kb => {
        if (!ka || !kb) return false
        if (ka === kb) return true
        const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
        return short.length >= 5 && long.startsWith(short)
      }))
      if (match) union(entries[i].p.id, entries[j].p.id)
    }
  }

  const groups = new Map()
  for (const p of profiles) {
    const root = find(p.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(p)
  }
  return [...groups.values()].filter(g => g.length > 1)
}

// Échéance calculée : date d'échéance imprimée si extraite, sinon date du document
// + termes (extraits du document, sinon termes par défaut du profil). null si rien.
export function computeDueDate({ dueDate, receiptDate, termsDays }) {
  if (dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return dueDate
  if (!receiptDate || !/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) return null
  const days = Number(termsDays)
  if (!Number.isInteger(days) || days <= 0) return null
  const [y, m, d] = receiptDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}
