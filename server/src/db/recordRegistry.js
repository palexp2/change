// Registre de schémas des tables CRUD simples. Sert deux consommateurs :
//   - utils/crudRouter.js : fabrique des routes /api/<ressource> (list/get/create/patch/delete)
//   - routes/records.js   : API générique PATCH/DELETE /api/records/:table/:id
//
// N'entrent ici que les tables sans side-effect métier (pas de cascade, d'email,
// de Stripe/QB, de transition de statut, de rôle au-delà du middleware d'auth).
// Champs du spec : voir l'en-tête de utils/crudRouter.js. Les noms de tables et
// de colonnes sont des constantes — seuls eux entrent dans le SQL.

import db from './database.js'
import { requireHR, requireAdmin } from '../middleware/auth.js'
import { toBool, toBoolDefaultTrue, trimOrNull } from '../utils/partialUpdate.js'
import { readRelation } from '../services/customFieldsView.js'
import { getWritableCustomColumns } from '../services/customFieldWritability.js'

// Colonnes natives d'un problème d'opérations. `resolved_at` est de la liste :
// la table ne l'expose pas à la saisie, mais le hook de statut l'écrit.
const OPS_ISSUE_COLUMNS = [
  'occurred_at', 'title', 'area', 'severity', 'status',
  'description', 'resolution', 'reported_by', 'resolved_at',
]

export const RECORD_REGISTRY = {
  activity_codes: {
    table: 'activity_codes',
    idColumn: 'id',
    entity: 'activity_code',
    writeAuth: requireHR,
    softDelete: true,
    touchUpdatedAt: true,
    allowed: ['name', 'description', 'active', 'payable', 'rsde_default'],
    nonNullable: new Set(['name']),
    coerce: { name: trimOrNull, active: toBool, payable: toBool, rsde_default: toBool },
    required: { name: 'name requis' },
    defaults: { active: 1, payable: 1, rsde_default: 0 },
    messages: { empty: () => 'name ne peut pas être vide' },
    // Au POST, active/payable absents ou non-false valent 1 (toBool ne sert qu'au PATCH).
    beforeCreate(body) {
      if (body.active !== undefined) body.active = toBoolDefaultTrue(body.active)
      if (body.payable !== undefined) body.payable = toBoolDefaultTrue(body.payable)
    },
  },

  vacations: {
    table: 'vacations',
    idColumn: 'id',
    entity: 'vacation',
    softDelete: false,
    touchUpdatedAt: true,
    allowed: ['start_date', 'end_date', 'paid', 'notes'],
    nonNullable: new Set(),
    coerce: { paid: toBoolDefaultTrue },
    insertable: ['employee_id', 'start_date', 'end_date', 'paid', 'notes'],
    required: { employee_id: 'employee_id requis' },
    defaults: { paid: 1 },
    filters: ['employee_id'],
    orderBy: `COALESCE(start_date, '') DESC, created_at DESC`,
    deleteResponse: { ok: true },
    beforeCreate(body) {
      if (!db.prepare('SELECT id FROM employees WHERE id = ?').get(body.employee_id)) return 'Employé introuvable'
    },
  },

  employees: {
    table: 'employees',
    idColumn: 'id',
    entity: 'employee',
    softDelete: false,
    touchUpdatedAt: true,
    auth: requireHR,
    allowed: [
      'first_name', 'last_name', 'phone_personal', 'phone_work', 'email_personal', 'email_work',
      'birth_date', 'hire_date', 'matricule', 'active', 'gender', 'address', 'emergency_contact',
      'end_date', 'office_key', 'insurance_id', 'nethris_username', 'is_salesperson', 'is_consultant',
      'accounting_department', 'hours_per_week', 'last_raise_date', 'group_insurance',
      'address_verified', 'banking_info', 'issues', 'peer_reviews', 'vacation_days_per_year',
      'commission_rate', 'vacation_pct', 'vacation_ref_date', 'vacation_ref_balance',
    ],
    nonNullable: new Set(),
    coerce: {},
    allowEmptyPatch: true,
    validateCreate: b => (!b.first_name || !b.last_name ? 'Prénom et nom requis' : null),
    search: ['first_name', 'last_name', 'email_work', 'matricule'],
    defaultLimit: 50,
    orderBy: 'last_name ASC, first_name ASC',
  },

  vendor_subscriptions: {
    table: 'vendor_subscriptions',
    idColumn: 'id',
    entity: 'vendor_subscription',
    softDelete: true,
    touchUpdatedAt: true,
    allowed: [],
    nonNullable: new Set(),
    coerce: {},
    deleteResponse: { ok: true },
  },

  field_visibility_rules: {
    table: 'field_visibility_rules',
    idColumn: 'id',
    entity: null,
    softDelete: false,
    touchUpdatedAt: true,
    writeAuth: requireAdmin,
    allowed: ['conditions_json'],
    nonNullable: new Set(['conditions_json']),
    coerce: {},
    insertable: ['context', 'field_id', 'conditions_json', 'created_by'],
    filters: ['context'],
    orderBy: 'context, field_id, created_at',
    deleteResponse: { ok: true },
    serialize: r => ({
      id: r.id,
      context: r.context,
      field_id: r.field_id,
      conditions: JSON.parse(r.conditions_json),
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }),
  },

  // Journal des problèmes d'opérations (migration 047). Table ouverte aux
  // champs personnalisés, donc `allowed` et `view` sont des accesseurs évalués
  // à chaque requête : la liste des colonnes écrivables change dès qu'un champ
  // est créé dans /champs/ops_issues, et la relation de lecture devient
  // `ops_issues_v` dès qu'un champ calculé existe.
  ops_issues: {
    table: 'ops_issues',
    idColumn: 'id',
    entity: 'ops_issue',
    softDelete: true,
    touchUpdatedAt: true,
    get view() { return readRelation('ops_issues') },
    get allowed() {
      return [...OPS_ISSUE_COLUMNS, ...getWritableCustomColumns('ops_issues').map(c => c.column_name)]
    },
    get insertable() { return this.allowed },
    nonNullable: new Set(['title']),
    coerce: { title: trimOrNull },
    required: { title: 'Décris le problème' },
    defaults: { status: 'Ouvert' },
    filters: ['status', 'area', 'severity', 'reported_by'],
    search: ['title', 'description', 'resolution'],
    orderBy: `COALESCE(occurred_at, created_at) DESC, created_at DESC`,
    messages: {
      notFound: 'Problème introuvable',
      empty: () => 'Le problème doit garder une description courte',
    },
    beforeCreate(body, req) {
      if (!body.reported_by && req?.user?.id) body.reported_by = req.user.id
      if (!body.occurred_at) body.occurred_at = new Date().toISOString().slice(0, 10)
    },
    // « Résolu » date la résolution ; en sortir l'efface. Sans ça, il faudrait
    // saisir deux fois la même information — et un problème réouvert garderait
    // une date de résolution qui n'a plus lieu d'être.
    beforeUpdate(id, body) {
      if (body.status === undefined) return
      body.resolved_at = body.status === 'Résolu' ? new Date().toISOString() : null
    },
  },

  projects: {
    table: 'projects',
    idColumn: 'id',
    entity: 'project',
    softDelete: true,
    touchUpdatedAt: true,
    allowed: [],
    nonNullable: new Set(),
    coerce: {},
    messages: { notFound: 'Project not found' },
    deleteResponse: { message: 'Deleted' },
  },
}

export function getRecordSpec(key) {
  if (!key || !Object.prototype.hasOwnProperty.call(RECORD_REGISTRY, key)) return null
  return RECORD_REGISTRY[key]
}

// Tables ouvertes à l'API générique /api/records : celles dont le PATCH est un
// pur update de champs (pas de writeAuth, pas d'auth spécifique).
export function listRecordTables() {
  return Object.keys(RECORD_REGISTRY).filter(k => {
    const s = RECORD_REGISTRY[k]
    return s.allowed.length && !s.writeAuth && !s.auth
  })
}
