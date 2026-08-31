#!/usr/bin/env node
// Import des Qualification Calls depuis Airtable « Communication interne »
// vers la table qualification_calls. Match best-effort sur le nom d'entreprise.
//
// Usage :
//   node src/scripts/import-qualification-calls.js            # dry run
//   node src/scripts/import-qualification-calls.js --apply    # execute

import { randomUUID } from 'node:crypto'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'

const APPLY = process.argv.includes('--apply')
const BASE_ID = 'appN2odudZaQ43RMd'        // Communication interne
const TABLE_ID = 'tbl9cem79f9Hnexej'       // Qualification calls

// ── Filet de sécurité : si le serveur n'a pas redémarré (schema.js pas exécuté),
// on (re)crée la table et les index ici de manière idempotente.
db.exec(`
  CREATE TABLE IF NOT EXISTS qualification_calls (
    id TEXT PRIMARY KEY,
    airtable_record_id TEXT UNIQUE NOT NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    company_name_raw TEXT,
    call_date TEXT,
    status TEXT,
    assignee TEXT,
    contact_full_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    decision_maker_name TEXT,
    decision_maker_role TEXT,
    farm_description TEXT,
    has_employees INTEGER,
    employees_count TEXT,
    is_charity INTEGER,
    can_issue_charity_receipt INTEGER,
    challenges TEXT,
    challenge_duration TEXT,
    challenge_financial_impact TEXT,
    short_term_goals TEXT,
    motivation_today TEXT,
    motivation_why_now TEXT,
    importance_score TEXT,
    readiness_score TEXT,
    has_budget TEXT,
    budget_amount TEXT,
    timeline TEXT,
    role_in_company TEXT,
    business_models TEXT,
    current_management TEXT,
    management_effective TEXT,
    pain_points TEXT,
    grows_tomatoes TEXT,
    tomato_season_months TEXT,
    summary TEXT,
    next_steps TEXT,
    notes TEXT,
    raw_fields TEXT,
    airtable_created_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_qualification_calls_company ON qualification_calls(company_id);
  CREATE INDEX IF NOT EXISTS idx_qualification_calls_date ON qualification_calls(call_date DESC);
`)

// Stopwords retirés avant comparaison (entreprise génériques + articles + suffixes corp).
const STOPWORDS = new Set([
  'inc','incorporated','ltd','ltee','limited','llc','corp','corporation','co','sa','sarl','gmbh','enr','srl',
  'the','la','le','les','de','du','des','of','et','and','&','a',
  'farm','farms','ferme','fermes','jardin','jardins','garden','gardens',
])

function tokensOf(name) {
  if (!name) return []
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,'"&()/\\-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/s$/, ''))           // pluriel naïf
    .filter(t => t && !STOPWORDS.has(t) && t.length > 1)
}

// Index des companies, avec tie-break par "poids" (nb de liens entrants).
const refCount = new Map()
for (const sql of [
  'SELECT company_id AS id, COUNT(*) AS n FROM contacts WHERE company_id IS NOT NULL GROUP BY company_id',
  'SELECT company_id AS id, COUNT(*) AS n FROM projects WHERE company_id IS NOT NULL GROUP BY company_id',
  'SELECT company_id AS id, COUNT(*) AS n FROM orders WHERE company_id IS NOT NULL GROUP BY company_id',
  'SELECT company_id AS id, COUNT(*) AS n FROM factures WHERE company_id IS NOT NULL GROUP BY company_id',
]) {
  try {
    for (const r of db.prepare(sql).all()) refCount.set(r.id, (refCount.get(r.id) || 0) + r.n)
  } catch {}
}

const allCompanies = db.prepare('SELECT id, name FROM companies').all()
const byNormalized = new Map()
const byTokenSet = new Map()
const companyTokenSets = []   // {id, name, tokens:Set}
for (const c of allCompanies) {
  const toks = tokensOf(c.name)
  if (toks.length === 0) continue
  const nKey = toks.join(' ')
  const tKey = [...toks].sort().join(' ')
  if (!byNormalized.has(nKey)) byNormalized.set(nKey, [])
  byNormalized.get(nKey).push(c)
  if (!byTokenSet.has(tKey)) byTokenSet.set(tKey, [])
  byTokenSet.get(tKey).push(c)
  companyTokenSets.push({ id: c.id, name: c.name, tokens: new Set(toks) })
}

function tieBreak(cands) {
  if (cands.length === 1) return cands[0]
  return [...cands].sort((a, b) => (refCount.get(b.id) || 0) - (refCount.get(a.id) || 0))[0]
}

function pickCompany(rawName) {
  const toks = tokensOf(rawName)
  if (toks.length === 0) return { match: null, tier: null }

  // Tier 1 : normalisation exacte (ordre préservé)
  const nKey = toks.join(' ')
  let cands = byNormalized.get(nKey)
  if (cands && cands.length) return { match: tieBreak(cands), tier: 'exact', n: cands.length }

  // Tier 2 : même set de tokens, ordre quelconque
  const tKey = [...toks].sort().join(' ')
  cands = byTokenSet.get(tKey)
  if (cands && cands.length) return { match: tieBreak(cands), tier: 'token-set', n: cands.length }

  // Tier 3 : tous les tokens de la requête présents dans la company,
  // accepté seulement si unique ET si la requête a >=2 tokens distinctifs
  // (sinon un seul nom de famille suffit pour matcher n'importe quoi).
  const tokSet = new Set(toks)
  if (tokSet.size < 2) return { match: null, tier: 'too-generic', n: 0 }
  const subsetCands = companyTokenSets.filter(c => {
    for (const t of tokSet) if (!c.tokens.has(t)) return false
    return true
  })
  if (subsetCands.length === 1) return { match: subsetCands[0], tier: 'subset-unique', n: 1 }
  if (subsetCands.length > 1) return { match: null, tier: 'subset-ambiguous', n: subsetCands.length }

  return { match: null, tier: null }
}

// ── Pull all Airtable records (paginated) ───────────────────────────────────
const token = await getAccessToken()
const records = []
let offset = ''
do {
  const path = `/${BASE_ID}/${TABLE_ID}?pageSize=100` + (offset ? `&offset=${encodeURIComponent(offset)}` : '')
  const data = await airtableFetch(path, token)
  records.push(...data.records)
  offset = data.offset || ''
} while (offset)
console.log(`Pulled ${records.length} records from Airtable.`)

// ── Helpers pour extraire des valeurs ────────────────────────────────────────
function asInt01(v) {
  if (v === true) return 1
  if (v === false) return 0
  return null
}
function asJsonArr(v) {
  if (Array.isArray(v) && v.length > 0) return JSON.stringify(v)
  return null
}
function asString(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string') return v
  return String(v)
}
function assigneeStr(v) {
  if (!v) return null
  if (typeof v === 'object') return v.email || v.name || null
  return String(v)
}

function rowFromAirtable(r) {
  const f = r.fields || {}
  // raw_fields : tout sauf le champ formula bruyant « test »
  const raw = { ...f }
  delete raw.test
  return {
    airtable_record_id: r.id,
    company_name_raw: asString(f['Quel est le nom de votre entreprise ?']),
    call_date: asString(f['Date']),
    status: asString(f['Status']),
    assignee: assigneeStr(f['Assignee']),
    contact_full_name: asString(f['Nom complet']),
    contact_email: asString(f['Email'] || f['mail']),
    contact_phone: asString(f['Phone']),
    decision_maker_name: asString(f['Quelle est le nom de cette personne?']),
    decision_maker_role: asString(f['Qui prend les décisions pour ce type de projet dans votre entreprise ?']),
    farm_description: asString(f['Parlez-moi de votre ferme.']),
    has_employees: asInt01(f['Avez-vous des employés?']),
    employees_count: asString(f['Combien?']),
    is_charity: asInt01(f["Est-ce que c'est une organisation charitable ?"]),
    can_issue_charity_receipt: asInt01(f['Pouvez-vous émettre un reçu de charité?']),
    challenges: asString(f['Quels sont les principaux défis que vous rencontrez actuellement dans votre secteur ?']),
    challenge_duration: asString(f['Depuis combien de temps avez-vous ce(s) défi(s)?']),
    challenge_financial_impact: asString(f['Quel est l’impact financier de ce défi, selon vous ?']),
    short_term_goals: asString(f['Quels sont vos objectifs à court terme (par saison) ?']),
    motivation_today: asString(f["What's the motivation for talking to us today?"]),
    motivation_why_now: asString(f['Why now? why not 3 years ago or next year?']),
    importance_score: asString(f['Sur une échelle de 1 à 5 : Où situez-vous l’importance de vos défis actuels ?']),
    readiness_score: asString(f['Sur une échelle de 1 à 5 : Où vous situez-vous pour résoudre ces défis ?']),
    has_budget: asString(f['Avez-vous un budget alloué pour résoudre ce problème ?']),
    budget_amount: asString(f['Montant arrondi']),
    timeline: asString(f['À quelle échéance envisagez-vous de mettre en place une solution ?']),
    role_in_company: asJsonArr(f["Quel est son rôle dans l'entreprise?"]),
    business_models: asJsonArr(f['Quels sont les modèles d’affaires?']),
    current_management: asString(f['Comment le(s) gérez-vous actuellement?']),
    management_effective: asString(f['Cette méthode est-elle efficace?']),
    pain_points: asJsonArr(f['Cochez les points douloureux nommés']),
    grows_tomatoes: asString(f['Est-ce que vous plantez des tomates dans vos serres?']),
    tomato_season_months: asJsonArr(f['Quels sont les mois de début et de fin de votre saison de culture pour les tomates ?']),
    summary: asString(f['Fait un résumé des points abordés'] || f['Récapitulatif des points abordés :']),
    next_steps: asString(f['Notes décision et follow up']),
    notes: asString(f['Notes 2'] || f['Note']),
    raw_fields: JSON.stringify(raw),
    airtable_created_at: r.createdTime,
  }
}

// ── Stats + UPSERT ───────────────────────────────────────────────────────────
const stats = {
  total: records.length, withName: 0,
  matched: 0, byTier: { exact: 0, 'token-set': 0, 'subset-unique': 0 },
  unmatched: 0, ambiguousSubset: 0, inserted: 0, updated: 0,
}
const unmatchedSamples = []
const matchedSamples = []

const existing = new Map()
for (const r of db.prepare('SELECT id, airtable_record_id FROM qualification_calls').all()) {
  existing.set(r.airtable_record_id, r.id)
}

const upsertInsert = db.prepare(`
  INSERT INTO qualification_calls (
    id, airtable_record_id, company_id, company_name_raw, call_date, status, assignee,
    contact_full_name, contact_email, contact_phone, decision_maker_name, decision_maker_role,
    farm_description, has_employees, employees_count, is_charity, can_issue_charity_receipt,
    challenges, challenge_duration, challenge_financial_impact, short_term_goals,
    motivation_today, motivation_why_now, importance_score, readiness_score,
    has_budget, budget_amount, timeline, role_in_company, business_models,
    current_management, management_effective, pain_points, grows_tomatoes, tomato_season_months,
    summary, next_steps, notes, raw_fields, airtable_created_at
  ) VALUES (
    @id, @airtable_record_id, @company_id, @company_name_raw, @call_date, @status, @assignee,
    @contact_full_name, @contact_email, @contact_phone, @decision_maker_name, @decision_maker_role,
    @farm_description, @has_employees, @employees_count, @is_charity, @can_issue_charity_receipt,
    @challenges, @challenge_duration, @challenge_financial_impact, @short_term_goals,
    @motivation_today, @motivation_why_now, @importance_score, @readiness_score,
    @has_budget, @budget_amount, @timeline, @role_in_company, @business_models,
    @current_management, @management_effective, @pain_points, @grows_tomatoes, @tomato_season_months,
    @summary, @next_steps, @notes, @raw_fields, @airtable_created_at
  )
`)

const upsertUpdate = db.prepare(`
  UPDATE qualification_calls SET
    company_id = @company_id,
    company_name_raw = @company_name_raw,
    call_date = @call_date,
    status = @status,
    assignee = @assignee,
    contact_full_name = @contact_full_name,
    contact_email = @contact_email,
    contact_phone = @contact_phone,
    decision_maker_name = @decision_maker_name,
    decision_maker_role = @decision_maker_role,
    farm_description = @farm_description,
    has_employees = @has_employees,
    employees_count = @employees_count,
    is_charity = @is_charity,
    can_issue_charity_receipt = @can_issue_charity_receipt,
    challenges = @challenges,
    challenge_duration = @challenge_duration,
    challenge_financial_impact = @challenge_financial_impact,
    short_term_goals = @short_term_goals,
    motivation_today = @motivation_today,
    motivation_why_now = @motivation_why_now,
    importance_score = @importance_score,
    readiness_score = @readiness_score,
    has_budget = @has_budget,
    budget_amount = @budget_amount,
    timeline = @timeline,
    role_in_company = @role_in_company,
    business_models = @business_models,
    current_management = @current_management,
    management_effective = @management_effective,
    pain_points = @pain_points,
    grows_tomatoes = @grows_tomatoes,
    tomato_season_months = @tomato_season_months,
    summary = @summary,
    next_steps = @next_steps,
    notes = @notes,
    raw_fields = @raw_fields,
    airtable_created_at = @airtable_created_at,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE airtable_record_id = @airtable_record_id
`)

const tx = db.transaction((rows) => {
  for (const row of rows) {
    if (existing.has(row.airtable_record_id)) {
      upsertUpdate.run(row)
      stats.updated++
    } else {
      upsertInsert.run({ ...row, id: randomUUID() })
      stats.inserted++
    }
  }
})

const prepared = []
for (const r of records) {
  const row = rowFromAirtable(r)
  let matched = null
  if (row.company_name_raw) {
    stats.withName++
    const { match, tier, n } = pickCompany(row.company_name_raw)
    if (match) {
      matched = match
      stats.matched++
      stats.byTier[tier] = (stats.byTier[tier] || 0) + 1
      if (tier !== 'exact' && matchedSamples.length < 25) {
        matchedSamples.push({ tier, raw: row.company_name_raw, picked: match.name, n })
      }
    } else {
      stats.unmatched++
      if (tier === 'subset-ambiguous') stats.ambiguousSubset++
      if (unmatchedSamples.length < 30) {
        unmatchedSamples.push({ raw: row.company_name_raw, reason: tier || 'no candidate' })
      }
    }
  }
  row.company_id = matched?.id || null
  prepared.push(row)
}

console.log('\n— Statistiques (avant écriture) —')
console.log('  total Airtable records :', stats.total)
console.log('  avec nom d\'entreprise  :', stats.withName)
console.log('  sans nom               :', stats.total - stats.withName)
console.log('  matchés                :', stats.matched)
console.log('    └─ exact             :', stats.byTier.exact)
console.log('    └─ token-set (ordre) :', stats.byTier['token-set'])
console.log('    └─ subset-unique     :', stats.byTier['subset-unique'])
console.log('  non-matchés            :', stats.unmatched,
  `(dont ${stats.ambiguousSubset} ambigus = plusieurs candidats partiels)`)

if (matchedSamples.length) {
  console.log('\n— Échantillon de matches non-exacts (vérifier que c\'est bien la bonne company) —')
  for (const s of matchedSamples) console.log(`  [${s.tier}] "${s.raw}" → "${s.picked}"${s.n>1?` (${s.n} cands)`:''}`)
}
if (unmatchedSamples.length) {
  console.log('\n— Noms non-matchés —')
  for (const s of unmatchedSamples) console.log(`  [${s.reason}] "${s.raw}"`)
}

if (!APPLY) {
  console.log('\n[dry run] — relancer avec --apply pour écrire en DB.')
  process.exit(0)
}

tx(prepared)
console.log('\n— Écriture appliquée —')
console.log('  insérés :', stats.inserted)
console.log('  mis à jour :', stats.updated)
const total = db.prepare('SELECT COUNT(*) AS n FROM qualification_calls').get().n
const linked = db.prepare('SELECT COUNT(*) AS n FROM qualification_calls WHERE company_id IS NOT NULL').get().n
console.log(`  total en DB : ${total}, dont ${linked} liés à une company.`)
