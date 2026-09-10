import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import db from '../db/database.js'
import { readRelation } from '../services/customFieldsView.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { emitEntity } from '../services/realtimeEmitters.js';
import { surveyEligibility, getSurveyByTicket, sendTicketSurvey, surveyUrl } from '../services/ticketSurveys.js';
import { writeBackRecord, createInAirtable } from '../services/airtableWriteback.js';
import { logSync } from '../services/syncLog.js';
import { deleteTicketCascade } from '../services/ticketDelete.js';
import { parsePage } from '../utils/pagination.js';
import { getWritableCustomColumns, refusedAirtablePullKeys, AIRTABLE_PULL_EDIT_ERROR } from '../services/customFieldWritability.js';

const router = Router();
router.use(requireAuth);

// Titre, question, réponse, type, statut, durée, date de création, entreprise et
// contact ont été droppés sur demande (migration 040) : un billet n'a plus de
// colonne native descriptive. Tout ce qui le décrit vit dans ses champs
// personnalisés, réglés depuis /champs/tickets et lus par la vue `tickets_v`.
// Conséquences ici : plus de /meta (aucun type ni statut), plus de filtres
// entreprise / statut / type, tri sur `updated_at`.
const ORDER_BY = 't.updated_at DESC'

// Colonnes modifiables depuis la fiche : les champs Airtable adoptés que la
// fiche édite en ligne. Les colonnes cf_ éditables s'y ajoutent au PUT
// (getWritableCustomColumns) — c'est par là que passent « Entreprise »
// (cf_entreprise) et « Contact » (cf_contact), les deux champs lien de la fiche.
//
// L'assignation n'est plus là : `assigned_to` (FK vers `users`, 8 billets sur
// 3 688) doublait « Assigné à », le champ réglé dans /champs/tickets et importé
// du « Responsable » d'Airtable — elle a été droppée (migration 048). Il n'y a
// donc plus de notification « Billet assigné » : le champ survivant porte un
// prénom, pas un utilisateur ERP.
const PATCHABLE_FIELDS = ['lien_issue_github', 'escalade', 'mots_cles',
  'arbre_de_troubleshoot_utilise', 'documents', 'items_retours']

// Colonnes déjà posées par le INSERT de base : une colonne du registre du même
// nom les dupliquerait dans la requête.
const CREATE_BASE_COLUMNS = new Set(['id'])

// SQLite ne sait pas lier un booléen : une case à cocher arrive en true/false.
function bindable(v) {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === '' || v === undefined) return null
  return v
}

// Miroir Airtable d'un billet, asynchrone et non bloquant : le billet existe
// dans Boréal même si Airtable est indisponible, et le prochain enregistrement
// de la fiche retentera la création (cf. PUT plus bas). `createInAirtable` ne
// lève jamais — chaque échec laisse déjà une trace dans sync_log — ce .catch
// n'est donc qu'un dernier filet.
function pushAirtable(promise, trigger, recordId) {
  return promise.catch(e => {
    console.error(`${trigger} billets ${recordId} (async):`, e.message)
    logSync('billets', trigger, { status: 'error', error: `${recordId}: ${e.message}` })
  })
}

// Sondage de satisfaction : le rating remonte sur CHAQUE ligne de billet pour
// alimenter la colonne « Satisfaction » (masquée par défaut) sans second appel.
// LEFT JOIN plutôt que sous-requête : idx_ticket_surveys_ticket est unique, il
// ne peut donc pas multiplier les lignes.
const SURVEY_JOIN = `
     LEFT JOIN ticket_surveys tsv ON tsv.ticket_id = t.id AND tsv.deleted_at IS NULL`
const SURVEY_COLS = `,
      tsv.send_status as survey_send_status,
      tsv.responded_at as survey_responded_at, tsv.sent_at as survey_sent_at`

function buildTicketRow(id) {
  return db.prepare(
    `SELECT t.*${SURVEY_COLS}
     FROM ${readRelation('tickets')} t${SURVEY_JOIN}
     WHERE t.id = ?`
  ).get(id)
}

// GET /api/tickets
router.get('/', (req, res) => {
  const { page, limit, limitVal, offset } = parsePage(req.query, 50);
  const where = 'WHERE 1=1';
  const params = [];

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM ${readRelation('tickets')} t ${where}`
  ).get(...params).c;

  const tickets = db.prepare(
    `SELECT t.*${SURVEY_COLS}
     FROM ${readRelation('tickets')} t${SURVEY_JOIN}
     ${where}
     ORDER BY ${ORDER_BY}
     LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset);

  res.json({ data: tickets, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/tickets/ids — minimal payload (id only) for prev/next navigation
router.get('/ids', (req, res) => {
  const rows = db.prepare(`SELECT id FROM tickets t ORDER BY ${ORDER_BY}`).all()
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

// GET /api/tickets/:id/survey — état du sondage + valeurs proposées à l'envoi.
// Le numéro proposé vient du dernier envoi, sinon du contact lié au billet
// (mobile, puis téléphone) ; la langue, du dernier envoi seulement. Une seule
// fonction décide, pour le front comme pour la route d'envoi.
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
// Envoi 100 % manuel : c'est l'humain qui juge le moment, le numéro et la langue.
router.post('/:id/survey', async (req, res) => {
  const exists = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id)
  if (!exists) return res.status(404).json({ error: 'Ticket not found' })

  const result = await sendTicketSurvey(req.params.id, {
    userId: req.user?.id || null,
    phoneOverride: req.body?.phone || null,
    language: req.body?.language || null,
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
  const ticket = buildTicketRow(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
});

// POST /api/tickets
//
// La création accepte TOUS les champs du registre de la table qui sont
// éditables (règle unique de customFieldWritability.js) : le formulaire
// « Nouveau billet » les propose tous dans « Modifier le formulaire »
// (client/src/pages/Tickets.jsx, `includeAllFields`). Sans ça, un champ ajouté
// au formulaire semblerait se saisir puis ne rien enregistrer.
router.post('/', (req, res) => {
  // Un champ Airtable en import seul est refusé en 400 explicite plutôt
  // qu'ignoré en silence : la valeur saisie serait écrasée au prochain sync.
  if (refusedAirtablePullKeys('tickets', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
  }

  const extras = {};
  const writable = new Set();
  for (const { column_name: col } of getWritableCustomColumns('tickets')) {
    writable.add(col);
    if (CREATE_BASE_COLUMNS.has(col) || col in extras) continue;
    if (!Object.prototype.hasOwnProperty.call(req.body, col)) continue;
    extras[col] = bindable(req.body[col]);
  }
  // Date d'ouverture. Un billet né dans Airtable porte toujours la sienne (le
  // champ « Date » y est rempli à la création) : on la pose donc aussi ici,
  // quand le formulaire ne la demande pas. Sans elle, un billet ouvert sans
  // aucun autre champ rempli n'aurait rien à pousser vers Airtable — et donc
  // pas de jumeau du tout.
  if (writable.has('cf_date') && !extras.cf_date) extras.cf_date = new Date().toISOString();
  const extraCols = Object.keys(extras);

  const id = newRecordId();
  db.prepare(
    `INSERT INTO tickets (id${extraCols.map(c => `, ${c}`).join('')})
     VALUES (?${extraCols.map(() => ', ?').join('')})`
  ).run(id, ...extraCols.map(c => extras[c]));

  const created = buildTicketRow(id);
  emitEntity('ticket', 'created', id, created, req.user?.id);

  // Création Boréal → Airtable : le support travaille encore les billets dans
  // Airtable, un billet ouvert ici doit donc y apparaître aussi. Poussés : les
  // champs dont le sens est « Bidirectionnel » ou « Boréal → Airtable » dans
  // /champs/tickets, plus les liens entreprise et contact (cf.
  // WRITEBACK_MODULES.billets). L'airtable_id revenu du POST est écrit sur le
  // billet : la suite passe par le write-back ordinaire, sans doublon.
  pushAirtable(createInAirtable('billets', id), 'erp-create', id);

  res.status(201).json(created);
});

// PUT /api/tickets/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });

  // Un champ Airtable en import seul est refusé en 400 explicite plutôt
  // qu'ignoré en silence : la valeur saisie serait écrasée au prochain sync.
  if (refusedAirtablePullKeys('tickets', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
  }
  const customCols = getWritableCustomColumns('tickets').map(c => c.column_name);
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: [...PATCHABLE_FIELDS, ...customCols],
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE tickets SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
    const linked = db.prepare('SELECT airtable_id FROM tickets WHERE id = ?').get(req.params.id)?.airtable_id
    if (linked) {
      // Write-back ERP → Airtable (fire-and-forget) : ne pousse que les colonnes
      // modifiées dont le sens n'est pas 'pull' — échecs tracés dans sync_log.
      pushAirtable(writeBackRecord('billets', req.params.id, Object.keys(req.body)), 'erp-writeback', req.params.id);
    } else {
      // Billet pas encore lié : créé dans Boréal alors qu'Airtable était
      // indisponible. Chemin de rattrapage — enregistrer la fiche le pousse enfin.
      pushAirtable(createInAirtable('billets', req.params.id), 'erp-create', req.params.id);
    }
  }

  const updated = buildTicketRow(req.params.id);
  emitEntity('ticket', 'updated', req.params.id, updated, req.user?.id);
  res.json(updated);
});

// DELETE /api/tickets/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM tickets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ticket not found' });
  try {
    deleteTicketCascade(db, req.params.id);
  } catch (err) {
    console.error('[tickets] delete failed', req.params.id, err);
    return res.status(409).json({ error: 'Impossible de supprimer ce billet : des données liées y font encore référence.' });
  }
  emitEntity('ticket', 'deleted', req.params.id, { id: req.params.id }, req.user?.id);
  res.json({ message: 'Deleted' });
});

export default router;
