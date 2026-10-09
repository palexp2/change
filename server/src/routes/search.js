import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Concaténation SQL de colonnes cherchables (NULL-safe), séparées par un espace.
const cat = (...cols) => `(${cols.map(c => `COALESCE(${c},'')`).join(" || ' ' || ")})`

router.get('/', requireAuth, (req, res) => {
  const { q = '' } = req.query
  const term = q.trim()
  if (!term || term.length < 2) return res.json({ results: [] })

  // La requête est découpée en mots : « Simon Desforges » ne se trouve dans
  // aucune colonne prise seule, mais chaque mot se trouve dans la concaténation
  // prénom + nom + courriel. Tous les mots doivent matcher, dans n'importe quel
  // ordre.
  const words = term.split(/\s+/).filter(Boolean)
  const like = `%${term}%`

  // `hay` : expression SQL des colonnes cherchables (voir `cat`).
  const allWords = (hay) => words.map(() => `${hay} LIKE ?`).join(' AND ')
  const wordParams = () => words.map(w => `%${w}%`)

  // Tri de pertinence — indispensable avec un `LIMIT` : sans lui, la coupe se
  // faisait dans l'ordre physique de la table (50 contacts « Simon », le bon
  // loin dans le tas → jamais montré).
  //  1. le libellé principal commence par le premier mot ;
  const prefixRank = (label) => `CASE WHEN ${label} LIKE ? THEN 0 ELSE 1 END`
  const prefixParam = () => `${words[0]}%`
  //  2. tous les mots sont dans le libellé principal (plutôt que dans un champ
  //     secondaire : courriel, téléphone, alias…), puis 1.
  const rankBy = (label) => `CASE WHEN ${allWords(label)} THEN 0 ELSE 1 END, ${prefixRank(label)}`
  const rankParams = () => [...wordParams(), prefixParam()]

  const results = []

  // Companies
  // Téléphone et site web ont été droppés (migration 045) : une entreprise se
  // cherche par son nom, et sa ville sert de sous-titre.
  const companies = db.prepare(`
    SELECT id, name, city FROM companies
    WHERE deleted_at IS NULL AND ${allWords('name')}
    ORDER BY ${prefixRank('name')}, length(name), name
    LIMIT 8
  `).all(...wordParams(), prefixParam())
  companies.forEach(r => results.push({
    type: 'company', id: r.id, label: r.name,
    sub: r.city || '',
    url: `/companies/${r.id}`
  }))

  // Contacts
  const contactName = cat('c.first_name', 'c.last_name')
  const contacts = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
           co.name AS company_name
    FROM contacts c
    LEFT JOIN companies co ON co.id = c.company_id
    WHERE c.deleted_at IS NULL AND ${allWords(cat('c.first_name', 'c.last_name', 'c.email', 'c.phone'))}
    ORDER BY ${rankBy(contactName)}, c.last_name, c.first_name
    LIMIT 8
  `).all(...wordParams(), ...rankParams())
  contacts.forEach(r => results.push({
    type: 'contact', id: r.id,
    label: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    sub: r.company_name || r.email || '',
    url: `/contacts/${r.id}`
  }))

  // Projects (pipeline)
  const projects = db.prepare(`
    SELECT id, name, status FROM projects
    WHERE deleted_at IS NULL AND ${allWords('name')}
    ORDER BY ${prefixRank('name')}, length(name), name
    LIMIT 6
  `).all(...wordParams(), prefixParam())
  projects.forEach(r => results.push({
    type: 'project', id: r.id, label: r.name,
    sub: r.status || '',
    url: `/pipeline/${r.id}`
  }))

  // Orders
  const orders = db.prepare(`
    SELECT o.id, o.order_number, c.name AS company_name
    FROM orders o
    LEFT JOIN companies c ON c.id = o.company_id
    WHERE o.deleted_at IS NULL
      AND ${allWords(cat('o.order_number', 'c.name'))}
    ORDER BY ${prefixRank("COALESCE(o.order_number,'')")}, o.order_number DESC
    LIMIT 6
  `).all(...wordParams(), prefixParam())
  orders.forEach(r => results.push({
    type: 'order', id: r.id,
    label: `#${r.order_number}`,
    sub: r.company_name || '',
    url: `/orders/${r.id}`
  }))

  // Products
  const productName = cat('name_fr', 'name_en')
  const products = db.prepare(`
    SELECT id, name_fr, name_en, sku FROM products
    WHERE ${allWords(cat('name_fr', 'name_en', 'sku'))}
    ORDER BY ${rankBy(productName)}, name_fr
    LIMIT 6
  `).all(...wordParams(), ...rankParams())
  products.forEach(r => results.push({
    type: 'product', id: r.id, label: r.name_fr || r.name_en || r.sku,
    sub: r.sku || '',
    url: `/products/${r.id}`
  }))

  // Serial numbers
  const serials = db.prepare(`
    SELECT sn.id, sn.serial, sn.status, pr.name_fr AS product_name
    FROM serial_numbers sn
    LEFT JOIN products pr ON pr.id = sn.product_id
    WHERE sn.serial LIKE ?
    ORDER BY ${prefixRank('sn.serial')}, sn.serial
    LIMIT 6
  `).all(like, prefixParam())
  serials.forEach(r => results.push({
    type: 'serial', id: r.id,
    label: r.serial,
    sub: r.product_name || r.status || '',
    url: `/serials/${r.id}`
  }))

  // Billets : hors recherche globale depuis la migration 040 — titre,
  // entreprise et contact ont été droppés, il ne reste rien à chercher.

  // Achats fournisseurs (factures + dépenses dans la même table)
  const achats = db.prepare(`
    SELECT id, type, vendor, vendor_invoice_number, bill_number, reference,
           description, total_cad, date_achat
    FROM achats_fournisseurs
    WHERE ${allWords(cat('vendor', 'vendor_invoice_number', 'bill_number', 'reference', 'description'))}
    ORDER BY date_achat DESC
    LIMIT 8
  `).all(...wordParams())
  achats.forEach(r => {
    const isBill = r.type === 'bill'
    const num = r.vendor_invoice_number || r.bill_number || r.reference || ''
    const label = isBill
      ? `Facture ${num || '—'}`
      : `Dépense ${num || (r.description ? r.description.slice(0, 40) : '—')}`
    const sub = [
      r.vendor,
      r.date_achat,
      r.total_cad != null ? `${Number(r.total_cad).toFixed(2)} CAD` : null,
    ].filter(Boolean).join(' · ')
    results.push({
      type: isBill ? 'bill' : 'expense',
      id: r.id, label, sub,
      url: `/achats-fournisseurs?id=${r.id}`,
    })
  })

  // Profils fournisseurs (nom canonique ou alias)
  const vendorProfiles = db.prepare(`
    SELECT id, name, qb_category FROM vendor_profiles
    WHERE deleted_at IS NULL
      AND ${allWords(cat('name', 'aliases'))}
    ORDER BY ${rankBy('name')}, name
    LIMIT 6
  `).all(...wordParams(), ...rankParams())
  vendorProfiles.forEach(r => results.push({
    type: 'vendor_profile', id: r.id, label: r.name,
    sub: r.qb_category || '',
    url: `/fournisseurs?open=${r.id}`
  }))

  res.json({ results })
})

export default router
