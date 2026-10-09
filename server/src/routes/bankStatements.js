// Dépôt de relevés bancaires : on dépose des fichiers, l'ERP les lit, on
// valide l'aperçu, puis — et seulement là — les transactions entrent en base.
// Le service fait tout le travail : services/bankStatementImport.js.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { makeUpload } from '../utils/upload.js'
import { ensureUploadsDir } from '../config/uploads.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import {
  ALLOWED_EXT, createUpload, analyzeUpload, getUpload, listUploads,
  setUploadAccount, replanUpload, commitUpload, deleteUpload, sweepStaleUploads,
  sendUploadToExtractor,
} from '../services/bankStatementImport.js'
import { fileUploadToDrive, fileRecentUploads, statementChecklist, STATEMENTS_TASK_ID } from '../services/bankStatementDriveFiling.js'
import { completeFromAutomation } from '../services/recurringWork.js'

const router = Router()
router.use(requireAuth)

const upload = makeUpload({
  destination: ensureUploadsDir('releves'),
  fileSize: 25 * 1024 * 1024,
  allowedExt: ALLOWED_EXT,
  rejectMessage: () => 'Type non supporté — PDF, image (PNG/JPG), CSV ou XLSX',
})

// Un redémarrage en pleine lecture laisse des dépôts figés : on les solde à la
// première visite. Pas au chargement du module — les routes sont importées
// AVANT que schema.js n'ait créé la table.
let swept = false
function sweepOnce() {
  if (swept) return
  swept = true
  try { sweepStaleUploads() } catch (e) { console.error('bankStatements.sweep:', e.message) }
}

// Un relevé mensuel complet part ranger au Drive (rien sinon) ; la carte suit.
function fileInBackground(id, userId) {
  fileUploadToDrive(id)
    .then(() => fileRecentUploads('dépôt de relevé'))
    .then((done) => { for (const r of done) emitEntity('bank_statement_upload', 'updated', r.id, getUpload(r.id), userId) })
    .catch((e) => console.error('bankStatements.driveFiling:', e.message))
}

// Lecture en tâche de fond : la réponse part tout de suite, l'UI suit l'état.
function analyzeInBackground(id, userId) {
  analyzeUpload(id)
    .then((up) => { emitEntity('bank_statement_upload', 'updated', id, up, userId); fileInBackground(id, userId) })
    .catch((e) => console.error('bankStatements.analyze:', e.message))
}

router.post('/upload', upload.array('file', 20), (req, res) => {
  sweepOnce()
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' })
  const ids = files.map((f) => createUpload({
    filePath: f.path,
    originalName: f.originalname,
    mime: f.mimetype,
    userId: req.user.id,
  }))
  res.status(201).json({ ids, uploads: ids.map((id) => getUpload(id)) })
  for (const id of ids) analyzeInBackground(id, req.user.id)
})

router.get('/', (req, res) => {
  sweepOnce()
  res.json(listUploads(Number(req.query.limit) || 40))
})

// Relevés du mois au Drive, compte par compte (travail récurrent d'Antoine).
router.get('/checklist', async (req, res) => {
  try {
    const month = String(req.query.month || '')
    const list = await statementChecklist(month)
    // Tous au Drive : le travail se coche tout de suite, sans attendre la veille
    // du matin (relevés rangés à la main directement dans le Drive).
    if (list.length && list.every((x) => x.done)) {
      completeFromAutomation(STATEMENTS_TASK_ID, { periodKey: month, note: `${list.length} relevés au Drive` })
    }
    res.json(list)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.get('/:id', (req, res) => {
  const up = getUpload(req.params.id)
  if (!up) return res.status(404).json({ error: 'Not found' })
  res.json(up)
})

// Corriger le compte deviné (ou en choisir un quand la lecture n'a pas tranché).
router.patch('/:id', (req, res) => {
  try {
    if (!('account_id' in (req.body || {}))) return res.status(400).json({ error: 'account_id attendu' })
    // Compte corrigé : un simple lien « déjà au Drive » pris sur l'ancien compte ne tient plus.
    db.prepare(`UPDATE bank_statement_uploads SET drive_file_id=NULL, drive_filing=NULL, drive_file_name=NULL
      WHERE id=? AND drive_filing IN ('deja','erreur') AND account_id IS NOT ?`).run(req.params.id, req.body.account_id || null)
    res.json(setUploadAccount(req.params.id, req.body.account_id || null))
    fileInBackground(req.params.id, req.user.id)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/:id/reanalyze', (req, res) => {
  const up = getUpload(req.params.id)
  if (!up) return res.status(404).json({ error: 'Not found' })
  if (up.status === 'importe') return res.status(409).json({ error: 'Ce dépôt est déjà importé' })
  res.status(202).json({ status: 'en_analyse' })
  analyzeInBackground(req.params.id, req.user.id)
})

// Le geste humain. `rows` (indices) permet de ne prendre qu'une partie de
// l'aperçu, y compris une ligne que la dédup croyait déjà en base.
router.post('/:id/commit', (req, res) => {
  try {
    const only = Array.isArray(req.body?.rows) ? req.body.rows.map(Number) : null
    res.status(201).json(commitUpload(req.params.id, req.user.id, { only }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// « Ce n'est pas un relevé, c'est une facture » : le document part à
// l'extraction de données. La lecture le fait d'elle-même quand elle le
// reconnaît ; ce bouton est là pour les fois où elle se trompe.
router.post('/:id/to-receipt', async (req, res) => {
  const up = getUpload(req.params.id)
  if (!up) return res.status(404).json({ error: 'Not found' })
  if (up.status === 'importe') return res.status(409).json({ error: 'Ce dépôt est déjà importé au compte' })
  try {
    res.json(await sendUploadToExtractor(req.params.id))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/:id/replan', (req, res) => {
  const up = replanUpload(req.params.id)
  if (!up) return res.status(404).json({ error: 'Not found' })
  res.json(up)
})

router.delete('/:id', (req, res) => {
  if (!deleteUpload(req.params.id)) return res.status(404).json({ error: 'Not found' })
  res.json({ deleted: true })
})

export default router
