import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { isHubSpotConfigured } from '../connectors/hubspot.js'
import {
  syncHubSpotForms, syncFormSubmissions, createHubSpotForm, renameHubSpotForm,
  hubspotPortalId, FIELD_PRESETS, DEFAULT_SUBMIT_SCRIPT, runSubmissionScript,
  startBulkScriptRun, bulkRunStatus,
} from '../services/hubspotForms.js'
import { logSync } from '../services/syncLog.js'

// Formulaires de capture de leads (Marketing → Formulaires), miroir HubSpot.
const router = Router()
router.use(requireAuth)

const parseForm = (row) => row && ({
  ...row, fields: JSON.parse(row.fields_json || '[]'), fields_json: undefined,
  on_submit_script: row.on_submit_script ?? DEFAULT_SUBMIT_SCRIPT,
})
const scriptRuns = (formId) => db.prepare(`
  SELECT * FROM marketing_form_script_runs WHERE form_id = ? ORDER BY ran_at DESC, id DESC LIMIT 500
`).all(formId)

function requireHubSpot(res) {
  if (isHubSpotConfigured()) return true
  res.status(400).json({ error: 'HubSpot non configuré (Connecteurs)' })
  return false
}

router.get('/', (req, res) => {
  const data = db.prepare(`
    SELECT id, name, form_type, language, embed_type, field_count, archived, submission_count,
           last_submission_at, hs_created_at, hs_updated_at, synced_at
    FROM marketing_forms
    WHERE archived = 0
    ORDER BY COALESCE(last_submission_at, hs_updated_at) DESC
  `).all()
  res.json({ data, total: data.length })
})

router.get('/field-presets', (req, res) => {
  res.json(Object.entries(FIELD_PRESETS).map(([key, p]) => ({ key, label: p.label.fr, required: !!p.required })))
})

router.post('/sync', async (req, res) => {
  if (!requireHubSpot(res)) return
  const t0 = Date.now()
  try {
    const out = await syncHubSpotForms()
    logSync('hubspot_forms', 'manual', {
      status: out.errors.length ? 'error' : 'success', modified: out.newSubmissions,
      error: out.errors.join(' · ') || null, durationMs: Date.now() - t0,
    })
    res.json(out)
  } catch (e) {
    logSync('hubspot_forms', 'manual', { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    res.status(502).json({ error: e.message })
  }
})

router.post('/', async (req, res) => {
  if (!requireHubSpot(res)) return
  const { name, language, fields, submit_text, thank_you } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nom requis' })
  try {
    const id = await createHubSpotForm({
      name: String(name).trim(), language,
      fields: Array.isArray(fields) ? fields : undefined,
      submitText: submit_text, thankYou: thank_you,
    })
    res.status(201).json(parseForm(db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(id)))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

router.get('/:id', async (req, res) => {
  const form = parseForm(db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(req.params.id))
  if (!form) return res.status(404).json({ error: 'Formulaire introuvable' })
  const submissions = db.prepare(`
    SELECT s.id, s.submitted_at, s.email, s.first_name, s.last_name, s.company, s.page_url,
           (SELECT c.id FROM contacts c WHERE s.email IS NOT NULL AND lower(c.email) = lower(s.email) LIMIT 1) AS contact_id
    FROM marketing_form_submissions s
    WHERE s.form_id = ?
    ORDER BY s.submitted_at DESC
  `).all(form.id)
  let portal_id = null
  try { portal_id = isHubSpotConfigured() ? await hubspotPortalId() : null } catch { /* lien HubSpot absent */ }
  res.json({ ...form, submissions, script_runs: scriptRuns(form.id), portal_id, bulk_run: bulkRunStatus(form.id) })
})

router.patch('/:id', async (req, res) => {
  const exists = db.prepare('SELECT on_submit_enabled FROM marketing_forms WHERE id = ?').get(req.params.id)
  if (!exists) return res.status(404).json({ error: 'Formulaire introuvable' })
  const body = req.body || {}
  // Script à la soumission : local à l'ERP, HubSpot non concerné.
  if ('on_submit_script' in body || 'on_submit_enabled' in body) {
    if ('on_submit_script' in body) {
      if (typeof body.on_submit_script !== 'string') return res.status(400).json({ error: 'Script invalide' })
      db.prepare('UPDATE marketing_forms SET on_submit_script = ? WHERE id = ?').run(body.on_submit_script, req.params.id)
    }
    if ('on_submit_enabled' in body) {
      const on = body.on_submit_enabled ? 1 : 0
      // L'activation date le point de départ : les soumissions antérieures ne déclenchent rien.
      if (on && !exists.on_submit_enabled) {
        db.prepare('UPDATE marketing_forms SET on_submit_enabled = 1, on_submit_enabled_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id)
      } else if (!on) {
        db.prepare('UPDATE marketing_forms SET on_submit_enabled = 0 WHERE id = ?').run(req.params.id)
      }
    }
    if (!('name' in body)) return res.json(parseForm(db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(req.params.id)))
  }
  if (!requireHubSpot(res)) return
  const { name } = body
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nom requis' })
  try {
    await renameHubSpotForm(req.params.id, String(name).trim())
    res.json(parseForm(db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(req.params.id)))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

router.post('/:id/sync', async (req, res) => {
  if (!requireHubSpot(res)) return
  try {
    const added = await syncFormSubmissions(req.params.id)
    res.json({ added })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Lancement du script pour les soumissionnaires dont `new_server_password`
// est vide dans HubSpot. `dry` : compte seulement (confirmation côté UI).
router.post('/:id/run-missing-password', async (req, res) => {
  if (!requireHubSpot(res)) return
  if (!db.prepare('SELECT 1 FROM marketing_forms WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Formulaire introuvable' })
  try {
    const out = await startBulkScriptRun(req.params.id, { dry: !!req.body?.dry })
    res.json({ ...out, bulk_run: bulkRunStatus(req.params.id) })
  } catch (e) {
    res.status(e.message === 'Lancement déjà en cours' ? 409 : 502).json({ error: e.message })
  }
})

// Relance manuelle du script pour la soumission d'un déclenchement passé.
router.post('/:id/script-runs/:runId/retry', async (req, res) => {
  const form = db.prepare('SELECT * FROM marketing_forms WHERE id = ?').get(req.params.id)
  const run = db.prepare('SELECT submission_id FROM marketing_form_script_runs WHERE id = ? AND form_id = ?').get(req.params.runId, req.params.id)
  if (!form || !run?.submission_id) return res.status(404).json({ error: 'Déclenchement introuvable' })
  try {
    res.json(await runSubmissionScript(form, run.submission_id))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

export default router
