import { v4 as uuid } from 'uuid'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { syncDynamicFields, updateDynamicFields } from './airtableAutoSync.js'
import { broadcastAll } from './realtime.js'
import { emitCompany, emitOrder } from './realtimeEmitters.js'
import { evaluateFieldRules } from './fieldRuleEngine.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'
import { consumeWritebackEcho, fieldMapDirection } from './airtableWriteback.js'
import { reconcileFacturesForOrder } from './quickbooks.js'
import { logSystemRun } from './systemAutomations.js'

// Cache live SQLite columns per table — read once at module level, refreshed
// only when an UPDATE/INSERT references an unknown column (rare, indicates a
// hardcoded field_map drift vs schema.js).
const _tableCols = new Map() // table → Set<col>
function tableColumns(table, refresh = false) {
  if (refresh || !_tableCols.has(table)) {
    _tableCols.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)))
  }
  return _tableCols.get(table)
}

/**
 * Dynamic upsert: INSERT or UPDATE a record based on airtable_id.
 * Drops payload keys that don't have a matching column (no schema mutation).
 * @param {string} table - SQLite table name
 * @param {string} airtableId - Airtable record ID
 * @param {Object} payload - column→value map (null values are preserved)
 * @returns {'imported'|'updated'}
 */
function upsertRecord(table, airtableId, payload) {
  const cols = tableColumns(table)
  const keys = Object.keys(payload).filter(k => cols.has(k))
  const dropped = Object.keys(payload).filter(k => !cols.has(k))
  if (dropped.length) {
    console.warn(`⚠️  ${table}: payload keys ignorées (colonne inexistante): ${dropped.join(', ')}`)
  }

  const existing = db.prepare(`SELECT id FROM ${table} WHERE airtable_id=?`).get(airtableId)
  if (existing) {
    if (!keys.length) return 'updated'
    const set = keys.map(k => `${k}=?`).join(', ')
    db.prepare(`UPDATE ${table} SET ${set}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(...keys.map(k => payload[k] ?? null), existing.id)
    return 'updated'
  } else {
    const allKeys = ['id', 'airtable_id', ...keys]
    const placeholders = allKeys.map(() => '?').join(',')
    db.prepare(`INSERT INTO ${table} (${allKeys.join(',')}) VALUES (${placeholders})`)
      .run(uuid(), airtableId, ...keys.map(k => payload[k] ?? null))
    return 'imported'
  }
}

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
}

function autoMapField(fields, ...candidates) {
  for (const candidate of candidates) {
    const norm = normalize(candidate)
    const found = Object.keys(fields).find(f => normalize(f) === norm)
    if (found) return found
  }
  return null
}

function getVal(fields, fieldName) {
  if (!fieldName || !(fieldName in fields)) return null
  const v = fields[fieldName]
  if (typeof v === 'string') return v.trim() || null
  if (Array.isArray(v)) return v.join(', ') || null
  if (typeof v === 'object' && v !== null) return v.email || v.name || null
  return v ? String(v) : null
}

// Resolve a linked-record (or plain text) company field to a local company id.
// Linked record fields return an array of Airtable record IDs → look up by airtable_id first,
// then fall back to a name-based LIKE search.
function lookupCompany(fields, fieldName) {
  if (!fieldName || !(fieldName in fields)) return null
  const raw = fields[fieldName]
  const linkedId = Array.isArray(raw) ? raw[0] : null
  if (linkedId) {
    const co = db.prepare('SELECT id FROM companies WHERE airtable_id=? LIMIT 1').get(linkedId)
    if (co) return co.id
  }
  // Fallback: text match
  const name = Array.isArray(raw) ? null : getVal(fields, fieldName)
  if (name) {
    const co = db.prepare('SELECT id FROM companies WHERE name LIKE ? LIMIT 1').get(`%${name}%`)
    if (co) return co.id
  }
  return null
}

// Diagnostic helper for FK failures on `projects`: list which records still
// reference a given project (blocks deletes via project_id REFERENCES projects(id)).
function describeProjectReferences(projectLocalId) {
  if (!projectLocalId) return ''
  const refs = []
  for (const t of ['orders', 'soumissions', 'factures']) {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE project_id=?`).get(projectLocalId)?.c || 0
      if (n) refs.push(`${t}×${n}`)
    } catch {}
  }
  return refs.join(', ')
}

/**
 * Purge orphan records: delete ERP rows whose airtable_id is not in the fetched set.
 * Only runs during full sync (!changes) to clean up records deleted from Airtable
 * whose webhook deletion event was missed.
 * @param {string} table - SQLite table name
 * @param {Array} records - all Airtable records fetched during full sync
 */
function purgeOrphans(table, records) {
  const airtableIds = new Set(records.map(r => r.id))
  const rows = db.prepare(`SELECT id, airtable_id FROM ${table} WHERE airtable_id IS NOT NULL`).all()
  const toDelete = rows.filter(r => !airtableIds.has(r.airtable_id))
  if (!toDelete.length) return 0
  const del = db.prepare(`DELETE FROM ${table} WHERE id=?`)
  for (const row of toDelete) {
    del.run(row.id)
  }
  console.log(`🧹 ${table}: ${toDelete.length} orphan(s) purged`)
  return toDelete.length
}

// Table Airtable « Fournisseurs » (liée depuis Achats). Son champ primaire porte le nom
// EXACT du fournisseur QuickBooks (« Takachi USD », « Mouser Electronics »…) et « ID »
// contient l'Id du vendor QB — c'est la source de vérité pour savoir de quel fournisseur
// vient un achat LIA. Le single-select « Fournisseur - LEGACY » auquel purchases.supplier
// est mappé est gelé depuis 2026 : il est vide sur tous les achats récents.
const AIRTABLE_VENDORS_TABLE = 'tblsJKllughNYKSuR'
// Champ lié « Fournisseur » de la table Achats (≠ « Fournisseur - LEGACY »).
const ACHATS_VENDOR_LINK_FIELD = 'Fournisseur'

// Rafraîchit le cache rec id → { name, qb_vendor_id }. Best effort : en cas d'échec on
// garde le cache précédent (la résolution retombera dessus) plutôt que de casser le sync.
async function refreshVendorLinkCache(baseId, accessToken) {
  try {
    const records = await fetchAllRecords(baseId, AIRTABLE_VENDORS_TABLE, accessToken, 'fournisseurs')
    const up = db.prepare(`
      INSERT INTO airtable_vendor_links (airtable_id, name, qb_vendor_id, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(airtable_id) DO UPDATE SET
        name=excluded.name, qb_vendor_id=excluded.qb_vendor_id, updated_at=excluded.updated_at
    `)
    db.transaction(recs => {
      for (const rec of recs) {
        const name = typeof rec.fields?.Name === 'string' ? rec.fields.Name.trim() : null
        if (!name) continue
        const qbId = rec.fields?.ID != null ? String(rec.fields.ID).trim() || null : null
        up.run(rec.id, name, qbId)
      }
    })(records)
    return records.length
  } catch (e) {
    console.warn(`⚠️  Fournisseurs Airtable: cache non rafraîchi (${e.message})`)
    return 0
  }
}

function vendorLinkMap() {
  const rows = db.prepare('SELECT airtable_id, name, qb_vendor_id FROM airtable_vendor_links').all()
  return new Map(rows.map(r => [r.airtable_id, r]))
}

async function fetchAllRecords(baseId, tableId, accessToken, syncKey, recordIds = null) {
  const records = []
  if (recordIds) {
    // Incremental: fetch only specified records (batches of 50 to stay under URL limits)
    const BATCH = 50
    for (let i = 0; i < recordIds.length; i += BATCH) {
      const batch = recordIds.slice(i, i + BATCH)
      const formula = batch.length === 1
        ? `RECORD_ID()='${batch[0]}'`
        : `OR(${batch.map(id => `RECORD_ID()='${id}'`).join(',')})`
      let offset = null
      do {
        const params = new URLSearchParams({ filterByFormula: formula, pageSize: '100' })
        if (offset) params.set('offset', offset)
        const data = await airtableFetch(`/${baseId}/${tableId}?${params}`, accessToken)
        records.push(...(data.records || []))
        offset = data.offset || null
      } while (offset)
    }
    return records
  }
  let offset = null
  do {
    const params = new URLSearchParams({ pageSize: '100' })
    if (offset) params.set('offset', offset)
    const data = await airtableFetch(`/${baseId}/${tableId}?${params}`, accessToken)
    records.push(...(data.records || []))
    offset = data.offset || null
    if (syncKey) {
      broadcastAll({ type: 'sync:progress', syncKey, loaded: records.length, done: !offset })
    }
  } while (offset)
  return records
}

export async function syncAirtable(changes = null) {
  const config = db.prepare('SELECT * FROM airtable_sync_config').get()
  if (!config?.base_id) { console.log('⚠️  Airtable sync config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  // Sync companies first
  if (config.companies_table_id) {
    if (changes?.[config.companies_table_id]?.destroyedIds?.length) {
      for (const id of changes[config.companies_table_id].destroyedIds)
        db.prepare('DELETE FROM companies WHERE airtable_id=?').run(id)
    }
    const _companyIds = changes?.[config.companies_table_id]?.recordIds
    if (!changes || _companyIds?.length) {
    try {
      const records = await fetchAllRecords(config.base_id, config.companies_table_id, accessToken, 'airtable', _companyIds)
      let fieldMap = config.field_map_companies ? JSON.parse(config.field_map_companies) : null
      let companiesImported = 0

      db.transaction((recs) => {
        for (const rec of recs) {
          if (!fieldMap && rec.fields) {
            fieldMap = {
              name:             autoMapField(rec.fields, 'name', 'nom', 'company') || Object.keys(rec.fields)[0],
              phone:            autoMapField(rec.fields, 'phone', 'telephone', 'téléphone'),
              email:            autoMapField(rec.fields, 'email', 'courriel'),
              website:          autoMapField(rec.fields, 'website', 'site web', 'url', 'domain'),
              address:          autoMapField(rec.fields, 'address', 'adresse'),
              city:             autoMapField(rec.fields, 'city', 'ville'),
              province:         autoMapField(rec.fields, 'province', 'state', 'région'),
              country:          autoMapField(rec.fields, 'country', 'pays'),
              type:             autoMapField(rec.fields, 'type', 'catégorie'),
              lifecycle_phase:  autoMapField(rec.fields, 'lifecycle phase', 'phase', 'cycle de vie', 'lifecycle'),
              notes:            autoMapField(rec.fields, 'notes', 'commentaires'),
            }
          }
          const name = getVal(rec.fields, fieldMap?.name)
          if (!name) continue

          const typeRaw = getVal(rec.fields, fieldMap?.type)
          const type = typeRaw ? (fieldMap?.type_choices?.[typeRaw] || typeRaw) : null

          const phaseRaw = getVal(rec.fields, fieldMap?.lifecycle_phase)
          const lifecycle_phase = phaseRaw ? (fieldMap?.phase_choices?.[phaseRaw] || phaseRaw) : null

          const existing = db.prepare('SELECT id FROM companies WHERE airtable_id=?').get(rec.id)
          if (existing) {
            db.prepare(`UPDATE companies SET name=?, phone=COALESCE(?,phone), email=COALESCE(?,email), website=COALESCE(?,website), address=COALESCE(?,address), city=COALESCE(?,city), province=COALESCE(?,province), country=COALESCE(?,country), type=COALESCE(?,type), lifecycle_phase=COALESCE(?,lifecycle_phase), notes=COALESCE(?,notes), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
              .run(name, getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.website), getVal(rec.fields, fieldMap?.address), getVal(rec.fields, fieldMap?.city), getVal(rec.fields, fieldMap?.province), getVal(rec.fields, fieldMap?.country), type, lifecycle_phase, getVal(rec.fields, fieldMap?.notes), existing.id)
            emitCompany('updated', existing.id, null)
          } else {
            const newId = uuid()
            db.prepare('INSERT INTO companies (id, name, phone, email, website, address, city, province, country, type, lifecycle_phase, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(newId, name, getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.website), getVal(rec.fields, fieldMap?.address), getVal(rec.fields, fieldMap?.city), getVal(rec.fields, fieldMap?.province), getVal(rec.fields, fieldMap?.country), type, lifecycle_phase, getVal(rec.fields, fieldMap?.notes), rec.id)
            emitCompany('created', newId, null)
            companiesImported++
          }
        }
      })(records)
      if (companiesImported > 0) console.log(`🏢 Airtable: ${companiesImported} companies imported`)
    if (!changes) {
      purgeOrphans('companies', records)
      await syncDynamicFields('airtable_companies', 'companies', config.base_id, config.companies_table_id, fieldMap, records)
    } else {
      await updateDynamicFields('companies', fieldMap, records)
    }
    } catch (e) { console.error('❌ Airtable companies:', e.message) }
    } // end if (!changes || _companyIds?.length)
  }

  // Sync contacts
  if (config.contacts_table_id) {
    if (changes?.[config.contacts_table_id]?.destroyedIds?.length) {
      for (const id of changes[config.contacts_table_id].destroyedIds)
        db.prepare('DELETE FROM contacts WHERE airtable_id=?').run(id)
    }
    const _contactIds = changes?.[config.contacts_table_id]?.recordIds
    if (!changes || _contactIds?.length) {
    try {
      const records = await fetchAllRecords(config.base_id, config.contacts_table_id, accessToken, 'airtable', _contactIds)
      let fieldMap = config.field_map_contacts ? JSON.parse(config.field_map_contacts) : null
      let contactsImported = 0

      db.transaction((recs) => {
        for (const rec of recs) {
          if (!fieldMap && rec.fields) {
            fieldMap = {
              first_name: autoMapField(rec.fields, 'first name', 'prénom', 'prenom') || Object.keys(rec.fields)[0],
              last_name:  autoMapField(rec.fields, 'last name', 'nom de famille', 'surname'),
              email:      autoMapField(rec.fields, 'email', 'courriel'),
              phone:      autoMapField(rec.fields, 'phone', 'telephone', 'téléphone'),
              mobile:     autoMapField(rec.fields, 'mobile', 'cell', 'cellulaire'),
              company:    autoMapField(rec.fields, 'company', 'entreprise', 'organization'),
              language:   autoMapField(rec.fields, 'language', 'langue', 'lang'),
              notes:      autoMapField(rec.fields, 'notes', 'commentaires'),
            }
          }
          const lastName = getVal(rec.fields, fieldMap?.last_name) || getVal(rec.fields, fieldMap?.first_name) || 'Inconnu'

          const companyId = lookupCompany(rec.fields, fieldMap?.company)

          const rawLang = (getVal(rec.fields, fieldMap?.language) || '').trim()
          const language = rawLang === 'French' || rawLang === 'Français' || rawLang === 'francais' ? 'French'
            : rawLang === 'English' || rawLang === 'Anglais' || rawLang === 'anglais' ? 'English'
            : null

          const existing = db.prepare('SELECT id FROM contacts WHERE airtable_id=?').get(rec.id)
          if (existing) {
            db.prepare('UPDATE contacts SET first_name=?, last_name=?, email=?, phone=?, mobile=COALESCE(?,mobile), company_id=?, language=?, notes=COALESCE(?,notes) WHERE id=?')
              .run(getVal(rec.fields, fieldMap?.first_name) || '', lastName, getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.mobile), companyId, language, getVal(rec.fields, fieldMap?.notes), existing.id)
          } else {
            db.prepare('INSERT INTO contacts (id, first_name, last_name, email, phone, mobile, company_id, language, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .run(uuid(), getVal(rec.fields, fieldMap?.first_name) || '', lastName, getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.mobile), companyId, language, getVal(rec.fields, fieldMap?.notes), rec.id)
            contactsImported++
          }
        }
        db.prepare(`UPDATE airtable_sync_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run()
      })(records)
      if (contactsImported > 0) console.log(`👤 Airtable: ${contactsImported} contacts imported`)
    if (!changes) {
      purgeOrphans('contacts', records)
      await syncDynamicFields('airtable_contacts', 'contacts', config.base_id, config.contacts_table_id, fieldMap, records)
    } else {
      await updateDynamicFields('contacts', fieldMap, records)
    }
    } catch (e) { console.error('❌ Airtable contacts:', e.message) }
    } // end if (!changes || _contactIds?.length)
  }
}

export async function syncOrders(changes = null) {
  const config = db.prepare('SELECT * FROM airtable_orders_config').get()
  if (!config?.base_id || !config?.orders_table_id) { console.log('⚠️  Orders config missing'); return }

  // ── 1. Deletions (no token needed) ───────────────────────────────────────
  if (changes?.[config.orders_table_id]?.destroyedIds?.length) {
    for (const id of changes[config.orders_table_id].destroyedIds)
      db.prepare('DELETE FROM orders WHERE airtable_id=?').run(id)
  }
  if (changes?.[config.items_table_id]?.destroyedIds?.length) {
    for (const id of changes[config.items_table_id].destroyedIds)
      db.prepare('DELETE FROM order_items WHERE airtable_id=?').run(id)
  }

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  const _orderIds = changes?.[config.orders_table_id]?.recordIds
  if (!changes || _orderIds?.length) {
  try {
    const records = await fetchAllRecords(config.base_id, config.orders_table_id, accessToken, 'orders', _orderIds)
    let fm = config.field_map_orders ? JSON.parse(config.field_map_orders) : null
    let imported = 0, updated = 0
    const touchedOrderIds = []
    // Sens de sync du champ Notes : si 'push' (ERP → Airtable seulement), on ne
    // ré-importe pas la valeur Airtable pour ne pas écraser une note éditée dans l'ERP.
    const notesDir = fieldMapDirection('orders', 'notes')

    // Max order_number for auto-increment
    const maxNum = () => (db.prepare('SELECT MAX(order_number) as m FROM orders').get()?.m || 0)

    db.transaction((recs) => {
      for (const rec of recs) {
        // Garde anti-boucle : si ce record est l'echo d'un write-back ERP récent
        // (mêmes valeurs), ne pas le ré-importer — évite la boucle avec le webhook.
        if (consumeWritebackEcho(rec.id, rec.fields)) continue

        if (!fm && rec.fields) {
          fm = {
            order_number:    autoMapField(rec.fields, 'numéro', 'numero', 'order number', 'commande', '#'),
            company:         autoMapField(rec.fields, 'company', 'entreprise', 'client', 'compte'),
            project:         autoMapField(rec.fields, 'project', 'projet'),
            status:          autoMapField(rec.fields, 'status', 'statut', 'état'),
            priority:        autoMapField(rec.fields, 'priority', 'priorité', 'urgence'),
            notes:           autoMapField(rec.fields, 'notes', 'commentaires', 'description'),
            address:         autoMapField(rec.fields, 'adresse', 'adresse de livraison', 'shipping address', 'address', 'delivery address'),
            is_subscription: autoMapField(rec.fields, 'abonnement', 'subscription', 'abonnement?'),
          }
        } else if (fm && !fm.is_subscription && rec.fields) {
          fm.is_subscription = autoMapField(rec.fields, 'abonnement', 'subscription', 'abonnement?')
        }

        // Status mapping
        const rawStatus = (getVal(rec.fields, fm?.status) || '').trim()
        const STATUS_MAP = {
          'commande vide': 'Commande vide', 'vide': 'Commande vide', 'brouillon': 'Commande vide', 'draft': 'Commande vide',
          "gel d'envois": "Gel d'envois", 'gel': "Gel d'envois",
          'en attente': 'En attente', 'confirmée': 'En attente', 'confirmed': 'En attente',
          'items à fabriquer ou à acheter': 'Items à fabriquer ou à acheter', 'en préparation': 'Items à fabriquer ou à acheter',
          'tous les items sont disponibles': 'Tous les items sont disponibles',
          'tout est dans la boite': 'Tout est dans la boite',
          'partiellement envoyé': 'Partiellement envoyé', 'partiellement envoyée': 'Partiellement envoyé', 'partial': 'Partiellement envoyé',
          'jwt-config': 'JWT-config',
          "envoyé aujourd'hui": "Envoyé aujourd'hui", 'envoyée': 'Envoyé', 'envoyé': 'Envoyé', 'sent': 'Envoyé', 'shipped': 'Envoyé',
          'drop ship seulement': 'Drop ship seulement', 'drop ship': 'Drop ship seulement',
          'erreur système': 'ERREUR SYSTÈME',
        }
        const status = STATUS_MAP[rawStatus.toLowerCase()] || 'Commande vide'

        // Company lookup
        const companyId = lookupCompany(rec.fields, fm?.company)

        // Project lookup — linked record (airtable_id) first, then name LIKE fallback
        let projectId = null
        if (fm?.project && rec.fields[fm.project] != null) {
          const raw = rec.fields[fm.project]
          const airtableId = Array.isArray(raw) ? raw[0] : null
          if (airtableId) {
            const proj = db.prepare('SELECT id FROM projects WHERE airtable_id=? LIMIT 1').get(airtableId)
            projectId = proj?.id || null
          }
          if (!projectId) {
            const projectName = getVal(rec.fields, fm.project)
            if (projectName) {
              const proj = db.prepare('SELECT id FROM projects WHERE name LIKE ? LIMIT 1').get(`%${projectName}%`)
              projectId = proj?.id || null
            }
          }
        }

        const notes    = getVal(rec.fields, fm?.notes)
        const priority = getVal(rec.fields, fm?.priority)

        // is_subscription: Airtable checkbox field → 1/0
        const rawSubscription = fm?.is_subscription ? rec.fields[fm.is_subscription] : null
        const isSubscription = rawSubscription === true || rawSubscription === 'Oui' || rawSubscription === 'oui' || rawSubscription === 1 ? 1 : 0

        // Address lookup via linked record
        let addressId = null
        if (fm?.address) {
          const raw = rec.fields[fm.address]
          const linkedId = Array.isArray(raw) ? raw[0] : null
          if (linkedId) {
            const addr = db.prepare('SELECT id FROM adresses WHERE airtable_id=? LIMIT 1').get(linkedId)
            addressId = addr?.id || null
          }
        }

        const existing = db.prepare('SELECT id, notes FROM orders WHERE airtable_id=?').get(rec.id)
        if (existing) {
          // Notes en sens 'push' (ERP → Airtable) : conserver la valeur ERP, ne pas
          // l'écraser avec Airtable. Sinon (pull/both) : importer la valeur Airtable.
          const notesToStore = notesDir === 'push' ? existing.notes : notes
          db.prepare(`UPDATE orders SET company_id=?, project_id=?, status=?, priority=?, notes=?, address_id=COALESCE(?,address_id), is_subscription=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(companyId, projectId, status, priority, notesToStore, addressId, isSubscription, existing.id)
          emitOrder('updated', existing.id, null)
          touchedOrderIds.push(existing.id)
          updated++
        } else {
          const rawNum = fm?.order_number ? parseInt(String(rec.fields[fm.order_number] ?? '').replace(/[^0-9]/g, '')) : NaN
          const orderNumber = isNaN(rawNum) || rawNum === 0 ? maxNum() + 1 : rawNum
          const newId = uuid()
          db.prepare('INSERT INTO orders (id, order_number, company_id, project_id, status, priority, notes, address_id, airtable_id, is_subscription) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(newId, orderNumber, companyId, projectId, status, priority, notes, addressId, rec.id, isSubscription)
          emitOrder('created', newId, null)
          touchedOrderIds.push(newId)
          imported++
        }
      }
    })(records)
    console.log(`📦 Orders: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('orders', records)
      await syncDynamicFields('orders', 'orders', config.base_id, config.orders_table_id, fm, records)
    } else {
      await updateDynamicFields('orders', fm, records)
    }
    await evaluateFieldRules({ erpTable: 'orders', tableId: config.orders_table_id, changes })

    // Constat de vente QB — pour chaque commande touchée par le sync Airtable,
    // tente de poser la JE Dr 23900|AR / Cr 40000 sur ses factures kind='order'.
    // reconcileFacturesForOrder est idempotent et filtre lui-même : skip si pas
    // d'envoi lié, déjà constatée, abonnement, ou payout Stripe en attente.
    // Fire-and-forget pour ne pas bloquer la fin du sync si QB est indisponible.
    for (const orderId of touchedOrderIds) {
      reconcileFacturesForOrder(orderId).then(r => {
        if (r.recognized.length || r.errors.length) {
          logSystemRun('sys_revenue_recognition', {
            status: r.errors.length ? 'error' : 'success',
            result: [
              `Commande ${orderId} (sync Airtable)`,
              `Constatées : ${r.recognized.length} (${r.recognized.map(x => `#${x.document_number || x.facture_id} ${x.amount} ${x.currency} via ${x.debit_account}`).join(', ') || '—'})`,
              `Skip : ${r.skipped.length}`,
              r.errors.length ? `Erreurs : ${r.errors.map(e => `${e.facture_id}: ${e.error}`).join(' | ')}` : null,
            ].filter(Boolean).join('\n'),
            error: r.errors.length ? r.errors.map(e => e.error).join(' | ') : undefined,
            triggerData: { order_id: orderId, source: 'airtable_sync' },
          })
        }
      }).catch(err => {
        console.error('reconcileFacturesForOrder (airtable sync) error:', err.message)
        logSystemRun('sys_revenue_recognition', {
          status: 'error', error: err.message,
          triggerData: { order_id: orderId, source: 'airtable_sync' },
        })
      })
    }
  } catch (e) { console.error('❌ Orders sync:', e.message) }
  } // end if (!changes || _orderIds?.length)

  // ── 2. Sync order items ───────────────────────────────────────────────────
  if (!config.items_table_id) return
  if (changes?.[config.items_table_id]?.destroyedIds?.length) {
    for (const id of changes[config.items_table_id].destroyedIds)
      db.prepare('DELETE FROM order_items WHERE airtable_id=?').run(id)
  }
  const _itemIds = changes?.[config.items_table_id]?.recordIds
  if (changes && !_itemIds?.length) return
  try {
    const records = await fetchAllRecords(config.base_id, config.items_table_id, accessToken, 'orders', _itemIds)
    let fm = config.field_map_items ? JSON.parse(config.field_map_items) : null
    let imported = 0, updated = 0

    db.transaction((recs) => {
      for (const rec of recs) {
        if (!fm && rec.fields) {
          fm = {
            order:     autoMapField(rec.fields, 'order', 'commande', 'bon de commande'),
            product:   autoMapField(rec.fields, 'product', 'produit', 'pièce', 'piece', 'item'),
            qty:       autoMapField(rec.fields, 'qty', 'quantité', 'quantite', 'quantity'),
            unit_cost: autoMapField(rec.fields, 'coût unitaire', 'cout', 'unit cost', 'prix unitaire'),
            item_type: autoMapField(rec.fields, 'type', 'item type', 'type item', 'facturable'),
            notes:     autoMapField(rec.fields, 'notes', 'commentaires'),
          }
        }

        // order link: linked record field → array of Airtable record IDs
        const orderLinkRaw = fm?.order ? rec.fields[fm.order] : null
        const orderAirtableId = Array.isArray(orderLinkRaw) ? orderLinkRaw[0] : (typeof orderLinkRaw === 'string' ? orderLinkRaw : null)
        if (!orderAirtableId) continue

        const order = db.prepare('SELECT id FROM orders WHERE airtable_id=?').get(orderAirtableId)
        if (!order) continue

        // Product lookup: linked record → array of record IDs, resolve via airtable_id
        const productLinkRaw = fm?.product ? rec.fields[fm.product] : null
        const productAirtableId = Array.isArray(productLinkRaw) ? productLinkRaw[0] : (typeof productLinkRaw === 'string' ? productLinkRaw : null)
        let productId = null
        if (productAirtableId) {
          const prod = db.prepare('SELECT id FROM products WHERE airtable_id=?').get(productAirtableId)
          productId = prod?.id || null
        }
        // Fallback: match by name
        if (!productId) {
          const productName = fm?.product ? getVal(rec.fields, fm.product) : null
          if (productName) {
            const prod = db.prepare('SELECT id FROM products WHERE (name_fr LIKE ? OR name_en LIKE ? OR sku=?) LIMIT 1')
              .get(`%${productName}%`, `%${productName}%`, productName)
            productId = prod?.id || null
          }
        }

        const qty = parseInt(String(fm?.qty ? rec.fields[fm.qty] ?? 1 : 1)) || 1
        const unitCost = parseFloat(String(fm?.unit_cost ? rec.fields[fm.unit_cost] ?? 0 : 0).replace(/[^0-9.-]/g, '')) || 0
        const rawType = (getVal(rec.fields, fm?.item_type) || '').trim()
        const ITEM_TYPES = ['Facturable', 'Remplacement', 'Non facturable']
        const itemType = ITEM_TYPES.find(t => t.toLowerCase() === rawType.toLowerCase()) || 'Facturable'
        const notes = getVal(rec.fields, fm?.notes)

        const existing = db.prepare('SELECT id FROM order_items WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare('UPDATE order_items SET product_id=?, qty=?, unit_cost=?, item_type=?, notes=? WHERE id=?')
            .run(productId, qty, unitCost, itemType, notes, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO order_items (id, order_id, product_id, qty, unit_cost, item_type, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?)')
            .run(uuid(), order.id, productId, qty, unitCost, itemType, notes, rec.id)
          imported++
        }
      }
      db.prepare(`UPDATE airtable_orders_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run()
    })(records)
    console.log(`🧾 Order items: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('order_items', records)
      await syncDynamicFields('order_items', 'order_items', config.base_id, config.items_table_id, fm, records)
    } else {
      await updateDynamicFields('order_items', fm, records)
    }

    // Backfill shipped_unit_cost from Airtable's frozen total cost
    try {
      db.prepare(`
        UPDATE order_items SET shipped_unit_cost = CAST(cout_total_au_moment_de_l_envoi AS REAL) / MAX(qty, 1)
        WHERE shipped_unit_cost IS NULL
          AND cout_total_au_moment_de_l_envoi IS NOT NULL
          AND CAST(cout_total_au_moment_de_l_envoi AS REAL) > 0
      `).run()
    } catch {}
  } catch (e) { console.error('❌ Order items sync:', e.message) }
}

async function downloadImage(url, destPath) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`)
  await mkdir(path.dirname(destPath), { recursive: true })
  const buffer = Buffer.from(await res.arrayBuffer())
  const { writeFile } = await import('fs/promises')
  await writeFile(destPath, buffer)
}

export async function syncPieces(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='pieces'").get()
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Pièces config missing'); return }

  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM products WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  const imagesDir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products')

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'pieces', _recordIds)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    // Pre-compute image URLs (async downloads must happen before the sync transaction)
    const imageUrlMap = {}
    for (const rec of records) {
      if (!fieldMap && rec.fields) {
        fieldMap = {
          name_fr:          autoMapField(rec.fields, 'nom', 'name fr', 'nom français', 'name_fr') || Object.keys(rec.fields)[0],
          name_en:          autoMapField(rec.fields, 'name', 'name en', 'nom anglais', 'name_en'),
          sku:              autoMapField(rec.fields, 'sku', 'code', 'référence', 'ref', 'numéro'),
          type:             autoMapField(rec.fields, 'type', 'catégorie', 'categorie', 'category'),
          unit_cost:        autoMapField(rec.fields, 'coût unitaire', 'cout', 'unit cost', 'cost'),
          price_cad:        autoMapField(rec.fields, 'prix', 'price', 'prix cad'),
          stock_qty:        autoMapField(rec.fields, 'stock', 'quantité', 'qty', 'quantity'),
          min_stock:        autoMapField(rec.fields, 'stock min', 'min stock', 'seuil', 'minimum'),
          supplier:         autoMapField(rec.fields, 'fournisseur', 'supplier', 'vendor'),
          procurement_type: autoMapField(rec.fields, 'approvisionnement', 'procurement', 'type achat'),
          weight_lbs:       autoMapField(rec.fields, 'poids', 'weight', 'poids lbs'),
          image:            autoMapField(rec.fields, 'image', 'photo', 'images', 'photos', 'picture'),
          // Étape 5 « Priorité d'assemblage » — champs produits finis (one-way Airtable → ERP)
          assembly_status:          autoMapField(rec.fields, "status d'assemblage", 'status assemblage', "statut d'assemblage", 'statut assemblage', 'assembly status'),
          finished_min_stock:       autoMapField(rec.fields, 'seuil min. produits finis', 'seuil min produits finis', 'seuil min produits fini', 'seuil minimum produits finis'),
          projected_available_qty:  autoMapField(rec.fields, 'quantité sera disponible', 'quantite sera disponible', 'qté sera disponible', 'quantité disponible projetée'),
          producible_qty:           autoMapField(rec.fields, 'nombre de produit possible', 'nombre de produits possible', 'nombre de produits possibles', 'nb produit possible', 'produit possible'),
          // Étape 4 « Priorité d'assemblage » — lien fournisseur (bouton externe)
          supplier_link:            autoMapField(rec.fields, 'lien fournisseur', "lien d'achat", 'url fournisseur', 'lien'),
        }
      }
      // Backfill des 4 champs étape 5 même si le field_map est déjà figé en DB
      // (l'auto-map initial ci-dessus ne s'exécute qu'au tout 1er sync). On reprobe
      // tant que non trouvé, car Airtable omet les champs vides : un champ peut
      // n'apparaître que dans un record plus loin. Idempotent.
      if (fieldMap && rec.fields) {
        const probe = (key, ...cands) => { if (!fieldMap[key]) { const m = autoMapField(rec.fields, ...cands); if (m) fieldMap[key] = m } }
        probe('assembly_status', "status d'assemblage", 'status assemblage', "statut d'assemblage", 'statut assemblage', 'assembly status')
        probe('finished_min_stock', 'seuil min. produits finis', 'seuil min produits finis', 'seuil min produits fini', 'seuil minimum produits finis')
        probe('projected_available_qty', 'quantité sera disponible', 'quantite sera disponible', 'qté sera disponible', 'quantité disponible projetée')
        probe('producible_qty', 'nombre de produit possible', 'nombre de produits possible', 'nombre de produits possibles', 'nb produit possible', 'produit possible')
        probe('supplier_link', 'lien fournisseur', "lien d'achat", 'url fournisseur', 'lien')
      }
      if (fieldMap?.image) {
        const attachments = rec.fields[fieldMap.image]
        if (Array.isArray(attachments) && attachments.length > 0) {
          const att = attachments[0]
          const ext = att.filename?.split('.').pop()?.toLowerCase() || 'jpg'
          const filename = `${rec.id}.${ext}`
          const destPath = path.join(imagesDir, filename)
          if (!existsSync(destPath)) {
            try { await downloadImage(att.url, destPath) } catch (e) { console.error('⚠️  Image download:', e.message) }
          }
          imageUrlMap[rec.id] = `/erp/api/product-images/${filename}`
        }
      }
    }

    db.transaction((recs) => {
      for (const rec of recs) {
        const nameFr = getVal(rec.fields, fieldMap?.name_fr)
        if (!nameFr) continue

        function toFloat(fieldKey) {
          const raw = fieldKey ? rec.fields[fieldKey] : null
          const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
          return isNaN(n) ? null : n
        }
        function toInt(fieldKey) {
          const raw = fieldKey ? rec.fields[fieldKey] : null
          const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
          return isNaN(n) ? null : Math.round(n)
        }

        const validProcurement = ['Acheté', 'Fabriqué', 'Drop ship']
        const rawProcurement = getVal(rec.fields, fieldMap?.procurement_type) || ''
        const procurementType = validProcurement.find(p => p.toLowerCase() === rawProcurement.toLowerCase()) || null

        const imageUrl = imageUrlMap[rec.id] || null

        const payload = {
          name_fr:          nameFr,
          name_en:          getVal(rec.fields, fieldMap?.name_en),
          sku:              getVal(rec.fields, fieldMap?.sku),
          type:             getVal(rec.fields, fieldMap?.type),
          unit_cost:        toFloat(fieldMap?.unit_cost) ?? 0,
          price_cad:        toFloat(fieldMap?.price_cad) ?? 0,
          stock_qty:        toInt(fieldMap?.stock_qty) ?? 0,
          min_stock:        toInt(fieldMap?.min_stock) ?? 0,
          supplier:         getVal(rec.fields, fieldMap?.supplier),
          procurement_type: procurementType,
          weight_lbs:       toFloat(fieldMap?.weight_lbs) ?? 0,
          image_url:        imageUrl,
          // Étape 5 « Priorité d'assemblage » (null si champ absent → on ne fausse pas le calcul du manque)
          assembly_status:          toFloat(fieldMap?.assembly_status),
          finished_min_stock:       toInt(fieldMap?.finished_min_stock),
          projected_available_qty:  toInt(fieldMap?.projected_available_qty),
          producible_qty:           toInt(fieldMap?.producible_qty),
          supplier_link:            getVal(rec.fields, fieldMap?.supplier_link),
        }

        const existing = db.prepare('SELECT id FROM products WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE products SET name_fr=?, name_en=?, sku=?, type=?, unit_cost=?, price_cad=?, stock_qty=?, min_stock=?, supplier=?, procurement_type=?, weight_lbs=?, image_url=COALESCE(?,image_url), assembly_status=?, finished_min_stock=?, projected_available_qty=?, producible_qty=?, supplier_link=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(payload.name_fr, payload.name_en, payload.sku, payload.type, payload.unit_cost, payload.price_cad, payload.stock_qty, payload.min_stock, payload.supplier, payload.procurement_type, payload.weight_lbs, payload.image_url, payload.assembly_status, payload.finished_min_stock, payload.projected_available_qty, payload.producible_qty, payload.supplier_link, existing.id)
          updated++
        } else {
          db.prepare(`INSERT INTO products (id, name_fr, name_en, sku, type, unit_cost, price_cad, stock_qty, min_stock, supplier, procurement_type, weight_lbs, image_url, assembly_status, finished_min_stock, projected_available_qty, producible_qty, supplier_link, airtable_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), payload.name_fr, payload.name_en, payload.sku, payload.type, payload.unit_cost, payload.price_cad, payload.stock_qty, payload.min_stock, payload.supplier, payload.procurement_type, payload.weight_lbs, payload.image_url, payload.assembly_status, payload.finished_min_stock, payload.projected_available_qty, payload.producible_qty, payload.supplier_link, rec.id)
          imported++
        }
      }
      // Persiste le field_map (incl. les 4 clés étape 5 backfillées) pour qu'il soit durable
      // et visible dans la config — évite tout UPDATE manuel de la DB.
      db.prepare(`UPDATE airtable_module_config SET field_map=?, last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='pieces'`).run(fieldMap ? JSON.stringify(fieldMap) : null)
    })(records)
    console.log(`🔩 Pièces: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('products', records)
      await syncDynamicFields('pieces', 'products', config.base_id, config.table_id, fieldMap, records)
    } else {
      await updateDynamicFields('products', fieldMap, records)
    }
    await evaluateFieldRules({ erpTable: 'products', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Pièces sync:', e.message) }
}

export async function syncAchats(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='achats'").get()
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Achats config missing'); return }

  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM purchases WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'achats', _recordIds)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null

    // Fournisseur lié (table Fournisseurs) — cache rafraîchi sur sync complète, ou sur
    // sync incrémentale dès qu'un achat pointe vers un fournisseur encore inconnu.
    let vendors = vendorLinkMap()
    const linkedVendorIds = new Set()
    for (const rec of records) {
      const raw = rec.fields?.[ACHATS_VENDOR_LINK_FIELD]
      if (Array.isArray(raw)) for (const v of raw) if (typeof v === 'string') linkedVendorIds.add(v)
    }
    if (!changes || [...linkedVendorIds].some(id => !vendors.has(id))) {
      await refreshVendorLinkCache(config.base_id, accessToken)
      vendors = vendorLinkMap()
    }

    // Field map computed from the UNION of keys across all fetched records, not a
    // single sample. Airtable omits empty fields per-record, so auto-detecting from
    // the first record alone made fields (notably "Date de réception complète")
    // appear/disappear between syncs depending on which record landed first in the
    // batch. On a full sync the union is complete → persist it so later incremental
    // syncs (small batches that may not contain every field) reuse a stable map.
    if (!fieldMap && records.length) {
      const union = {}
      for (const rec of records) if (rec.fields) Object.assign(union, rec.fields)
      fieldMap = {
        product:        autoMapField(union, 'nom de la pièce', 'nom de la piece', 'produit', 'pièce', 'piece', 'product', 'item'),
        supplier:       autoMapField(union, 'fournisseur - legacy', 'fournisseur legacy', 'fournisseur', 'supplier', 'vendor'),
        reference:      autoMapField(union, 'numéro de commande', 'numero de commande', 'référence', 'reference', 'ref', 'po', 'numéro'),
        order_date:     autoMapField(union, 'date de commande', 'date commande', 'date achat', 'order date', 'date'),
        expected_date:  autoMapField(union, 'date prévue', 'date prevue', 'expected', 'livraison prévue'),
        received_date:  autoMapField(union, 'date de réception complète', 'date de réception', 'date réception', 'date reception', 'received date', 'reçu le'),
        qty_ordered:    autoMapField(union, 'quantité commandé', 'quantite commande', 'qté commandée', 'qty ordered', 'quantité commandée', 'qte commandee'),
        qty_received:   autoMapField(union, 'qté reçue', 'qty received', 'quantité reçue', 'qte recue'),
        unit_cost:      autoMapField(union, 'prix unitaire ($ cad)', 'prix unitaire', 'coût unitaire', 'cout unitaire', 'unit cost'),
        status:         autoMapField(union, 'statut', 'status', 'état'),
        notes:          autoMapField(union, 'notes', 'commentaires', 'remarks'),
      }
      // Persist only on full sync — an incremental batch's union may be partial.
      if (!changes) db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='achats'").run(JSON.stringify(fieldMap))
    }
    let imported = 0, updated = 0

    let echoed = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        // Garde anti-boucle : si ce record est l'echo d'un write-back ERP récent
        // (mêmes valeurs), ne pas le ré-importer — évite la boucle avec le webhook.
        if (consumeWritebackEcho(rec.id, rec.fields)) { echoed++; continue }

        function toFloat(fieldKey) {
          const raw = fieldKey ? rec.fields[fieldKey] : null
          const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
          return isNaN(n) ? null : n
        }
        function toInt(fieldKey) {
          const raw = fieldKey ? rec.fields[fieldKey] : null
          const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
          return isNaN(n) ? null : Math.round(n)
        }

        let productId = null
        if (fieldMap?.product) {
          const raw = rec.fields[fieldMap.product]
          const linkedId = Array.isArray(raw) ? raw[0] : (typeof raw === 'string' ? raw : null)
          if (linkedId) {
            const prod = db.prepare('SELECT id FROM products WHERE airtable_id=?').get(linkedId)
            productId = prod?.id || null
            if (!productId) {
              const nameStr = typeof linkedId === 'string' ? linkedId : null
              if (nameStr) {
                const prod2 = db.prepare('SELECT id FROM products WHERE (name_fr LIKE ? OR sku LIKE ?) LIMIT 1').get(`%${nameStr}%`, `%${nameStr}%`)
                productId = prod2?.id || null
              }
            }
          }
        }

        const STATUS_MAP = {
          'commandé': 'Commandé', 'ordered': 'Commandé', 'commande': 'Commandé',
          'reçu partiellement': 'Reçu partiellement', 'partial': 'Reçu partiellement', 'partiel': 'Reçu partiellement',
          'reçu': 'Reçu', 'received': 'Reçu', 'livré': 'Reçu', 'livre': 'Reçu',
          'annulé': 'Annulé', 'cancelled': 'Annulé', 'canceled': 'Annulé', 'annule': 'Annulé',
        }
        const rawStatus = (getVal(rec.fields, fieldMap?.status) || '').trim()
        const receivedDate = getVal(rec.fields, fieldMap?.received_date)
        const qtyOrdered = toInt(fieldMap?.qty_ordered) ?? 0
        const mappedQtyReceived = toInt(fieldMap?.qty_received)
        // Airtable's "achats" table has no Statut / Qté reçue column — reception is
        // tracked solely by "Date de réception complète". Prefer an explicit status
        // field when one exists; otherwise derive it: a reception date ⇒ Reçu (and
        // assume the full ordered qty received), absence ⇒ still Commandé.
        const status = STATUS_MAP[rawStatus.toLowerCase()] || (receivedDate ? 'Reçu' : 'Commandé')
        const qtyReceived = mappedQtyReceived ?? (status === 'Reçu' ? qtyOrdered : 0)

        // Fournisseur : le champ LIÉ fait foi (nom = raison sociale QB exacte). Le
        // single-select legacy ne sert plus que de repli pour les achats antérieurs à
        // la bascule. On ne l'ÉCRASE pas dans `supplier` (colonne héritée utilisée par
        // les vues/filtres existants) : on ne la remplit que si elle est vide.
        const legacySupplier = getVal(rec.fields, fieldMap?.supplier)
        const rawVendorLink = rec.fields?.[ACHATS_VENDOR_LINK_FIELD]
        const linkedVendorId = Array.isArray(rawVendorLink) ? rawVendorLink[0] : null
        const linkedVendor = linkedVendorId ? vendors.get(linkedVendorId) : null

        const payload = {
          supplier_vendor_name:  linkedVendor?.name || null,
          supplier_qb_vendor_id: linkedVendor?.qb_vendor_id || null,
          product_id:     productId,
          supplier:       legacySupplier || linkedVendor?.name || null,
          reference:      getVal(rec.fields, fieldMap?.reference),
          order_date:     getVal(rec.fields, fieldMap?.order_date),
          expected_date:  getVal(rec.fields, fieldMap?.expected_date),
          received_date:  receivedDate,
          qty_ordered:    qtyOrdered,
          qty_received:   qtyReceived,
          unit_cost:      toFloat(fieldMap?.unit_cost) ?? 0,
          status,
          notes:          getVal(rec.fields, fieldMap?.notes),
        }

        const existing = db.prepare('SELECT id FROM purchases WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE purchases SET product_id=?, supplier=?, supplier_vendor_name=?, supplier_qb_vendor_id=?, reference=?, order_date=?, expected_date=?, received_date=?, qty_ordered=?, qty_received=?, unit_cost=?, status=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(payload.product_id, payload.supplier, payload.supplier_vendor_name, payload.supplier_qb_vendor_id, payload.reference, payload.order_date, payload.expected_date, payload.received_date, payload.qty_ordered, payload.qty_received, payload.unit_cost, payload.status, payload.notes, existing.id)
          updated++
        } else {
          db.prepare(`INSERT INTO purchases (id, airtable_id, product_id, supplier, supplier_vendor_name, supplier_qb_vendor_id, reference, order_date, expected_date, received_date, qty_ordered, qty_received, unit_cost, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), rec.id, payload.product_id, payload.supplier, payload.supplier_vendor_name, payload.supplier_qb_vendor_id, payload.reference, payload.order_date, payload.expected_date, payload.received_date, payload.qty_ordered, payload.qty_received, payload.unit_cost, payload.status, payload.notes)
          imported++
        }
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='achats'`).run()
    })(records)
    console.log(`🛒 Achats: ${imported} importés, ${updated} mis à jour${echoed ? `, ${echoed} echo(s) write-back ignoré(s)` : ''}`)
    if (!changes) {
      purgeOrphans('purchases', records)
      await syncDynamicFields('achats', 'purchases', config.base_id, config.table_id, fieldMap, records)
    } else {
      await updateDynamicFields('purchases', fieldMap, records)
    }
    await evaluateFieldRules({ erpTable: 'purchases', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Achats sync:', e.message) }
}

export async function syncSerials(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='serials'").get()
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Serials config missing'); return }

  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM serial_numbers WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'serials', _recordIds)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    db.transaction((recs) => {
      for (const rec of recs) {
        if (!fieldMap && rec.fields) {
          fieldMap = {
            serial:   autoMapField(rec.fields, 'numéro de série', 'numero de serie', 'serial', 'serial number', 's/n', 'sn') || Object.keys(rec.fields)[0],
            product:  autoMapField(rec.fields, 'produit', 'pièce', 'piece', 'product', 'item'),
            company:  autoMapField(rec.fields, 'entreprise', 'company', 'client', 'compte'),
            order_item:           autoMapField(rec.fields, 'item de commande', 'order item', 'ligne de commande', 'item'),
            address:              autoMapField(rec.fields, 'adresse', 'address'),
            manufacture_date:     autoMapField(rec.fields, 'date de fabrication', 'manufacture date', 'date fabrication', 'fabrication'),
            last_programmed_date: autoMapField(rec.fields, 'date de la dernière programmation', 'date derniere programmation', 'dernière programmation', 'last programmed', 'programmation'),
            manufacture_value:    autoMapField(rec.fields, 'valeur au moment de la fabrication', 'valeur fabrication', 'manufacture value', 'valeur'),
            status:               autoMapField(rec.fields, 'statut', 'status', 'état'),
            notes:                autoMapField(rec.fields, 'notes', 'commentaires'),
          }
        }

        const serial = getVal(rec.fields, fieldMap?.serial)
        if (!serial) continue

        const companyId = lookupCompany(rec.fields, fieldMap?.company)

        let productId = null
        if (fieldMap?.product) {
          const raw = rec.fields[fieldMap.product]
          const linkedId = Array.isArray(raw) ? raw[0] : null
          if (linkedId) {
            const prod = db.prepare('SELECT id FROM products WHERE airtable_id=? LIMIT 1').get(linkedId)
            productId = prod?.id || null
          }
          if (!productId) {
            const name = Array.isArray(rec.fields[fieldMap.product]) ? null : getVal(rec.fields, fieldMap.product)
            if (name) {
              const prod = db.prepare('SELECT id FROM products WHERE (name_fr LIKE ? OR sku LIKE ?) LIMIT 1').get(`%${name}%`, `%${name}%`)
              productId = prod?.id || null
            }
          }
        }

        let orderItemId = null
        if (fieldMap?.order_item) {
          const raw = rec.fields[fieldMap.order_item]
          const linkedId = Array.isArray(raw) ? raw[0] : null
          if (linkedId) {
            const oi = db.prepare('SELECT id FROM order_items WHERE airtable_id=? LIMIT 1').get(linkedId)
            orderItemId = oi?.id || null
          }
        }

        const address             = getVal(rec.fields, fieldMap?.address)
        const manufacture_date    = getVal(rec.fields, fieldMap?.manufacture_date)
        const last_programmed_date = getVal(rec.fields, fieldMap?.last_programmed_date)
        const rawVal              = fieldMap?.manufacture_value ? rec.fields[fieldMap.manufacture_value] : null
        const manufacture_value   = rawVal != null ? (parseFloat(String(rawVal).replace(/[^0-9.-]/g, '')) || 0) : 0
        const status              = getVal(rec.fields, fieldMap?.status)
        const notes               = getVal(rec.fields, fieldMap?.notes)

        const existing = db.prepare('SELECT id FROM serial_numbers WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE serial_numbers SET serial=?, product_id=?, company_id=?, order_item_id=?, address=?, manufacture_date=?, last_programmed_date=?, manufacture_value=?, status=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(serial, productId, companyId, orderItemId, address, manufacture_date, last_programmed_date, manufacture_value, status, notes, existing.id)
          updated++
        } else {
          db.prepare(`INSERT INTO serial_numbers (id, airtable_id, serial, product_id, company_id, order_item_id, address, manufacture_date, last_programmed_date, manufacture_value, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), rec.id, serial, productId, companyId, orderItemId, address, manufacture_date, last_programmed_date, manufacture_value, status, notes)
          imported++
        }
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='serials'`).run()
    })(records)
    console.log(`🔢 Sériaux: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      purgeOrphans('serial_numbers', records)
      await syncDynamicFields('serials', 'serial_numbers', config.base_id, config.table_id, fieldMap, records)
    } else {
      await updateDynamicFields('serial_numbers', fieldMap, records)
    }
    await evaluateFieldRules({ erpTable: 'serial_numbers', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Serials sync:', e.message) }
}

export async function syncEnvois(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='envois'").get()
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Envois config missing'); return }

  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM shipments WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'envois', _recordIds)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0, echoed = 0

    db.transaction((recs) => {
      for (const rec of recs) {
        // Garde anti-boucle : si ce record est l'echo d'un write-back ERP récent
        // (mêmes valeurs scalaires), ne pas le ré-importer — évite la boucle avec
        // le webhook déclenché par notre propre PATCH Airtable.
        if (consumeWritebackEcho(rec.id, rec.fields)) { echoed++; continue }

        if (!fieldMap && rec.fields) {
          fieldMap = {
            order:           autoMapField(rec.fields, 'commande', 'order', 'numéro de commande', 'order number'),
            tracking_number: autoMapField(rec.fields, 'numéro de suivi', 'numero de suivi', 'tracking number', 'tracking', 'suivi'),
            carrier:         autoMapField(rec.fields, 'transporteur', 'carrier', 'livreur', 'expéditeur'),
            status:          autoMapField(rec.fields, 'statut', 'status', 'état'),
            shipped_at:      autoMapField(rec.fields, "date d'envoi", 'date envoi', 'shipped at', 'shipped date', 'expédié le'),
            notes:           autoMapField(rec.fields, 'notes', 'commentaires'),
            address:         autoMapField(rec.fields, 'adresse', 'adresse de livraison', 'shipping address', 'address', 'delivery address'),
            pays:            autoMapField(rec.fields, 'pays', 'pays de livraison', 'country', 'destination country', 'pays destination'),
            items:           autoMapField(rec.fields, 'items expédiés', 'items expedies', 'items à expédier', 'items a expedier', 'articles expédiés', 'articles expedies'),
          }
        }

        let orderId = null
        if (fieldMap?.order) {
          const raw = rec.fields[fieldMap.order]
          const linkedId = Array.isArray(raw) ? raw[0] : null
          if (linkedId) {
            const o = db.prepare('SELECT id FROM orders WHERE airtable_id=? LIMIT 1').get(linkedId)
            orderId = o?.id || null
          }
          if (!orderId) {
            const orderNum = Array.isArray(raw) ? null : getVal(rec.fields, fieldMap.order)
            if (orderNum) {
              const o = db.prepare('SELECT id FROM orders WHERE order_number=? LIMIT 1').get(parseInt(orderNum))
              orderId = o?.id || null
            }
          }
        }

        const tracking_number = getVal(rec.fields, fieldMap?.tracking_number)
        const carrier         = getVal(rec.fields, fieldMap?.carrier)
        const status          = getVal(rec.fields, fieldMap?.status)
        const shipped_at      = getVal(rec.fields, fieldMap?.shipped_at)
        const notes           = getVal(rec.fields, fieldMap?.notes)
        const pays            = getVal(rec.fields, fieldMap?.pays)

        let addressId = null
        if (fieldMap?.address) {
          const raw = rec.fields[fieldMap.address]
          const linkedId = Array.isArray(raw) ? raw[0] : null
          if (linkedId) {
            const addr = db.prepare('SELECT id FROM adresses WHERE airtable_id=? LIMIT 1').get(linkedId)
            addressId = addr?.id || null
          }
        }

        const existing = db.prepare('SELECT id FROM shipments WHERE airtable_id=?').get(rec.id)
        let shipmentId = null
        if (existing) {
          db.prepare(`UPDATE shipments SET order_id=COALESCE(?,order_id), tracking_number=?, carrier=?, status=?, shipped_at=?, notes=?, address_id=COALESCE(?,address_id), pays=? WHERE id=?`)
            .run(orderId, tracking_number, carrier, status || 'À envoyer', shipped_at, notes, addressId, pays, existing.id)
          shipmentId = existing.id
          updated++
        } else {
          if (!orderId) continue
          shipmentId = uuid()
          db.prepare(`INSERT INTO shipments (id, order_id, airtable_id, tracking_number, carrier, status, shipped_at, notes, address_id, pays) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(shipmentId, orderId, rec.id, tracking_number, carrier, status || 'À envoyer', shipped_at, notes, addressId, pays)
          imported++
        }

        // Lier les items expédiés (Airtable « items expédiés ») → order_items.shipment_id.
        // C'est la source de vérité de « quels articles partent dans cet envoi » : sans ça,
        // la fiche envoi retombe sur l'affichage de toute la commande. On ne ré-assigne que
        // si Airtable fournit une liste explicite — sinon on ne touche à rien (vieux envois).
        const itemsField = fieldMap?.items
          || autoMapField(rec.fields, 'items expédiés', 'items expedies', 'items à expédier', 'items a expedier', 'articles expédiés', 'articles expedies')
        if (shipmentId && itemsField) {
          const raw = rec.fields[itemsField]
          const linkedIds = Array.isArray(raw) ? raw : []
          const oiIds = []
          for (const atid of linkedIds) {
            const oi = db.prepare('SELECT id FROM order_items WHERE airtable_id=? LIMIT 1').get(atid)
            if (oi) oiIds.push(oi.id)
          }
          if (oiIds.length) {
            // Détache d'abord les items pointant vers cet envoi mais absents de la nouvelle liste,
            // puis (re)lie ceux d'Airtable. Idempotent.
            db.prepare('UPDATE order_items SET shipment_id=NULL WHERE shipment_id=?').run(shipmentId)
            const link = db.prepare('UPDATE order_items SET shipment_id=? WHERE id=?')
            for (const oiId of oiIds) link.run(shipmentId, oiId)
          }
        }
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='envois'`).run()
    })(records)
    console.log(`🚚 Envois: ${imported} importés, ${updated} mis à jour${echoed ? `, ${echoed} echos ignorés` : ''}`)
    if (!changes) {
      purgeOrphans('shipments', records)
      await syncDynamicFields('envois', 'shipments', config.base_id, config.table_id, fieldMap, records)
    } else {
      await updateDynamicFields('shipments', fieldMap, records)
    }
    await evaluateFieldRules({ erpTable: 'shipments', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Envois sync:', e.message) }
}

export async function syncBillets(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='billets'").get()
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Billets config missing'); return }

  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM tickets WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'billets', _recordIds)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    db.transaction((recs) => {
      for (const rec of recs) {
        if (rec.fields) {
          const autoMap = {
            title:            autoMapField(rec.fields, 'titre', 'title', 'sujet', 'subject', 'nom'),
            description:      autoMapField(rec.fields, 'description', 'détails', 'details'),
            response:         autoMapField(rec.fields, 'réponse', 'reponse', 'response', 'answer'),
            type:             autoMapField(rec.fields, 'type', 'catégorie', 'categorie'),
            status:           autoMapField(rec.fields, 'statut', 'status', 'état'),
            company:          autoMapField(rec.fields, 'entreprise', 'company', 'client', 'compte'),
            contact:          autoMapField(rec.fields, 'contact', 'personne'),
            duration_minutes: autoMapField(rec.fields, 'durée', 'duree', 'duration', 'minutes', 'temps'),
            created_at:       autoMapField(rec.fields, 'date de création', 'date creation', 'created', 'créé le', 'cree le', 'date'),
          }
          if (!fieldMap) fieldMap = autoMap
          else for (const k of Object.keys(autoMap)) {
            if (!fieldMap[k] && autoMap[k]) fieldMap[k] = autoMap[k]
          }
        }

        const title = getVal(rec.fields, fieldMap?.title)
        if (!title) continue

        const FALLBACK_STATUS_MAP = {
          'waiting on us': 'Waiting on us', 'en attente nous': 'Waiting on us', 'en cours': 'Waiting on us', 'ouvert': 'Waiting on us', 'open': 'Waiting on us',
          'waiting on them': 'Waiting on them', 'en attente client': 'Waiting on them', 'waiting client': 'Waiting on them',
          'closed': 'Closed', 'fermé': 'Closed', 'ferme': 'Closed', 'résolu': 'Closed', 'resolu': 'Closed',
        }
        const rawStatus = (getVal(rec.fields, fieldMap?.status) || '').trim()
        let status
        if (!rawStatus) {
          status = 'Closed'
        } else if (fieldMap?.status_map && fieldMap.status_map[rawStatus]) {
          status = fieldMap.status_map[rawStatus]
        } else {
          status = FALLBACK_STATUS_MAP[rawStatus.toLowerCase()] || rawStatus
        }

        const TYPE_MAP = {
          'aide software': 'Aide software', 'defect software': 'Defect software',
          'aide hardware': 'Aide hardware', 'defect hardware': 'Defect hardware',
          'erreur de commande': 'Erreur de commande', 'formation': 'Formation', 'installation': 'Installation',
        }
        const rawType = (getVal(rec.fields, fieldMap?.type) || '').trim()
        const type = TYPE_MAP[rawType.toLowerCase()] || rawType || null

        function toInt(fieldKey) {
          const raw = fieldKey ? rec.fields[fieldKey] : null
          const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
          return isNaN(n) ? null : Math.round(n)
        }

        const companyId = lookupCompany(rec.fields, fieldMap?.company)

        // Contact lookup via linked record or name
        let contactId = null
        if (fieldMap?.contact) {
          const raw = rec.fields[fieldMap.contact]
          const linkedId = Array.isArray(raw) ? raw[0] : null
          if (linkedId) {
            const ct = db.prepare('SELECT id FROM contacts WHERE airtable_id=? LIMIT 1').get(linkedId)
            contactId = ct?.id || null
          }
          if (!contactId) {
            const name = Array.isArray(raw) ? null : getVal(rec.fields, fieldMap.contact)
            if (name) {
              const ct = db.prepare("SELECT id FROM contacts WHERE (first_name || ' ' || last_name) LIKE ? LIMIT 1").get(`%${name}%`)
              contactId = ct?.id || null
            }
          }
        }

        // Date de création: champ Airtable mappé, sinon createdTime du record Airtable
        const rawCreatedAt = getVal(rec.fields, fieldMap?.created_at) || rec.createdTime || null
        const createdAt = rawCreatedAt ? new Date(rawCreatedAt).toISOString() : null

        const payload = {
          title, status, type,
          description:      getVal(rec.fields, fieldMap?.description),
          response:         getVal(rec.fields, fieldMap?.response),
          duration_minutes: toInt(fieldMap?.duration_minutes) ?? 0,
          company_id:       companyId,
          contact_id:       contactId,
          created_at:       createdAt,
        }

        const result = upsertRecord('tickets', rec.id, payload)
        if (result === 'updated') updated++
        else imported++
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='billets'`).run()
    })(records)
    console.log(`🎫 Billets: ${imported} importés, ${updated} mis à jour`)
    if (!changes) purgeOrphans('tickets', records)

    // Auto-sync dynamic fields (all Airtable fields not in hardcoded map)
    if (!changes) {
      await syncDynamicFields('billets', 'tickets', config.base_id, config.table_id, fieldMap, records)
    } else {
      await updateDynamicFields('tickets', fieldMap, records)
    }

    await evaluateFieldRules({ erpTable: 'tickets', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Billets sync:', e.message) }
}

/**
 * Prospects Instagram — sync Airtable → ERP VOLONTAIREMENT PARTIELLE.
 *
 * L'ERP est la source de vérité : la fiche est créée par l'appel de ManyChat, pas
 * par Airtable. Trois écarts assumés par rapport aux autres modules :
 *
 *  • AUCUNE CRÉATION — un record Airtable sans contrepartie ERP est ignoré. Une
 *    ligne ajoutée à la main par Philippe n'a ni IGSID ni nom d'usager fiable,
 *    donc aucune clé de dédup : l'importer polluerait la liste et pourrait faire
 *    envoyer un DM à un fantôme.
 *  • PAS DE purgeOrphans — c'est un DELETE dur. Une ligne supprimée dans Airtable
 *    ne doit ni effacer un prospect capté, ni faire perdre la mémoire du DM déjà
 *    envoyé (ce qui rouvrirait la porte à un second contact).
 *  • CHAMPS RESTREINTS — seuls follow_up_status et notes remontent. Tous les
 *    autres champs sont poussés par le système (cf. airtable_field_directions).
 */
export async function syncInstagramProspects(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='instagram'").get()
  if (!config?.base_id || !config?.table_id) return

  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'instagram', _recordIds)
    const fieldMap = config.field_map ? JSON.parse(config.field_map) : {}
    let updated = 0, ignored = 0

    db.transaction((recs) => {
      for (const rec of recs) {
        const existingRow = db.prepare('SELECT id, contacted, contacted_at FROM instagram_prospects WHERE airtable_id=? AND deleted_at IS NULL').get(rec.id)
        if (!existingRow) { ignored++; continue }
        // Nos propres écritures reviennent par le webhook Airtable : les ignorer.
        if (consumeWritebackEcho(rec.id, rec.fields)) continue

        const payload = {}
        for (const key of ['follow_up_status', 'notes', 'contacted']) {
          if (fieldMapDirection('instagram', key) === 'push') continue
          const atField = fieldMap[key]
          if (!atField) continue
          const val = getVal(rec.fields, atField)
          if (val === undefined) continue
          // La case « Contacté » revient en booléen ; better-sqlite3 refuse les
          // booléens et la colonne est un INTEGER. On horodate au passage pour
          // que la coche faite dans Airtable soit datée comme celle de l'ERP.
          if (key === 'contacted') {
            payload.contacted = val === true || val === 1 || val === '1' ? 1 : 0
            if (payload.contacted && !existingRow?.contacted_at) payload.contacted_at = new Date().toISOString()
            if (!payload.contacted) payload.contacted_at = null
            continue
          }
          payload[key] = val === '' ? null : val
        }
        if (!Object.keys(payload).length) continue

        upsertRecord('instagram_prospects', rec.id, payload)
        updated++
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='instagram'`).run()
    })(records)

    console.log(`📸 Prospects Instagram: ${updated} suivi(s) mis à jour${ignored ? `, ${ignored} record(s) Airtable sans fiche ERP ignoré(s)` : ''}`)
  } catch (e) { console.error('❌ Instagram prospects sync:', e.message) }
}

// Sentinel thrown by upsertProjectRecord when a project links to a company that
// isn't imported in ERP yet. The caller catches it, syncs the missing companies,
// then retries — instead of importing the project as a company-less orphan.
const DEFER_MISSING_COMPANY = 'DEFER_MISSING_COMPANY'

// Upsert a single Airtable record into `projects`.
// Returns 'imported' | 'updated' | 'skipped'. Throws on DB constraint.
// When the record links to a company not yet imported and !allowMissingCompany,
// throws DEFER_MISSING_COMPANY so the caller can sync companies first and retry.
function upsertProjectRecord(rec, fmap, frozenSet, allowMissingCompany = false) {
  const name = getVal(rec.fields, fmap?.name)
  if (!name) return 'skipped'

  // Status: use user-defined choices map, fallback to Oui/Non legacy
  const rawStatus = (getVal(rec.fields, fmap?.status) || '').trim()
  const STATUS_CHOICES = fmap?.status_choices || { 'Oui': 'Gagné', 'Non': 'Perdu' }
  const status = STATUS_CHOICES[rawStatus] || 'Ouvert'

  // Type: use user-defined choices map, fallback to exact match
  const rawType = getVal(rec.fields, fmap?.type) || ''
  const validTypes = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']
  const TYPE_CHOICES = fmap?.type_choices || {}
  const type = TYPE_CHOICES[rawType] || validTypes.find(t => t.toLowerCase() === rawType.toLowerCase()) || null

  // Company lookup. If the Airtable record links a company (linked-record id)
  // that ERP hasn't imported yet, defer rather than insert an orphan.
  const companyLink = fmap?.company ? rec.fields?.[fmap.company] : undefined
  const companyLinked = Array.isArray(companyLink) ? companyLink.find(v => typeof v === 'string') : null
  const companyId = lookupCompany(rec.fields, fmap?.company)
  if (!allowMissingCompany && companyLinked && !companyId) {
    const err = new Error(DEFER_MISSING_COMPANY)
    err.code = DEFER_MISSING_COMPANY
    throw err
  }

  const toFloat = (fieldKey) => {
    const raw = fieldKey ? rec.fields[fieldKey] : null
    const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
    return isNaN(n) ? null : n
  }
  const toInt = (fieldKey) => {
    const raw = fieldKey ? rec.fields[fieldKey] : null
    const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
    return isNaN(n) ? null : Math.round(n)
  }

  const valueCad = toFloat(fmap?.value_cad)
  // Airtable percent fields are stored as decimals (0.30 = 30%) — multiply by 100 if ≤ 1
  const rawProb = fmap?.probability ? rec.fields[fmap.probability] : null
  const probFloat = parseFloat(String(rawProb ?? ''))
  const probability = isNaN(probFloat) ? null : Math.round(probFloat > 1 ? probFloat : probFloat * 100)
  const monthlyCad = toFloat(fmap?.monthly_cad)
  const nbGreenhouses = toInt(fmap?.nb_greenhouses)
  const closeDate = getVal(rec.fields, fmap?.close_date)
  const notes = getVal(rec.fields, fmap?.notes)

  const existing = db.prepare('SELECT id FROM projects WHERE airtable_id=?').get(rec.id)
  const allPairs = [
    ['name', name],
    ['company_id', companyId],
    ['status', status],
    ['type', type],
    ['value_cad', valueCad],
    ['probability', probability],
    ['monthly_cad', monthlyCad],
    ['nb_greenhouses', nbGreenhouses],
    ['close_date', closeDate],
    ['notes', notes],
  ]
  // Colonnes dont la valeur dérivée d'un champ NON mappé serait destructrice à
  // l'UPDATE : sans mapping `status`, rawStatus='' → 'Ouvert' blanchissait tous
  // les Gagné/Perdu à chaque sync (le graphique « Taux de closing » du dashboard
  // se vidait). Idem close_date → null. On ne les écrit que si le champ est mappé.
  const unmappedDerived = new Set()
  if (!fmap?.status) unmappedDerived.add('status')
  if (!fmap?.close_date) unmappedDerived.add('close_date')
  // Idem probability : « Probabilité » n'est pas dans le field_map hardcodé (elle
  // est importée par le mapping dynamique, cf. airtableAutoSync). Sans ce garde-fou
  // chaque passe écrivait probability=NULL avant que la passe dynamique ne la
  // réécrive — et une désactivation de l'import du champ l'effaçait pour de bon.
  if (!fmap?.probability) unmappedDerived.add('probability')
  // Idem pour company_id : « Client final » est vide dans Airtable sur une partie
  // des projets (et la 2e passe, allowMissingCompany=true, laisse passer un lien
  // vers une entreprise absente de l'ERP). Écrire null effaçait alors l'entreprise
  // du projet à chaque sync — y compris celle saisie à la main dans l'ERP, qui
  // « disparaissait » de la fiche. On n'écrit company_id que si on a résolu une
  // entreprise ; le délier se fait depuis l'ERP.
  if (!companyId) unmappedDerived.add('company_id')
  if (existing) {
    const writable = allPairs.filter(([c]) => !frozenSet.has(c) && !unmappedDerived.has(c))
    if (!writable.length) return 'skipped'
    const setClause = writable.map(([c]) => `${c}=?`).join(', ')
    db.prepare(`UPDATE projects SET ${setClause}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(...writable.map(([, v]) => v), existing.id)
    return 'updated'
  }
  db.prepare('INSERT INTO projects (id, name, company_id, status, type, value_cad, probability, monthly_cad, nb_greenhouses, close_date, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(uuid(), name, companyId, status, type, valueCad, probability, monthlyCad, nbGreenhouses, closeDate, notes, rec.id)
  return 'imported'
}

// Retry project records deferred during the first pass: sync the companies they
// reference (the missing dependency) then re-upsert them. On this second pass a
// still-missing company no longer blocks the import (the project is created with
// a null company_id rather than being lost indefinitely).
// Returns { imported, updated, stillDeferred }.
async function retryDeferredProjects(deferredMain, deferredExtra, mainFieldMap, frozenSet) {
  const crm = db.prepare('SELECT base_id, companies_table_id FROM airtable_sync_config').get()
  const missingCompanyIds = new Set()
  const collect = (rec, fmap) => {
    const link = fmap?.company ? rec.fields?.[fmap.company] : undefined
    if (!Array.isArray(link)) return
    for (const v of link) {
      if (typeof v !== 'string') continue
      const exists = db.prepare('SELECT 1 FROM companies WHERE airtable_id=? LIMIT 1').get(v)
      if (!exists) missingCompanyIds.add(v)
    }
  }
  for (const rec of deferredMain) collect(rec, mainFieldMap)
  for (const { rec, fmap } of deferredExtra) collect(rec, fmap)

  // Sync the missing companies first (the dependency), then retry.
  if (crm?.companies_table_id && missingCompanyIds.size) {
    try {
      console.log(`🔗 Projets: ${missingCompanyIds.size} entreprise(s) liée(s) manquante(s) — sync companies avant retry`)
      await syncAirtable({
        [crm.companies_table_id]: {
          recordIds: [...missingCompanyIds],
          destroyedIds: [],
          changedFieldIds: [],
          hasCreates: false,
        },
      })
    } catch (e) {
      console.error('❌ Projets: sync de la dépendance companies échoué:', e.message)
    }
  }

  let imported = 0, updated = 0, stillDeferred = 0
  // Same savepoint isolation as the first pass: a record still failing its FK
  // (company unresolvable even after syncing the dependency) rolls back only
  // itself, so the other recovered projects still commit.
  const upsertOne = db.transaction((rec, fmap) =>
    upsertProjectRecord(rec, fmap, frozenSet, true))
  const retryPass = db.transaction(() => {
    const retryOne = (rec, fmap, isExtra) => {
      try {
        const action = upsertOne(rec, fmap)
        if (action === 'imported') imported++
        else if (action === 'updated') updated++
      } catch (e) {
        stillDeferred++
        console.error(`⚠️  Projets${isExtra ? ' (table extra)' : ''}: record ${rec.id} toujours en échec après sync des dépendances — ${e.message}`)
      }
    }
    for (const rec of deferredMain) retryOne(rec, mainFieldMap, false)
    for (const { rec, fmap } of deferredExtra) retryOne(rec, fmap, true)
  })
  retryPass()

  const recovered = imported + updated
  if (recovered) console.log(`🔁 Projets: ${recovered} record(s) ré-importé(s)/mis à jour après sync des dépendances (${imported} importés, ${updated} mis à jour)`)
  if (stillDeferred) console.warn(`⚠️  Projets: ${stillDeferred} record(s) encore en échec après retry`)
  return { imported, updated, stillDeferred }
}

export async function syncProjets(changes = null) {
  const config = db.prepare('SELECT * FROM airtable_projets_config').get()
  if (!config?.base_id || !config?.projects_table_id) { console.log('⚠️  Projets config missing'); return }

  // Deletes — main table + extra tables all map to `projects`
  if (changes) {
    const allTableIds = [config.projects_table_id]
    const extraTables0 = config.extra_tables ? JSON.parse(config.extra_tables) : []
    for (const e of extraTables0) if (e.table_id) allTableIds.push(e.table_id)
    for (const tid of allTableIds) {
      if (changes[tid]?.destroyedIds?.length) {
        for (const id of changes[tid].destroyedIds) {
          try {
            db.prepare('DELETE FROM projects WHERE airtable_id=?').run(id)
          } catch (e) {
            // FK constraint (projet encore référencé par une commande/soumission/facture) :
            // ne pas tuer tout le module — logger le record fautif et différer sa suppression.
            const proj = db.prepare('SELECT id, name FROM projects WHERE airtable_id=?').get(id)
            const refs = proj ? describeProjectReferences(proj.id) : ''
            console.error(`⚠️  Projets: suppression différée du projet ${id}${proj ? ` ("${proj.name}")` : ''} — ${e.message}${refs ? ` ; encore référencé par ${refs}` : ''}`)
          }
        }
      }
    }
    // Skip entirely if no records to process in any projets table
    const hasRecords = allTableIds.some(tid => changes[tid]?.recordIds?.length)
    if (!hasRecords) return
  }

  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const _projIds = changes?.[config.projects_table_id]?.recordIds
    const records = await fetchAllRecords(config.base_id, config.projects_table_id, accessToken, 'projets', _projIds)
    let fieldMap = config.field_map_projects ? JSON.parse(config.field_map_projects) : null
    let imported = 0, updated = 0

    // Fetch extra table records before the sync transaction (async)
    const extraTables = config.extra_tables ? JSON.parse(config.extra_tables) : []
    const extraTableData = []
    for (const extra of extraTables) {
      if (!extra.table_id) continue
      const _extraIds = changes?.[extra.table_id]?.recordIds
      if (changes && !_extraIds?.length) continue
      const extraRecords = await fetchAllRecords(config.base_id, extra.table_id, accessToken, 'projets', _extraIds)
      extraTableData.push({ extra, extraRecords })
    }

    const frozenProjects = getFrozenColumns('projects')

    // Pass 1: upsert every record. Any record that references a not-yet-imported
    // company — or that hits a DB constraint — is collected for a second pass run
    // AFTER its dependency (companies) is synced. This is the root-cause fix: the
    // webhook can dispatch 'Projets' before 'Companies', and without this the
    // project would be imported as a company-less orphan (or fail the FK).
    const deferredMain = []
    const deferredExtra = []

    // Each record upserts inside its own SAVEPOINT (a nested db.transaction
    // compiles to SAVEPOINT/RELEASE/ROLLBACK TO). A FK/CHECK failure on one
    // orphan (e.g. company_id pointing to a not-yet-synced companies row) rolls
    // back only that record's writes — the surrounding batch transaction stays
    // open and the valid projects still commit.
    const upsertOne = db.transaction((rec, fmap, allowMissing) =>
      upsertProjectRecord(rec, fmap, frozenProjects, allowMissing))

    const runPass = db.transaction(() => {
      for (const rec of records) {
        if (!fieldMap && rec.fields) {
          fieldMap = {
            name:           autoMapField(rec.fields, 'name', 'nom', 'projet', 'project') || Object.keys(rec.fields)[0],
            company:        autoMapField(rec.fields, 'company', 'entreprise', 'client', 'compte'),
            status:         autoMapField(rec.fields, 'status', 'statut', 'état', 'etat', 'stage'),
            type:           autoMapField(rec.fields, 'type', 'type de projet', 'catégorie', 'categorie'),
            value_cad:      autoMapField(rec.fields, 'valeur', 'value', 'montant', 'valeur cad', 'amount'),
            probability:    autoMapField(rec.fields, 'probabilité', 'probabilite', 'probability', 'prob'),
            monthly_cad:    autoMapField(rec.fields, 'mrr', 'mensuel', 'monthly', 'récurrent', 'recurrent'),
            nb_greenhouses: autoMapField(rec.fields, 'nb serres', 'serres', 'greenhouses', 'nombre serres'),
            close_date:     autoMapField(rec.fields, 'close date', 'date fermeture', 'date de clôture', 'closing date'),
            notes:          autoMapField(rec.fields, 'notes', 'description', 'commentaires'),
          }
        }
        try {
          const action = upsertOne(rec, fieldMap, false)
          if (action === 'imported') imported++
          else if (action === 'updated') updated++
        } catch (e) {
          // Constraint (FK company_id, CHECK…) or missing-company on a single record
          // must not abort the whole batch — its savepoint rolled back; defer it and continue.
          deferredMain.push(rec)
          if (e.code !== DEFER_MISSING_COMPANY) {
            const companyVal = fieldMap?.company ? rec.fields?.[fieldMap.company] : undefined
            console.error(`⚠️  Projets: record ${rec.id} différé — ${e.message}${companyVal !== undefined ? ` ; ${fieldMap.company}=${JSON.stringify(companyVal)}` : ''}`)
          }
        }
      }

      // Sync extra tables (additional Airtable tables mapped to projects)
      for (const { extra, extraRecords } of extraTableData) {
        const extraFieldMap = extra.field_map || {}
        for (const rec of extraRecords) {
          try {
            const action = upsertOne(rec, extraFieldMap, false)
            if (action === 'imported') imported++
            else if (action === 'updated') updated++
          } catch (e) {
            deferredExtra.push({ rec, fmap: extraFieldMap })
            if (e.code !== DEFER_MISSING_COMPANY) {
              const companyVal = extraFieldMap.company ? rec.fields?.[extraFieldMap.company] : undefined
              console.error(`⚠️  Projets (table extra): record ${rec.id} différé — ${e.message}${companyVal !== undefined ? ` ; ${extraFieldMap.company}=${JSON.stringify(companyVal)}` : ''}`)
            }
          }
        }
      }

      db.prepare(`UPDATE airtable_projets_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run()
    })
    runPass()

    // Pass 2: re-process deferred records after syncing their missing company deps.
    if (deferredMain.length || deferredExtra.length) {
      const r = await retryDeferredProjects(deferredMain, deferredExtra, fieldMap, frozenProjects)
      imported += r.imported
      updated += r.updated
    }
    console.log(`📋 Inventaire: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      const allRecords = [...records]
      for (const { extraRecords } of extraTableData) allRecords.push(...extraRecords)
      purgeOrphans('projects', allRecords)
    }

    // Auto-sync dynamic fields (all Airtable fields not in hardcoded map)
    if (!changes) {
      await syncDynamicFields('projets', 'projects', config.base_id, config.projects_table_id, fieldMap, records)
    } else {
      await updateDynamicFields('projects', fieldMap, records)
    }
    await evaluateFieldRules({ erpTable: 'projects', tableId: config.projects_table_id, changes })
  } catch (e) { console.error('❌ Inventaire sync:', e.message) }
}

// ── helper used by multiple sync functions
function lookupSerial(airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM serial_numbers WHERE airtable_id=? LIMIT 1').get(airtableId)?.id || null
}
function lookupProject(airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM projects WHERE airtable_id=? LIMIT 1').get(airtableId)?.id || null
}
function lookupProduct(airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM products WHERE airtable_id=? LIMIT 1').get(airtableId)?.id || null
}
function lookupContact(airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM contacts WHERE airtable_id=? LIMIT 1').get(airtableId)?.id || null
}
function firstLinked(fields, fieldName) {
  if (!fieldName || !(fieldName in fields)) return null
  const v = fields[fieldName]
  return Array.isArray(v) ? (v[0] || null) : (typeof v === 'string' ? v : null)
}

// Derive customer currency from a country/region code (shipping address).
// Defaults to CAD when unknown.
export function currencyFromCountry(country) {
  if (!country) return 'CAD'
  const c = String(country).trim().toUpperCase()
  if (c === 'US' || c === 'USA' || c === 'UNITED STATES' || c === 'ÉTATS-UNIS' || c === 'ETATS-UNIS') return 'USD'
  if (c === 'FR' || c === 'FRANCE' || c === 'BE' || c === 'BELGIUM' || c === 'BELGIQUE' || c === 'DE' || c === 'GERMANY' || c === 'ALLEMAGNE') return 'EUR'
  if (c === 'UK' || c === 'GB' || c === 'UNITED KINGDOM' || c === 'ROYAUME-UNI') return 'GBP'
  return 'CAD'
}

export async function syncSoumissions(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='soumissions'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM soumissions WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'soumissions', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    const touchedProjects = new Set()
    const getCurrencyStmt = db.prepare(`
      SELECT co.pays_de_livraison AS pays
      FROM projects p LEFT JOIN companies co ON co.id = p.company_id
      WHERE p.id = ?
    `)
    db.transaction((recs) => {
      for (const rec of recs) {
        const projectAirtableId = firstLinked(rec.fields, fm.project)
        const projectId = lookupProject(projectAirtableId)
        const quoteUrl = getVal(rec.fields, fm.quote_url)
        const purchasePrice = parseFloat(String(rec.fields[fm.purchase_price] ?? 0).replace(/[^0-9.-]/g, '')) || 0
        const subscriptionPrice = parseFloat(String(rec.fields[fm.subscription_price] ?? 0).replace(/[^0-9.-]/g, '')) || 0
        const expirationDate = getVal(rec.fields, fm.expiration_date)
        // pdf_url from attachment
        let pdfUrl = null
        if (fm.pdf) {
          const atts = rec.fields[fm.pdf]
          if (Array.isArray(atts) && atts.length > 0) pdfUrl = atts[0].url || null
        }
        const pays = projectId ? (getCurrencyStmt.get(projectId)?.pays || null) : null
        const currency = currencyFromCountry(pays)
        const existing = db.prepare('SELECT id FROM soumissions WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE soumissions SET project_id=?, quote_url=?, pdf_url=?, purchase_price=?, subscription_price=?, currency=?, expiration_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(projectId, quoteUrl, pdfUrl, purchasePrice, subscriptionPrice, currency, expirationDate, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO soumissions (id, airtable_id, project_id, quote_url, pdf_url, purchase_price, subscription_price, currency, expiration_date) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(uuid(), rec.id, projectId, quoteUrl, pdfUrl, purchasePrice, subscriptionPrice, currency, expirationDate)
          imported++
        }
        if (projectId) touchedProjects.add(projectId)
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='soumissions'").run()
    })(records)
    console.log(`📝 Soumissions: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('soumissions', records)
      await syncDynamicFields('soumissions', 'soumissions', config.base_id, config.table_id, fm, records)
    } else {
      await updateDynamicFields('soumissions', fm, records)
    }
    // Recompute projects.valeur_cad_calc for every project whose soumissions
    // were touched by this sync (uses Bank of Canada FX for USD conversions).
    if (touchedProjects.size > 0) {
      const { recomputeProjectValeurCad } = await import('./projectValeur.js')
      let ok = 0
      for (const pid of touchedProjects) {
        try { await recomputeProjectValeurCad(pid); ok++ } catch (e) { console.error('[valeur_cad_calc]', pid, e.message) }
      }
      console.log(`💱 valeur_cad_calc: ${ok}/${touchedProjects.size} projets recalculés`)
    }
    await evaluateFieldRules({ erpTable: 'soumissions', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Soumissions sync:', e.message) }
}

export async function syncRetours(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='retours'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM returns WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'retours', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const companyId = lookupCompany(rec.fields, fm.company)
        const contactId = lookupContact(firstLinked(rec.fields, fm.contact))
        const returnNumber = getVal(rec.fields, fm.return_number)
        const status = getVal(rec.fields, fm.status) || 'Ouvert'
        const problemStatus = getVal(rec.fields, fm.problem_status)
        const processingStatus = getVal(rec.fields, fm.processing_status)
        const trackingNumber = getVal(rec.fields, fm.tracking_number)
        const notes = getVal(rec.fields, fm.notes)
        const billedAt = getVal(rec.fields, fm.billed_at)
        const existing = db.prepare('SELECT id FROM returns WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE returns SET company_id=?, contact_id=?, return_number=?, status=?, problem_status=?, processing_status=?, tracking_number=?, notes=?, billed_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(companyId, contactId, returnNumber, status, problemStatus, processingStatus, trackingNumber, notes, billedAt, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO returns (id, airtable_id, company_id, contact_id, return_number, status, problem_status, processing_status, tracking_number, notes, billed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), rec.id, companyId, contactId, returnNumber, status, problemStatus, processingStatus, trackingNumber, notes, billedAt)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='retours'").run()
    })(records)
    console.log(`↩️ Retours: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      purgeOrphans('returns', records)
      await syncDynamicFields('retours', 'returns', config.base_id, config.table_id, fm, records)
    } else {
      await updateDynamicFields('returns', fm, records)
    }
    await evaluateFieldRules({ erpTable: 'returns', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Retours sync:', e.message) }
}

export async function syncRetourItems(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='retour_items'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM return_items WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'retour_items', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const retourAirtableId = firstLinked(rec.fields, fm.return)
        const retour = retourAirtableId ? db.prepare('SELECT id FROM returns WHERE airtable_id=?').get(retourAirtableId) : null
        if (!retour) continue
        const productId = lookupProduct(firstLinked(rec.fields, fm.product_to_receive))
        const productSendId = lookupProduct(firstLinked(rec.fields, fm.product_to_send))
        const serialId = lookupSerial(firstLinked(rec.fields, fm.serial))
        const companyId = lookupCompany(rec.fields, fm.company)
        const problemCategory = getVal(rec.fields, fm.problem_category)
        const returnReason = getVal(rec.fields, fm.return_reason)
        const returnReasonNotes = getVal(rec.fields, fm.return_reason_notes)
        const action = getVal(rec.fields, fm.action)
        const receivedAt = getVal(rec.fields, fm.received_at)
        const receivedBy = getVal(rec.fields, fm.received_by)
        const analysisNotes = getVal(rec.fields, fm.analysis_notes)
        const analyzedBy = getVal(rec.fields, fm.analyzed_by)
        const existing = db.prepare('SELECT id FROM return_items WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare('UPDATE return_items SET return_id=?, product_id=?, product_send_id=?, serial_id=?, company_id=?, problem_category=?, return_reason=?, return_reason_notes=?, action=?, received_at=?, received_by=?, analysis_notes=?, analyzed_by=? WHERE id=?')
            .run(retour.id, productId, productSendId, serialId, companyId, problemCategory, returnReason, returnReasonNotes, action, receivedAt, receivedBy, analysisNotes, analyzedBy, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO return_items (id, return_id, airtable_id, product_id, product_send_id, serial_id, company_id, problem_category, return_reason, return_reason_notes, action, received_at, received_by, analysis_notes, analyzed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), retour.id, rec.id, productId, productSendId, serialId, companyId, problemCategory, returnReason, returnReasonNotes, action, receivedAt, receivedBy, analysisNotes, analyzedBy)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='retour_items'").run()
    })(records)
    console.log(`📦 Retour items: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      purgeOrphans('return_items', records)
      await syncDynamicFields('retour_items', 'return_items', config.base_id, config.table_id, fm, records)
    } else {
      await updateDynamicFields('return_items', fm, records)
    }
  } catch (e) { console.error('❌ Retour items sync:', e.message) }
}

export async function syncAdresses(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='adresses'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM adresses WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'adresses', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const companyId = lookupCompany(rec.fields, fm.company)
        const contactId = lookupContact(firstLinked(rec.fields, fm.contact))
        const line1 = getVal(rec.fields, fm.line1)
        const city = getVal(rec.fields, fm.city)
        const province = getVal(rec.fields, fm.province)
        const postalCode = getVal(rec.fields, fm.postal_code)
        const country = getVal(rec.fields, fm.country)
        const language = getVal(rec.fields, fm.language)
        const addressType = getVal(rec.fields, fm.address_type)
        const existing = db.prepare('SELECT id FROM adresses WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE adresses SET company_id=?, contact_id=?, line1=?, city=?, province=?, postal_code=?, country=?, language=?, address_type=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(companyId, contactId, line1, city, province, postalCode, country, language, addressType, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO adresses (id, airtable_id, company_id, contact_id, line1, city, province, postal_code, country, language, address_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), rec.id, companyId, contactId, line1, city, province, postalCode, country, language, addressType)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='adresses'").run()
    })(records)
    console.log(`📍 Adresses: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('adresses', records)
      await syncDynamicFields('adresses', 'adresses', config.base_id, config.table_id, fm, records)
    } else {
      await updateDynamicFields('adresses', fm, records)
    }
    await evaluateFieldRules({ erpTable: 'adresses', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Adresses sync:', e.message) }
}

export async function syncBomItems(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='bom'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM bom_items WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'bom', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const productId = lookupProduct(firstLinked(rec.fields, fm.product))
        const componentId = lookupProduct(firstLinked(rec.fields, fm.component))
        if (!productId && !componentId) continue
        const qtyRequired = parseFloat(String(rec.fields[fm.qty_required] ?? 1).replace(/[^0-9.-]/g, '')) || 1
        const refDes = getVal(rec.fields, fm.ref_des)
        const existing = db.prepare('SELECT id FROM bom_items WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE bom_items SET product_id=?, component_id=?, qty_required=?, ref_des=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(productId, componentId, qtyRequired, refDes, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO bom_items (id, airtable_id, product_id, component_id, qty_required, ref_des) VALUES (?,?,?,?,?,?)')
            .run(uuid(), rec.id, productId, componentId, qtyRequired, refDes)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='bom'").run()
    })(records)
    console.log(`🔩 BOM items: ${imported} importés, ${updated} mis à jour`)
    if (!changes) purgeOrphans('bom_items', records)
  } catch (e) { console.error('❌ BOM sync:', e.message) }
}

export async function syncSerialStateChanges(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='serial_changes'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM serial_state_changes WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'serial_changes', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const serialId = lookupSerial(firstLinked(rec.fields, fm.serial))
        const previousStatus = getVal(rec.fields, fm.previous_status)
        const newStatus = getVal(rec.fields, fm.new_status)
        const changedAt = getVal(rec.fields, fm.changed_at)
        const existing = db.prepare('SELECT id FROM serial_state_changes WHERE airtable_id=?').get(rec.id)
        if (!existing) {
          db.prepare('INSERT INTO serial_state_changes (id, airtable_id, serial_id, previous_status, new_status, changed_at) VALUES (?,?,?,?,?,?)')
            .run(uuid(), rec.id, serialId, previousStatus, newStatus, changedAt)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='serial_changes'").run()
    })(records)
    console.log(`🔄 Serial state changes: ${imported} importés`)
    await syncDynamicFields('serial_changes', 'serial_state_changes', config.base_id, config.table_id, fm, records)
    if (!changes) purgeOrphans('serial_state_changes', records)
  } catch (e) { console.error('❌ Serial changes sync:', e.message) }
}


export async function syncStockMovements(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='stock_movements'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM stock_movements WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'stock_movements', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0, skipped = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const productId = lookupProduct(firstLinked(rec.fields, fm.product))
        if (!productId) { skipped++; continue }
        const rawQty = parseFloat(String(rec.fields[fm.qty_change] ?? 0)) || 0
        const atType = getVal(rec.fields, fm.type) || ''
        let type
        if (/ajustement/i.test(atType)) type = 'adjustment'
        else if (rawQty >= 0) type = 'in'
        else type = 'out'
        const qty = Math.round(Math.abs(rawQty))
        const unitCost = parseFloat(String(rec.fields[fm.unit_cost] ?? '')) || null
        const movementValue = parseFloat(String(rec.fields[fm.movement_value] ?? '')) || null
        const occurredAt = getVal(rec.fields, fm.occurred_at) || rec.createdTime || null
        const existing = db.prepare('SELECT id FROM stock_movements WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE stock_movements SET product_id=?, type=?, qty=?, reason=?, unit_cost=?, movement_value=?, created_at=? WHERE id=?`)
            .run(productId, type, qty, atType || null, unitCost, movementValue, occurredAt, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO stock_movements (id, airtable_id, product_id, type, qty, reason, unit_cost, movement_value, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(uuid(), rec.id, productId, type, qty, atType || null, unitCost, movementValue, occurredAt)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='stock_movements'").run()
    })(records)
    console.log(`📦 Mouvements d'inventaire: ${imported} importés, ${updated} mis à jour, ${skipped} sautés (produit inconnu)`)
    if (!changes) purgeOrphans('stock_movements', records)
  } catch (e) { console.error('❌ Stock movements sync:', e.message) }
}

export async function syncAssemblages(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='assemblages'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM assemblages WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'assemblages', _recordIds)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const productId = lookupProduct(firstLinked(rec.fields, fm.product))
        const qtyProduced = parseInt(String(rec.fields[fm.qty_produced] ?? 0)) || 0
        const assembledAt = getVal(rec.fields, fm.assembled_at)
        const assemblyPoints = parseInt(String(rec.fields[fm.assembly_points] ?? 0)) || 0
        const existing = db.prepare('SELECT id FROM assemblages WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE assemblages SET product_id=?, qty_produced=?, assembled_at=?, assembly_points=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(productId, qtyProduced, assembledAt, assemblyPoints, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO assemblages (id, airtable_id, product_id, qty_produced, assembled_at, assembly_points) VALUES (?,?,?,?,?,?)')
            .run(uuid(), rec.id, productId, qtyProduced, assembledAt, assemblyPoints)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='assemblages'").run()
    })(records)
    console.log(`🔨 Assemblages: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      purgeOrphans('assemblages', records)
      await syncDynamicFields('assemblages', 'assemblages', config.base_id, config.table_id, fm, records)
    } else {
      await updateDynamicFields('assemblages', fm, records)
    }
    await evaluateFieldRules({ erpTable: 'assemblages', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Assemblages sync:', e.message) }
}

function empBool(fields, name) {
  if (!name || !(name in fields)) return 0
  const v = fields[name]
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0
}
function empNum(fields, name) {
  if (!name || !(name in fields)) return null
  const v = fields[name]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function syncEmployees(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='employees'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM employees WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'employees', _recordIds)
    // Airtable omits unchecked checkboxes and empty cells per-record, so we must
    // build the auto-map against the union of field names seen across ALL records.
    const fieldUnion = {}
    for (const rec of records) {
      if (rec.fields) for (const k of Object.keys(rec.fields)) fieldUnion[k] = true
    }
    let fm = config.field_map ? JSON.parse(config.field_map) : null
    if (!fm) {
      fm = {
        first_name:     autoMapField(fieldUnion, 'first name', 'prénom', 'prenom', 'firstname'),
        last_name:      autoMapField(fieldUnion, 'last name', 'nom', 'nom de famille', 'lastname', 'surname'),
        email_work:     autoMapField(fieldUnion, 'courriel professionnel', 'email travail', 'work email', 'email professionnel', 'courriel travail', 'courriel'),
        email_personal: autoMapField(fieldUnion, 'courriel personnel', 'email personnel', 'personal email', 'email perso'),
        phone_work:     autoMapField(fieldUnion, 'téléphone travail', 'telephone travail', 'phone work', 'work phone', 'phone', 'téléphone'),
        phone_personal: autoMapField(fieldUnion, 'téléphone perso', 'telephone perso', 'téléphone personnel', 'phone personal', 'personal phone', 'mobile', 'cell'),
        birth_date:     autoMapField(fieldUnion, 'date de naissance', 'birth date', 'naissance', 'birthday'),
        hire_date:      autoMapField(fieldUnion, "date d'embauche", 'date embauche', 'hire date', 'embauche', 'start date'),
        matricule:      autoMapField(fieldUnion, 'matricule nethris', 'matricule', 'employee id', 'employee number', 'id employé'),
        active:         autoMapField(fieldUnion, 'actif', 'active'),
        gender:         autoMapField(fieldUnion, 'genre', 'gender', 'sexe'),
        address:        autoMapField(fieldUnion, 'adresse de résidence', 'adresse', 'address', 'residence'),
        emergency_contact: autoMapField(fieldUnion, "contact en cas d'urgence", 'emergency contact', 'contact urgence'),
        end_date:       autoMapField(fieldUnion, "date de fin d'emploi", 'end date', 'termination date', 'fin emploi'),
        office_key:     autoMapField(fieldUnion, 'clef du bureau', 'office key', 'cle bureau'),
        insurance_id:   autoMapField(fieldUnion, 'id assurances', 'insurance id', 'assurances id'),
        nethris_username: autoMapField(fieldUnion, 'nethris username', 'username nethris'),
        is_salesperson: autoMapField(fieldUnion, 'vendeur', 'salesperson', 'sales'),
        is_consultant:  autoMapField(fieldUnion, 'consultant'),
        accounting_department: autoMapField(fieldUnion, 'département pour comptabilité', 'departement pour comptabilite', 'department', 'département'),
        hours_per_week: autoMapField(fieldUnion, 'heures par semaine', 'hours per week', 'weekly hours'),
        last_raise_date: autoMapField(fieldUnion, 'dernière augmentation', 'derniere augmentation', 'last raise', 'last increase'),
        group_insurance: autoMapField(fieldUnion, 'assurance collective', 'group insurance'),
        address_verified: autoMapField(fieldUnion, 'validation adresse', 'address verified', 'address validation'),
        banking_info:   autoMapField(fieldUnion, 'coordonnées bancaires', 'coordonnees bancaires', 'banking info', 'bank info'),
        issues:         autoMapField(fieldUnion, 'problèmes', 'problemes', 'issues', 'problems'),
        peer_reviews:   autoMapField(fieldUnion, 'évaluations par les pairs', 'evaluations par les pairs', 'peer reviews', 'peer evaluations'),
      }
      db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='employees'").run(JSON.stringify(fm))
    }
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const firstName = getVal(rec.fields, fm?.first_name)
        const lastName = getVal(rec.fields, fm?.last_name)
        if (!firstName && !lastName) continue
        const row = {
          first_name: firstName || '',
          last_name: lastName || '',
          email_work: getVal(rec.fields, fm?.email_work),
          email_personal: getVal(rec.fields, fm?.email_personal),
          phone_work: getVal(rec.fields, fm?.phone_work),
          phone_personal: getVal(rec.fields, fm?.phone_personal),
          birth_date: getVal(rec.fields, fm?.birth_date),
          hire_date: getVal(rec.fields, fm?.hire_date),
          matricule: getVal(rec.fields, fm?.matricule),
          active: empBool(rec.fields, fm?.active),
          gender: getVal(rec.fields, fm?.gender),
          address: getVal(rec.fields, fm?.address),
          emergency_contact: getVal(rec.fields, fm?.emergency_contact),
          end_date: getVal(rec.fields, fm?.end_date),
          office_key: empBool(rec.fields, fm?.office_key),
          insurance_id: getVal(rec.fields, fm?.insurance_id),
          nethris_username: getVal(rec.fields, fm?.nethris_username),
          is_salesperson: empBool(rec.fields, fm?.is_salesperson),
          is_consultant: empBool(rec.fields, fm?.is_consultant),
          accounting_department: getVal(rec.fields, fm?.accounting_department),
          hours_per_week: empNum(rec.fields, fm?.hours_per_week),
          last_raise_date: getVal(rec.fields, fm?.last_raise_date),
          group_insurance: empBool(rec.fields, fm?.group_insurance),
          address_verified: empBool(rec.fields, fm?.address_verified),
          banking_info: getVal(rec.fields, fm?.banking_info),
          issues: getVal(rec.fields, fm?.issues),
          peer_reviews: getVal(rec.fields, fm?.peer_reviews),
        }
        const existing = db.prepare('SELECT id FROM employees WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE employees SET
            first_name=@first_name, last_name=@last_name, email_work=@email_work, email_personal=@email_personal,
            phone_work=@phone_work, phone_personal=@phone_personal, birth_date=@birth_date, hire_date=@hire_date,
            matricule=@matricule, active=@active, gender=@gender, address=@address, emergency_contact=@emergency_contact,
            end_date=@end_date, office_key=@office_key, insurance_id=@insurance_id, nethris_username=@nethris_username,
            is_salesperson=@is_salesperson, is_consultant=@is_consultant, accounting_department=@accounting_department,
            hours_per_week=@hours_per_week, last_raise_date=@last_raise_date, group_insurance=@group_insurance,
            address_verified=@address_verified, banking_info=@banking_info, issues=@issues, peer_reviews=@peer_reviews,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`).run({ ...row, id: existing.id })
          updated++
        } else {
          db.prepare(`INSERT INTO employees (
            id, airtable_id, first_name, last_name, email_work, email_personal, phone_work, phone_personal,
            birth_date, hire_date, matricule, active, gender, address, emergency_contact, end_date, office_key,
            insurance_id, nethris_username, is_salesperson, is_consultant, accounting_department, hours_per_week,
            last_raise_date, group_insurance, address_verified, banking_info, issues, peer_reviews
          ) VALUES (
            @id, @airtable_id, @first_name, @last_name, @email_work, @email_personal, @phone_work, @phone_personal,
            @birth_date, @hire_date, @matricule, @active, @gender, @address, @emergency_contact, @end_date, @office_key,
            @insurance_id, @nethris_username, @is_salesperson, @is_consultant, @accounting_department, @hours_per_week,
            @last_raise_date, @group_insurance, @address_verified, @banking_info, @issues, @peer_reviews
          )`).run({ ...row, id: uuid(), airtable_id: rec.id })
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='employees'").run()
    })(records)
    console.log(`👥 Employés: ${imported} importés, ${updated} mis à jour`)
    if (!changes) purgeOrphans('employees', records)
    await evaluateFieldRules({ erpTable: 'employees', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Employees sync:', e.message) }
}

export async function syncPaies(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='paies'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM paies WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'paies', _recordIds)
    const fieldUnion = {}
    for (const rec of records) {
      if (rec.fields) for (const k of Object.keys(rec.fields)) fieldUnion[k] = true
    }
    let fm = config.field_map ? JSON.parse(config.field_map) : null
    if (!fm) {
      fm = {
        number:                     autoMapField(fieldUnion, 'number', 'numéro', 'numero'),
        period_end:                 autoMapField(fieldUnion, 'fin', 'end', 'date de fin'),
        status:                     autoMapField(fieldUnion, 'statut des feuilles de temps', 'statut', 'status'),
        csv:                        autoMapField(fieldUnion, 'csv'),
        nb_holiday_days:            autoMapField(fieldUnion, 'nombre de congés fériés', 'nombre de conges feries', 'nb congés fériés'),
        total_with_charges_and_reimb: autoMapField(fieldUnion, 'total de la paie incluant les remises aux organismes et les remboursements de dépenses', 'total paie', 'total'),
        timesheets_deadline:        autoMapField(fieldUnion, 'date limite pour correction des feuille de temps', 'date limite correction', 'deadline feuilles de temps'),
        includes_hourly:            autoMapField(fieldUnion, "heures pour employés payés à l'heure", 'heures payés heure', 'hourly hours'),
        includes_mileage:           autoMapField(fieldUnion, 'kilométrage', 'kilometrage', 'mileage'),
        includes_expense_reimb:     autoMapField(fieldUnion, 'remboursement de dépenses', 'remboursement de depenses', 'expense reimbursement'),
        includes_paid_leave:        autoMapField(fieldUnion, 'congés payés', 'conges payes', 'paid leave'),
        includes_holiday_hours:     autoMapField(fieldUnion, 'heures férié', 'heures ferie', 'holiday hours'),
        includes_sales_commissions: autoMapField(fieldUnion, 'commissions vendeurs', 'sales commissions'),
        timesheets_sent:            autoMapField(fieldUnion, 'envoi des feuilles de temps', 'timesheets sent'),
      }
      db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='paies'").run(JSON.stringify(fm))
    }
    // Champs ajoutés après coup — compléter un field_map déjà persisté.
    // Le champ currency « Total … incluant … les remboursements » n'est rempli
    // qu'au write-back de la comptabilisation : avant la publication, le total
    // attendu se reconstitue depuis la formule « …excluant les remboursements »
    // + le rollup « Remboursements de dépenses ». « Période de paie » fournit
    // le début de période (« YYYY-MM-DD au YYYY-MM-DD »).
    if (fm) {
      let fmDirty = false
      for (const [key, candidates] of Object.entries({
        total_excl_reimb: ['total de la paie incluant les remises aux organismes et excluant les remboursements de dépenses'],
        expense_reimb_total: ['remboursements de dépenses'],
        period_range: ['période de paie', 'periode de paie'],
      })) {
        if (!(key in fm)) { fm[key] = autoMapField(fieldUnion, ...candidates); fmDirty = true }
      }
      if (fmDirty) db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='paies'").run(JSON.stringify(fm))
    }
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const totalIncl = empNum(rec.fields, fm?.total_with_charges_and_reimb)
        const totalExcl = empNum(rec.fields, fm?.total_excl_reimb)
        const reimbTotal = empNum(rec.fields, fm?.expense_reimb_total)
        const totalFallback = totalExcl != null ? Math.round((totalExcl + (reimbTotal || 0)) * 100) / 100 : null
        const periodRange = String(getVal(rec.fields, fm?.period_range) || '')
        const periodStartMatch = periodRange.match(/^(\d{4}-\d{2}-\d{2})\s+au\b/)
        const row = {
          number: empNum(rec.fields, fm?.number),
          period_start: periodStartMatch ? periodStartMatch[1] : null,
          period_end: getVal(rec.fields, fm?.period_end),
          status: getVal(rec.fields, fm?.status),
          csv: getVal(rec.fields, fm?.csv),
          nb_holiday_days: empNum(rec.fields, fm?.nb_holiday_days),
          // Fallback ignoré tant que la paie est incomplète côté Airtable (remises
          // aux organismes pas encore saisies → formule ≤ 0).
          total_with_charges_and_reimb: totalIncl != null ? totalIncl : (totalFallback > 0 ? totalFallback : null),
          timesheets_deadline: getVal(rec.fields, fm?.timesheets_deadline),
          includes_hourly: empBool(rec.fields, fm?.includes_hourly),
          includes_mileage: empBool(rec.fields, fm?.includes_mileage),
          includes_expense_reimb: empBool(rec.fields, fm?.includes_expense_reimb),
          includes_paid_leave: empBool(rec.fields, fm?.includes_paid_leave),
          includes_holiday_hours: empBool(rec.fields, fm?.includes_holiday_hours),
          includes_sales_commissions: empBool(rec.fields, fm?.includes_sales_commissions),
          timesheets_sent: empBool(rec.fields, fm?.timesheets_sent),
        }
        const existing = db.prepare('SELECT id FROM paies WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE paies SET
            number=@number, period_start=COALESCE(@period_start, period_start),
            period_end=@period_end, status=@status, csv=@csv,
            nb_holiday_days=@nb_holiday_days, total_with_charges_and_reimb=@total_with_charges_and_reimb,
            timesheets_deadline=@timesheets_deadline, includes_hourly=@includes_hourly,
            includes_mileage=@includes_mileage, includes_expense_reimb=@includes_expense_reimb,
            includes_paid_leave=@includes_paid_leave, includes_holiday_hours=@includes_holiday_hours,
            includes_sales_commissions=@includes_sales_commissions, timesheets_sent=@timesheets_sent,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`).run({ ...row, id: existing.id })
          updated++
        } else {
          db.prepare(`INSERT INTO paies (
            id, airtable_id, number, period_start, period_end, status, csv, nb_holiday_days,
            total_with_charges_and_reimb, timesheets_deadline, includes_hourly, includes_mileage,
            includes_expense_reimb, includes_paid_leave, includes_holiday_hours,
            includes_sales_commissions, timesheets_sent
          ) VALUES (
            @id, @airtable_id, @number, @period_start, @period_end, @status, @csv, @nb_holiday_days,
            @total_with_charges_and_reimb, @timesheets_deadline, @includes_hourly, @includes_mileage,
            @includes_expense_reimb, @includes_paid_leave, @includes_holiday_hours,
            @includes_sales_commissions, @timesheets_sent
          )`).run({ ...row, id: uuid(), airtable_id: rec.id })
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='paies'").run()
    })(records)
    console.log(`💰 Paies: ${imported} importées, ${updated} mises à jour`)
    if (!changes) purgeOrphans('paies', records)
    await evaluateFieldRules({ erpTable: 'paies', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Paies sync:', e.message) }
}

export async function syncPaieItems(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='paie_items'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM paie_items WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'paie_items', _recordIds)
    const fieldUnion = {}
    for (const rec of records) {
      if (rec.fields) for (const k of Object.keys(rec.fields)) fieldUnion[k] = true
    }
    let fm = config.field_map ? JSON.parse(config.field_map) : null
    if (!fm) {
      fm = {
        paie_link:       autoMapField(fieldUnion, 'évènement paie', 'evenement paie', 'paie', 'payroll event'),
        employee_link:   autoMapField(fieldUnion, 'employé', 'employe', 'employee'),
        start_date:      autoMapField(fieldUnion, 'début', 'debut', 'start', 'start date'),
        hourly_rate:     autoMapField(fieldUnion, '$/h', 'taux horaire', 'hourly rate', 'rate'),
        regular_hours:   autoMapField(fieldUnion, 'h régulières', 'h regulieres', 'regular hours'),
        holiday_hours:   autoMapField(fieldUnion, 'h férié', 'h ferie', 'holiday hours'),
        vacation:        autoMapField(fieldUnion, 'vacances', 'vacation'),
        commission:      autoMapField(fieldUnion, 'commission', 'commissions'),
        expense_reimb:   autoMapField(fieldUnion, 'remb. dépenses', 'remb depenses', 'remboursement dépenses', 'expense reimbursement'),
        rsde_pct:        autoMapField(fieldUnion, 'rsde'),
        insurance_gains: autoMapField(fieldUnion, 'gains assurances', 'insurance gains'),
        holiday_1_20:    autoMapField(fieldUnion, 'férié 1/20', 'ferie 1/20', 'holiday 1/20'),
        paid_leave:      autoMapField(fieldUnion, 'congés payés', 'conges payes', 'paid leave'),
        notes:           autoMapField(fieldUnion, 'notes', 'note'),
      }
      db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='paie_items'").run(JSON.stringify(fm))
    }
    // Champ ajouté après coup — compléter un field_map déjà persisté. La formule
    // Airtable « Paie avec remb. dépenses » = total de paie de l'item (salaire +
    // vacances + commission + remb.), sans les remises aux organismes.
    if (fm && !('total_pay' in fm)) {
      fm.total_pay = autoMapField(fieldUnion, 'paie avec remb. dépenses', 'paie avec remb depenses', 'total')
      db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='paie_items'").run(JSON.stringify(fm))
    }
    // Champ ajouté après coup — date « Débité » (formule) : jour du débit BNC,
    // utilisée pour pré-remplir la date de la comptabilisation de la paie.
    if (fm && !('debited_date' in fm)) {
      fm.debited_date = autoMapField(fieldUnion, 'débité', 'debite', 'debited')
      db.prepare("UPDATE airtable_module_config SET field_map=? WHERE module='paie_items'").run(JSON.stringify(fm))
    }
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const paieAirtableId = firstLinked(rec.fields, fm?.paie_link)
        const employeeAirtableId = firstLinked(rec.fields, fm?.employee_link)
        const paieId = paieAirtableId
          ? db.prepare('SELECT id FROM paies WHERE airtable_id=?').get(paieAirtableId)?.id || null
          : null
        const employeeId = employeeAirtableId
          ? db.prepare('SELECT id FROM employees WHERE airtable_id=?').get(employeeAirtableId)?.id || null
          : null
        const row = {
          paie_id: paieId,
          paie_airtable_id: paieAirtableId,
          employee_id: employeeId,
          employee_airtable_id: employeeAirtableId,
          start_date: getVal(rec.fields, fm?.start_date),
          hourly_rate: empNum(rec.fields, fm?.hourly_rate),
          regular_hours: empNum(rec.fields, fm?.regular_hours),
          holiday_hours: empNum(rec.fields, fm?.holiday_hours),
          vacation: empNum(rec.fields, fm?.vacation),
          commission: empNum(rec.fields, fm?.commission),
          expense_reimb: empNum(rec.fields, fm?.expense_reimb),
          rsde_pct: empNum(rec.fields, fm?.rsde_pct),
          insurance_gains: empNum(rec.fields, fm?.insurance_gains),
          holiday_1_20: empNum(rec.fields, fm?.holiday_1_20),
          paid_leave: getVal(rec.fields, fm?.paid_leave),
          notes: getVal(rec.fields, fm?.notes),
          total_pay: empNum(rec.fields, fm?.total_pay),
          debited_date: getVal(rec.fields, fm?.debited_date),
        }
        const existing = db.prepare('SELECT id FROM paie_items WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE paie_items SET
            paie_id=@paie_id, paie_airtable_id=@paie_airtable_id,
            employee_id=@employee_id, employee_airtable_id=@employee_airtable_id,
            start_date=@start_date, hourly_rate=@hourly_rate, regular_hours=@regular_hours,
            holiday_hours=@holiday_hours, vacation=@vacation, commission=@commission,
            expense_reimb=@expense_reimb, rsde_pct=@rsde_pct, insurance_gains=@insurance_gains,
            holiday_1_20=@holiday_1_20, paid_leave=@paid_leave, notes=@notes, total_pay=@total_pay,
            debited_date=@debited_date,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`).run({ ...row, id: existing.id })
          updated++
        } else {
          db.prepare(`INSERT INTO paie_items (
            id, airtable_id, paie_id, paie_airtable_id, employee_id, employee_airtable_id,
            start_date, hourly_rate, regular_hours, holiday_hours, vacation, commission,
            expense_reimb, rsde_pct, insurance_gains, holiday_1_20, paid_leave, notes, total_pay, debited_date
          ) VALUES (
            @id, @airtable_id, @paie_id, @paie_airtable_id, @employee_id, @employee_airtable_id,
            @start_date, @hourly_rate, @regular_hours, @holiday_hours, @vacation, @commission,
            @expense_reimb, @rsde_pct, @insurance_gains, @holiday_1_20, @paid_leave, @notes, @total_pay, @debited_date
          )`).run({ ...row, id: uuid(), airtable_id: rec.id })
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='paie_items'").run()
    })(records)
    console.log(`📋 Items paie: ${imported} importés, ${updated} mis à jour`)
    if (!changes) purgeOrphans('paie_items', records)
  } catch (e) { console.error('❌ Paie items sync:', e.message) }
}

