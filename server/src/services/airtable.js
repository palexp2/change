import { v4 as uuid } from 'uuid'
import { createWriteStream, existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'

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
function lookupCompany(tenantId, fields, fieldName) {
  if (!fieldName || !(fieldName in fields)) return null
  const raw = fields[fieldName]
  const linkedId = Array.isArray(raw) ? raw[0] : null
  if (linkedId) {
    const co = db.prepare('SELECT id FROM companies WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, linkedId)
    if (co) return co.id
  }
  // Fallback: text match
  const name = Array.isArray(raw) ? null : getVal(fields, fieldName)
  if (name) {
    const co = db.prepare('SELECT id FROM companies WHERE tenant_id=? AND name LIKE ? LIMIT 1').get(tenantId, `%${name}%`)
    if (co) return co.id
  }
  return null
}

async function fetchAllRecords(baseId, tableId, accessToken) {
  const records = []
  let offset = null
  do {
    const params = new URLSearchParams({ pageSize: '100' })
    if (offset) params.set('offset', offset)
    const data = await airtableFetch(`/${baseId}/${tableId}?${params}`, accessToken)
    records.push(...(data.records || []))
    offset = data.offset || null
  } while (offset)
  return records
}

export async function syncAirtable(tenantId) {
  const config = db.prepare('SELECT * FROM airtable_sync_config WHERE tenant_id=?').get(tenantId)
  if (!config?.base_id) { console.log('⚠️  Airtable sync config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  // Sync companies first
  if (config.companies_table_id) {
    try {
      const records = await fetchAllRecords(config.base_id, config.companies_table_id, accessToken)
      let fieldMap = config.field_map_companies ? JSON.parse(config.field_map_companies) : null
      let companiesImported = 0

      for (const rec of records) {
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

        // Resolve single-select choices via user-defined maps
        const typeRaw = getVal(rec.fields, fieldMap?.type)
        const type = typeRaw ? (fieldMap?.type_choices?.[typeRaw] || typeRaw) : null

        const phaseRaw = getVal(rec.fields, fieldMap?.lifecycle_phase)
        const lifecycle_phase = phaseRaw ? (fieldMap?.phase_choices?.[phaseRaw] || phaseRaw) : null

        // Build extra_fields from cf_ prefixed keys in fieldMap
        const extra = {}
        if (fieldMap) {
          for (const [k, v] of Object.entries(fieldMap)) {
            if (k.startsWith('cf_')) {
              const cfKey = k.slice(3)
              const val = getVal(rec.fields, v)
              if (val) extra[cfKey] = val
            }
          }
        }
        const extraJson = JSON.stringify(extra)

        const existing = db.prepare('SELECT id, extra_fields FROM companies WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
        if (existing) {
          const merged = { ...JSON.parse(existing.extra_fields || '{}'), ...extra }
          db.prepare(`UPDATE companies SET name=?, phone=COALESCE(?,phone), email=COALESCE(?,email), website=COALESCE(?,website), address=COALESCE(?,address), city=COALESCE(?,city), province=COALESCE(?,province), country=COALESCE(?,country), type=COALESCE(?,type), lifecycle_phase=COALESCE(?,lifecycle_phase), notes=COALESCE(?,notes), extra_fields=?, updated_at=datetime('now') WHERE id=?`)
            .run(name, getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.website), getVal(rec.fields, fieldMap?.address), getVal(rec.fields, fieldMap?.city), getVal(rec.fields, fieldMap?.province), getVal(rec.fields, fieldMap?.country), type, lifecycle_phase, getVal(rec.fields, fieldMap?.notes), JSON.stringify(merged), existing.id)
        } else {
          db.prepare('INSERT INTO companies (id, tenant_id, name, phone, email, website, address, city, province, country, type, lifecycle_phase, notes, extra_fields, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), tenantId, name, getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.website), getVal(rec.fields, fieldMap?.address), getVal(rec.fields, fieldMap?.city), getVal(rec.fields, fieldMap?.province), getVal(rec.fields, fieldMap?.country), type, lifecycle_phase, getVal(rec.fields, fieldMap?.notes), extraJson, rec.id)
          companiesImported++
        }
      }
      if (companiesImported > 0) console.log(`🏢 Airtable: ${companiesImported} companies imported`)
    } catch (e) { console.error('❌ Airtable companies:', e.message) }
  }

  // Sync contacts
  if (config.contacts_table_id) {
    try {
      const records = await fetchAllRecords(config.base_id, config.contacts_table_id, accessToken)
      let fieldMap = config.field_map_contacts ? JSON.parse(config.field_map_contacts) : null
      let contactsImported = 0

      for (const rec of records) {
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

        const companyId = lookupCompany(tenantId, rec.fields, fieldMap?.company)

        const rawLang = (getVal(rec.fields, fieldMap?.language) || '').trim()
        const language = rawLang === 'French' || rawLang === 'Français' || rawLang === 'francais' ? 'French'
          : rawLang === 'English' || rawLang === 'Anglais' || rawLang === 'anglais' ? 'English'
          : null

        // Build extra_fields from cf_ prefixed keys in fieldMap
        const extra = {}
        if (fieldMap) {
          for (const [k, v] of Object.entries(fieldMap)) {
            if (k.startsWith('cf_')) {
              const cfKey = k.slice(3)
              const val = getVal(rec.fields, v)
              if (val) extra[cfKey] = val
            }
          }
        }
        const extraJson = JSON.stringify(extra)

        const existing = db.prepare('SELECT id, extra_fields FROM contacts WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
        if (existing) {
          const merged = { ...JSON.parse(existing.extra_fields || '{}'), ...extra }
          db.prepare('UPDATE contacts SET first_name=?, last_name=?, email=?, phone=?, mobile=COALESCE(?,mobile), company_id=?, language=?, notes=COALESCE(?,notes), extra_fields=? WHERE id=?')
            .run(getVal(rec.fields, fieldMap?.first_name) || '', lastName, getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.mobile), companyId, language, getVal(rec.fields, fieldMap?.notes), JSON.stringify(merged), existing.id)
        } else {
          db.prepare('INSERT INTO contacts (id, tenant_id, first_name, last_name, email, phone, mobile, company_id, language, notes, extra_fields, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), tenantId, getVal(rec.fields, fieldMap?.first_name) || '', lastName, getVal(rec.fields, fieldMap?.email), getVal(rec.fields, fieldMap?.phone), getVal(rec.fields, fieldMap?.mobile), companyId, language, getVal(rec.fields, fieldMap?.notes), extraJson, rec.id)
          contactsImported++
        }
      }
      db.prepare(`UPDATE airtable_sync_config SET last_synced_at=datetime('now') WHERE tenant_id=?`).run(tenantId)
      if (contactsImported > 0) console.log(`👤 Airtable: ${contactsImported} contacts imported`)
    } catch (e) { console.error('❌ Airtable contacts:', e.message) }
  }
}

export async function syncOrders(tenantId) {
  const config = db.prepare('SELECT * FROM airtable_orders_config WHERE tenant_id=?').get(tenantId)
  if (!config?.base_id || !config?.orders_table_id) { console.log('⚠️  Orders config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  // ── 1. Sync orders ────────────────────────────────────────────────────────
  try {
    const records = await fetchAllRecords(config.base_id, config.orders_table_id, accessToken)
    let fm = config.field_map_orders ? JSON.parse(config.field_map_orders) : null
    let imported = 0, updated = 0

    // Max order_number for auto-increment
    const maxNum = () => (db.prepare('SELECT MAX(order_number) as m FROM orders WHERE tenant_id=?').get(tenantId)?.m || 0)

    for (const rec of records) {
      if (!fm && rec.fields) {
        fm = {
          order_number: autoMapField(rec.fields, 'numéro', 'numero', 'order number', 'commande', '#'),
          company:      autoMapField(rec.fields, 'company', 'entreprise', 'client', 'compte'),
          project:      autoMapField(rec.fields, 'project', 'projet'),
          status:       autoMapField(rec.fields, 'status', 'statut', 'état'),
          priority:     autoMapField(rec.fields, 'priority', 'priorité', 'urgence'),
          notes:        autoMapField(rec.fields, 'notes', 'commentaires', 'description'),
          address:      autoMapField(rec.fields, 'adresse', 'adresse de livraison', 'shipping address', 'address', 'delivery address'),
        }
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
        'erreur système': 'ERREUR SYSTÈME', 'annulée': 'ERREUR SYSTÈME', 'canceled': 'ERREUR SYSTÈME',
      }
      const status = STATUS_MAP[rawStatus.toLowerCase()] || 'Commande vide'

      // Company lookup
      const companyId = lookupCompany(tenantId, rec.fields, fm?.company)

      // Project lookup
      const projectName = fm?.project ? getVal(rec.fields, fm.project) : null
      let projectId = null
      if (projectName) {
        const proj = db.prepare('SELECT id FROM projects WHERE tenant_id=? AND name LIKE ? LIMIT 1').get(tenantId, `%${projectName}%`)
        projectId = proj?.id || null
      }

      const notes    = getVal(rec.fields, fm?.notes)
      const priority = getVal(rec.fields, fm?.priority)

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

      const existing = db.prepare('SELECT id FROM orders WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE orders SET company_id=?, project_id=?, status=?, priority=?, notes=?, address_id=COALESCE(?,address_id), updated_at=datetime('now') WHERE id=?`)
          .run(companyId, projectId, status, priority, notes, addressId, existing.id)
        updated++
      } else {
        const rawNum = fm?.order_number ? parseInt(String(rec.fields[fm.order_number] ?? '').replace(/[^0-9]/g, '')) : NaN
        const orderNumber = isNaN(rawNum) || rawNum === 0 ? maxNum() + 1 : rawNum
        db.prepare('INSERT INTO orders (id, tenant_id, order_number, company_id, project_id, status, priority, notes, address_id, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, orderNumber, companyId, projectId, status, priority, notes, addressId, rec.id)
        imported++
      }
    }
    console.log(`📦 Orders: ${imported} importées, ${updated} mises à jour`)
  } catch (e) { console.error('❌ Orders sync:', e.message) }

  // ── 2. Sync order items ───────────────────────────────────────────────────
  if (!config.items_table_id) return
  try {
    const records = await fetchAllRecords(config.base_id, config.items_table_id, accessToken)
    let fm = config.field_map_items ? JSON.parse(config.field_map_items) : null
    let imported = 0, updated = 0

    for (const rec of records) {
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

      const order = db.prepare('SELECT id FROM orders WHERE tenant_id=? AND airtable_id=?').get(tenantId, orderAirtableId)
      if (!order) continue

      // Product lookup: linked record → array of record IDs, resolve via airtable_id
      const productLinkRaw = fm?.product ? rec.fields[fm.product] : null
      const productAirtableId = Array.isArray(productLinkRaw) ? productLinkRaw[0] : (typeof productLinkRaw === 'string' ? productLinkRaw : null)
      let productId = null
      if (productAirtableId) {
        const prod = db.prepare('SELECT id FROM products WHERE tenant_id=? AND airtable_id=?').get(tenantId, productAirtableId)
        productId = prod?.id || null
      }
      // Fallback: match by name
      if (!productId) {
        const productName = fm?.product ? getVal(rec.fields, fm.product) : null
        if (productName) {
          const prod = db.prepare('SELECT id FROM products WHERE tenant_id=? AND (name_fr LIKE ? OR name_en LIKE ? OR sku=?) LIMIT 1')
            .get(tenantId, `%${productName}%`, `%${productName}%`, productName)
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
    db.prepare(`UPDATE airtable_orders_config SET last_synced_at=datetime('now') WHERE tenant_id=?`).run(tenantId)
    console.log(`🧾 Order items: ${imported} importées, ${updated} mises à jour`)
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

export async function syncPieces(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='pieces'").get(tenantId)
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Pièces config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  const imagesDir = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'products')

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

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

      const nameFr = getVal(rec.fields, fieldMap?.name_fr)
      if (!nameFr) continue

      function toFloat(fieldKey) {
        const raw = fieldKey ? rec.fields[fieldKey] : null
        const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
        return isNaN(n) ? null : n
      }
      function toInt(fieldKey) {
        const raw = fieldKey ? rec.fields[fieldKey] : null
        const n = parseInt(String(raw ?? '').replace(/[^0-9]/g, ''))
        return isNaN(n) ? null : n
      }

      const validProcurement = ['Acheté', 'Fabriqué', 'Drop ship']
      const rawProcurement = getVal(rec.fields, fieldMap?.procurement_type) || ''
      const procurementType = validProcurement.find(p => p.toLowerCase() === rawProcurement.toLowerCase()) || null

      // Handle image attachment
      let imageUrl = null
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
          imageUrl = `/erp/api/product-images/${filename}`
        }
      }

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

      const existing = db.prepare('SELECT id FROM products WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE products SET name_fr=?, name_en=?, sku=?, type=?, unit_cost=?, price_cad=?, stock_qty=?, min_stock=?, supplier=?, procurement_type=?, weight_lbs=?, image_url=COALESCE(?,image_url), updated_at=datetime('now') WHERE id=?`)
          .run(payload.name_fr, payload.name_en, payload.sku, payload.type, payload.unit_cost, payload.price_cad, payload.stock_qty, payload.min_stock, payload.supplier, payload.procurement_type, payload.weight_lbs, payload.image_url, existing.id)
        updated++
      } else {
        db.prepare(`INSERT INTO products (id, tenant_id, name_fr, name_en, sku, type, unit_cost, price_cad, stock_qty, min_stock, supplier, procurement_type, weight_lbs, image_url, airtable_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), tenantId, payload.name_fr, payload.name_en, payload.sku, payload.type, payload.unit_cost, payload.price_cad, payload.stock_qty, payload.min_stock, payload.supplier, payload.procurement_type, payload.weight_lbs, payload.image_url, rec.id)
        imported++
      }
    }
    db.prepare(`UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='pieces'`).run(tenantId)
    console.log(`🔩 Pièces: ${imported} importées, ${updated} mises à jour`)
  } catch (e) { console.error('❌ Pièces sync:', e.message) }
}

export async function syncAchats(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='achats'").get(tenantId)
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Achats config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    for (const rec of records) {
      if (!fieldMap && rec.fields) {
        fieldMap = {
          product:        autoMapField(rec.fields, 'produit', 'pièce', 'piece', 'product', 'item'),
          supplier:       autoMapField(rec.fields, 'fournisseur', 'supplier', 'vendor'),
          reference:      autoMapField(rec.fields, 'référence', 'reference', 'ref', 'po', 'numéro'),
          order_date:     autoMapField(rec.fields, 'date commande', 'date achat', 'order date', 'date'),
          expected_date:  autoMapField(rec.fields, 'date prévue', 'date prevue', 'expected', 'livraison prévue'),
          received_date:  autoMapField(rec.fields, 'date réception', 'date reception', 'received date', 'reçu le'),
          qty_ordered:    autoMapField(rec.fields, 'qté commandée', 'qty ordered', 'quantité commandée', 'qte commandee'),
          qty_received:   autoMapField(rec.fields, 'qté reçue', 'qty received', 'quantité reçue', 'qte recue'),
          unit_cost:      autoMapField(rec.fields, 'coût unitaire', 'cout unitaire', 'unit cost', 'prix unitaire'),
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
        const n = parseInt(String(raw ?? '').replace(/[^0-9]/g, ''))
        return isNaN(n) ? null : n
      }

      // Product lookup: linked record → array of airtable record IDs
      let productId = null
      if (fieldMap?.product) {
        const raw = rec.fields[fieldMap.product]
        const linkedId = Array.isArray(raw) ? raw[0] : (typeof raw === 'string' ? raw : null)
        if (linkedId) {
          const prod = db.prepare('SELECT id FROM products WHERE tenant_id=? AND airtable_id=?').get(tenantId, linkedId)
          productId = prod?.id || null
          if (!productId) {
            // fallback: match by name/sku
            const nameStr = typeof linkedId === 'string' ? linkedId : null
            if (nameStr) {
              const prod2 = db.prepare('SELECT id FROM products WHERE tenant_id=? AND (name_fr LIKE ? OR sku LIKE ?) LIMIT 1').get(tenantId, `%${nameStr}%`, `%${nameStr}%`)
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

      const existing = db.prepare('SELECT id FROM purchases WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE purchases SET product_id=?, supplier=?, reference=?, order_date=?, expected_date=?, received_date=?, qty_ordered=?, qty_received=?, unit_cost=?, status=?, notes=?, updated_at=datetime('now') WHERE id=?`)
          .run(payload.product_id, payload.supplier, payload.reference, payload.order_date, payload.expected_date, payload.received_date, payload.qty_ordered, payload.qty_received, payload.unit_cost, payload.status, payload.notes, existing.id)
        updated++
      } else {
        db.prepare(`INSERT INTO purchases (id, tenant_id, airtable_id, product_id, supplier, reference, order_date, expected_date, received_date, qty_ordered, qty_received, unit_cost, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), tenantId, rec.id, payload.product_id, payload.supplier, payload.reference, payload.order_date, payload.expected_date, payload.received_date, payload.qty_ordered, payload.qty_received, payload.unit_cost, payload.status, payload.notes)
        imported++
      }
    }
    db.prepare(`UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='achats'`).run(tenantId)
    console.log(`🛒 Achats: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Achats sync:', e.message) }
}

export async function syncSerials(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='serials'").get(tenantId)
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Serials config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    for (const rec of records) {
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

      const companyId = lookupCompany(tenantId, rec.fields, fieldMap?.company)

      // Product lookup via linked record
      let productId = null
      if (fieldMap?.product) {
        const raw = rec.fields[fieldMap.product]
        const linkedId = Array.isArray(raw) ? raw[0] : null
        if (linkedId) {
          const prod = db.prepare('SELECT id FROM products WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, linkedId)
          productId = prod?.id || null
        }
        if (!productId) {
          const name = Array.isArray(raw) ? null : getVal(rec.fields, fieldMap.product)
          if (name) {
            const prod = db.prepare('SELECT id FROM products WHERE tenant_id=? AND (name_fr LIKE ? OR sku LIKE ?) LIMIT 1').get(tenantId, `%${name}%`, `%${name}%`)
            productId = prod?.id || null
          }
        }
      }

      // Order item lookup via linked record
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

      const existing = db.prepare('SELECT id FROM serial_numbers WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE serial_numbers SET serial=?, product_id=?, company_id=?, order_item_id=?, address=?, manufacture_date=?, last_programmed_date=?, manufacture_value=?, status=?, notes=?, updated_at=datetime('now') WHERE id=?`)
          .run(serial, productId, companyId, orderItemId, address, manufacture_date, last_programmed_date, manufacture_value, status, notes, existing.id)
        updated++
      } else {
        db.prepare(`INSERT INTO serial_numbers (id, tenant_id, airtable_id, serial, product_id, company_id, order_item_id, address, manufacture_date, last_programmed_date, manufacture_value, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), tenantId, rec.id, serial, productId, companyId, orderItemId, address, manufacture_date, last_programmed_date, manufacture_value, status, notes)
        imported++
      }
    }
    db.prepare(`UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='serials'`).run(tenantId)
    console.log(`🔢 Sériaux: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Serials sync:', e.message) }
}

export async function syncEnvois(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='envois'").get(tenantId)
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Envois config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    for (const rec of records) {
      if (!fieldMap && rec.fields) {
        fieldMap = {
          order:           autoMapField(rec.fields, 'commande', 'order', 'numéro de commande', 'order number'),
          tracking_number: autoMapField(rec.fields, 'numéro de suivi', 'numero de suivi', 'tracking number', 'tracking', 'suivi'),
          carrier:         autoMapField(rec.fields, 'transporteur', 'carrier', 'livreur', 'expéditeur'),
          status:          autoMapField(rec.fields, 'statut', 'status', 'état'),
          shipped_at:      autoMapField(rec.fields, "date d'envoi", 'date envoi', 'shipped at', 'shipped date', 'expédié le'),
          notes:           autoMapField(rec.fields, 'notes', 'commentaires'),
          address:         autoMapField(rec.fields, 'adresse', 'adresse de livraison', 'shipping address', 'address', 'delivery address'),
        }
      }

      // Order lookup via linked record
      let orderId = null
      if (fieldMap?.order) {
        const raw = rec.fields[fieldMap.order]
        const linkedId = Array.isArray(raw) ? raw[0] : null
        if (linkedId) {
          const o = db.prepare('SELECT id FROM orders WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, linkedId)
          orderId = o?.id || null
        }
        if (!orderId) {
          const orderNum = Array.isArray(raw) ? null : getVal(rec.fields, fieldMap.order)
          if (orderNum) {
            const o = db.prepare('SELECT id FROM orders WHERE tenant_id=? AND order_number=? LIMIT 1').get(tenantId, parseInt(orderNum))
            orderId = o?.id || null
          }
        }
      }

      const tracking_number = getVal(rec.fields, fieldMap?.tracking_number)
      const carrier         = getVal(rec.fields, fieldMap?.carrier)
      const status          = getVal(rec.fields, fieldMap?.status)
      const shipped_at      = getVal(rec.fields, fieldMap?.shipped_at)
      const notes           = getVal(rec.fields, fieldMap?.notes)

      // Address lookup via linked record
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
        db.prepare(`UPDATE shipments SET order_id=COALESCE(?,order_id), tracking_number=?, carrier=?, status=?, shipped_at=?, notes=?, address_id=COALESCE(?,address_id) WHERE id=?`)
          .run(orderId, tracking_number, carrier, status || 'À envoyer', shipped_at, notes, addressId, existing.id)
        updated++
      } else {
        if (!orderId) continue
        db.prepare(`INSERT INTO shipments (id, tenant_id, order_id, airtable_id, tracking_number, carrier, status, shipped_at, notes, address_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), tenantId, orderId, rec.id, tracking_number, carrier, status || 'À envoyer', shipped_at, notes, addressId)
        imported++
      }
    }
    db.prepare(`UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='envois'`).run(tenantId)
    console.log(`🚚 Envois: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Envois sync:', e.message) }
}

export async function syncBillets(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='billets'").get(tenantId)
  if (!config?.base_id || !config?.table_id) { console.log('⚠️  Billets config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    let fieldMap = config.field_map ? JSON.parse(config.field_map) : null
    let imported = 0, updated = 0

    for (const rec of records) {
      if (!fieldMap && rec.fields) {
        fieldMap = {
          title:            autoMapField(rec.fields, 'titre', 'title', 'sujet', 'subject', 'nom'),
          description:      autoMapField(rec.fields, 'description', 'détails', 'details'),
          type:             autoMapField(rec.fields, 'type', 'catégorie', 'categorie'),
          status:           autoMapField(rec.fields, 'statut', 'status', 'état'),
          company:          autoMapField(rec.fields, 'entreprise', 'company', 'client', 'compte'),
          contact:          autoMapField(rec.fields, 'contact', 'personne'),
          duration_minutes: autoMapField(rec.fields, 'durée', 'duree', 'duration', 'minutes', 'temps'),
          notes:            autoMapField(rec.fields, 'notes', 'commentaires'),
        }
      }

      const title = getVal(rec.fields, fieldMap?.title)
      if (!title) continue

      const STATUS_MAP = {
        'ouvert': 'Ouvert', 'open': 'Ouvert',
        'en attente client': 'En attente client', 'waiting client': 'En attente client',
        'en attente nous': 'En attente nous', 'waiting us': 'En attente nous', 'en cours': 'En attente nous',
        'fermé': 'Fermé', 'closed': 'Fermé', 'résolu': 'Fermé', 'resolu': 'Fermé',
      }
      const rawStatus = (getVal(rec.fields, fieldMap?.status) || '').trim()
      const status = !rawStatus ? 'Fermé' : (STATUS_MAP[rawStatus.toLowerCase()] || 'Ouvert')

      const TYPE_MAP = {
        'aide software': 'Aide software', 'defect software': 'Defect software',
        'aide hardware': 'Aide hardware', 'defect hardware': 'Defect hardware',
        'erreur de commande': 'Erreur de commande', 'formation': 'Formation', 'installation': 'Installation',
      }
      const rawType = (getVal(rec.fields, fieldMap?.type) || '').trim()
      const type = TYPE_MAP[rawType.toLowerCase()] || null

      function toInt(fieldKey) {
        const raw = fieldKey ? rec.fields[fieldKey] : null
        const n = parseInt(String(raw ?? '').replace(/[^0-9]/g, ''))
        return isNaN(n) ? null : n
      }

      const companyId = lookupCompany(tenantId, rec.fields, fieldMap?.company)

      // Contact lookup via linked record or name
      let contactId = null
      if (fieldMap?.contact) {
        const raw = rec.fields[fieldMap.contact]
        const linkedId = Array.isArray(raw) ? raw[0] : null
        if (linkedId) {
          const ct = db.prepare('SELECT id FROM contacts WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, linkedId)
          contactId = ct?.id || null
        }
        if (!contactId) {
          const name = Array.isArray(raw) ? null : getVal(rec.fields, fieldMap.contact)
          if (name) {
            const ct = db.prepare("SELECT id FROM contacts WHERE tenant_id=? AND (first_name || ' ' || last_name) LIKE ? LIMIT 1").get(tenantId, `%${name}%`)
            contactId = ct?.id || null
          }
        }
      }

      const payload = {
        title, status, type,
        description:      getVal(rec.fields, fieldMap?.description),
        duration_minutes: toInt(fieldMap?.duration_minutes) ?? 0,
        notes:            getVal(rec.fields, fieldMap?.notes),
        company_id:       companyId,
        contact_id:       contactId,
      }

      const existing = db.prepare('SELECT id FROM tickets WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE tickets SET title=?, description=?, type=?, status=?, company_id=?, contact_id=?, duration_minutes=?, notes=?, updated_at=datetime('now') WHERE id=?`)
          .run(payload.title, payload.description, payload.type, payload.status, payload.company_id, payload.contact_id, payload.duration_minutes, payload.notes, existing.id)
        updated++
      } else {
        db.prepare(`INSERT INTO tickets (id, tenant_id, airtable_id, title, description, type, status, company_id, contact_id, duration_minutes, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), tenantId, rec.id, payload.title, payload.description, payload.type, payload.status, payload.company_id, payload.contact_id, payload.duration_minutes, payload.notes)
        imported++
      }
    }
    db.prepare(`UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='billets'`).run(tenantId)
    console.log(`🎫 Billets: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Billets sync:', e.message) }
}

export async function syncInventaire(tenantId) {
  const config = db.prepare('SELECT * FROM airtable_inventaire_config WHERE tenant_id=?').get(tenantId)
  if (!config?.base_id || !config?.projects_table_id) { console.log('⚠️  Inventaire config missing'); return }

  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }

  try {
    const records = await fetchAllRecords(config.base_id, config.projects_table_id, accessToken)
    let fieldMap = config.field_map_projects ? JSON.parse(config.field_map_projects) : null
    let imported = 0, updated = 0

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
      const companyId = lookupCompany(tenantId, rec.fields, fieldMap?.company)

      function toFloat(fieldKey) {
        const raw = fieldKey ? rec.fields[fieldKey] : null
        const n = parseFloat(String(raw ?? '').replace(/[^0-9.-]/g, ''))
        return isNaN(n) ? null : n
      }
      function toInt(fieldKey) {
        const raw = fieldKey ? rec.fields[fieldKey] : null
        const n = parseInt(String(raw ?? '').replace(/[^0-9]/g, ''))
        return isNaN(n) ? null : n
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

      const existing = db.prepare('SELECT id FROM projects WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE projects SET name=?, company_id=?, status=?, type=?, value_cad=?, probability=?, monthly_cad=?, nb_greenhouses=?, close_date=?, notes=?, updated_at=datetime('now') WHERE id=?`)
          .run(name, companyId, status, type, valueCad, probability, monthlyCad, nbGreenhouses, closeDate, notes, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO projects (id, tenant_id, name, company_id, status, type, value_cad, probability, monthly_cad, nb_greenhouses, close_date, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, name, companyId, status, type, valueCad, probability, monthlyCad, nbGreenhouses, closeDate, notes, rec.id)
        imported++
      }
    }
    // Sync extra tables (additional Airtable tables mapped to projects)
    const extraTables = config.extra_tables ? JSON.parse(config.extra_tables) : []
    for (const extra of extraTables) {
      if (!extra.table_id) continue
      const extraRecords = await fetchAllRecords(config.base_id, extra.table_id, accessToken)
      const extraFieldMap = extra.field_map || {}
      for (const rec of extraRecords) {
        const name = getVal(rec.fields, extraFieldMap.name)
        if (!name) continue
        const rawStatus2 = (getVal(rec.fields, extraFieldMap.status) || '').trim()
        const STATUS_CHOICES2 = extraFieldMap.status_choices || { 'Oui': 'Gagné', 'Non': 'Perdu' }
        const status2 = STATUS_CHOICES2[rawStatus2] || 'Ouvert'
        const rawType2 = getVal(rec.fields, extraFieldMap.type) || ''
        const TYPE_CHOICES2 = extraFieldMap.type_choices || {}
        const type2 = TYPE_CHOICES2[rawType2] || validTypes.find(t => t.toLowerCase() === rawType2.toLowerCase()) || null
        const companyId2 = lookupCompany(tenantId, rec.fields, extraFieldMap.company)
        function toF(k) { const r = k ? rec.fields[k] : null; const n = parseFloat(String(r ?? '').replace(/[^0-9.-]/g, '')); return isNaN(n) ? null : n }
        function toI(k) { const r = k ? rec.fields[k] : null; const n = parseInt(String(r ?? '').replace(/[^0-9]/g, '')); return isNaN(n) ? null : n }
        const rawProb2 = extraFieldMap.probability ? rec.fields[extraFieldMap.probability] : null
        const pf2 = parseFloat(String(rawProb2 ?? ''))
        const prob2 = isNaN(pf2) ? null : Math.round(pf2 > 1 ? pf2 : pf2 * 100)
        const existing2 = db.prepare('SELECT id FROM projects WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
        if (existing2) {
          db.prepare(`UPDATE projects SET name=?, company_id=?, status=?, type=?, value_cad=?, probability=?, monthly_cad=?, nb_greenhouses=?, close_date=?, notes=?, updated_at=datetime('now') WHERE id=?`)
            .run(name, companyId2, status2, type2, toF(extraFieldMap.value_cad), prob2, toF(extraFieldMap.monthly_cad), toI(extraFieldMap.nb_greenhouses), getVal(rec.fields, extraFieldMap.close_date), getVal(rec.fields, extraFieldMap.notes), existing2.id)
          updated++
        } else {
          db.prepare('INSERT INTO projects (id, tenant_id, name, company_id, status, type, value_cad, probability, monthly_cad, nb_greenhouses, close_date, notes, airtable_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uuid(), tenantId, name, companyId2, status2, type2, toF(extraFieldMap.value_cad), prob2, toF(extraFieldMap.monthly_cad), toI(extraFieldMap.nb_greenhouses), getVal(rec.fields, extraFieldMap.close_date), getVal(rec.fields, extraFieldMap.notes), rec.id)
          imported++
        }
      }
    }

    db.prepare(`UPDATE airtable_inventaire_config SET last_synced_at=datetime('now') WHERE tenant_id=?`).run(tenantId)
    console.log(`📋 Inventaire: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Inventaire sync:', e.message) }
}

// ── helper used by multiple sync functions
function lookupSerial(tenantId, airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM serial_numbers WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, airtableId)?.id || null
}
function lookupProject(tenantId, airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM projects WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, airtableId)?.id || null
}
function lookupProduct(tenantId, airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM products WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, airtableId)?.id || null
}
function lookupContact(tenantId, airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM contacts WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, airtableId)?.id || null
}
function lookupOrder(tenantId, airtableId) {
  if (!airtableId) return null
  return db.prepare('SELECT id FROM orders WHERE tenant_id=? AND airtable_id=? LIMIT 1').get(tenantId, airtableId)?.id || null
}
function firstLinked(fields, fieldName) {
  if (!fieldName || !(fieldName in fields)) return null
  const v = fields[fieldName]
  return Array.isArray(v) ? (v[0] || null) : (typeof v === 'string' ? v : null)
}

export async function syncSoumissions(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='soumissions'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const projectAirtableId = firstLinked(rec.fields, fm.project)
      const projectId = lookupProject(tenantId, projectAirtableId)
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
      const existing = db.prepare('SELECT id FROM soumissions WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE soumissions SET project_id=?, quote_url=?, pdf_url=?, purchase_price_cad=?, subscription_price_cad=?, expiration_date=?, updated_at=datetime('now') WHERE id=?`)
          .run(projectId, quoteUrl, pdfUrl, purchasePrice, subscriptionPrice, expirationDate, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO soumissions (id, tenant_id, airtable_id, project_id, quote_url, pdf_url, purchase_price_cad, subscription_price_cad, expiration_date) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, projectId, quoteUrl, pdfUrl, purchasePrice, subscriptionPrice, expirationDate)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='soumissions'").run(tenantId)
    console.log(`📝 Soumissions: ${imported} importées, ${updated} mises à jour`)
  } catch (e) { console.error('❌ Soumissions sync:', e.message) }
}

export async function syncRetours(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='retours'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const companyId = lookupCompany(tenantId, rec.fields, fm.company)
      const contactId = lookupContact(tenantId, firstLinked(rec.fields, fm.contact))
      const returnNumber = getVal(rec.fields, fm.return_number)
      const status = getVal(rec.fields, fm.status) || 'Ouvert'
      const problemStatus = getVal(rec.fields, fm.problem_status)
      const processingStatus = getVal(rec.fields, fm.processing_status)
      const trackingNumber = getVal(rec.fields, fm.tracking_number)
      const notes = getVal(rec.fields, fm.notes)
      const billedAt = getVal(rec.fields, fm.billed_at)
      const existing = db.prepare('SELECT id FROM returns WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE returns SET company_id=?, contact_id=?, return_number=?, status=?, problem_status=?, processing_status=?, tracking_number=?, notes=?, billed_at=?, updated_at=datetime('now') WHERE id=?`)
          .run(companyId, contactId, returnNumber, status, problemStatus, processingStatus, trackingNumber, notes, billedAt, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO returns (id, tenant_id, airtable_id, company_id, contact_id, return_number, status, problem_status, processing_status, tracking_number, notes, billed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, companyId, contactId, returnNumber, status, problemStatus, processingStatus, trackingNumber, notes, billedAt)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='retours'").run(tenantId)
    console.log(`↩️ Retours: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Retours sync:', e.message) }
}

export async function syncRetourItems(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='retour_items'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const retourAirtableId = firstLinked(rec.fields, fm.return)
      const retour = retourAirtableId ? db.prepare('SELECT id FROM returns WHERE tenant_id=? AND airtable_id=?').get(tenantId, retourAirtableId) : null
      if (!retour) continue
      const productId = lookupProduct(tenantId, firstLinked(rec.fields, fm.product_to_receive))
      const productSendId = lookupProduct(tenantId, firstLinked(rec.fields, fm.product_to_send))
      const serialId = lookupSerial(tenantId, firstLinked(rec.fields, fm.serial))
      const companyId = lookupCompany(tenantId, rec.fields, fm.company)
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
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='retour_items'").run(tenantId)
    console.log(`📦 Retour items: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Retour items sync:', e.message) }
}

export async function syncAdresses(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='adresses'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const companyId = lookupCompany(tenantId, rec.fields, fm.company)
      const contactId = lookupContact(tenantId, firstLinked(rec.fields, fm.contact))
      const line1 = getVal(rec.fields, fm.line1)
      const city = getVal(rec.fields, fm.city)
      const province = getVal(rec.fields, fm.province)
      const postalCode = getVal(rec.fields, fm.postal_code)
      const country = getVal(rec.fields, fm.country)
      const language = getVal(rec.fields, fm.language)
      const addressType = getVal(rec.fields, fm.address_type)
      const existing = db.prepare('SELECT id FROM adresses WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE adresses SET company_id=?, contact_id=?, line1=?, city=?, province=?, postal_code=?, country=?, language=?, address_type=?, updated_at=datetime('now') WHERE id=?`)
          .run(companyId, contactId, line1, city, province, postalCode, country, language, addressType, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO adresses (id, tenant_id, airtable_id, company_id, contact_id, line1, city, province, postal_code, country, language, address_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, companyId, contactId, line1, city, province, postalCode, country, language, addressType)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='adresses'").run(tenantId)
    console.log(`📍 Adresses: ${imported} importées, ${updated} mises à jour`)
  } catch (e) { console.error('❌ Adresses sync:', e.message) }
}

export async function syncBomItems(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='bom'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const productId = lookupProduct(tenantId, firstLinked(rec.fields, fm.product))
      const componentId = lookupProduct(tenantId, firstLinked(rec.fields, fm.component))
      if (!productId && !componentId) continue
      const qtyRequired = parseFloat(String(rec.fields[fm.qty_required] ?? 1).replace(/[^0-9.-]/g, '')) || 1
      const refDes = getVal(rec.fields, fm.ref_des)
      const existing = db.prepare('SELECT id FROM bom_items WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE bom_items SET product_id=?, component_id=?, qty_required=?, ref_des=?, updated_at=datetime('now') WHERE id=?`)
          .run(productId, componentId, qtyRequired, refDes, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO bom_items (id, tenant_id, airtable_id, product_id, component_id, qty_required, ref_des) VALUES (?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, productId, componentId, qtyRequired, refDes)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='bom'").run(tenantId)
    console.log(`🔩 BOM items: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ BOM sync:', e.message) }
}

export async function syncSerialStateChanges(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='serial_changes'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0
    for (const rec of records) {
      const serialId = lookupSerial(tenantId, firstLinked(rec.fields, fm.serial))
      const previousStatus = getVal(rec.fields, fm.previous_status)
      const newStatus = getVal(rec.fields, fm.new_status)
      const changedAt = getVal(rec.fields, fm.changed_at)
      const existing = db.prepare('SELECT id FROM serial_state_changes WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (!existing) {
        db.prepare('INSERT INTO serial_state_changes (id, tenant_id, airtable_id, serial_id, previous_status, new_status, changed_at) VALUES (?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, serialId, previousStatus, newStatus, changedAt)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='serial_changes'").run(tenantId)
    console.log(`🔄 Serial state changes: ${imported} importés`)
  } catch (e) { console.error('❌ Serial changes sync:', e.message) }
}

export async function syncAbonnements(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='abonnements'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const companyId = lookupCompany(tenantId, rec.fields, fm.company)
      const stripeId = getVal(rec.fields, fm.stripe_id)
      const startDate = getVal(rec.fields, fm.start_date)
      const canceledAt = getVal(rec.fields, fm.canceled_at)
      const monthlyAmountCad = parseFloat(String(rec.fields[fm.monthly_amount_cad] ?? 0).replace(/[^0-9.-]/g, '')) || 0
      const type = getVal(rec.fields, fm.type)
      const status = getVal(rec.fields, fm.status) || 'active'
      const intervalCount = parseInt(String(rec.fields[fm.interval_count] ?? 1)) || 1
      const intervalType = getVal(rec.fields, fm.interval_type)
      const currency = getVal(rec.fields, fm.currency) || 'CAD'
      const customerId = getVal(rec.fields, fm.customer_id)
      const customerEmail = getVal(rec.fields, fm.customer_email)
      const trialEndDate = getVal(rec.fields, fm.trial_end_date)
      const stripeUrl = getVal(rec.fields, fm.stripe_url)
      const amountAfterDiscount = parseFloat(String(rec.fields[fm.amount_after_discount] ?? 0).replace(/[^0-9.-]/g, '')) || 0
      const existing = db.prepare('SELECT id FROM subscriptions WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE subscriptions SET company_id=?, stripe_id=?, start_date=?, cancel_date=?, amount_monthly=?, type=?, status=?, interval_count=?, interval_type=?, currency=?, customer_id=?, customer_email=?, trial_end_date=?, stripe_url=?, amount_after_discount=? WHERE id=?`)
          .run(companyId, stripeId, startDate, canceledAt, monthlyAmountCad, type, status, intervalCount, intervalType, currency, customerId, customerEmail, trialEndDate, stripeUrl, amountAfterDiscount, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO subscriptions (id, tenant_id, airtable_id, company_id, stripe_id, start_date, cancel_date, amount_monthly, type, status, interval_count, interval_type, currency, customer_id, customer_email, trial_end_date, stripe_url, amount_after_discount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, companyId, stripeId, startDate, canceledAt, monthlyAmountCad, type, status, intervalCount, intervalType, currency, customerId, customerEmail, trialEndDate, stripeUrl, amountAfterDiscount)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='abonnements'").run(tenantId)
    console.log(`💳 Abonnements: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Abonnements sync:', e.message) }
}

export async function syncAssemblages(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='assemblages'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const productId = lookupProduct(tenantId, firstLinked(rec.fields, fm.product))
      const qtyProduced = parseInt(String(rec.fields[fm.qty_produced] ?? 0)) || 0
      const assembledAt = getVal(rec.fields, fm.assembled_at)
      const assemblyPoints = parseInt(String(rec.fields[fm.assembly_points] ?? 0)) || 0
      const existing = db.prepare('SELECT id FROM assemblages WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE assemblages SET product_id=?, qty_produced=?, assembled_at=?, assembly_points=?, updated_at=datetime('now') WHERE id=?`)
          .run(productId, qtyProduced, assembledAt, assemblyPoints, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO assemblages (id, tenant_id, airtable_id, product_id, qty_produced, assembled_at, assembly_points) VALUES (?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, productId, qtyProduced, assembledAt, assemblyPoints)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='assemblages'").run(tenantId)
    console.log(`🔨 Assemblages: ${imported} importés, ${updated} mis à jour`)
  } catch (e) { console.error('❌ Assemblages sync:', e.message) }
}

export async function syncFactures(tenantId) {
  const config = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module='factures'").get(tenantId)
  if (!config?.base_id || !config?.table_id) return
  let accessToken
  try { accessToken = await getAccessToken(tenantId) }
  catch (e) { console.error('❌ Airtable token:', e.message); return }
  try {
    const records = await fetchAllRecords(config.base_id, config.table_id, accessToken)
    const fm = config.field_map ? JSON.parse(config.field_map) : {}
    let imported = 0, updated = 0
    for (const rec of records) {
      const companyId = lookupCompany(tenantId, rec.fields, fm.company)
      const projectId = lookupProject(tenantId, firstLinked(rec.fields, fm.project))
      const orderId = lookupOrder(tenantId, firstLinked(rec.fields, fm.order))
      const invoiceId = getVal(rec.fields, fm.invoice_id)
      const documentNumber = getVal(rec.fields, fm.document_number)
      const documentDate = getVal(rec.fields, fm.document_date)
      const dueDate = getVal(rec.fields, fm.due_date)
      const status = getVal(rec.fields, fm.status)
      const currency = getVal(rec.fields, fm.currency) || 'CAD'
      const amountBeforeTaxCad = parseFloat(String(rec.fields[fm.amount_before_tax_cad] ?? 0).replace(/[^0-9.-]/g, '')) || 0
      const totalAmount = parseFloat(String(rec.fields[fm.total_amount] ?? 0).replace(/[^0-9.-]/g, '')) || 0
      const balanceDue = parseFloat(String(rec.fields[fm.balance_due] ?? 0).replace(/[^0-9.-]/g, '')) || 0
      const notes = getVal(rec.fields, fm.notes)
      const existing = db.prepare('SELECT id FROM factures WHERE tenant_id=? AND airtable_id=?').get(tenantId, rec.id)
      if (existing) {
        db.prepare(`UPDATE factures SET company_id=?, project_id=?, order_id=?, invoice_id=?, document_number=?, document_date=?, due_date=?, status=?, currency=?, amount_before_tax_cad=?, total_amount=?, balance_due=?, notes=?, updated_at=datetime('now') WHERE id=?`)
          .run(companyId, projectId, orderId, invoiceId, documentNumber, documentDate, dueDate, status, currency, amountBeforeTaxCad, totalAmount, balanceDue, notes, existing.id)
        updated++
      } else {
        db.prepare('INSERT INTO factures (id, tenant_id, airtable_id, company_id, project_id, order_id, invoice_id, document_number, document_date, due_date, status, currency, amount_before_tax_cad, total_amount, balance_due, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuid(), tenantId, rec.id, companyId, projectId, orderId, invoiceId, documentNumber, documentDate, dueDate, status, currency, amountBeforeTaxCad, totalAmount, balanceDue, notes)
        imported++
      }
    }
    db.prepare("UPDATE airtable_module_config SET last_synced_at=datetime('now') WHERE tenant_id=? AND module='factures'").run(tenantId)
    console.log(`🧾 Factures: ${imported} importées, ${updated} mises à jour`)
  } catch (e) { console.error('❌ Factures sync:', e.message) }
}
