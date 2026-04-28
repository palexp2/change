import { v4 as uuid } from 'uuid'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'
import { syncDynamicFields, updateDynamicFields } from './airtableAutoSync.js'
import { broadcastAll } from './realtime.js'
import { evaluateFieldRules } from './fieldRuleEngine.js'
import { getFrozenColumns } from './airtableFrozenColumns.js'

// Auto-create missing columns in SQLite table (all added as TEXT — safe default)
const _ensuredTables = new Map() // table → Set<col>
function ensureColumns(table, columns) {
  if (!_ensuredTables.has(table)) {
    _ensuredTables.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)))
  }
  const existing = _ensuredTables.get(table)
  for (const col of columns) {
    if (!existing.has(col)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`).run()
      existing.add(col)
      console.log(`🔧 Auto-created column ${table}.${col}`)
    }
  }
}

/**
 * Dynamic upsert: INSERT or UPDATE a record based on airtable_id.
 * Automatically creates missing columns in the target table.
 * @param {string} table - SQLite table name
 * @param {string} airtableId - Airtable record ID
 * @param {Object} payload - column→value map (null values are preserved)
 * @returns {'imported'|'updated'}
 */
function upsertRecord(table, airtableId, payload) {
  const keys = Object.keys(payload)
  ensureColumns(table, keys)

  const existing = db.prepare(`SELECT id FROM ${table} WHERE airtable_id=?`).get(airtableId)
  if (existing) {
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
          } else {
            db.prepare('INSERT INTO companies (id, name, phone, email, website, address, city, province, country, type, lifecycle_phase, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(uuid(), name, getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.website), getVal(rec.fields, fieldMap?.address), getVal(rec.fields, fieldMap?.city), getVal(rec.fields, fieldMap?.province), getVal(rec.fields, fieldMap?.country), type, lifecycle_phase, getVal(rec.fields, fieldMap?.notes), rec.id)
            companiesImported++
          }
        }
      })(records)
      if (companiesImported > 0) console.log(`🏢 Airtable: ${companiesImported} companies imported`)
    if (!changes) {
      purgeOrphans('companies', records)
      await syncDynamicFields('airtable_companies', 'companies', config.base_id, config.companies_table_id, fieldMap, records)
    } else {
      updateDynamicFields('companies', fieldMap, records)
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
      updateDynamicFields('contacts', fieldMap, records)
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

    // Max order_number for auto-increment
    const maxNum = () => (db.prepare('SELECT MAX(order_number) as m FROM orders').get()?.m || 0)

    db.transaction((recs) => {
      for (const rec of recs) {
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

        const existing = db.prepare('SELECT id FROM orders WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE orders SET company_id=?, project_id=?, status=?, priority=?, notes=?, address_id=COALESCE(?,address_id), is_subscription=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(companyId, projectId, status, priority, notes, addressId, isSubscription, existing.id)
          updated++
        } else {
          const rawNum = fm?.order_number ? parseInt(String(rec.fields[fm.order_number] ?? '').replace(/[^0-9]/g, '')) : NaN
          const orderNumber = isNaN(rawNum) || rawNum === 0 ? maxNum() + 1 : rawNum
          db.prepare('INSERT INTO orders (id, order_number, company_id, project_id, status, priority, notes, address_id, airtable_id, is_subscription) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), orderNumber, companyId, projectId, status, priority, notes, addressId, rec.id, isSubscription)
          imported++
        }
      }
    })(records)
    console.log(`📦 Orders: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('orders', records)
      await syncDynamicFields('orders', 'orders', config.base_id, config.orders_table_id, fm, records)
    } else {
      updateDynamicFields('orders', fm, records)
    }
    await evaluateFieldRules({ erpTable: 'orders', tableId: config.orders_table_id, changes })
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
      updateDynamicFields('order_items', fm, records)
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
        }
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
        }

        const existing = db.prepare('SELECT id FROM products WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE products SET name_fr=?, name_en=?, sku=?, type=?, unit_cost=?, price_cad=?, stock_qty=?, min_stock=?, supplier=?, procurement_type=?, weight_lbs=?, image_url=COALESCE(?,image_url), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(payload.name_fr, payload.name_en, payload.sku, payload.type, payload.unit_cost, payload.price_cad, payload.stock_qty, payload.min_stock, payload.supplier, payload.procurement_type, payload.weight_lbs, payload.image_url, existing.id)
          updated++
        } else {
          db.prepare(`INSERT INTO products (id, name_fr, name_en, sku, type, unit_cost, price_cad, stock_qty, min_stock, supplier, procurement_type, weight_lbs, image_url, airtable_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), payload.name_fr, payload.name_en, payload.sku, payload.type, payload.unit_cost, payload.price_cad, payload.stock_qty, payload.min_stock, payload.supplier, payload.procurement_type, payload.weight_lbs, payload.image_url, rec.id)
          imported++
        }
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='pieces'`).run()
    })(records)
    console.log(`🔩 Pièces: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('products', records)
      await syncDynamicFields('pieces', 'products', config.base_id, config.table_id, fieldMap, records)
    } else {
      updateDynamicFields('products', fieldMap, records)
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
    let imported = 0, updated = 0

    db.transaction((recs) => {
      for (const rec of recs) {
        if (!fieldMap && rec.fields) {
          fieldMap = {
            product:        autoMapField(rec.fields, 'nom de la pièce', 'nom de la piece', 'produit', 'pièce', 'piece', 'product', 'item'),
            supplier:       autoMapField(rec.fields, 'fournisseur - legacy', 'fournisseur legacy', 'fournisseur', 'supplier', 'vendor'),
            reference:      autoMapField(rec.fields, 'numéro de commande', 'numero de commande', 'référence', 'reference', 'ref', 'po', 'numéro'),
            order_date:     autoMapField(rec.fields, 'date de commande', 'date commande', 'date achat', 'order date', 'date'),
            expected_date:  autoMapField(rec.fields, 'date prévue', 'date prevue', 'expected', 'livraison prévue'),
            received_date:  autoMapField(rec.fields, 'date de réception complète', 'date de réception', 'date réception', 'date reception', 'received date', 'reçu le'),
            qty_ordered:    autoMapField(rec.fields, 'quantité commandé', 'quantite commande', 'qté commandée', 'qty ordered', 'quantité commandée', 'qte commandee'),
            qty_received:   autoMapField(rec.fields, 'qté reçue', 'qty received', 'quantité reçue', 'qte recue'),
            unit_cost:      autoMapField(rec.fields, 'prix unitaire ($ cad)', 'prix unitaire', 'coût unitaire', 'cout unitaire', 'unit cost'),
            status:         autoMapField(rec.fields, 'statut', 'status', 'état'),
            notes:          autoMapField(rec.fields, 'notes', 'commentaires', 'remarks'),
          }
        }

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
        const status = STATUS_MAP[rawStatus.toLowerCase()] || 'Commandé'

        const payload = {
          product_id:     productId,
          supplier:       getVal(rec.fields, fieldMap?.supplier),
          reference:      getVal(rec.fields, fieldMap?.reference),
          order_date:     getVal(rec.fields, fieldMap?.order_date),
          expected_date:  getVal(rec.fields, fieldMap?.expected_date),
          received_date:  getVal(rec.fields, fieldMap?.received_date),
          qty_ordered:    toInt(fieldMap?.qty_ordered) ?? 0,
          qty_received:   toInt(fieldMap?.qty_received) ?? 0,
          unit_cost:      toFloat(fieldMap?.unit_cost) ?? 0,
          status,
          notes:          getVal(rec.fields, fieldMap?.notes),
        }

        const existing = db.prepare('SELECT id FROM purchases WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE purchases SET product_id=?, supplier=?, reference=?, order_date=?, expected_date=?, received_date=?, qty_ordered=?, qty_received=?, unit_cost=?, status=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(payload.product_id, payload.supplier, payload.reference, payload.order_date, payload.expected_date, payload.received_date, payload.qty_ordered, payload.qty_received, payload.unit_cost, payload.status, payload.notes, existing.id)
          updated++
        } else {
          db.prepare(`INSERT INTO purchases (id, airtable_id, product_id, supplier, reference, order_date, expected_date, received_date, qty_ordered, qty_received, unit_cost, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), rec.id, payload.product_id, payload.supplier, payload.reference, payload.order_date, payload.expected_date, payload.received_date, payload.qty_ordered, payload.qty_received, payload.unit_cost, payload.status, payload.notes)
          imported++
        }
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='achats'`).run()
    })(records)
    console.log(`🛒 Achats: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      purgeOrphans('purchases', records)
      await syncDynamicFields('achats', 'purchases', config.base_id, config.table_id, fieldMap, records)
    } else {
      updateDynamicFields('purchases', fieldMap, records)
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
      updateDynamicFields('serial_numbers', fieldMap, records)
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
    let imported = 0, updated = 0

    db.transaction((recs) => {
      for (const rec of recs) {
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
        if (existing) {
          db.prepare(`UPDATE shipments SET order_id=COALESCE(?,order_id), tracking_number=?, carrier=?, status=?, shipped_at=?, notes=?, address_id=COALESCE(?,address_id), pays=? WHERE id=?`)
            .run(orderId, tracking_number, carrier, status || 'À envoyer', shipped_at, notes, addressId, pays, existing.id)
          updated++
        } else {
          if (!orderId) continue
          db.prepare(`INSERT INTO shipments (id, order_id, airtable_id, tracking_number, carrier, status, shipped_at, notes, address_id, pays) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), orderId, rec.id, tracking_number, carrier, status || 'À envoyer', shipped_at, notes, addressId, pays)
          imported++
        }
      }
      db.prepare(`UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='envois'`).run()
    })(records)
    console.log(`🚚 Envois: ${imported} importés, ${updated} mis à jour`)
    if (!changes) {
      purgeOrphans('shipments', records)
      await syncDynamicFields('envois', 'shipments', config.base_id, config.table_id, fieldMap, records)
    } else {
      updateDynamicFields('shipments', fieldMap, records)
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
      updateDynamicFields('tickets', fieldMap, records)
    }

    await evaluateFieldRules({ erpTable: 'tickets', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Billets sync:', e.message) }
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
        for (const id of changes[tid].destroyedIds)
          db.prepare('DELETE FROM projects WHERE airtable_id=?').run(id)
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

    db.transaction((recs) => {
      for (const rec of recs) {
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

        const name = getVal(rec.fields, fieldMap?.name)
        if (!name) continue

        // Status: use user-defined choices map, fallback to Oui/Non legacy
        const rawStatus = (getVal(rec.fields, fieldMap?.status) || '').trim()
        const STATUS_CHOICES = fieldMap?.status_choices || { 'Oui': 'Gagné', 'Non': 'Perdu' }
        const status = STATUS_CHOICES[rawStatus] || (rawStatus ? 'Ouvert' : 'Ouvert')

        // Type: use user-defined choices map, fallback to exact match
        const rawType = getVal(rec.fields, fieldMap?.type) || ''
        const validTypes = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']
        const TYPE_CHOICES = fieldMap?.type_choices || {}
        const type = TYPE_CHOICES[rawType] || validTypes.find(t => t.toLowerCase() === rawType.toLowerCase()) || null

        // Company lookup
        const companyId = lookupCompany(rec.fields, fieldMap?.company)

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

        const valueCad      = toFloat(fieldMap?.value_cad)
        // Airtable percent fields are stored as decimals (0.30 = 30%) — multiply by 100 if ≤ 1
        const rawProb = fieldMap?.probability ? rec.fields[fieldMap.probability] : null
        const probFloat = parseFloat(String(rawProb ?? ''))
        const probability = isNaN(probFloat) ? null : Math.round(probFloat > 1 ? probFloat : probFloat * 100)
        const monthlyCad    = toFloat(fieldMap?.monthly_cad)
        const nbGreenhouses = toInt(fieldMap?.nb_greenhouses)
        const closeDate     = getVal(rec.fields, fieldMap?.close_date)
        const notes         = getVal(rec.fields, fieldMap?.notes)

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
        if (existing) {
          const writable = allPairs.filter(([c]) => !frozenProjects.has(c))
          if (writable.length) {
            const setClause = writable.map(([c]) => `${c}=?`).join(', ')
            db.prepare(`UPDATE projects SET ${setClause}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
              .run(...writable.map(([, v]) => v), existing.id)
            updated++
          }
        } else {
          db.prepare('INSERT INTO projects (id, name, company_id, status, type, value_cad, probability, monthly_cad, nb_greenhouses, close_date, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), name, companyId, status, type, valueCad, probability, monthlyCad, nbGreenhouses, closeDate, notes, rec.id)
          imported++
        }
      }

      // Sync extra tables (additional Airtable tables mapped to projects)
      for (const { extra, extraRecords } of extraTableData) {
        const extraFieldMap = extra.field_map || {}
        const validTypes = ['Nouveau client', 'Expansion', 'Ajouts mineurs', 'Pièces de rechange']
        for (const rec of extraRecords) {
          const name = getVal(rec.fields, extraFieldMap.name)
          if (!name) continue
          const rawStatus2 = (getVal(rec.fields, extraFieldMap.status) || '').trim()
          const STATUS_CHOICES2 = extraFieldMap.status_choices || { 'Oui': 'Gagné', 'Non': 'Perdu' }
          const status2 = STATUS_CHOICES2[rawStatus2] || 'Ouvert'
          const rawType2 = getVal(rec.fields, extraFieldMap.type) || ''
          const TYPE_CHOICES2 = extraFieldMap.type_choices || {}
          const type2 = TYPE_CHOICES2[rawType2] || validTypes.find(t => t.toLowerCase() === rawType2.toLowerCase()) || null
          const companyId2 = lookupCompany(rec.fields, extraFieldMap.company)
          function toF(k) { const r = k ? rec.fields[k] : null; const n = parseFloat(String(r ?? '').replace(/[^0-9.-]/g, '')); return isNaN(n) ? null : n }
          function toI(k) { const r = k ? rec.fields[k] : null; const n = parseInt(String(r ?? '').replace(/[^0-9]/g, '')); return isNaN(n) ? null : n }
          const rawProb2 = extraFieldMap.probability ? rec.fields[extraFieldMap.probability] : null
          const pf2 = parseFloat(String(rawProb2 ?? ''))
          const prob2 = isNaN(pf2) ? null : Math.round(pf2 > 1 ? pf2 : pf2 * 100)
          const existing2 = db.prepare('SELECT id FROM projects WHERE airtable_id=?').get(rec.id)
          if (existing2) {
            const extraPairs = [
              ['name', name],
              ['company_id', companyId2],
              ['status', status2],
              ['type', type2],
              ['value_cad', toF(extraFieldMap.value_cad)],
              ['probability', prob2],
              ['monthly_cad', toF(extraFieldMap.monthly_cad)],
              ['nb_greenhouses', toI(extraFieldMap.nb_greenhouses)],
              ['close_date', getVal(rec.fields, extraFieldMap.close_date)],
              ['notes', getVal(rec.fields, extraFieldMap.notes)],
            ]
            const writable = extraPairs.filter(([c]) => !frozenProjects.has(c))
            if (writable.length) {
              const setClause = writable.map(([c]) => `${c}=?`).join(', ')
              db.prepare(`UPDATE projects SET ${setClause}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
                .run(...writable.map(([, v]) => v), existing2.id)
              updated++
            }
          } else {
            db.prepare('INSERT INTO projects (id, name, company_id, status, type, value_cad, probability, monthly_cad, nb_greenhouses, close_date, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(uuid(), name, companyId2, status2, type2, toF(extraFieldMap.value_cad), prob2, toF(extraFieldMap.monthly_cad), toI(extraFieldMap.nb_greenhouses), getVal(rec.fields, extraFieldMap.close_date), getVal(rec.fields, extraFieldMap.notes), rec.id)
            imported++
          }
        }
      }

      db.prepare(`UPDATE airtable_projets_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run()
    })(records)
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
      updateDynamicFields('projects', fieldMap, records)
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
function lookupOrder(airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM orders WHERE airtable_id=? LIMIT 1').get(airtableId)?.id || null
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
      updateDynamicFields('soumissions', fm, records)
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
      updateDynamicFields('returns', fm, records)
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
      updateDynamicFields('return_items', fm, records)
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
      updateDynamicFields('adresses', fm, records)
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
      updateDynamicFields('assemblages', fm, records)
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
    let imported = 0, updated = 0
    db.transaction((recs) => {
      for (const rec of recs) {
        const row = {
          number: empNum(rec.fields, fm?.number),
          period_end: getVal(rec.fields, fm?.period_end),
          status: getVal(rec.fields, fm?.status),
          csv: getVal(rec.fields, fm?.csv),
          nb_holiday_days: empNum(rec.fields, fm?.nb_holiday_days),
          total_with_charges_and_reimb: empNum(rec.fields, fm?.total_with_charges_and_reimb),
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
            number=@number, period_end=@period_end, status=@status, csv=@csv,
            nb_holiday_days=@nb_holiday_days, total_with_charges_and_reimb=@total_with_charges_and_reimb,
            timesheets_deadline=@timesheets_deadline, includes_hourly=@includes_hourly,
            includes_mileage=@includes_mileage, includes_expense_reimb=@includes_expense_reimb,
            includes_paid_leave=@includes_paid_leave, includes_holiday_hours=@includes_holiday_hours,
            includes_sales_commissions=@includes_sales_commissions, timesheets_sent=@timesheets_sent,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`).run({ ...row, id: existing.id })
          updated++
        } else {
          db.prepare(`INSERT INTO paies (
            id, airtable_id, number, period_end, status, csv, nb_holiday_days,
            total_with_charges_and_reimb, timesheets_deadline, includes_hourly, includes_mileage,
            includes_expense_reimb, includes_paid_leave, includes_holiday_hours,
            includes_sales_commissions, timesheets_sent
          ) VALUES (
            @id, @airtable_id, @number, @period_end, @status, @csv, @nb_holiday_days,
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
        }
        const existing = db.prepare('SELECT id FROM paie_items WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE paie_items SET
            paie_id=@paie_id, paie_airtable_id=@paie_airtable_id,
            employee_id=@employee_id, employee_airtable_id=@employee_airtable_id,
            start_date=@start_date, hourly_rate=@hourly_rate, regular_hours=@regular_hours,
            holiday_hours=@holiday_hours, vacation=@vacation, commission=@commission,
            expense_reimb=@expense_reimb, rsde_pct=@rsde_pct, insurance_gains=@insurance_gains,
            holiday_1_20=@holiday_1_20, paid_leave=@paid_leave, notes=@notes,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`).run({ ...row, id: existing.id })
          updated++
        } else {
          db.prepare(`INSERT INTO paie_items (
            id, airtable_id, paie_id, paie_airtable_id, employee_id, employee_airtable_id,
            start_date, hourly_rate, regular_hours, holiday_hours, vacation, commission,
            expense_reimb, rsde_pct, insurance_gains, holiday_1_20, paid_leave, notes
          ) VALUES (
            @id, @airtable_id, @paie_id, @paie_airtable_id, @employee_id, @employee_airtable_id,
            @start_date, @hourly_rate, @regular_hours, @holiday_hours, @vacation, @commission,
            @expense_reimb, @rsde_pct, @insurance_gains, @holiday_1_20, @paid_leave, @notes
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

export async function syncFactures(changes = null) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE module='factures'").get()
  if (!config?.base_id || !config?.table_id) return
  if (changes?.[config.table_id]?.destroyedIds?.length) {
    for (const id of changes[config.table_id].destroyedIds)
      db.prepare('DELETE FROM factures WHERE airtable_id=?').run(id)
  }
  const _recordIds = changes?.[config.table_id]?.recordIds
  if (changes && !_recordIds?.length) return
  let accessToken
  try { accessToken = await getAccessToken() }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const rawRecords = await fetchAllRecords(config.base_id, config.table_id, accessToken, 'factures', _recordIds)
    // Ignore QuickBooks refund receipts — no Stripe counterpart, pollution only.
    const skippedQbRefundIds = []
    const records = []
    for (const rec of rawRecords) {
      if (rec.fields?.['Sync Source'] === 'Remboursements Quickbooks') skippedQbRefundIds.push(rec.id)
      else records.push(rec)
    }
    if (skippedQbRefundIds.length) {
      const ph = skippedQbRefundIds.map(() => '?').join(',')
      const del = db.prepare(`DELETE FROM factures WHERE airtable_id IN (${ph})`).run(...skippedQbRefundIds)
      if (del.changes) console.log(`🧾 Factures: ${del.changes} remboursement(s) QB supprimé(s) (ignorés à la sync)`)
    }
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    const findCompanyByStripeCustomerId = db.prepare(
      'SELECT id FROM companies WHERE stripe_customer_id=? LIMIT 1'
    )
    db.transaction((recs) => {
      for (const rec of recs) {
        // Match strictement par stripe_customer_id (champ Airtable "Customer ID").
        // Pas de fallback par nom/linked record : duplicate companies → mauvais lien.
        const stripeCustomerId = rec.fields['Customer ID'] || null
        const companyId = stripeCustomerId
          ? findCompanyByStripeCustomerId.get(stripeCustomerId)?.id || null
          : null
        const projectId = lookupProject(firstLinked(rec.fields, fm.project))
        const orderId = lookupOrder(firstLinked(rec.fields, fm.order))
        const invoiceId = getVal(rec.fields, fm.invoice_id)
        const documentNumber = getVal(rec.fields, fm.document_number)
        const documentDate = getVal(rec.fields, fm.document_date)
        const dueDate = getVal(rec.fields, fm.due_date)
        const status = getVal(rec.fields, fm.status)
        const currency = getVal(rec.fields, fm.currency) || 'CAD'
        const amountBeforeTaxCad = parseFloat(String(rec.fields[fm.amount_before_tax] ?? 0).replace(/[^0-9.-]/g, '')) || 0
        const totalAmount = parseFloat(String(rec.fields[fm.total_amount] ?? 0).replace(/[^0-9.-]/g, '')) || 0
        const balanceDue = parseFloat(String(rec.fields[fm.balance_due] ?? 0).replace(/[^0-9.-]/g, '')) || 0
        const notes = getVal(rec.fields, fm.notes)
        const existing = db.prepare('SELECT id FROM factures WHERE airtable_id=?').get(rec.id)
        if (existing) {
          db.prepare(`UPDATE factures SET company_id=?, project_id=?, order_id=?, invoice_id=?, document_number=?, document_date=?, due_date=?, status=?, currency=?, amount_before_tax_cad=?, total_amount=?, balance_due=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
            .run(companyId, projectId, orderId, invoiceId, documentNumber, documentDate, dueDate, status, currency, amountBeforeTaxCad, totalAmount, balanceDue, notes, existing.id)
          updated++
        } else {
          db.prepare('INSERT INTO factures (id, airtable_id, company_id, project_id, order_id, invoice_id, document_number, document_date, due_date, status, currency, amount_before_tax_cad, total_amount, balance_due, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), rec.id, companyId, projectId, orderId, invoiceId, documentNumber, documentDate, dueDate, status, currency, amountBeforeTaxCad, totalAmount, balanceDue, notes)
          imported++
        }
      }
      db.prepare("UPDATE airtable_module_config SET last_synced_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE module='factures'").run()
    })(records)
    console.log(`🧾 Factures: ${imported} importées, ${updated} mises à jour`)
    if (!changes) {
      purgeOrphans('factures', records)
      await syncDynamicFields('factures', 'factures', config.base_id, config.table_id, fm, records)
    } else {
      updateDynamicFields('factures', fm, records)
    }
    // Download invoice PDFs from Airtable (URLs are temporary — must dl during sync)
    await downloadFacturePdfs(records)
    // Link factures to subscriptions via Airtable linked record IDs
    await resolveFactureSubscriptions(accessToken)
    await evaluateFieldRules({ erpTable: 'factures', tableId: config.table_id, changes })
  } catch (e) { console.error('❌ Factures sync:', e.message) }
}

async function downloadFacturePdfs(records) {
  const { mkdir, writeFile } = await import('fs/promises')
  const path = await import('path')
  const dir = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'factures')
  await mkdir(dir, { recursive: true })
  let downloaded = 0
  for (const rec of records) {
    const attachments = rec.fields['Invoice pdf']
    if (!Array.isArray(attachments) || !attachments[0]?.url) continue
    const row = db.prepare('SELECT id, airtable_pdf_path FROM factures WHERE airtable_id=?').get(rec.id)
    if (!row || row.airtable_pdf_path) continue // already downloaded
    try {
      const res = await fetch(attachments[0].url)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const filePath = `${dir}/${row.id}.pdf`
      await writeFile(filePath, buf)
      db.prepare('UPDATE factures SET airtable_pdf_path=? WHERE id=?').run(`factures/${row.id}.pdf`, row.id)
      downloaded++
    } catch(e) { console.error(`❌ PDF dl ${row.id}:`, e.message) }
  }
  if (downloaded > 0) console.log(`📄 Factures PDFs: ${downloaded} téléchargés`)
}

/**
 * Fetch Airtable abonnements, populate subscriptions.airtable_id (matching on stripe_id),
 * then update factures.subscription_id by resolving the linked Airtable record IDs.
 */
async function resolveFactureSubscriptions(accessToken) {
  const abCfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='abonnements'").get()
  if (!abCfg) return

  let abRecords
  try {
    abRecords = await fetchAllRecords(abCfg.base_id, abCfg.table_id, accessToken, 'abonnements_link')
  } catch (e) { console.error('❌ resolveFactureSubscriptions fetch:', e.message); return }

  // Step 1: populate subscriptions.airtable_id where NULL, matching on stripe_id = rec.fields['id']
  let linked = 0
  for (const rec of abRecords) {
    const stripeId = rec.fields['id'] || rec.fields['Stripe ID'] || rec.fields['stripe_id']
    if (!stripeId) continue
    const sub = db.prepare('SELECT id FROM subscriptions WHERE stripe_id=? AND airtable_id IS NULL').get(stripeId)
    if (sub) {
      db.prepare('UPDATE subscriptions SET airtable_id=? WHERE id=?').run(rec.id, sub.id)
      linked++
    }
  }
  if (linked > 0) console.log(`🔗 Abonnements: ${linked} airtable_id peuplés`)

  // Step 2: update factures.subscription_id where NULL, resolving abonnement JSON → subscriptions.airtable_id
  const factures = db.prepare(
    "SELECT id, abonnement FROM factures WHERE abonnement IS NOT NULL AND subscription_id IS NULL"
  ).all()
  let resolved = 0
  for (const f of factures) {
    let ids
    try { ids = JSON.parse(f.abonnement) } catch { continue }
    const atId = Array.isArray(ids) ? ids[0] : null
    if (!atId) continue
    const sub = db.prepare('SELECT id FROM subscriptions WHERE airtable_id=?').get(atId)
    if (sub) {
      db.prepare('UPDATE factures SET subscription_id=? WHERE id=?').run(sub.id, f.id)
      resolved++
    }
  }
  if (resolved > 0) console.log(`🧾 Factures: ${resolved} liées à un abonnement`)
}
