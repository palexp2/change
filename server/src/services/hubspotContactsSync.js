// Contacts HubSpot → Boréal, en direct (sens unique, HubSpot fait foi).
//
// Avant : HubSpot → Airtable → Boréal, trop lent. Le miroir Airtable des
// contacts continue de tourner pour tous les autres champs ; les colonnes
// listées dans HUBSPOT_OWNED_COLUMNS ne sont plus réécrites par lui tant que
// cette synchro est active (cf. plan `contacts` de airtableMirrorEngine.js),
// et une fiche créée ici est ADOPTÉE par le miroir Airtable quand le record
// y arrive (même id HubSpot ou même courriel) au lieu d'être dédoublée.
//
// Abonnements : statut de chaque type d'abonnement HubSpot pour CHAQUE courriel
// du contact (principal + hs_additional_emails), dans contact_email_subscriptions.
// Exige les portées `communication_preferences.read` et
// `communication_preferences.statuses.batch.read` sur l'app privée HubSpot ;
// sans elles les contacts se synchronisent quand même et l'erreur est gardée.

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { hsFetch, isHubSpotConfigured } from '../connectors/hubspot.js'

export const HUBSPOT_OWNED_COLUMNS = ['first_name', 'last_name', 'email', 'phone', 'company_id']

const PROPS = ['firstname', 'lastname', 'email', 'phone', 'hs_additional_emails', 'associatedcompanyid', 'lastmodifieddate']
const SUBS_FULL_EVERY_MS = 24 * 3600 * 1000

// ── Réglages (connector_config) ──────────────────────────────────────────────

function getCfg(key) {
  return db.prepare("SELECT value FROM connector_config WHERE connector='hubspot' AND key=?").get(key)?.value ?? null
}
function setCfg(key, value) {
  db.prepare(`INSERT INTO connector_config (connector, key, value) VALUES ('hubspot', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value`).run(key, value == null ? null : String(value))
}

/** Synchro active = HubSpot branché et pas coupée (`contacts_sync_enabled` = '0'). */
export function isHubSpotContactsSyncActive() {
  try { return isHubSpotConfigured() && getCfg('contacts_sync_enabled') !== '0' } catch { return false }
}

// ── Utilitaires purs ─────────────────────────────────────────────────────────

/** Les ids HubSpot importés d'Airtable portent un « .0 » (nombre stocké en texte). */
export function normHsId(v) {
  if (v == null) return null
  const s = String(v).trim().replace(/\.0+$/, '')
  return s || null
}

export function contactEmails(props) {
  const out = []
  const add = (e) => {
    const v = String(e || '').trim().toLowerCase()
    if (v && v.includes('@') && !out.includes(v)) out.push(v)
  }
  add(props.email)
  for (const e of String(props.hs_additional_emails || '').split(/[;,\s]+/)) add(e)
  return out
}

/** Valeurs ERP d'un contact HubSpot. `companyId` : undefined = ne pas toucher. */
export function hsContactToErp(props, companyId) {
  const first = (props.firstname || '').trim()
  const last = (props.lastname || '').trim()
  const out = {
    first_name: first,
    last_name: last || first || 'Inconnu',
    email: (props.email || '').trim() || null,
    phone: (props.phone || '').trim() || null,
  }
  if (companyId !== undefined) out.company_id = companyId
  return out
}

// ── Lecture HubSpot ──────────────────────────────────────────────────────────

async function listAllContacts(onPage) {
  let after = null
  do {
    const qs = new URLSearchParams({ limit: '100', properties: PROPS.join(',') })
    if (after) qs.set('after', after)
    const data = await hsFetch(`/crm/v3/objects/contacts?${qs}`)
    if (!data) break
    await onPage(data.results || [])
    after = data.paging?.next?.after || null
  } while (after)
}

// La recherche HubSpot plafonne à 10 000 résultats par requête : on repart du
// dernier `lastmodifieddate` vu quand on atteint le plafond.
async function searchContactsSince(sinceMs, onPage) {
  let from = sinceMs
  for (;;) {
    let after = 0
    let lastSeen = null
    let capped = false
    for (;;) {
      const data = await hsFetch('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: {
          filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(from) }] }],
          sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
          properties: PROPS,
          limit: 100,
          after,
        },
      })
      const results = data?.results || []
      if (results.length) {
        await onPage(results)
        lastSeen = results[results.length - 1].properties?.lastmodifieddate || lastSeen
      }
      const next = data?.paging?.next?.after
      if (!next) break
      after = Number(next)
      if (after >= 9900) { capped = true; break }
    }
    if (!capped || !lastSeen) return
    const t = new Date(lastSeen).getTime()
    if (!(t > from)) return
    from = t
  }
}

// ── Écriture ERP ─────────────────────────────────────────────────────────────

function loadIndexes() {
  const byHsId = new Map()
  const byEmail = new Map()
  for (const r of db.prepare('SELECT id, hubspot_record_id, lower(email) AS em, deleted_at FROM contacts').all()) {
    const hs = normHsId(r.hubspot_record_id)
    if (hs && !byHsId.has(hs)) byHsId.set(hs, r)
    // Repli par courriel : seulement les fiches vivantes qu'aucun id HubSpot ne
    // rattache encore — une fiche à la corbeille ne doit pas bloquer un contact
    // recréé dans HubSpot avec le même courriel.
    if (!hs && !r.deleted_at && r.em && !byEmail.has(r.em)) byEmail.set(r.em, r)
  }
  const companies = new Map()
  for (const c of db.prepare('SELECT id, hubspot_record_id FROM companies WHERE hubspot_record_id IS NOT NULL').all()) {
    const hs = normHsId(c.hubspot_record_id)
    if (hs && !companies.has(hs)) companies.set(hs, c.id)
  }
  return { byHsId, byEmail, companies }
}

function applyContacts(results, idx, report, emailsByContact) {
  const selectRow = db.prepare(`SELECT id, ${HUBSPOT_OWNED_COLUMNS.join(', ')}, hubspot_record_id, deleted_at FROM contacts WHERE id=?`)
  const tx = db.transaction(() => {
    for (const hs of results) {
      const p = hs.properties || {}
      const hsId = normHsId(hs.id)
      if (!hsId) continue
      const emails = contactEmails(p)
      const match = idx.byHsId.get(hsId) || (emails[0] && idx.byEmail.get(emails[0])) || null

      // Entreprise : pas d'association → aucune ; entreprise pas encore dans
      // Boréal → on ne touche pas (elle arrivera par son propre sync).
      const hsCompany = normHsId(p.associatedcompanyid)
      let companyId
      if (!hsCompany) companyId = null
      else if (idx.companies.has(hsCompany)) companyId = idx.companies.get(hsCompany)
      else { companyId = undefined; report.company_unresolved++ }

      const values = hsContactToErp(p, companyId)

      if (!match) {
        const id = newRecordId()
        const cols = ['id', ...Object.keys(values), 'hubspot_record_id', 'hubspot_record_link']
        const link = hs.url || null
        db.prepare(`INSERT INTO contacts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
          .run(id, ...Object.values(values), hsId, link)
        const row = { id, hubspot_record_id: hsId, em: emails[0] || null, deleted_at: null }
        idx.byHsId.set(hsId, row)
        report.created++
        emailsByContact.set(id, emails)
        continue
      }
      // Fiche mise à la corbeille dans Boréal : on ne la ressuscite pas.
      if (match.deleted_at) { report.skipped_deleted++; continue }

      const cur = selectRow.get(match.id)
      if (!cur) continue
      const changed = Object.keys(values).filter(k => (cur[k] ?? null) !== (values[k] ?? null))
      if (normHsId(cur.hubspot_record_id) !== hsId) changed.push('hubspot_record_id')
      if (changed.length) {
        const vals = changed.map(k => (k === 'hubspot_record_id' ? hsId : values[k] ?? null))
        db.prepare(`UPDATE contacts SET ${changed.map(k => `"${k}"=?`).join(', ')} WHERE id=?`).run(...vals, match.id)
        report.updated++
      } else report.unchanged++
      if (!idx.byHsId.has(hsId)) idx.byHsId.set(hsId, match)
      emailsByContact.set(match.id, emails)
    }
  })
  tx()
}

// ── Abonnements ──────────────────────────────────────────────────────────────

// Lecture courriel par courriel : l'API de lecture en lot exige une portée que
// le compte HubSpot n'offre pas (communication_preferences.statuses.batch.read).
const SUBS_CONCURRENCY = 5

async function readEmailStatuses(email) {
  const data = await hsFetch(`/communication-preferences/v3/status/email/${encodeURIComponent(email)}`)
  return data?.subscriptionStatuses || []
}

/**
 * Relit les statuts d'abonnement de chaque courriel et remplace ceux de chaque
 * contact concerné, contact par contact (un long passage garde son avancée).
 * `emailsByContact` : Map contactId → [courriels].
 */
export async function refreshSubscriptions(emailsByContact) {
  const del = db.prepare('DELETE FROM contact_email_subscriptions WHERE contact_id=?')
  const ins = db.prepare(`INSERT OR REPLACE INTO contact_email_subscriptions
    (contact_id, email, subscription_id, subscription_name, status, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
  const queue = [...emailsByContact].filter(([, emails]) => emails.length)
  let emails = 0
  let firstError = null
  const worker = async () => {
    while (queue.length && !firstError) {
      const [contactId, list] = queue.shift()
      try {
        const got = []
        for (const email of list) { got.push([email, await readEmailStatuses(email)]); emails++ }
        db.transaction(() => {
          del.run(contactId)
          for (const [email, statuses] of got) {
            for (const st of statuses) ins.run(contactId, email, String(st.id), st.name || String(st.id), st.status || null)
          }
        })()
      } catch (e) {
        // Portée manquante : inutile de continuer. Autre erreur : on passe au suivant.
        if (/403|scope/i.test(e.message)) firstError = e
        else console.error(`HubSpot abonnements ${contactId}: ${e.message.slice(0, 200)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: SUBS_CONCURRENCY }, worker))
  if (firstError) throw firstError
  return { emails }
}

async function refreshSubscriptionsSafely(emailsByContact, report) {
  try {
    const r = await refreshSubscriptions(emailsByContact)
    report.subscription_emails = r.emails
    setCfg('contacts_subs_error', null)
  } catch (e) {
    // Les contacts restent synchronisés ; l'erreur (souvent une portée
    // manquante) est gardée pour la fiche contact.
    report.subscriptions_error = e.message.slice(0, 300)
    setCfg('contacts_subs_error', /403|scope/i.test(e.message) ? 'scope' : e.message.slice(0, 300))
  }
}

// Passage complet (~15 000 courriels, plusieurs minutes) : détaché, pour ne pas
// retenir la synchro des contacts de chaque minute.
let fullSubsRunning = false
function startFullSubscriptionsRefresh(fromPull) {
  if (fullSubsRunning) return
  fullSubsRunning = true
  const all = new Map()
  for (const r of db.prepare(
    "SELECT id, email FROM contacts WHERE deleted_at IS NULL AND hubspot_record_id IS NOT NULL AND hubspot_record_id <> ''"
  ).all()) {
    // Courriels lus dans HubSpot à l'instant (principal + secondaires).
    all.set(r.id, [...(fromPull.get(r.id) || (r.email ? [r.email.trim().toLowerCase()] : []))])
  }
  // Courriels secondaires connus des abonnements déjà lus.
  for (const r of db.prepare('SELECT DISTINCT contact_id, email FROM contact_email_subscriptions').all()) {
    const list = all.get(r.contact_id)
    if (list && !list.includes(r.email)) list.push(r.email)
  }
  const report = {}
  const t0 = Date.now()
  refreshSubscriptionsSafely(all, report)
    .then(() => {
      // En échec, on retente dans une heure plutôt qu'à chaque minute.
      setCfg('contacts_subs_full_at', report.subscriptions_error ? Date.now() - SUBS_FULL_EVERY_MS + 3600_000 : Date.now())
      console.log(`📬 HubSpot abonnements : ${report.subscription_emails || 0} courriels en ${Math.round((Date.now() - t0) / 1000)} s${report.subscriptions_error ? ` — ${report.subscriptions_error}` : ''}`)
    })
    .finally(() => { fullSubsRunning = false })
}

export function subscriptionsError() {
  return getCfg('contacts_subs_error')
}

// ── Point d'entrée ───────────────────────────────────────────────────────────

/**
 * Tire les contacts modifiés depuis le dernier passage (tous au premier).
 * Les abonnements suivent pour les contacts touchés ; une fois par jour, pour
 * tous (un changement d'abonnement d'un courriel secondaire ne modifie pas
 * toujours le contact).
 */
export async function pullHubSpotContacts({ full = false } = {}) {
  const report = { created: 0, updated: 0, unchanged: 0, skipped_deleted: 0, company_unresolved: 0, fetched: 0 }
  // Passage d'abonnements dû : on relit TOUS les contacts (≈20 s) pour avoir
  // leurs courriels secondaires à jour.
  const subsDue = !fullSubsRunning && Date.now() - Number(getCfg('contacts_subs_full_at') || 0) > SUBS_FULL_EVERY_MS
  const cursor = full || subsDue ? null : getCfg('contacts_last_pull')
  const idx = loadIndexes()
  const emailsByContact = new Map()
  let maxSeen = cursor ? new Date(cursor).getTime() : 0
  const onPage = async (results) => {
    report.fetched += results.length
    applyContacts(results, idx, report, emailsByContact)
    for (const r of results) {
      const t = new Date(r.properties?.lastmodifieddate || r.updatedAt || 0).getTime()
      if (t > maxSeen) maxSeen = t
    }
  }
  if (cursor) await searchContactsSince(new Date(cursor).getTime(), onPage)
  else await listAllContacts(onPage)
  if (maxSeen) setCfg('contacts_last_pull', new Date(maxSeen).toISOString())

  // Abonnements des contacts touchés tout de suite ; tous, une fois par jour
  // (le changement d'abonnement d'un courriel secondaire ne modifie pas
  // toujours le contact).
  if (emailsByContact.size && cursor) await refreshSubscriptionsSafely(emailsByContact, report)
  if (subsDue) startFullSubscriptionsRefresh(emailsByContact)
  return report
}

/** Abonnements d'un contact, groupés par courriel. */
export function contactSubscriptions(contactId) {
  const rows = db.prepare(`SELECT email, subscription_id, subscription_name, status
    FROM contact_email_subscriptions WHERE contact_id=? ORDER BY email, subscription_name`).all(contactId)
  const byEmail = new Map()
  for (const r of rows) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, [])
    byEmail.get(r.email).push({ id: r.subscription_id, name: r.subscription_name, status: r.status })
  }
  return [...byEmail].map(([email, subscriptions]) => ({ email, subscriptions }))
}
