import { v4 as uuid } from 'uuid'
import db from '../db/database.js'

// Profils fournisseurs : fiche unique par fournisseur, éditable dans /fournisseurs.
// Elle porte à la fois
//  - les DÉFAUTS COMPTABLES appris automatiquement à chaque publication QB (vendor QB
//    par devise, comptes, type de transaction, code de taxe, échéance) — ce qui permet
//    de pré-remplir l'extraction au lieu de redemander les mêmes choix à chaque facture ;
//  - les PARTICULARITÉS du fournisseur (devise habituelle, mode de paiement, catégorie
//    comptable, description, particularités), jadis tenues dans le Google Doc
//    « Fournisseurs_Particularités ». L'ERP est maintenant la seule source de vérité :
//    le doc n'est plus synchronisé, tout s'édite ici.

// Clé de comparaison de noms de fournisseurs : minuscules, sans accents ni ponctuation.
export function normalizeVendorKey(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

// Suffixes légaux ignorés par la clé de repli : « Anthropic, PBC » ≡ « Anthropic »,
// « Sticker Mule, LLC » ≡ « Sticker Mule », « ByteDance Pte. Ltd. » ≡ « ByteDance ».
// C'est la principale source de profils doublons : la raison sociale imprimée sur la
// facture porte le suffixe, pas le nom canonique du répertoire.
export const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'ltee', 'limited', 'limitee',
  'corp', 'corporation', 'co', 'company', 'ulc', 'pbc', 'plc', 'pte', 'pty',
  'gmbh', 'sarl', 'srl', 'sa', 'ag', 'nv', 'bv',
])

// Clé de repli : comme normalizeVendorKey, mais sans les suffixes légaux de fin de nom.
export function strippedVendorKey(name) {
  const tokens = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop()
  const key = tokens.join('')
  // Trop court après retrait (ex. raison sociale réduite à un sigle) : repli inutilisable.
  return key.length >= 3 ? key : normalizeVendorKey(name)
}

// Cherche un nom identique (à la normalisation près) dans une liste de fournisseurs.
// Volontairement conservateur (pas de match partiel) : le fuzzy matching est fait par
// le modèle d'extraction, qui reçoit la liste des noms canoniques en contexte.
export function findVendorMatch(name, vendors) {
  const key = normalizeVendorKey(name)
  if (!key) return null
  return vendors.find(v => normalizeVendorKey(v.name) === key) || null
}

// Contexte injecté dans le prompt d'extraction des reçus : liste des fournisseurs
// connus (nom canonique + devise habituelle + catégorie comptable + alias appris).
// null si aucun profil — l'extraction fonctionne alors sans.
export function buildVendorExtractionContext() {
  const rows = db.prepare(`
    SELECT name, usual_currency, qb_category, aliases FROM vendor_profiles
    WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE
  `).all()
  if (!rows.length) return null
  const lines = rows.map(r => {
    const extra = [r.usual_currency, r.qb_category].filter(Boolean).join(' | ')
    const aliases = parseAliases(r.aliases)
    const alias = aliases.length ? ` [aussi vu sous : ${aliases.join(', ')}]` : ''
    return `- ${r.name}${extra ? ` (${extra})` : ''}${alias}`
  })
  return `RÉPERTOIRE INTERNE DES FOURNISSEURS CONNUS (nom canonique, devise habituelle | catégorie comptable) :
Si l'émetteur du document correspond à l'un de ces fournisseurs — même sous une variante de raison sociale, une marque ou un domaine de courriel — utilise EXACTEMENT le nom canonique ci-dessous comme "company". La devise indiquée est celle habituellement facturée par ce fournisseur : sers-t'en pour trancher quand le document est ambigu (ex. « $ » sans mention CAD/USD).
${lines.join('\n')}`
}

function parseAliases(raw) {
  try {
    const a = JSON.parse(raw || '[]')
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()) : []
  } catch { return [] }
}

export function serializeProfile(row) {
  if (!row) return null
  return {
    ...row,
    aliases: parseAliases(row.aliases),
    // Motifs du relevé bancaire — servent à reconnaître le fournisseur DANS un
    // libellé de banque (cf. services/scrapers/vendorFromBankLabel.js), pas à
    // reconnaître un document. Volontairement distincts des alias.
    bank_label_patterns: parseAliases(row.bank_label_patterns),
  }
}

// Cherche le profil correspondant à un nom extrait : match exact (à la normalisation
// près — accents/casse/ponctuation) sur le nom canonique OU l'un des alias, puis en
// repli le même match SANS les suffixes légaux (« Twilio, Inc. » → profil « Twilio »).
// Le repli reste conservateur : jamais de match partiel/préfixe.
export function findVendorProfile(name) {
  const key = normalizeVendorKey(name)
  if (!key) return null
  const rows = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL').all()
  for (const row of rows) {
    if (normalizeVendorKey(row.name) === key) return serializeProfile(row)
    if (parseAliases(row.aliases).some(a => normalizeVendorKey(a) === key)) return serializeProfile(row)
  }
  const stripped = strippedVendorKey(name)
  for (const row of rows) {
    if (strippedVendorKey(row.name) === stripped) return serializeProfile(row)
    if (parseAliases(row.aliases).some(a => strippedVendorKey(a) === stripped)) return serializeProfile(row)
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
  // Devise habituelle : renseignée au premier push (jamais écrasée ensuite — une
  // édition manuelle fait foi). Elle est injectée dans le prompt d'extraction pour
  // trancher les factures qui n'impriment que « $ » (cas Postmark/ActiveCampaign :
  // facture en dollars US lue CAD, puis convertie à tort à la publication).
  if (!profile.usual_currency) set('usual_currency', usd ? 'USD' : 'CAD')
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

// Amorçage : crée un profil pour chaque fournisseur déjà comptabilisé
// (sale_receipts publiés), puis remplit les défauts
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
  'usual_currency', 'payment_method', 'qb_category', 'description', 'particularites',
  'payment_note',
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
// préfixe de celle de l'autre (ex. « digikey » / « digikeyelectronics »), dont les
// clés sans suffixe légal coïncident (« Wix.com » / « Wix.com LTD »), ou dont un
// alias entre en collision avec le nom/alias d'un autre profil. Les groupes marqués
// « pas des doublons » (vendor_duplicate_dismissals) sont tus tant que leur
// composition ne change pas.
export function findDuplicateProfileGroups() {
  const profiles = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE').all().map(serializeProfile)
  const entries = profiles.map(p => ({
    p,
    keys: [...new Set([
      normalizeVendorKey(p.name), strippedVendorKey(p.name),
      ...p.aliases.flatMap(a => [normalizeVendorKey(a), strippedVendorKey(a)]),
    ])].filter(Boolean),
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
  const dismissed = new Set(
    db.prepare('SELECT member_ids FROM vendor_duplicate_dismissals WHERE deleted_at IS NULL').all().map(r => r.member_ids),
  )
  return [...groups.values()].filter(g => g.length > 1 && !dismissed.has(dismissalKey(g.map(p => p.id))))
}

// Clé stable d'un groupe : JSON des ids triés — identique tant que la composition
// du groupe ne bouge pas, différente dès qu'un profil le rejoint ou le quitte.
export function dismissalKey(ids) {
  return JSON.stringify([...ids].sort())
}

// Marque un groupe « pas des doublons » : il ne sera plus proposé. Rappelle un
// dismissal soft-deleté au lieu d'en créer un second (member_ids est UNIQUE).
export function dismissDuplicateGroup(ids) {
  const key = dismissalKey(ids)
  const existing = db.prepare('SELECT id FROM vendor_duplicate_dismissals WHERE member_ids=?').get(key)
  if (existing) {
    db.prepare('UPDATE vendor_duplicate_dismissals SET deleted_at=NULL WHERE id=?').run(existing.id)
    return existing.id
  }
  const id = uuid()
  db.prepare('INSERT INTO vendor_duplicate_dismissals (id, member_ids) VALUES (?,?)').run(id, key)
  return id
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
