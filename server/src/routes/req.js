// Registre des entreprises du Québec (REQ) — consultation du miroir local,
// liaison d'une fiche entreprise à son NEQ, et prospection horticole.
//
// LECTURE SEULE côté REQ : aucune route ne parle au Registraire autrement que
// pour télécharger le jeu de données public. Les seules écritures sont côté
// ERP : `companies.neq` (liaison) et la création d'un prospect + son projet.
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { emitCompany } from '../services/realtimeEmitters.js'
import { logSync } from '../services/syncLog.js'
import {
  runReqImport, getReqStatus, searchReq, getByNeq, matchCompany, listReqProspects, normalizeName,
} from '../services/reqImport.js'

const router = Router()
router.use(requireAuth)

// Le CSV collé à la main peut peser quelques dizaines de Mo (le registre entier
// est bien plus gros — il passe alors par le ZIP déposé sur le serveur).
const MAX_CSV_CHARS = 60 * 1024 * 1024

const NEQ_RE = /^\d{6,12}$/

// GET /api/req/status — volumétrie du miroir + dernière livraison importée.
router.get('/status', (req, res) => {
  res.json(getReqStatus())
})

// GET /api/req/search?q=… — picker « Corriger la correspondance ».
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ data: [] })
  res.json({ data: searchReq(q, Number(req.query.limit) || 25) })
})

// GET /api/req/entreprises/:neq — fiche registre d'un NEQ.
router.get('/entreprises/:neq', (req, res) => {
  const row = getByNeq(req.params.neq)
  if (!row) return res.status(404).json({ error: 'NEQ introuvable dans le registre' })
  res.json(row)
})

// GET /api/req/match/:companyId — correspondance automatique (nom + ville) et
// NEQ déjà lié le cas échéant. N'écrit rien : la liaison reste explicite.
router.get('/match/:companyId', (req, res) => {
  const company = db.prepare('SELECT id, name, city, neq FROM companies WHERE id = ? AND deleted_at IS NULL').get(req.params.companyId)
  if (!company) return res.status(404).json({ error: 'Entreprise introuvable' })

  const linked = company.neq ? getByNeq(company.neq) : null
  // Un NEQ lié à la main fait foi : on ne repropose pas de correspondance
  // par-dessus, mais on garde la trace d'un NEQ absent du miroir (registre pas
  // encore importé, ou entreprise disparue d'une livraison).
  if (company.neq) {
    return res.json({
      company_id: company.id, neq: company.neq, linked: true,
      entreprise: linked, missing_from_registry: !linked,
      match: null, candidates: [], suggested: false,
    })
  }
  const { match, candidates, exact_city, ambiguous } = matchCompany(company)
  res.json({
    company_id: company.id, neq: null, linked: false, entreprise: null,
    match, candidates, exact_city: !!exact_city, ambiguous: !!ambiguous, suggested: !!match,
  })
})

// PUT /api/req/link/:companyId — lie (ou délie avec neq: null) la fiche à un NEQ.
router.put('/link/:companyId', (req, res) => {
  const company = db.prepare('SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL').get(req.params.companyId)
  if (!company) return res.status(404).json({ error: 'Entreprise introuvable' })

  const raw = req.body?.neq
  if (raw === null || raw === '' || raw === undefined) {
    db.prepare("UPDATE companies SET neq = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(company.id)
    emitCompany('updated', company.id, req.user?.id)
    return res.json({ company_id: company.id, neq: null, entreprise: null })
  }

  const neq = String(raw).trim()
  if (!NEQ_RE.test(neq)) return res.status(400).json({ error: 'NEQ invalide (6 à 12 chiffres)' })
  const entreprise = getByNeq(neq)
  if (!entreprise) return res.status(404).json({ error: 'NEQ absent du registre importé' })

  db.prepare("UPDATE companies SET neq = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(neq, company.id)
  emitCompany('updated', company.id, req.user?.id)
  res.json({ company_id: company.id, neq, entreprise })
})

// GET /api/req/prospects — entreprises horticoles du registre sans correspondance.
router.get('/prospects', (req, res) => {
  const { search = '', region = '', limit } = req.query
  res.json(listReqProspects({
    search: String(search), region: String(region),
    limit: limit ? Number(limit) || 500 : 500,
  }))
})

// POST /api/req/prospects — crée l'entreprise + son projet de prospection.
// Body : { neq } ou { neqs: [...] }. Ne met jamais à jour une fiche existante.
router.post('/prospects', (req, res) => {
  const list = Array.isArray(req.body?.neqs) ? req.body.neqs : (req.body?.neq ? [req.body.neq] : [])
  const neqs = [...new Set(list.map(n => String(n || '').trim()).filter(Boolean))]
  if (!neqs.length) return res.status(400).json({ error: 'neq (ou neqs) requis' })
  if (neqs.length > 200) return res.status(400).json({ error: 'Maximum 200 entrées par lot' })

  const started = Date.now()
  const created = []
  const skipped = []

  const insertCompany = db.prepare(`
    INSERT INTO companies (id, name, type, lifecycle_phase, address, city, province, country,
      notes, source, currency, neq, created_at, updated_at)
    VALUES (?, ?, 'Prospect', 'Lead', ?, ?, ?, 'Canada', ?, 'REQ', 'CAD', ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)
  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, company_id, type, status, probability, notes, creation, created_at, updated_at)
    VALUES (?, ?, ?, 'Nouveau client', 'Ouvert', 0, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `)

  for (const neq of neqs) {
    const e = getByNeq(neq)
    if (!e) { skipped.push({ neq, reason: 'NEQ absent du registre importé' }); continue }
    if (!String(e.nom_legal || '').trim()) { skipped.push({ neq, reason: 'Aucun nom au registre' }); continue }

    // Re-vérification côté serveur : la liste peut dater. Une entreprise déjà
    // dans l'ERP (par NEQ ou par nom) n'est ni recréée ni écrasée.
    const byNeq = db.prepare('SELECT id, name FROM companies WHERE neq = ? AND deleted_at IS NULL').get(neq)
    if (byNeq) { skipped.push({ neq, reason: 'Déjà liée à une entreprise', company_id: byNeq.id, company_name: byNeq.name }); continue }
    const norm = normalizeName(e.nom_legal)
    const byName = norm
      ? db.prepare("SELECT id, name FROM companies WHERE deleted_at IS NULL AND name IS NOT NULL").all()
        .find(c => normalizeName(c.name) === norm)
      : null
    if (byName) { skipped.push({ neq, reason: 'Entreprise déjà présente dans l\'ERP', company_id: byName.id, company_name: byName.name }); continue }

    const notes = [
      'Prospect importé du Registre des entreprises du Québec (culture en serre / horticulture).',
      `NEQ : ${e.neq}`,
      e.desc_activite ? `Activité déclarée : ${e.desc_activite}` : null,
      e.date_immat ? `Immatriculée le ${e.date_immat}` : null,
      e.code_postal ? `Code postal : ${e.code_postal}` : null,
    ].filter(Boolean).join('\n')

    const companyId = uuidv4()
    const projectId = uuidv4()
    db.transaction(() => {
      insertCompany.run(companyId, e.nom_legal, e.adresse, e.ville, e.province || 'QC', notes, e.neq)
      insertProject.run(
        projectId, `Prospection REQ — ${e.nom_legal}`, companyId,
        "Créé automatiquement depuis le Registre des entreprises du Québec. Stade initial de prospection.",
        new Date().toISOString(),
      )
    })()
    emitCompany('created', companyId, req.user?.id)
    created.push({ neq, name: e.nom_legal, company_id: companyId, project_id: projectId })
  }

  logSync('req', 'manual', { status: 'success', modified: created.length, durationMs: Date.now() - started })
  res.status(201).json({ created, skipped })
})

// POST /api/req/import — import manuel. Réservé aux admins : il réécrit le
// miroir complet et peut tourner de longues minutes.
// Body : { csv?, zip_path?, apply? }
router.post('/import', requireAdmin, async (req, res) => {
  const { csv, zip_path: zipPath, apply } = req.body || {}
  if (csv != null && typeof csv !== 'string') return res.status(400).json({ error: 'csv doit être une chaîne' })
  if (typeof csv === 'string' && csv.length > MAX_CSV_CHARS) {
    return res.status(400).json({ error: 'Contenu trop volumineux (max 60 Mo) — déposer le ZIP sur le serveur et passer zip_path' })
  }
  if (zipPath != null && typeof zipPath !== 'string') return res.status(400).json({ error: 'zip_path doit être une chaîne' })

  try {
    const out = await runReqImport({
      trigger: 'manuel',
      csv: csv || null,
      zipPath: zipPath || null,
      apply: apply !== false,
    })
    res.json(out)
  } catch (e) {
    res.status(502).json({ error: `Import du registre impossible : ${e.message}` })
  }
})

// DELETE /api/req/entreprises/:neq — retire une ligne du miroir (soft delete).
// L'import ne supprimant jamais, c'est le seul moyen d'écarter une ligne fautive.
// La ligne reste écartée après les livraisons suivantes : l'upsert met ses
// champs à jour mais ne touche pas `deleted_at` — sinon la décision de l'écarter
// serait annulée par le prochain import mensuel.
router.delete('/entreprises/:neq', requireAdmin, (req, res) => {
  const neq = String(req.params.neq || '').trim()
  const { changes } = db.prepare(
    "UPDATE req_entreprises SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE neq = ? AND deleted_at IS NULL",
  ).run(neq)
  if (!changes) return res.status(404).json({ error: 'NEQ introuvable dans le registre' })
  res.json({ neq, deleted: true })
})

export default router
