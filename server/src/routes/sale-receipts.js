import { Router } from 'express'
import { randomUUID } from 'crypto'
import multer from 'multer'
import { join, extname } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { pushSaleReceiptToQB } from '../services/quickbooks.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { runExtractionAndUpdate } from '../services/saleReceiptExtraction.js'
import { syncReceiptAnomalies, receiptObsolescence } from '../services/transactionAnomalies.js'
import { listTransactionTypes } from '../services/fiscalStatus.js'
import { resolveFiscalDetection } from '../services/fiscalDetection.js'
import { findVendorProfile, serializeProfile, profileDefaultsForCurrency } from '../services/vendorProfiles.js'
import { matchReceiptItems, completeLiaDescription, LIA_AUTO_THRESHOLD, LIA_SUGGEST_THRESHOLD } from '../services/purchaseLiaMatch.js'
import { detectPrepaidStatement, attachStatementToMonthQb, monthLabel } from '../services/prepaidStatementAttach.js'

// Construit l'URL QB d'un reçu poussé. Les rangées antérieures au toggle
// Purchase/Bill n'ont pas de quickbooks_type ; on les traite comme 'purchase'.
function buildQbUrl(row) {
  if (!row.quickbooks_id) return null
  const entity = row.quickbooks_type === 'bill' ? 'bill'
    : row.quickbooks_type === 'cc_credit' ? 'creditcardcredit'
    : 'expense'
  return qbEntityUrl(entity, row.quickbooks_id)
}

function serializeRow(row) {
  let items = []
  try { items = JSON.parse(row.items || '[]') }
  catch (e) { console.error(`sale_receipts.items malformed for id=${row.id}: ${e.message}`) }
  // Document multipage : page 1 = filename/file_type, pages suivantes = extra_pages.
  // On expose une liste unifiée `pages` (métadonnées seules, pas le binaire) + le compte,
  // pour que la fiche détail affiche chaque page via /:id/file?page=N.
  let extraPages = []
  try { extraPages = JSON.parse(row.extra_pages || '[]') }
  catch (e) { console.error(`sale_receipts.extra_pages malformed for id=${row.id}: ${e.message}`) }
  const pages = [
    { file_type: row.file_type, original_name: row.original_name },
    ...extraPages.map(p => ({ file_type: p.file_type, original_name: p.original_name })),
  ]
  // Profil fournisseur : défauts comptables par fournisseur (services/vendorProfiles.js).
  // Rattaché à l'extraction (vendor_profile_id), sinon résolu à la volée par nom —
  // et alors persisté (backfill) pour les prochains chargements. `vendor_defaults`
  // expose les défauts résolus pour LA devise du reçu (vendor QB, comptes, code…).
  let vendor_profile = null
  try {
    if (row.vendor_profile_id) {
      const p = db.prepare('SELECT * FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(row.vendor_profile_id)
      vendor_profile = serializeProfile(p)
    }
    if (!vendor_profile && row.company) {
      vendor_profile = findVendorProfile(row.company)
      if (vendor_profile) {
        db.prepare('UPDATE sale_receipts SET vendor_profile_id=? WHERE id=?').run(vendor_profile.id, row.id)
      }
    }
  } catch (e) { console.error(`vendor profile lookup failed for id=${row.id}: ${e.message}`) }
  // Détection fiscale (type de transaction + code de taxe probables) calculée à la
  // volée en croisant profil fournisseur, historique publié, classification IA du
  // document et heuristiques — chaque signal validé contre les montants extraits
  // (services/fiscalDetection.js). Sert de présélection à CONFIRMER : le type retenu
  // n'est écrit qu'à la publication (transaction_type). suggested_transaction_type
  // reste exposé (compat) et pointe désormais sur le type détecté.
  let fiscal_detection = null
  try {
    fiscal_detection = resolveFiscalDetection({ ...row, items }, { profile: vendor_profile })
  } catch (e) { console.error(`resolveFiscalDetection failed for id=${row.id}: ${e.message}`) }
  // Obsolescence : document sans objet comptable — total 0 $ ou copie d'un document
  // déjà publié sur QuickBooks (transactionAnomalies.receiptObsolescence). `qb_url`
  // pointe la transaction QB EXISTANTE (celle du document original), pour vérifier
  // d'un clic que la pièce est bien déjà comptabilisée avant de l'archiver.
  let obsolete = null
  try {
    if (row.status === 'done' && !row.quickbooks_id && !row.archived_at) {
      obsolete = receiptObsolescence(row.id)
      if (obsolete) obsolete.qb_url = obsolete.qb_id ? qbEntityUrl(obsolete.qb_entity, obsolete.qb_id) : null
    }
  } catch (e) { console.error(`receiptObsolescence failed for id=${row.id}: ${e.message}`) }
  // Relevé mensuel d'un fournisseur prépayé (Twilio) : document récapitulatif dont
  // la dépense est déjà comptabilisée par les recharges du mois — non nul, l'UI
  // propose de le joindre aux transactions QB du mois (prepaidStatementAttach.js).
  let prepaid_statement = null
  try { prepaid_statement = detectPrepaidStatement(row) }
  catch (e) { console.error(`detectPrepaidStatement failed for id=${row.id}: ${e.message}`) }
  return {
    ...row,
    items,
    pages,
    prepaid_statement,
    page_count: pages.length,
    fiscal_detection,
    suggested_transaction_type: fiscal_detection?.transaction_type || null,
    obsolete,
    quickbooks_url: buildQbUrl(row),
    vendor_profile,
    vendor_defaults: vendor_profile ? profileDefaultsForCurrency(vendor_profile, row.currency) : null,
  }
}

function fetchSaleReceiptRow(id) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(id)
  if (!row) return null
  return serializeRow(row)
}

// Journal d'événements d'un reçu (ajout / modifications / archivage / publication).
// Table persistante sale_receipt_events — distincte du change_log (rétention 48h).
function logReceiptEvent(receiptId, userId, action, detail = null) {
  try {
    db.prepare('INSERT INTO sale_receipt_events (id, receipt_id, user_id, action, detail) VALUES (?,?,?,?,?)')
      .run(randomUUID(), receiptId, userId || null, action, detail)
  } catch (e) {
    console.error('logReceiptEvent failed:', e.message)
  }
}

// Libellés FR des champs éditables — pour le détail d'un événement 'updated'.
const FIELD_LABELS = {
  company: 'Entreprise', address: 'Adresse', receipt_number: 'N° de reçu',
  payment_method: 'Mode de paiement', receipt_date: 'Date', currency: 'Devise',
  subtotal: 'Sous-total', tps: 'TPS', tvq: 'TVQ', other_taxes: 'Autres taxes',
  total: 'Total', items: 'Articles', memo: 'Mémo', general_description: 'Description générale',
  service_period: 'Période couverte',
  quickbooks_id: 'Lien QuickBooks', quickbooks_type: 'Type QuickBooks',
  transaction_type: 'Type de transaction', fiscal_force_reason: 'Justification écart fiscal',
  due_date: 'Échéance', payment_terms_days: 'Termes de paiement (jours)',
  expense_account_id: 'Compte de dépense', payment_account_id: 'Compte de paiement',
  tax_code_id: 'Code de taxe', vendor_id: 'Fournisseur QB',
  bank_charged_total: 'Montant passé à la banque',
}

const router = Router()
router.use(requireAuth)

const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'receipts')
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
})
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase()
    if (ALLOWED_EXT.includes(ext)) cb(null, true)
    else cb(new Error('Type de fichier non supporté. Formats acceptés: JPG, PNG, GIF, WEBP, PDF'))
  },
})

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { page = 1, limit = 100 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  const total = db.prepare('SELECT COUNT(*) as c FROM sale_receipts WHERE deleted_at IS NULL').get().c
  const rows = db.prepare(`
    SELECT * FROM sale_receipts
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limitVal, offset)

  const parsed = rows.map(serializeRow)
  res.json({ data: parsed, total, page: parseInt(page), limit: parseInt(limit) })
})

// Liste des types de transaction (référentiel fiscal) — pour le sélecteur du
// formulaire de publication. Défini AVANT /:id pour ne pas être pris pour un id.
router.get('/transaction-types', (req, res) => {
  res.json({ data: listTransactionTypes() })
})

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(serializeRow(row))
})

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const editable = ['company', 'address', 'receipt_number', 'general_description', 'service_period', 'payment_method', 'receipt_date', 'currency', 'subtotal', 'tps', 'tvq', 'other_taxes', 'total', 'items', 'memo', 'quickbooks_id', 'quickbooks_type', 'expense_account_id', 'payment_account_id', 'tax_code_id', 'vendor_id', 'transaction_type', 'due_date', 'payment_terms_days', 'bank_charged_total']
  // bank_charged_total : paramètre de publication (conversion de devise) — persisté
  // comme brouillon pour être retrouvé au retour sur la facture.
  const numericFields = new Set(['subtotal', 'tps', 'tvq', 'other_taxes', 'total', 'bank_charged_total'])
  // expense_account_id/payment_account_id/tax_code_id/vendor_id : modèle de
  // comptabilisation mémorisé par fournisseur — éditables à la main pour corriger un
  // modèle erroné, et autosauvegardés comme BROUILLON par le formulaire de publication
  // (les choix faits avant de quitter la fiche sont retrouvés au retour).
  // transaction_type : statut fiscal — éditable pour corriger un classement a posteriori.
  const textFields = new Set(['company', 'address', 'receipt_number', 'general_description', 'service_period', 'payment_method', 'memo', 'expense_account_id', 'payment_account_id', 'tax_code_id', 'vendor_id', 'transaction_type'])
  const sets = []
  const values = []
  for (const key of editable) {
    if (key in req.body) {
      let v = req.body[key]
      if (textFields.has(key)) {
        v = v == null ? null : String(v).trim() || null
      } else if (key === 'receipt_date' || key === 'due_date') {
        // Dates métier date-only (YYYY-MM-DD) — pas de composante horaire/UTC.
        v = v == null ? null : String(v).trim() || null
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: `${key}: format YYYY-MM-DD attendu` })
      } else if (key === 'payment_terms_days') {
        if (v === '' || v == null) v = null
        else {
          v = Number(v)
          if (!Number.isInteger(v) || v < 0 || v > 365) return res.status(400).json({ error: 'payment_terms_days: entier 0-365 attendu' })
        }
      } else if (key === 'currency') {
        v = v == null ? null : String(v).trim().toUpperCase() || null
        if (v && !/^[A-Z]{3}$/.test(v)) return res.status(400).json({ error: 'currency: code ISO 3 lettres attendu' })
      } else if (numericFields.has(key)) {
        if (v === '' || v == null) {
          v = null
        } else {
          const n = Number(v)
          if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${key}: nombre positif attendu` })
          v = n
        }
      } else if (key === 'quickbooks_id' || key === 'quickbooks_type') {
        v = v == null || v === '' ? null : String(v)
        if (key === 'quickbooks_type' && v != null && !['purchase', 'bill', 'cc_credit'].includes(v)) {
          return res.status(400).json({ error: 'quickbooks_type: purchase|bill|cc_credit|null attendu' })
        }
      } else if (key === 'items') {
        if (!Array.isArray(v)) return res.status(400).json({ error: 'items: tableau attendu' })
        const normalized = []
        for (const it of v) {
          if (!it || typeof it !== 'object') return res.status(400).json({ error: 'items: objet attendu par ligne' })
          const num = x => {
            if (x === '' || x == null) return null
            const n = Number(x)
            if (!Number.isFinite(n) || n < 0) throw new Error('items: nombres positifs attendus')
            return n
          }
          // Montants signés : une ligne de CRÉDIT (crédit de proration « Unused time on… »,
          // remise, retour) retranche du sous-total et doit pouvoir être négative. Seule la
          // quantité reste positive.
          const signed = x => {
            if (x === '' || x == null) return null
            const n = Number(x)
            if (!Number.isFinite(n)) throw new Error('items: nombre attendu')
            return n
          }
          try {
            normalized.push({
              // Ligne rattachée à un achat LIA : la description porte le code SUIVI du nom
              // de la pièce (« LIA-1991⇥PCB Module d'activation V2 »). Une ligne qui n'a que
              // le code — saisie à la main, extraite d'une facture, ou écrite avant que le
              // nom soit ajouté — est complétée ici, à l'enregistrement, en lisant le nom
              // dans la table Achats. Rien n'est écrit côté Airtable : le nom est seulement
              // recopié sur la ligne du reçu.
              description: completeLiaDescription(it.description == null ? '' : String(it.description)),
              quantity:    num(it.quantity),
              unit_price:  signed(it.unit_price),
              total:       signed(it.total),
              // Code de taxe QB par ligne (Id QuickBooks) — facultatif. Vide/null =
              // la ligne suit le code de taxe global du document à la publication.
              tax_code_id: it.tax_code_id == null || it.tax_code_id === '' ? null : String(it.tax_code_id),
              // Achat LIA rattaché à la ligne (purchases.id) et son code (purchases.at_id,
              // dupliqué pour l'affichage). Posé par l'appariement automatique ou choisi
              // à la main dans la fiche — cf. purchaseLiaMatch.js.
              purchase_id: it.purchase_id == null || it.purchase_id === '' ? null : String(it.purchase_id),
              lia_ref: it.lia_ref == null || it.lia_ref === '' ? null : String(it.lia_ref),
              // Libellé imprimé par le fournisseur, mémorisé quand la description est
              // remplacée par le code LIA : il n'est pas publié, mais il apprend le
              // vocabulaire du fournisseur (purchaseLiaMatch.learnLineAliases).
              source_description: it.source_description == null || it.source_description === '' ? null : String(it.source_description),
            })
          } catch (e) {
            return res.status(400).json({ error: e.message })
          }
        }
        v = JSON.stringify(normalized)
      }
      sets.push(`${key}=?`)
      values.push(v)
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })

  // Nom de fournisseur modifié → le rattachement au profil est invalidé ; il sera
  // re-résolu (et re-persisté) au prochain serializeRow avec le nouveau nom.
  if ('company' in req.body) sets.push('vendor_profile_id=NULL')

  sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  values.push(req.params.id)
  db.prepare(`UPDATE sale_receipts SET ${sets.join(', ')} WHERE id=?`).run(...values)

  const changedLabels = editable.filter(k => k in req.body).map(k => FIELD_LABELS[k] || k)
  logReceiptEvent(req.params.id, req.user?.id, 'updated', changedLabels.join(', ') || null)

  // Corriger un montant/fournisseur/numéro peut créer ou résoudre une anomalie.
  try { syncReceiptAnomalies(req.params.id) } catch (e) { console.warn(`Anomaly re-scan ${req.params.id}: ${e.message}`) }

  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// Upload d'un document : 1 à N fichiers (champ `file` répété) assemblés en UN reçu.
// Page 1 → filename/file_type/original_name ; pages 2..N → extra_pages (JSON).
// L'extraction IA consolide l'ensemble des pages en un seul reçu.
router.post('/upload', upload.array('file', 20), async (req, res) => {
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' })

  const [first, ...rest] = files
  const ext = extname(first.originalname).toLowerCase()
  const id = randomUUID()
  const extraPages = rest.map(f => ({
    filename: f.filename,
    file_type: extname(f.originalname).toLowerCase(),
    original_name: f.originalname,
  }))

  // Insert with processing status
  db.prepare(`
    INSERT INTO sale_receipts (id, filename, original_name, file_type, extra_pages, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'processing', ?)
  `).run(id, first.filename, first.originalname, ext, JSON.stringify(extraPages), req.user.id)

  const createdDetail = files.length > 1
    ? `${first.originalname || 'document'} (+${files.length - 1} page${files.length - 1 > 1 ? 's' : ''})`
    : (first.originalname || null)
  logReceiptEvent(id, req.user?.id, 'created', createdDetail)

  const created = fetchSaleReceiptRow(id)
  if (created) emitEntity('sale_receipt', 'created', id, created, req.user?.id)

  // Return immediately, process async
  res.status(201).json({ id, status: 'processing', page_count: files.length })

  const pages = files.map(f => ({
    filePath: join(uploadsDir, f.filename),
    fileExt: extname(f.originalname).toLowerCase(),
  }))
  runExtractionAndUpdate({ saleReceiptId: id, pages, userId: req.user?.id, trigger: 'manual' })
})

// Relance l'extraction IA sur le ou les fichiers DÉJÀ téléversés — sans re-upload.
// Utile quand l'extraction a échoué (status='error') : remet status='processing'
// et rappelle runExtractionAndUpdate sur les pages existantes (filename + extra_pages).
router.post('/:id/re-extract', (req, res) => {
  const row = db.prepare('SELECT id, status, filename, file_type, extra_pages FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (row.status === 'processing') return res.status(409).json({ error: 'Extraction déjà en cours' })

  // Reconstruit la liste des pages depuis le disque (page 1 + extra_pages).
  let extra = []
  try { extra = JSON.parse(row.extra_pages || '[]') } catch {}
  const pageMeta = [
    { filename: row.filename, file_type: row.file_type },
    ...extra.map(p => ({ filename: p.filename, file_type: p.file_type })),
  ]
  for (const p of pageMeta) {
    if (!p.filename || !existsSync(join(uploadsDir, p.filename))) {
      return res.status(400).json({ error: 'Fichier introuvable — impossible de relancer l\'extraction' })
    }
  }

  db.prepare("UPDATE sale_receipts SET status='processing', error_message=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    .run(req.params.id)
  logReceiptEvent(req.params.id, req.user?.id, 'updated', 'Relance de l\'extraction')

  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)

  // Traitement async — même pattern que /upload.
  const pages = pageMeta.map(p => ({
    filePath: join(uploadsDir, p.filename),
    fileExt: p.file_type,
  }))
  runExtractionAndUpdate({ saleReceiptId: req.params.id, pages, userId: req.user?.id, trigger: 'manual' })
})

// Sert la page demandée d'un document. ?page=0 (défaut) = page 1 (filename) ;
// ?page=N (1-based dans extra_pages) = page N+1. Compat : sans ?page → page 1.
router.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT filename, file_type, extra_pages FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const pageIdx = parseInt(req.query.page, 10) || 0
  let filename = row.filename
  let fileType = row.file_type
  if (pageIdx > 0) {
    let extra = []
    try { extra = JSON.parse(row.extra_pages || '[]') } catch {}
    const p = extra[pageIdx - 1]
    if (!p) return res.status(404).json({ error: 'Page not found' })
    filename = p.filename
    fileType = p.file_type
  }

  const filePath = join(uploadsDir, filename)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' })

  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }
  res.set('Content-Type', mime[fileType] || 'application/octet-stream')
  res.sendFile(filePath)
})

// Historique d'un reçu : ajout, modifications, archivage, publication.
router.get('/:id/history', (req, res) => {
  const rec = db.prepare('SELECT id, created_by, created_at FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!rec) return res.status(404).json({ error: 'Not found' })

  const events = db.prepare(`
    SELECT e.id, e.action, e.detail, e.created_at, e.user_id, u.name AS user_name
    FROM sale_receipt_events e
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.receipt_id = ?
    ORDER BY e.created_at ASC, e.rowid ASC
  `).all(req.params.id)

  // Reçus antérieurs à la journalisation : synthétiser l'événement de création
  // depuis created_by / created_at pour toujours afficher « ajouté par … ».
  if (!events.some(e => e.action === 'created')) {
    const u = rec.created_by ? db.prepare('SELECT name FROM users WHERE id=?').get(rec.created_by) : null
    events.unshift({
      id: 'synthetic-created', action: 'created', detail: null,
      created_at: rec.created_at, user_id: rec.created_by, user_name: u?.name || null,
    })
  }

  events.reverse() // plus récent d'abord
  res.json({ data: events })
})

// Transactions passées du même fournisseur déjà publiées sur QuickBooks — pour
// servir de modèle de comptabilisation. Fournisseur identifié par le champ texte
// `company` (insensible à la casse / espaces).
router.get('/:id/vendor-history', (req, res) => {
  const rec = db.prepare('SELECT id, company FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!rec) return res.status(404).json({ error: 'Not found' })
  if (!rec.company || !rec.company.trim()) return res.json({ data: [] })

  const rows = db.prepare(`
    SELECT * FROM sale_receipts
    WHERE deleted_at IS NULL
      AND quickbooks_id IS NOT NULL
      AND id != ?
      AND LOWER(TRIM(company)) = LOWER(TRIM(?))
    ORDER BY COALESCE(receipt_date, created_at) DESC
    LIMIT 20
  `).all(req.params.id, rec.company)

  res.json({ data: rows.map(serializeRow) })
})

// Achats LIA rapprochables de ce reçu. Pour chaque ligne : la suggestion retenue
// (si elle dépasse le seuil) et la liste des achats candidats du même fournisseur,
// classés par pertinence — c'est cette liste qui alimente le sélecteur de la fiche.
// Rien n'est écrit ici : la route est en lecture seule, l'opérateur confirme via PATCH.
router.get('/:id/lia-matches', (req, res) => {
  const rec = db.prepare('SELECT id, company, receipt_date, vendor_profile_id, items FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!rec) return res.status(404).json({ error: 'Not found' })
  let items = []
  try { items = JSON.parse(rec.items || '[]') } catch {}
  try {
    const { lines, candidates } = matchReceiptItems({
      items,
      company: rec.company,
      vendorProfileId: rec.vendor_profile_id,
      receiptDate: rec.receipt_date,
      excludeReceiptId: rec.id,
    })
    res.json({
      lines: lines.map(l => ({ index: l.index, locked: !!l.locked, match: l.match, blocked_by: l.blocked_by || null })),
      candidates,
      thresholds: { auto: LIA_AUTO_THRESHOLD, suggest: LIA_SUGGEST_THRESHOLD },
    })
  } catch (e) {
    console.error(`lia-matches ${req.params.id}:`, e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/:id/push-to-qb', async (req, res) => {
  try {
    const { type, expenseAccountId, paymentAccountId, vendorId, newVendorName, dueDate, taxCodeId, transactionType, forceReason, anomalyOverride, bankChargedTotal } = req.body
    const qbId = await pushSaleReceiptToQB(req.params.id, { type, expenseAccountId, paymentAccountId, vendorId, newVendorName, dueDate, taxCodeId, transactionType, forceReason, anomalyOverride, bankChargedTotal })
    // Trace quand l'opérateur a publié malgré une anomalie doublon ouverte.
    if (anomalyOverride && String(anomalyOverride).trim()) {
      logReceiptEvent(req.params.id, req.user?.id, 'anomaly_override', `Doublon probable ignoré : ${String(anomalyOverride).trim()}`)
    }
    const bankNote = bankChargedTotal ? ` — montant passé à la banque : ${Number(bankChargedTotal).toFixed(2)} (écart éventuel en ligne « Frais de conversion »)` : ''
    logReceiptEvent(req.params.id, req.user?.id, 'published', `QuickBooks #${qbId} (${type === 'bill' ? 'facture' : type === 'cc_credit' ? 'crédit carte de crédit' : 'dépense'})${bankNote}`)
    // Trace distincte quand l'opérateur a forcé la publication malgré un écart de statut fiscal.
    if (forceReason && forceReason.trim()) {
      logReceiptEvent(req.params.id, req.user?.id, 'fiscal_override', `Écart fiscal forcé : ${forceReason.trim()}`)
    }
    const updated = fetchSaleReceiptRow(req.params.id)
    if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
    res.json({ ok: true, quickbooks_id: qbId })
  } catch (e) {
    res.status(400).json({ error: e.message, field: e.field || null })
  }
})

// Joint le document (relevé mensuel d'un fournisseur prépayé) à toutes les
// transactions QB de ce fournisseur datées dans le mois couvert. Rien n'est
// comptabilisé dans QuickBooks : la dépense l'est déjà par les recharges du
// mois. Le montant extrait de la facture (pas du reçu de paiement) alimente
// en revanche le ledger prépayé de l'ERP — voir prepaidStatementAttach.js.
router.post('/:id/attach-to-month-qb', async (req, res) => {
  try {
    const summary = await attachStatementToMonthQb(req.params.id, { month: req.body?.month || null })
    const label = monthLabel(summary.month)
    const ledgerNote = summary.ledger_entry
      ? ` — facture de ${summary.ledger_entry.amount} enregistrée au solde prépayé`
      : ''
    logReceiptEvent(req.params.id, req.user?.id, 'month_attached',
      `Joint à ${summary.transactions.length} transaction(s) QuickBooks de ${label}`
      + ` — ${summary.attached} fichier(s) téléversé(s)${summary.skipped ? `, ${summary.skipped} déjà présent(s)` : ''}`
      + ledgerNote)
    const updated = fetchSaleReceiptRow(req.params.id)
    if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
    res.json({ ok: true, ...summary })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Délie le pointeur QB d'un reçu (sans toucher à QB) — utile après suppression
// manuelle de la transaction dans QB pour permettre un re-push.
router.delete('/:id/quickbooks-link', (req, res) => {
  const r = db.prepare(`
    UPDATE sale_receipts
    SET quickbooks_id=NULL, quickbooks_type=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `).run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Not found' })
  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json({ ok: true })
})

// Archive / désarchive — soft, conserve le reçu et son fichier. archived_at NULL = actif.
router.post('/:id/archive', (req, res) => {
  const row = db.prepare('SELECT id FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare("UPDATE sale_receipts SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    .run(req.params.id)
  logReceiptEvent(req.params.id, req.user?.id, 'archived')
  // Copie archivée sans publication = doublon classé : ses anomalies ouvertes
  // (zero_total, doublons) se résolvent immédiatement, sans attendre le scan.
  try { syncReceiptAnomalies(req.params.id) } catch (e) { console.warn(`Anomaly re-scan ${req.params.id}: ${e.message}`) }
  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

router.post('/:id/unarchive', (req, res) => {
  const row = db.prepare('SELECT id FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare("UPDATE sale_receipts SET archived_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    .run(req.params.id)
  logReceiptEvent(req.params.id, req.user?.id, 'unarchived')
  // Le reçu redevient actif : ses anomalies (doublons, 0 $) se re-détectent aussitôt.
  try { syncReceiptAnomalies(req.params.id) } catch (e) { console.warn(`Anomaly re-scan ${req.params.id}: ${e.message}`) }
  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// Lu / non lu — à la Gmail : read_at NULL = non lu (ligne en gras dans la liste).
// Marqué lu à l'ouverture du reçu, remis non lu manuellement par l'utilisateur.
router.post('/:id/read', (req, res) => {
  const row = db.prepare('SELECT id, read_at FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (!row.read_at) {
    db.prepare("UPDATE sale_receipts SET read_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(req.params.id)
    const updated = fetchSaleReceiptRow(req.params.id)
    if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
    return res.json(updated)
  }
  res.json(fetchSaleReceiptRow(req.params.id))
})

router.post('/:id/unread', (req, res) => {
  const row = db.prepare('SELECT id FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE sale_receipts SET read_at=NULL WHERE id=?').run(req.params.id)
  const updated = fetchSaleReceiptRow(req.params.id)
  if (updated) emitEntity('sale_receipt', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT filename, extra_pages, gmail_message_id FROM sale_receipts WHERE id=? AND deleted_at IS NULL')
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  // Toutes les pages (page 1 + extra_pages) sont purgées du disque.
  let extra = []
  try { extra = JSON.parse(row.extra_pages || '[]') } catch {}
  for (const name of [row.filename, ...extra.map(p => p.filename)]) {
    if (!name) continue
    try { const fp = join(uploadsDir, name); if (existsSync(fp)) unlinkSync(fp) } catch {}
  }

  // Si la pièce vient d'un email (gmail_message_id), soft-delete pour que
  // syncInvoiceLabel ne la réimporte pas à chaque tour ; sinon, hard-delete.
  if (row.gmail_message_id) {
    db.prepare("UPDATE sale_receipts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(req.params.id)
  } else {
    db.prepare('DELETE FROM sale_receipts WHERE id=?').run(req.params.id)
    db.prepare('DELETE FROM sale_receipt_events WHERE receipt_id=?').run(req.params.id)
  }
  // Le reçu n'existe plus : ses anomalies ouvertes (dont les paires de doublon) se résolvent.
  try { syncReceiptAnomalies(req.params.id) } catch (e) { console.warn(`Anomaly re-scan ${req.params.id}: ${e.message}`) }
  emitEntity('sale_receipt', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ ok: true })
})

export default router
