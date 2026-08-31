import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { getCentralControllers } from '../utils/centralController.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { checkForeignKeys } from '../utils/fkExists.js';
import { emitEntity } from '../services/realtimeEmitters.js';
import { notifyAssignment } from '../services/notifications.js';
import { surveyEligibility, getSurveyByTicket, sendTicketSurvey, surveyUrl } from '../services/ticketSurveys.js';
import { writeBackRecord } from '../services/airtableWriteback.js';

const router = Router();
router.use(requireAuth);

// Sondage de satisfaction : le rating remonte sur CHAQUE ligne de billet pour
// alimenter la colonne « Satisfaction » (masquée par défaut) sans second appel.
// LEFT JOIN plutôt que sous-requête : idx_ticket_surveys_ticket est unique, il
// ne peut donc pas multiplier les lignes.
const SURVEY_JOIN = `
     LEFT JOIN ticket_surveys tsv ON tsv.ticket_id = t.id AND tsv.deleted_at IS NULL`
const SURVEY_COLS = `,
      tsv.rating as survey_rating, tsv.send_status as survey_send_status,
      tsv.responded_at as survey_responded_at, tsv.sent_at as survey_sent_at`

function buildTicketRow(id) {
  const r = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name,
      ct.first_name || ' ' || ct.last_name as contact_name${SURVEY_COLS}
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id${SURVEY_JOIN}
     WHERE t.id = ?`
  ).get(id)
  if (r) r.central_controllers = getCentralControllers(r.company_id)
  return r
}

// GET /api/tickets/meta — distinct types & statuses
router.get('/meta', (req, res) => {
  const types = db.prepare("SELECT DISTINCT type FROM tickets WHERE type IS NOT NULL AND type != '' ORDER BY type").all().map(r => r.type);
  const statuses = db.prepare("SELECT DISTINCT status FROM tickets WHERE status IS NOT NULL AND status != '' ORDER BY status").all().map(r => r.status);
  res.json({ types, statuses });
});

// GET /api/tickets
router.get('/', (req, res) => {
  const { search, status, type, company_id, assigned_to, page = 1, limit = 50 } = req.query;
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE 1=1';
  const params = [];

  if (search) {
    where += ' AND (t.title LIKE ? OR c.name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND t.status = ?';
    params.push(status);
  }
  if (type) {
    where += ' AND t.type = ?';
    params.push(type);
  }
  if (company_id) {
    where += ' AND t.company_id = ?';
    params.push(company_id);
  }
  if (assigned_to) {
    where += ' AND t.assigned_to = ?';
    params.push(assigned_to);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM tickets t LEFT JOIN companies c ON t.company_id = c.id ${where}`
  ).get(...params).c;

  const tickets = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name,
      ct.first_name || ' ' || ct.last_name as contact_name${SURVEY_COLS}
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id${SURVEY_JOIN}
     ${where}
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: tickets, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/tickets/ids — minimal payload (id only) for prev/next navigation
router.get('/ids', (req, res) => {
  const rows = db.prepare(`SELECT id FROM tickets ORDER BY created_at DESC`).all()
  res.json(rows.map(r => r.id))
})

// GET /api/tickets/keywords — options du champ « Mots clés » (multi-sélection).
// Les mots-clés viennent d'Airtable, dont la liste de choix n'est pas répliquée
// dans la config du champ : on dérive donc les options de l'usage réel, les plus
// utilisées en tête (comme le menu d'un champ multi-select Airtable).
router.get('/keywords', (req, res) => {
  const rows = db.prepare(`SELECT mots_cles FROM tickets WHERE mots_cles IS NOT NULL AND mots_cles != ''`).all()
  const counts = new Map()
  for (const r of rows) {
    let items
    // Valeurs historiques : tableau JSON (sync Airtable) ou texte libre séparé
    // par des virgules (ancien champ texte de la fiche billet).
    try { items = JSON.parse(r.mots_cles) } catch { items = String(r.mots_cles).split(',') }
    if (!Array.isArray(items)) items = [items]
    for (const raw of items) {
      const k = String(raw ?? '').trim()
      if (k) counts.set(k, (counts.get(k) || 0) + 1)
    }
  }
  const keywords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'))
    .map(([label]) => label)
  res.json(keywords)
})

// GET /api/tickets/:id/survey — état du sondage + éligibilité à l'envoi.
// L'éligibilité vient du serveur (jamais recalculée côté front) pour que le
// bouton désactivé et le refus d'envoi appliquent exactement la même règle.
router.get('/:id/survey', (req, res) => {
  const exists = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id)
  if (!exists) return res.status(404).json({ error: 'Ticket not found' })
  const survey = getSurveyByTicket(req.params.id)
  res.json({
    eligibility: surveyEligibility(req.params.id),
    survey: survey || null,
    survey_url: survey ? surveyUrl(survey.token) : null,
  })
})

// POST /api/tickets/:id/survey — envoie (ou renvoie) le sondage par SMS.
// Envoi 100 % manuel, aucune restriction de statut : c'est l'humain qui juge.
router.post('/:id/survey', async (req, res) => {
  const exists = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id)
  if (!exists) return res.status(404).json({ error: 'Ticket not found' })

  const result = await sendTicketSurvey(req.params.id, {
    userId: req.user?.id || null,
    phoneOverride: req.body?.phone || null,
  })
  if (!result.ok) return res.status(400).json({ error: result.error, survey: result.survey || null })

  emitEntity('ticket', 'updated', req.params.id, buildTicketRow(req.params.id), req.user?.id)
  res.json({
    survey: result.survey,
    survey_url: surveyUrl(result.survey.token),
    simulated: !!result.simulated,
  })
})

// GET /api/tickets/:id
router.get('/:id', (req, res) => {
  const ticket = db.prepare(
    `SELECT t.*, c.name as company_name, u.name as assigned_name,
      ct.first_name || ' ' || ct.last_name as contact_name${SURVEY_COLS}
     FROM tickets t
     LEFT JOIN companies c ON t.company_id = c.id
     LEFT JOIN users u ON t.assigned_to = u.id
     LEFT JOIN contacts ct ON t.contact_id = ct.id${SURVEY_JOIN}
     WHERE t.id = ?`
  ).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  ticket.central_controllers = getCentralControllers(ticket.company_id);
  res.json(ticket);
});

// POST /api/tickets
router.post('/', (req, res) => {
  const { company_id, contact_id, assigned_to, title, description, response, type, status, duration_minutes } = req.body;
  const fkErr = checkForeignKeys({ company_id, contact_id });
  if (fkErr) return res.status(400).json({ error: fkErr.message });
  const id = uuidv4();
  db.prepare(
    `INSERT INTO tickets (id, company_id, contact_id, assigned_to, title, description, response, type, status, duration_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, company_id || null, contact_id || null, assigned_to || null,
    title, description || null, response || null, type || null, status || 'Waiting on us', duration_minutes || 0);

  const created = buildTicketRow(id);
  emitEntity('ticket', 'created', id, created, req.user?.id);
  notifyAssignment({
    assignedTo: assigned_to,
    actorUserId: req.user?.id,
    type: 'ticket:assigned',
    title: `Ticket assigné : ${title}`,
    link: `/tickets/${id}`,
  });
  res.status(201).json(created);
});

// PUT /api/tickets/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id, assigned_to, title FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['company_id', 'contact_id', 'assigned_to', 'title', 'description',
      'response', 'type', 'status', 'duration_minutes',
      'lien_issue_github', 'escalade', 'mots_cles',
      'arbre_de_troubleshoot_utilise', 'documents', 'items_retours'],
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE tickets SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
    // Write-back ERP → Airtable (fire-and-forget) : ne pousse que les colonnes
    // modifiées dont le sens n'est pas 'pull' — échecs tracés dans sync_log.
    writeBackRecord('billets', req.params.id, Object.keys(req.body));
  }

  const updated = buildTicketRow(req.params.id);
  emitEntity('ticket', 'updated', req.params.id, updated, req.user?.id);
  if ('assigned_to' in req.body) {
    notifyAssignment({
      assignedTo: req.body.assigned_to,
      prevAssignedTo: existing.assigned_to,
      actorUserId: req.user?.id,
      type: 'ticket:assigned',
      title: `Ticket assigné : ${updated?.title || existing.title}`,
      link: `/tickets/${req.params.id}`,
    });
  }
  res.json(updated);
});

// PATCH /api/tickets/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required' });
  db.prepare(`UPDATE tickets SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(status, req.params.id);
  writeBackRecord('billets', req.params.id, ['status']);
  emitEntity('ticket', 'updated', req.params.id, buildTicketRow(req.params.id), req.user?.id);
  res.json({ message: 'Status updated' });
});

// DELETE /api/tickets/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });
  const tx = db.transaction((id) => {
    db.prepare(`UPDATE tasks SET ticket_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ticket_id = ?`).run(id);
    db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  });
  tx(req.params.id);
  emitEntity('ticket', 'deleted', req.params.id, { id: req.params.id }, req.user?.id);
  res.json({ message: 'Deleted' });
});

export default router;
