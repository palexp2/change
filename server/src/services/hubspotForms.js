// Formulaires de capture de leads ↔ HubSpot (page Marketing → Formulaires).
//
// HubSpot reste la source : les formulaires y vivent (rendu, soumissions,
// création des contacts). L'ERP en garde un miroir — la liste, la structure des
// champs et les soumissions — et peut en créer de nouveaux ou les renommer.
//
// API : Marketing Forms v3 (liste / création / modification) et
// form-integrations v1 (soumissions, les plus récentes d'abord).
import db from '../db/database.js'
import { hsFetch, getPortalId } from '../connectors/hubspot.js'
import { runScriptSandboxed } from './scriptSandbox.js'

const now = () => new Date().toISOString()

let portalIdCache = null
export async function hubspotPortalId() {
  if (!portalIdCache) portalIdCache = await getPortalId()
  return portalIdCache
}

function flattenFields(form) {
  return (form.fieldGroups || []).flatMap(g => g.fields || []).map(f => ({
    name: f.name, label: f.label, type: f.fieldType, required: !!f.required, hidden: !!f.hidden,
  }))
}

const upsertForm = db.prepare(`
  INSERT INTO marketing_forms (id, name, form_type, language, embed_type, fields_json, field_count,
    submit_text, post_submit_type, post_submit_value, archived, hs_created_at, hs_updated_at, synced_at)
  VALUES (@id, @name, @form_type, @language, @embed_type, @fields_json, @field_count,
    @submit_text, @post_submit_type, @post_submit_value, @archived, @hs_created_at, @hs_updated_at, @synced_at)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, form_type = excluded.form_type, language = excluded.language,
    embed_type = excluded.embed_type, fields_json = excluded.fields_json, field_count = excluded.field_count,
    submit_text = excluded.submit_text, post_submit_type = excluded.post_submit_type,
    post_submit_value = excluded.post_submit_value, archived = excluded.archived,
    hs_created_at = excluded.hs_created_at, hs_updated_at = excluded.hs_updated_at, synced_at = excluded.synced_at
`)

function saveForm(form) {
  const fields = flattenFields(form)
  const cfg = form.configuration || {}
  upsertForm.run({
    id: form.id,
    name: form.name || '(sans nom)',
    form_type: form.formType || null,
    language: cfg.language || null,
    embed_type: cfg.embedType || null,
    fields_json: JSON.stringify(fields),
    field_count: fields.length,
    submit_text: form.displayOptions?.submitButtonText || null,
    post_submit_type: cfg.postSubmitAction?.type || null,
    post_submit_value: cfg.postSubmitAction?.value || null,
    archived: form.archived ? 1 : 0,
    hs_created_at: form.createdAt || null,
    hs_updated_at: form.updatedAt || null,
    synced_at: now(),
  })
}

const insertSubmission = db.prepare(`
  INSERT OR IGNORE INTO marketing_form_submissions
    (id, form_id, submitted_at, email, first_name, last_name, company, page_url, values_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const submissionExists = db.prepare('SELECT 1 FROM marketing_form_submissions WHERE id = ?')

function saveSubmission(formId, s) {
  const values = s.values || []
  const pick = (name, objectTypeId) => values.find(v => v.name === name && (!objectTypeId || v.objectTypeId === objectTypeId))?.value || null
  const id = s.conversionId || `${formId}:${s.submittedAt}`
  return insertSubmission.run(
    id, formId,
    s.submittedAt ? new Date(s.submittedAt).toISOString() : null,
    pick('email'), pick('firstname'), pick('lastname'),
    pick('company') || pick('name', '0-2'),
    s.pageUrl || null,
    JSON.stringify(values.map(v => ({ name: v.name, value: v.value }))),
  ).changes
}

// Soumissions d'un formulaire : pages de 50, des plus récentes aux plus
// anciennes. Une fois l'historique lu en entier (`submissions_complete`), on
// s'arrête dès qu'une page ne contient que du déjà connu ; avant, le
// rattrapage reprend à chaque passage jusqu'au bout de la liste.
export async function syncFormSubmissions(formId, { maxPages = 200 } = {}) {
  const complete = !!db.prepare('SELECT submissions_complete FROM marketing_forms WHERE id = ?').get(formId)?.submissions_complete
  let after = null, added = 0, reachedEnd = false
  const freshIds = []
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: '50' })
    if (after) q.set('after', after)
    const data = await hsFetch(`/form-integrations/v1/submissions/forms/${formId}?${q}`)
    const results = data?.results || []
    let fresh = 0
    for (const s of results) {
      const id = s.conversionId || `${formId}:${s.submittedAt}`
      if (submissionExists.get(id)) continue
      if (saveSubmission(formId, s)) { fresh++; freshIds.push(id) }
    }
    added += fresh
    after = data?.paging?.next?.after
    if (!after) { reachedEnd = true; break }
    if (complete && fresh === 0) break
  }
  if (reachedEnd && !complete) db.prepare('UPDATE marketing_forms SET submissions_complete = 1 WHERE id = ?').run(formId)
  db.prepare(`
    UPDATE marketing_forms SET
      submission_count = (SELECT COUNT(*) FROM marketing_form_submissions WHERE form_id = @id),
      last_submission_at = (SELECT MAX(submitted_at) FROM marketing_form_submissions WHERE form_id = @id)
    WHERE id = @id
  `).run({ id: formId })
  await runScriptOnNewSubmissions(formId, freshIds)
  return added
}

// ── Script à la soumission ────────────────────────────────────────────────
// Code JS éditable sur la fiche du formulaire, exécuté dans le bac à sable des
// scripts (fetch limité aux origines SCRIPT_FETCH_ORIGINS). `row` = la
// soumission ({ email, first_name, last_name, company, page_url, values }).
// Chaque déclenchement est journalisé avec le code HTTP renvoyé.

export const DEFAULT_SUBMIT_SCRIPT = `async function createServerUser(email) {
    const encodedEmail = encodeURIComponent(email)

    console.log(encodedEmail)

    const url = "https://app.orisha.io/api/create-server-user?email=" + encodedEmail

    const response = await fetch(url).catch(err => {
        console.error("[waitlist] create-server-user failed:", err)

        throw new Error("Échec de la requête réseau vers create-server-user")
    })

    if (response && !response.ok) {
        if (response.status === 409) {
            console.log("Le serveur Orisha a répondu 409 : conflit ignoré.")

            return response
        }

        throw new Error("L'API create-server-user a renvoyé une erreur")
    }

    console.log(response)

    return response
}

await createServerUser(row.email)
`

const insertRun = db.prepare(`
  INSERT INTO marketing_form_script_runs (form_id, submission_id, email, status_code, ok, error, output, duration_ms)
  VALUES (@form_id, @submission_id, @email, @status_code, @ok, @error, @output, @duration_ms)
`)

export async function runSubmissionScript(form, submissionId) {
  const sub = db.prepare('SELECT * FROM marketing_form_submissions WHERE id = ?').get(submissionId)
  if (!sub) throw new Error('Soumission introuvable')
  const script = form.on_submit_script ?? DEFAULT_SUBMIT_SCRIPT
  const row = {
    id: sub.id, email: sub.email, first_name: sub.first_name, last_name: sub.last_name,
    company: sub.company, page_url: sub.page_url, submitted_at: sub.submitted_at,
    values: JSON.parse(sub.values_json || '[]'),
  }
  let status = null
  const t0 = Date.now()
  const run = { form_id: form.id, submission_id: sub.id, email: sub.email, status_code: null, ok: 0, error: null, output: null, duration_ms: null }
  try {
    const out = await runScriptSandboxed(script, {
      row, trigger: { form_id: form.id, form_name: form.name }, onFetch: r => { status = r.status },
    })
    Object.assign(run, { ok: 1, output: out.output })
  } catch (e) {
    Object.assign(run, { error: e.message, output: e.partialOutput || null })
  }
  run.status_code = status
  run.duration_ms = Date.now() - t0
  const id = insertRun.run(run).lastInsertRowid
  return db.prepare('SELECT * FROM marketing_form_script_runs WHERE id = ?').get(id)
}

async function runScriptOnNewSubmissions(formId, ids) {
  if (!ids.length) return
  const form = db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(formId)
  if (!form?.on_submit_enabled || !form.on_submit_enabled_at) return
  const subs = db.prepare(`
    SELECT id FROM marketing_form_submissions
    WHERE form_id = ? AND submitted_at >= ? AND id IN (${ids.map(() => '?').join(',')})
    ORDER BY submitted_at
  `).all(formId, form.on_submit_enabled_at, ...ids)
  for (const s of subs) {
    try { await runSubmissionScript(form, s.id) }
    catch (e) { console.error('[formulaires] script à la soumission :', e.message) }
  }
}

// ── Lancement groupé : soumissionnaires sans `new_server_password` ─────────
// Une soumission par courriel (la plus récente), seulement pour les contacts
// HubSpot existants dont la propriété est vide. Tourne en arrière-plan ; son
// avancement est exposé sur la fiche (`bulk_run`).

const bulkRuns = new Map() // formId → { total, done, failed }
export const bulkRunStatus = (formId) => bulkRuns.get(formId) || null

// Seules les soumissions depuis le 31 décembre 2025 (minuit, Montréal) comptent.
export const BULK_RUN_SINCE = '2025-12-31T05:00:00.000Z'

export async function submittersWithoutPassword(formId) {
  const latest = new Map()
  for (const s of db.prepare(`
    SELECT id, email FROM marketing_form_submissions
    WHERE form_id = ? AND trim(COALESCE(email, '')) != '' AND submitted_at >= ?
    ORDER BY submitted_at DESC
  `).all(formId, BULK_RUN_SINCE)) {
    const k = s.email.trim().toLowerCase()
    if (!latest.has(k)) latest.set(k, s.id)
  }
  const emails = [...latest.keys()]
  const ids = []
  for (let i = 0; i < emails.length; i += 100) {
    const data = await hsFetch('/crm/v3/objects/contacts/batch/read', {
      method: 'POST',
      body: { idProperty: 'email', properties: ['email', 'new_server_password'], inputs: emails.slice(i, i + 100).map(id => ({ id })) },
    })
    for (const r of data?.results || []) {
      const email = r.properties?.email?.trim().toLowerCase()
      if (email && latest.has(email) && !String(r.properties.new_server_password ?? '').trim()) ids.push(latest.get(email))
    }
  }
  return ids
}

export async function startBulkScriptRun(formId, { dry = false } = {}) {
  if (bulkRuns.has(formId)) throw new Error('Lancement déjà en cours')
  const state = { total: null, done: 0, failed: 0 }
  bulkRuns.set(formId, state)
  let ids
  try { ids = await submittersWithoutPassword(formId) }
  catch (e) { bulkRuns.delete(formId); throw e }
  if (dry || !ids.length) { bulkRuns.delete(formId); return { count: ids.length } }
  state.total = ids.length
  ;(async () => {
    try {
      for (const id of ids) {
        const form = db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(formId)
        try { if (!(await runSubmissionScript(form, id)).ok) state.failed++ }
        catch (e) { state.failed++; console.error('[formulaires] lancement groupé :', e.message) }
        state.done++
      }
    } finally { bulkRuns.delete(formId) }
  })()
  return { count: ids.length }
}

// Relève rapide (toutes les 2 min) des seuls formulaires dont le script est
// actif, pour que le déclenchement n'attende pas la synchro horaire.
export async function syncScriptedForms() {
  const forms = db.prepare('SELECT id FROM marketing_forms WHERE on_submit_enabled = 1 AND archived = 0').all()
  let added = 0
  for (const f of forms) added += await syncFormSubmissions(f.id, { maxPages: 5 })
  return added
}

// Synchronisation complète : tous les formulaires actifs, puis leurs
// soumissions. Un formulaire absent de HubSpot est marqué archivé.
export async function syncHubSpotForms({ submissions = true } = {}) {
  const forms = []
  let after = null
  do {
    const q = new URLSearchParams({ limit: '100' })
    if (after) q.set('after', after)
    const data = await hsFetch(`/marketing/v3/forms?${q}`)
    forms.push(...(data?.results || []))
    after = data?.paging?.next?.after
  } while (after)

  db.transaction(() => {
    for (const f of forms) saveForm(f)
    const ids = forms.map(f => f.id)
    const marks = ids.map(() => '?').join(',')
    db.prepare(`UPDATE marketing_forms SET archived = 1 WHERE archived = 0${ids.length ? ` AND id NOT IN (${marks})` : ''}`).run(...ids)
  })()

  let newSubmissions = 0
  const errors = []
  if (submissions) {
    for (const f of forms) {
      try { newSubmissions += await syncFormSubmissions(f.id) }
      catch (e) { errors.push(`${f.name}: ${e.message}`) }
    }
  }
  return { forms: forms.length, newSubmissions, errors }
}

// ── Création / modification ────────────────────────────────────────────────

// Champs proposés à la création — propriétés standard des contacts (0-1) et
// des entreprises (0-2) HubSpot.
export const FIELD_PRESETS = {
  firstname: { objectTypeId: '0-1', fieldType: 'single_line_text', label: { fr: 'Prénom', en: 'First name' } },
  lastname:  { objectTypeId: '0-1', fieldType: 'single_line_text', label: { fr: 'Nom', en: 'Last name' } },
  email:     { objectTypeId: '0-1', fieldType: 'email', label: { fr: 'Courriel', en: 'Email' }, required: true },
  phone:     { objectTypeId: '0-1', fieldType: 'phone', label: { fr: 'Téléphone', en: 'Phone' } },
  company:   { objectTypeId: '0-1', fieldType: 'single_line_text', label: { fr: 'Entreprise / ferme', en: 'Company / farm' } },
  city:      { objectTypeId: '0-1', fieldType: 'single_line_text', label: { fr: 'Ville', en: 'City' } },
  message:   { objectTypeId: '0-1', fieldType: 'multi_line_text', label: { fr: 'Message', en: 'Message' } },
}

function buildField(key, lang) {
  const p = FIELD_PRESETS[key]
  const field = {
    objectTypeId: p.objectTypeId, name: key, label: p.label[lang] || p.label.en,
    required: !!p.required, hidden: false, fieldType: p.fieldType,
  }
  if (p.fieldType === 'email') field.validation = { blockedEmailDomains: [], useDefaultBlockList: false }
  if (p.fieldType === 'phone') field.validation = { minAllowedDigits: 7, maxAllowedDigits: 20 }
  return field
}

export async function createHubSpotForm({ name, language = 'fr', fields = ['firstname', 'lastname', 'email'], submitText, thankYou }) {
  const lang = language === 'en' ? 'en' : 'fr'
  // Le courriel est obligatoire : HubSpot en a besoin pour créer le contact.
  const keys = [...new Set(fields.filter(k => FIELD_PRESETS[k]))]
  if (!keys.includes('email')) keys.unshift('email')
  const body = {
    name,
    formType: 'hubspot',
    archived: false,
    createdAt: now(),
    // Un champ par groupe : HubSpot plafonne le nombre de champs par groupe.
    fieldGroups: keys.map(k => ({ groupType: 'default_group', richTextType: 'text', fields: [buildField(k, lang)] })),
    configuration: {
      language: lang,
      cloneable: true,
      postSubmitAction: { type: 'thank_you', value: thankYou || (lang === 'fr' ? 'Merci ! Nous vous contacterons sous peu.' : 'Thanks! We will be in touch shortly.') },
      editable: true,
      archivable: true,
      recaptchaEnabled: false,
      notifyContactOwner: false,
      notifyRecipients: [],
      createNewContactForNewEmail: true,
      prePopulateKnownValues: true,
      allowLinkToResetKnownValues: false,
      lifecycleStages: [],
    },
    displayOptions: {
      renderRawHtml: false,
      theme: 'default_style',
      submitButtonText: submitText || (lang === 'fr' ? 'Envoyer' : 'Submit'),
      style: {
        fontFamily: 'Montserrat', backgroundWidth: '100%',
        labelTextColor: '#33475b', labelTextSize: '12px',
        helpTextColor: '#7C98B6', helpTextSize: '11px',
        legalConsentTextColor: '#33475b', legalConsentTextSize: '14px',
        submitColor: '#25b14e', submitAlignment: 'left', submitFontColor: '#ffffff', submitSize: '12px',
      },
      cssClass: 'hs-form stacked',
    },
    legalConsentOptions: { type: 'none' },
  }
  const form = await hsFetch('/marketing/v3/forms', { method: 'POST', body, retries: 0 })
  saveForm(form)
  return form.id
}

// Seul le nom est modifiable depuis l'ERP — la mise en page se fait dans
// l'éditeur HubSpot (lien sur la fiche).
export async function renameHubSpotForm(id, name) {
  const form = await hsFetch(`/marketing/v3/forms/${id}`, { method: 'PATCH', body: { name }, retries: 0 })
  saveForm(form)
}
