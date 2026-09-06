// Registre de schémas des tables CRUD simples. Sert deux consommateurs :
//   - utils/crudRouter.js : fabrique des routes /api/<ressource> (list/get/create/patch/delete)
//   - routes/records.js   : API générique PATCH/DELETE /api/records/:table/:id
//
// N'entrent ici que les tables sans side-effect métier (pas de cascade, d'email,
// de Stripe/QB, de transition de statut, de rôle au-delà du middleware d'auth).
// Champs du spec : voir l'en-tête de utils/crudRouter.js. Les noms de tables et
// de colonnes sont des constantes — seuls eux entrent dans le SQL.

import db from './database.js'
import { requireHROrAdmin, requireAdmin } from '../middleware/auth.js'
import { toBool, toBoolDefaultTrue, trimOrNull } from '../utils/partialUpdate.js'

const toNumberOrNull = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v))

export const RECORD_REGISTRY = {
  activity_codes: {
    table: 'activity_codes',
    idColumn: 'id',
    entity: 'activity_code',
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
    auth: requireHROrAdmin,
    allowed: [
      'first_name', 'last_name', 'phone_personal', 'phone_work', 'email_personal', 'email_work',
      'birth_date', 'hire_date', 'matricule', 'active', 'gender', 'address', 'emergency_contact',
      'end_date', 'office_key', 'insurance_id', 'nethris_username', 'is_salesperson', 'is_consultant',
      'accounting_department', 'hours_per_week', 'last_raise_date', 'group_insurance',
      'address_verified', 'banking_info', 'issues', 'peer_reviews', 'vacation_days_per_year',
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

  hour_bank_entries: {
    table: 'hour_bank_entries',
    idColumn: 'id',
    entity: 'hour_bank_entry',
    softDelete: true,
    touchUpdatedAt: true,
    writeAuth: requireHROrAdmin,
    allowed: ['hours', 'date', 'notes'],
    nonNullable: new Set(['hours']),
    coerce: { hours: toNumberOrNull },
    messages: { empty: () => 'hours invalide' },
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
