import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPartialUpdate } from '../utils/partialUpdate.js';
import { validateNumericFields } from '../utils/validateNumbers.js';
import { checkForeignKeys } from '../utils/fkExists.js';
import { applyCustomFieldDefaults } from './custom-fields.js';
import { getWritableCustomColumns, refusedAirtablePullKeys, AIRTABLE_PULL_EDIT_ERROR } from '../services/customFieldWritability.js';
import { emitEntity } from '../services/realtimeEmitters.js';
import { writeBackRecord } from '../services/airtableWriteback.js';
import { readRelation } from '../services/customFieldsView.js';
import { fetchProjectCommissions } from '../services/projectCommissions.js';
import { parsePage } from '../utils/pagination.js';
import { mountCrud } from '../utils/crudRouter.js';
import { RECORD_REGISTRY } from '../db/recordRegistry.js';

const router = Router();
router.use(requireAuth);

// GET /api/projects/vendeur-options — liste fusionnée pour le picker du champ
// Vendeur sur les projets : employés actifs avec is_salesperson=1 + companies
// avec is_vendeur_orisha=1.
router.get('/vendeur-options', (req, res) => {
  const employees = db.prepare(`
    SELECT id, first_name, last_name FROM employees
    WHERE active=1 AND is_salesperson=1
    ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE
  `).all()
  const companies = db.prepare(`
    SELECT id, name FROM companies
    WHERE deleted_at IS NULL AND is_vendeur_orisha=1
    ORDER BY name COLLATE NOCASE
  `).all()
  const data = [
    ...employees.map(e => ({
      ref: `employee:${e.id}`,
      kind: 'employee',
      label: [e.first_name, e.last_name].filter(Boolean).join(' '),
    })),
    ...companies.map(c => ({
      ref: `company:${c.id}`,
      kind: 'company',
      label: c.name,
    })),
  ]
  // Vendeurs déjà portés par un projet mais absents des deux listes : un vendeur
  // importé d'Airtable est résolu vers l'employé ou l'entreprise du même nom,
  // qui n'est pas forcément coché « vendeur ». Sans eux, le sélecteur affichait
  // « Aucun » sur un projet qui a pourtant un vendeur.
  const known = new Set(data.map(d => d.ref))
  const used = db.prepare(`
    SELECT DISTINCT vendeur_ref FROM projects
    WHERE deleted_at IS NULL AND vendeur_ref IS NOT NULL AND vendeur_ref != ''
  `).all().map(r => r.vendeur_ref).filter(ref => !known.has(ref))
  for (const ref of used) {
    if (ref.startsWith('employee:')) {
      const e = db.prepare('SELECT first_name, last_name FROM employees WHERE id=?').get(ref.slice(9))
      if (e) data.push({ ref, kind: 'employee', label: [e.first_name, e.last_name].filter(Boolean).join(' ') })
    } else if (ref.startsWith('company:')) {
      const c = db.prepare('SELECT name FROM companies WHERE id=? AND deleted_at IS NULL').get(ref.slice(8))
      if (c) data.push({ ref, kind: 'company', label: c.name })
    }
  }
  res.json({ data })
})

// GET /api/projects
// ?lite=1 → renvoie seulement les colonnes affichées par défaut dans la liste,
// sans les sous-requêtes coûteuses (orders json_group_array, vendeur_label CASE,
// notes). Pipeline.jsx l'utilise pour la première peinture, puis recharge en
// silence la version complète.
router.get('/', (req, res) => {
  const { search, status, company_id } = req.query;
  const lite = req.query.lite === '1' || req.query.lite === 'true';
  const { page, limit, limitVal, offset } = parsePage(req.query, 100);
  let where = 'WHERE p.deleted_at IS NULL';
  const params = [];

  if (search) {
    where += ' AND (p.name LIKE ? OR c.name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q);
  }
  if (status) {
    where += ' AND p.status = ?';
    params.push(status);
  }
  if (company_id) {
    where += ' AND p.company_id = ?';
    params.push(company_id);
  }
  if (req.query.month) {
    // Même bucketing que le graphique « Taux de closing » du dashboard :
    // close_date si renseignée, sinon `creation` (et non `updated_at`, qui date
    // de la dernière synchro).
    where += " AND strftime('%Y-%m', COALESCE(NULLIF(p.close_date, ''), p.creation)) = ?";
    params.push(req.query.month);
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM ${readRelation('projects')} p LEFT JOIN companies c ON p.company_id = c.id ${where}`
  ).get(...params).c;

  const liteSelect = `
    SELECT p.id, p.name, p.company_id, p.contact_id, p.type, p.status,
           p.probability, p.value_cad, p.monthly_cad, p.nb_greenhouses,
           p.close_date, p.creation, p.updated_at, p.vendeur_ref,
           c.name as company_name
    FROM ${readRelation('projects')} p
    LEFT JOIN companies c ON p.company_id = c.id
    ${where}
    ORDER BY p.updated_at DESC
    LIMIT ? OFFSET ?`

  const fullSelect = `
    SELECT p.*, c.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name,
           CASE
             WHEN p.vendeur_ref LIKE 'employee:%' THEN (
               SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))
               FROM employees e WHERE e.id = substr(p.vendeur_ref, 10)
             )
             WHEN p.vendeur_ref LIKE 'company:%' THEN (
               SELECT vc.name FROM companies vc WHERE vc.id = substr(p.vendeur_ref, 9)
             )
             -- Vendeur importé d'Airtable dont le nom ne correspond à aucun
             -- employé ni entreprise : on affiche le nom tel quel plutôt que
             -- rien (cf. services/airtableNativeMappedColumns.js).
             ELSE NULLIF(TRIM(p.vendeur_ref), '')
           END AS vendeur_label,
           (SELECT json_group_array(json_object('id', o.id, 'order_number', o.order_number))
              FROM orders o WHERE o.project_id = p.id AND o.deleted_at IS NULL) as orders_json
    FROM ${readRelation('projects')} p
    LEFT JOIN companies c ON p.company_id = c.id
    LEFT JOIN contacts ct ON p.contact_id = ct.id
    ${where}
    ORDER BY p.updated_at DESC
    LIMIT ? OFFSET ?`

  const projects = db.prepare(lite ? liteSelect : fullSelect).all(...params, limitVal, offset);

  if (!lite) {
    for (const p of projects) {
      try { p.orders = p.orders_json ? JSON.parse(p.orders_json).filter(o => o.id) : []; }
      catch { p.orders = []; }
      delete p.orders_json;
    }
  }

  res.json({ data: projects, total, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const project = db.prepare(
    `SELECT p.*, c.name as company_name, ct.first_name || ' ' || ct.last_name as contact_name,
            CASE
              WHEN p.vendeur_ref LIKE 'employee:%' THEN (
                SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,''))
                FROM employees e WHERE e.id = substr(p.vendeur_ref, 10)
              )
              WHEN p.vendeur_ref LIKE 'company:%' THEN (
                SELECT vc.name FROM companies vc WHERE vc.id = substr(p.vendeur_ref, 9)
              )
              ELSE NULLIF(TRIM(p.vendeur_ref), '')
            END AS vendeur_label
     FROM ${readRelation('projects')} p
     LEFT JOIN companies c ON p.company_id = c.id
     LEFT JOIN contacts ct ON p.contact_id = ct.id
     WHERE p.id = ?`
  ).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.orders = db.prepare(
    `SELECT id, order_number, status FROM orders WHERE project_id = ? AND deleted_at IS NULL ORDER BY order_number`
  ).all(req.params.id);
  res.json(project);
});

// GET /api/projects/:id/commissions — commissions du projet, lues en direct
// dans Airtable. La table « Commissions » n'est pas miroitée dans Boréal
// (périmètre du miroir gelé le 2026-09-03) : la colonne `projects.commissions`
// ne porte que des record IDs, on va donc chercher les lignes à l'affichage.
router.get('/:id/commissions', async (req, res) => {
  const project = db.prepare('SELECT id, commissions FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const data = await fetchProjectCommissions(project.commissions);
    res.json({ data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/projects
router.post('/', (req, res) => {
  const { name, company_id, contact_id, type, status, close_date, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const fkErr = checkForeignKeys({ company_id, contact_id });
  if (fkErr) return res.status(400).json({ error: fkErr.message });

  // Valide les champs monétaires/numériques avant l'INSERT : un `"abc"` ou un
  // négatif doit produire un 400 explicite, pas un `0` silencieux qui corromprait
  // le P&L et le forecast.
  const { error: numError, values: nums } = validateNumericFields(req.body, [
    { key: 'probability', min: 0, max: 100 },
    { key: 'value_cad' },
    { key: 'monthly_cad' },
    { key: 'nb_greenhouses', int: true },
  ]);
  if (numError) return res.status(400).json({ error: numError });
  const probability = nums.probability ?? 0;
  const value_cad = nums.value_cad ?? 0;
  const monthly_cad = nums.monthly_cad ?? 0;
  const nb_greenhouses = nums.nb_greenhouses ?? 0;

  const id = newRecordId();
  // `creation` est le champ canonique de date de création (originellement importé d'Airtable).
  // On le remplit aussi pour les projets créés nativement dans l'ERP afin que le même champ
  // soit utilisable uniformément (graphiques, filtres, affichage) — voir aussi le backfill
  // dans schema.js pour les anciennes lignes ayant `creation IS NULL`.
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, company_id, contact_id, type, status, probability, value_cad, monthly_cad, nb_greenhouses, close_date, notes, creation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, company_id || null, contact_id || null,
    type || null, status || 'Ouvert', probability, value_cad, monthly_cad,
    nb_greenhouses, close_date || null, notes || null, nowIso);

  // Pré-remplit les champs custom ayant une valeur par défaut (single_select via
  // default_id, ou text/number/currency/url via default_value) — colonnes cf_*
  // absentes de l'INSERT natif ci-dessus.
  applyCustomFieldDefaults('projects', id);

  const project = db.prepare(
    `SELECT p.*, c.name as company_name FROM ${readRelation('projects')} p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`
  ).get(id);
  emitEntity('project', 'created', id, project, req.user?.id);
  res.status(201).json(project);
});

// PUT /api/projects/:id — partial update
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  // Rejette NaN/négatifs/hors-bornes sur les champs numériques présents dans le
  // patch avant de construire l'UPDATE (mêmes bornes qu'au POST).
  const { error: numError } = validateNumericFields(req.body, [
    { key: 'probability', min: 0, max: 100 },
    { key: 'value_cad' },
    { key: 'monthly_cad' },
    { key: 'nb_greenhouses', int: true },
  ]);
  if (numError) return res.status(400).json({ error: numError });

  // Whitelist d'update : seules les colonnes custom ÉDITABLES (règle unique —
  // services/customFieldWritability.js). Un champ Airtable en import seul est
  // refusé en 400 explicite plutôt qu'ignoré en silence par buildPartialUpdate :
  // l'écriture aurait de toute façon été écrasée au prochain sync.
  if (refusedAirtablePullKeys('projects', req.body).length > 0) {
    return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR });
  }
  const customCols = getWritableCustomColumns('projects').map(c => c.column_name)
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['name', 'company_id', 'contact_id', 'type', 'status', 'probability',
      'value_cad', 'monthly_cad', 'nb_greenhouses', 'close_date', 'notes',
      'vendeur_ref', ...customCols],
    nonNullable: new Set(['name']),
    // Stocke des nombres (et non la chaîne brute) ; la validation ci-dessus
    // garantit déjà que ces conversions sont finies et bornées.
    coerce: {
      probability: v => (v === '' || v == null ? null : Number(v)),
      value_cad: v => (v === '' || v == null ? null : Number(v)),
      monthly_cad: v => (v === '' || v == null ? null : Number(v)),
      nb_greenhouses: v => (v === '' || v == null ? null : Number(v)),
    },
  });
  if (error) return res.status(400).json({ error });
  if (setClause) {
    db.prepare(`UPDATE projects SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id);
    // Write-back ERP → Airtable (fire-and-forget) : ne pousse que les colonnes
    // modifiées dont le sens n'est pas 'pull' — échecs tracés dans sync_log.
    writeBackRecord('projets', req.params.id, Object.keys(req.body));
  }

  const updated = db.prepare(`SELECT p.*, c.name as company_name FROM ${readRelation('projects')} p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`).get(req.params.id)
  emitEntity('project', 'updated', req.params.id, updated, req.user?.id);
  res.json(updated);
});

// PATCH /api/projects/:id/status
router.patch('/:id/status', (req, res) => {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  // Le statut seul : « Raison du refus » n'est plus une colonne native (elle
  // vit comme champ personnalisé alimenté par Airtable — migration 025).
  const { status } = req.body;
  if (!['Ouvert', 'Gagné', 'Perdu'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare(`UPDATE projects SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(status, req.params.id);
  writeBackRecord('projets', req.params.id, ['status']);
  const updated = db.prepare(`SELECT p.*, c.name as company_name FROM ${readRelation('projects')} p LEFT JOIN companies c ON p.company_id = c.id WHERE p.id = ?`).get(req.params.id)
  emitEntity('project', 'updated', req.params.id, updated, req.user?.id);
  res.json({ message: 'Status updated' });
});

// DELETE /api/projects/:id
mountCrud(router, RECORD_REGISTRY.projects, { only: ['delete'] });

export default router;
