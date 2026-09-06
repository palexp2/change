// Inventaire décisionnel des documents Google Drive de la comptabilité.
//
// BUT : lister ce qui se tient encore dans le Drive (Sheets, Docs, classeurs
// Excel) et que l'ERP ne lit PAS, pour décider un par un ce qui mérite d'être
// rapatrié. Le module lit des métadonnées et le CONTENU des onglets (en-tête +
// échantillon) ; il n'importe aucune donnée métier et n'écrit rien dans le Drive.
//
// L'unité de décision est l'ONGLET, pas le fichier. Un classeur « déjà
// synchronisé » au niveau du fichier peut n'avoir qu'un onglet repris sur douze
// — c'est le cas de CTB - Suivi, dont l'ERP ne touche que « Pmt_Suivi » et deux
// sections de « Sommaire », alors que « Abonn. », « Récurrents » ou « Paie &
// Ass. coll. » attendent toujours. Raisonner au fichier masquait exactement ça.
//
// Quatre statuts, proposés et seulement proposés :
//   - `synced`    : un sync de l'ERP lit déjà cet onglet ;
//   - `partial`   : partiellement repris (fichier dont des onglets restent
//                   ouverts, ou onglet dont seules certaines sections sont lues) ;
//   - `candidate` : de la matière à trancher ;
//   - `ignore`    : vide, dormant, ou sans rien de comptable.
// La DÉCISION (importer / garder dans Drive / archiver) appartient à
// l'utilisateur : un re-scan rafraîchit métadonnées, contenu et statut, jamais la
// décision ni sa note.
import xlsx from 'xlsx'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { logSync } from './syncLog.js'
import { analyzeInventory } from './driveInventoryAnalysis.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

export const DEFAULT_ACCOUNT_EMAIL = 'michel@orisha.io'

// Plafonds du scan — un Drive d'entreprise peut contenir des milliers de
// fichiers ; la page sert à trancher, pas à tout recenser.
export const SCAN_LIMITS = { maxFiles: 1500, maxTabFetches: 160, maxFolderLookups: 120 }

const SPREADSHEET_MIMES = [
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]
const DOC_MIMES = [
  'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export function kindOfMime(mime) {
  if (SPREADSHEET_MIMES.includes(mime)) return 'spreadsheet'
  if (DOC_MIMES.includes(mime)) return 'document'
  if (mime === 'application/vnd.google-apps.presentation') return 'presentation'
  if (mime === 'application/pdf') return 'pdf'
  return 'other'
}

// ── Vocabulaire comptable ────────────────────────────────────────────────────
// Un fichier est « candidat » si son nom OU son dossier parent contient un de
// ces termes. Liste volontairement large : mieux vaut un candidat de trop
// (l'utilisateur le classe « garder dans Drive » en un clic) qu'un fichier de
// la comptabilité passé sous le radar.
export const ACCOUNTING_TERMS = [
  'compta', 'comptab', 'facture', 'factur', 'fournisseur', 'client', 'paie', 'salaire',
  'tps', 'tvq', 'tvh', 'taxe', 'budget', 'banque', 'bnc', 'solde', 'tresorerie',
  'depense', 'debourse', 'revenu', 'vente', 'bilan', 'grand livre', 'gl ', 'quickbooks',
  'qb ', 'stripe', 'ctb', 'trx', 'pret', 'dette', 'amortissement', 'inventaire', 'stock',
  'rsde', 'r&d', 'credit', 'subvention', 'douane', 'carm', 'prepay', 'abonnement',
  'ecriture', 'provision', 'marge', 'cout', 'encaisse', 'remboursement', 'exercice',
  'audit', 'immobilis', 'capital', 'actionnaire', 'aga', 'dividende', 't4', 'releve',
  'cnesst', 'remise', 'acompte', 'conciliation', 'rapprochement', 'suivi', 'cash',
  'flux', 'previsionnel', 'projection', 'annee financiere', 'fin de mois', 'fin d annee',
  'pmt', 'paiement', 'cheque', 'visa', 'carte de credit', 'feuille de temps', 'heures',
  'piece', 'achat', 'commande', 'soumission', 'devis', 'prix', 'tarif',
]

const strip = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function matchAccountingTerms(name, folderName) {
  const hay = `${strip(name)} ${strip(folderName)}`
  return ACCOUNTING_TERMS.filter(t => hay.includes(t))
}

// ── Registre de ce qui est DÉJÀ synchronisé ─────────────────────────────────
// Sources : la config des automations système (éditable dans l'interface, donc
// lue en base plutôt que codée en dur) + les fichiers que l'ERP a lui-même
// déposés dans le Drive + les dossiers du connecteur Google.
function automationConfig(id) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(id)
  try { return JSON.parse(row?.action_config || '{}') } catch { return {} }
}

// Documents dont l'ERP ne lit pas le fichier mais dont le CONTENU a été
// rapatrié une fois pour toutes (l'ERP est devenu la source de vérité), et
// fichiers que l'ERP produit lui-même. Reconnus au nom, faute d'identifiant
// stable (les mensuels changent de fichier chaque mois).
export const KNOWN_SYNCED_PATTERNS = [
  [/^sommaire_statut fiscal des taxes/i, 'Statuts fiscaux TPS/TVQ : référentiel rapatrié dans l\'ERP (vérifié à chaque publication QB)'],
  [/^fournisseurs_particularit/i, 'Particularités fournisseurs : rapatriées dans les profils fournisseurs de l\'ERP'],
  [/^feuille_de_temps_\d+_\d{4}\.xlsx$/i, 'Feuilles de temps R&D : import mensuel des heures'],
  [/^pi[eè]ces_d[ée]bours[ée]s/i, 'Déboursés de pièces : fichier produit par l\'ERP'],
]

export function knownSyncedRegistry() {
  const files = new Map()   // drive_file_id → libellé du sync
  const folders = new Map() // drive_folder_id → libellé du sync
  const add = (map, id, label) => { const k = String(id || '').trim(); if (k) map.set(k, label) }

  add(files, automationConfig('sys_ctb_programmation_paiement').spreadsheet_id || '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ',
    'CTB - Suivi : programmation des factures à payer + import Pmt_Suivi')
  add(files, automationConfig('sys_treasury_solde_sheet').spreadsheet_id || '1ETlbHIcwClZTiskwQh8PWYuDxZGwqJBKU-0p2iWoxgo',
    'Trésorerie : sync « Maintien du solde disponible BNC »')
  add(files, automationConfig('sys_bank_trx_sheet').file_id || '1fRE0c1zv5zks70pwzgpojB7LZz-V5lHR',
    'Rapprochement bancaire : sync TRX_Orisha')
  add(folders, automationConfig('sys_pieces_disbursements').drive_folder_id || '1q0e-rHE2xxeapcDt8yyHh2xwJt1mChJc',
    'Déboursés de pièces : fichiers déposés par l\'ERP')

  // Fichiers dont l'ERP lit ou écrit déjà le contenu, tracés en base.
  const tracked = [
    ['SELECT drive_file_id FROM rd_month_hours WHERE drive_file_id IS NOT NULL', 'Feuilles de temps R&D : import mensuel des heures'],
    ['SELECT drive_file_id FROM pieces_disbursements WHERE drive_file_id IS NOT NULL', 'Déboursés de pièces : fichier généré par l\'ERP'],
  ]
  for (const [sql, label] of tracked) {
    try { for (const r of db.prepare(sql).all()) add(files, r.drive_file_id, label) } catch {}
  }

  // Dossiers d'enregistrements d'appels du connecteur Google.
  try {
    const row = db.prepare(`SELECT value FROM connector_config WHERE connector='google' AND key='drive_folders'`).get()
    for (const f of JSON.parse(row?.value || '[]')) add(folders, f.folder_id, 'Enregistrements d\'appels : import Drive')
  } catch {}

  return { files, folders, tabs: knownSyncedTabs() }
}

// ── Ce qui est synchronisé, ONGLET par ONGLET ───────────────────────────────
// Le niveau fichier ment : CTB - Suivi compte 12 onglets et l'ERP n'en touche
// que deux — dont « Sommaire », où il n'écrit que deux sections sur trois. Un
// onglet marqué `partial` reste donc à trancher : il porte encore de la matière
// non reprise.
export function knownSyncedTabs() {
  const ctb = automationConfig('sys_ctb_programmation_paiement').spreadsheet_id || '13rd8x_xy5AQJemDwE6yWp8ffvkj3bEo7kq3cuogRGyQ'
  const solde = automationConfig('sys_treasury_solde_sheet').spreadsheet_id || '1ETlbHIcwClZTiskwQh8PWYuDxZGwqJBKU-0p2iWoxgo'
  const trx = automationConfig('sys_bank_trx_sheet').file_id || '1fRE0c1zv5zks70pwzgpojB7LZz-V5lHR'
  const soldeTab = automationConfig('sys_treasury_solde_sheet').sheet_name || 'Compte chèque'
  const ctbTab = automationConfig('sys_ctb_programmation_paiement').sheet_name || 'Sommaire'
  return [
    {
      file: ctb, tab: ctbTab, partial: true,
      label: "L'ERP n'écrit que les sections « Programmation des factures à payer » et « Factures payées cette semaine ». La section « Factures manquantes » de cet onglet n'est PAS reprise.",
    },
    { file: ctb, tab: 'Pmt_Suivi', label: 'Paiements émis : import de l\'onglet vers /paiements-emis (dont le vert « passé à la banque »)' },
    { file: solde, tab: soldeTab, label: 'Trésorerie : solde disponible, paiements planifiés et sorties récurrentes' },
    { file: trx, tab: '*', label: 'Rapprochement bancaire : un onglet par compte, importé en transactions' },
  ]
}

export function syncedTabInfo(registryTabs, fileId, tabName) {
  const hit = (registryTabs || []).find(t => t.file === fileId && (t.tab === '*' || strip(t.tab) === strip(tabName)))
  if (!hit) return null
  return { status: hit.partial ? 'partial' : 'synced', label: hit.label }
}

// Statut du FICHIER dérivé de ses onglets : un classeur dont l'ERP ne lit que
// deux onglets sur douze n'est pas « déjà synchronisé », il est « partiellement
// repris » — c'est exactement l'angle mort que cette page doit lever.
export function deriveItemStatus(tabs, fallback) {
  if (!tabs?.length) return fallback
  const covered = tabs.filter(t => t.status === 'synced').length
  const partial = tabs.some(t => t.status === 'partial')
  const open = tabs.filter(t => t.status === 'candidate').length
  if (covered === tabs.length && !partial) return 'synced'
  if (covered > 0 || partial) return open > 0 || partial ? 'partial' : 'synced'
  return fallback
}

// ── Fréquence de modification (métadonnées Drive) ───────────────────────────
// Drive expose `version` : un compteur qui s'incrémente à chaque changement du
// fichier. Rapporté à l'âge du fichier, il donne un rythme d'édition ; croisé
// avec la date de dernière modification, il classe le fichier en vivant / lent
// / mort. C'est un ordre de grandeur, pas une mesure exacte (les changements de
// partage comptent aussi) — assez pour trier ce qui vaut un import.
export function computeFrequency({ createdTime, modifiedTime, version }, now = new Date()) {
  const created = createdTime ? new Date(createdTime) : null
  const modified = modifiedTime ? new Date(modifiedTime) : null
  const ageDays = created ? Math.max(1, (now - created) / 86400000) : null
  const daysSince = modified ? Math.max(0, Math.floor((now - modified) / 86400000)) : null
  const v = Number(version) || 0
  const editsPerMonth = ageDays && v > 1 ? Math.round(((v - 1) / ageDays) * 30 * 10) / 10 : 0

  let frequency
  if (daysSince == null) frequency = 'inconnue'
  else if (daysSince > 365) frequency = 'inactive'
  else if (daysSince > 90) frequency = 'rare'
  else if (editsPerMonth >= 20) frequency = 'quotidienne'
  else if (editsPerMonth >= 4) frequency = 'hebdomadaire'
  else if (editsPerMonth >= 1) frequency = 'mensuelle'
  else frequency = 'rare'

  return { editsPerMonth, daysSinceModified: daysSince, frequency }
}

export const FREQUENCY_LABELS = {
  quotidienne: 'Quotidienne', hebdomadaire: 'Hebdomadaire', mensuelle: 'Mensuelle',
  rare: 'Rare', inactive: 'Inactive', inconnue: 'Inconnue',
}

// ── Statut proposé ───────────────────────────────────────────────────────────
export function classify(file, { registry, folderName }) {
  const syncedFile = registry.files.get(file.id)
  const syncedFolder = (file.parents || []).map(p => registry.folders.get(p)).find(Boolean)
  const syncedName = KNOWN_SYNCED_PATTERNS.find(([re]) => re.test(String(file.name || '')))?.[1]
  const target = syncedFile || syncedFolder || syncedName
  if (target) {
    return { status: 'synced', reason: 'Déjà couvert par l\'ERP', syncTarget: target, terms: [] }
  }
  const terms = matchAccountingTerms(file.name, folderName)
  const { frequency } = computeFrequency(file)
  if (frequency === 'inactive') {
    return { status: 'ignore', reason: 'Plus modifié depuis plus d\'un an', syncTarget: null, terms }
  }
  if (terms.length === 0) {
    return { status: 'ignore', reason: 'Aucun terme comptable dans le nom ni dans le dossier', syncTarget: null, terms }
  }
  return { status: 'candidate', reason: `Termes comptables : ${terms.slice(0, 4).join(', ')}`, syncTarget: null, terms }
}

// Statut proposé pour UN onglet, avant tout jugement du modèle. Le registre
// tranche en premier ; ensuite c'est la nature du contenu qui décide s'il y a
// quelque chose à importer. L'analyse de pertinence peut promouvoir un onglet
// écarté ici (une procédure qui mérite de devenir une page de l'ERP).
export function classifyTab(tab, { registryTabs, fileId, fileSync = null }) {
  const known = syncedTabInfo(registryTabs, fileId, tab.tab_name)
  if (known) return { status: known.status, reason: known.label, syncTarget: known.label }

  // Un fichier lu EN ENTIER par un sync (feuilles de temps mensuelles, fichiers
  // produits par l'ERP…) couvre tous ses onglets : sans ça, chaque onglet
  // « Prénom Nom » d'une feuille de temps déjà importée reviendrait en
  // suggestion. La règle ne vaut QUE pour les fichiers absents du registre
  // par onglet — pour CTB - Suivi ou TRX_Orisha, seul le détail fait foi.
  const governedByTabs = (registryTabs || []).some(t => t.file === fileId)
  if (!governedByTabs && fileSync) {
    return { status: 'synced', reason: fileSync, syncTarget: fileSync }
  }

  if (tab.nature === 'vide') return { status: 'ignore', reason: 'Onglet vide', syncTarget: null }
  if (tab.nature === 'donnees') {
    return { status: 'candidate', reason: `Tableau de ${tab.rows_count} lignes — ${tab.header.slice(0, 5).join(' · ') || 'colonnes non identifiées'}`, syncTarget: null }
  }
  const label = {
    procedure: 'Procédure rédigée — à lire, rien à importer tel quel',
    calculatrice: 'Calculatrice (formules) — un outil, pas des données',
    reference: 'Petite grille de référence / paramètres',
  }[tab.nature] || 'Contenu non tabulaire'
  return { status: 'ignore', reason: label, syncTarget: null }
}

// ── Accès Google ─────────────────────────────────────────────────────────────
function resolveAccount(preferredEmail) {
  if (preferredEmail) {
    const row = db.prepare(`SELECT * FROM connector_oauth WHERE connector='google' AND account_email=? AND refresh_token IS NOT NULL`).get(preferredEmail)
    if (row) return row
  }
  return db.prepare(`
    SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `).get() || null
}

const FILE_FIELDS = 'nextPageToken, files(id,name,mimeType,owners(emailAddress,displayName),'
  + 'lastModifyingUser(displayName,emailAddress),createdTime,modifiedTime,version,size,webViewLink,parents,ownedByMe,driveId)'

async function listAllFiles(drive, maxFiles) {
  const mimeQ = [...SPREADSHEET_MIMES, ...DOC_MIMES].map(m => `mimeType='${m}'`).join(' or ')
  const q = `trashed=false and (${mimeQ})`
  const files = []
  let pageToken = null
  do {
    const res = await drive.files.list({
      q, fields: FILE_FIELDS, orderBy: 'modifiedTime desc', pageSize: 200, pageToken,
      includeItemsFromAllDrives: true, supportsAllDrives: true, corpora: 'allDrives',
    })
    files.push(...(res.data.files || []))
    pageToken = res.data.nextPageToken || null
  } while (pageToken && files.length < maxFiles)
  return files.slice(0, maxFiles)
}

// Un fichier d'un Drive partagé n'a PAS de propriétaire au sens de l'API : la
// propriété appartient au Drive lui-même. On affiche alors son nom, sinon la
// colonne « Propriétaire » resterait vide pour la moitié de la comptabilité.
async function resolveSharedDriveNames(drive, files) {
  const names = new Map()
  for (const id of [...new Set(files.map(f => f.driveId).filter(Boolean))]) {
    try {
      const res = await drive.drives.get({ driveId: id, fields: 'id,name' })
      names.set(id, res.data.name || null)
    } catch { names.set(id, null) }
  }
  return names
}

export function ownerOf(file, sharedDriveNames) {
  const owner = file.owners?.[0]
  if (owner) return { email: owner.emailAddress || null, name: owner.displayName || owner.emailAddress || null }
  const driveName = file.driveId ? sharedDriveNames.get(file.driveId) : null
  if (driveName) return { email: null, name: `Drive partagé — ${driveName}` }
  return { email: null, name: null }
}

async function resolveFolderNames(drive, files, limit) {
  const names = new Map()
  const wanted = []
  for (const f of files) {
    const p = f.parents?.[0]
    if (p && !names.has(p) && !wanted.includes(p)) wanted.push(p)
  }
  for (const id of wanted.slice(0, limit)) {
    try {
      const res = await drive.files.get({ fileId: id, fields: 'id,name', supportsAllDrives: true })
      names.set(id, res.data.name || null)
    } catch { names.set(id, null) }
  }
  return names
}

// ── Lecture du CONTENU des onglets ───────────────────────────────────────────
// Connaître les noms d'onglets ne suffit pas à décider : « Abonn. » est un
// tableau de 36 abonnements fournisseurs à rapatrier, « Repas » est une note de
// deux paragraphes sur les taxes. Il faut regarder DEDANS. On lit donc chaque
// onglet et on en tire sa nature, sa ligne d'en-tête et un échantillon —
// l'export xlsx est de toute façon téléchargé une seule fois par classeur.

const CELL = v => String(v ?? '').replace(/\s+/g, ' ').trim()

// Une ligne d'en-tête = la première ligne avec au moins 3 libellés courts, dont
// au moins une ligne remplie en dessous. Sans elle, ce n'est pas un tableau.
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const cells = (rows[i] || []).map(CELL)
    const labels = cells.filter(c => c && c.length <= 40)
    if (labels.length < 3) continue
    const below = rows.slice(i + 1, i + 6).filter(r => (r || []).filter(c => CELL(c)).length >= 2)
    if (below.length >= 1) return i
  }
  return -1
}

// Nature de l'onglet — ce qui décide s'il y a quelque chose à IMPORTER :
//   donnees      : un tableau (en-tête + lignes) → candidat naturel à l'import
//   procedure    : de la prose (phrases longues en colonne A) → à lire, pas à importer
//   calculatrice : peu de lignes, beaucoup de formules → outil de calcul
//   reference    : petite grille de correspondances / paramètres
//   vide         : rien d'exploitable
export function classifyTabNature({ rows, formulaRatio = 0 }) {
  const nonEmpty = rows.filter(r => (r || []).some(c => CELL(c)))
  if (nonEmpty.length < 2) return 'vide'

  const headerIdx = findHeaderRow(nonEmpty)
  const dataRows = headerIdx >= 0 ? nonEmpty.length - headerIdx - 1 : 0

  // Prose : l'essentiel du contenu tient dans la première colonne, en phrases.
  const longFirstCol = nonEmpty.filter(r => CELL(r?.[0]).length > 60).length
  const wide = nonEmpty.filter(r => (r || []).filter(c => CELL(c)).length >= 3).length
  if (longFirstCol >= 3 && longFirstCol > wide) return 'procedure'

  if (headerIdx >= 0 && dataRows >= 3) return 'donnees'
  if (formulaRatio > 0.25) return 'calculatrice'
  if (nonEmpty.length <= 12) return 'reference'
  return 'procedure'
}

// Titres de section d'un onglet : une ligne où une seule cellule est remplie,
// en majuscules. Un onglet comme « Sommaire » empile trois blocs indépendants
// (FACTURES MANQUANTES, PROGRAMMATION DES FACTURES À PAYER, FACTURES PAYÉES
// CETTE SEMAINE) dont l'ERP n'écrit que les deux derniers — sans cette liste,
// impossible de voir que le premier bloc reste orphelin.
export function findSections(rows) {
  const out = []
  for (const row of rows) {
    const filled = (row || []).map(CELL).filter(Boolean)
    if (filled.length !== 1) continue
    const label = filled[0]
    if (label.length < 8 || label.length > 80) continue
    const letters = label.replace(/[^A-Za-zÀ-ÿ]/g, '')
    if (!letters || letters !== letters.toUpperCase()) continue
    if (!out.includes(label)) out.push(label)
  }
  return out.slice(0, 8)
}

// Contenu d'un classeur, onglet par onglet. Retourne aussi l'échantillon qui
// servira à juger la pertinence : en-tête + 3 lignes, tronqués (le jugement se
// fait sur la forme des données, pas sur leur volume).
export function readWorkbookTabs(wb) {
  return (wb.SheetNames || []).map((name, index) => {
    const sheet = wb.Sheets[name]
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
    const nonEmpty = rows.filter(r => (r || []).some(c => CELL(c)))
    const cells = Object.keys(sheet || {}).filter(k => !k.startsWith('!'))
    const formulas = cells.filter(k => sheet[k]?.f).length
    const formulaRatio = cells.length ? formulas / cells.length : 0

    const headerIdx = findHeaderRow(nonEmpty)
    const header = headerIdx >= 0 ? (nonEmpty[headerIdx] || []).map(CELL).slice(0, 14).filter(Boolean) : []
    const sample = nonEmpty.slice(headerIdx >= 0 ? headerIdx + 1 : 0, (headerIdx >= 0 ? headerIdx + 1 : 0) + 3)
      .map(r => (r || []).map(c => CELL(c).slice(0, 40)).slice(0, 10))

    return {
      tab_name: name,
      tab_index: index,
      rows_count: nonEmpty.length,
      cols_count: Math.max(0, ...nonEmpty.map(r => (r || []).length)),
      header,
      sample,
      sections: findSections(nonEmpty),
      nature: classifyTabNature({ rows: nonEmpty, formulaRatio }),
    }
  })
}

// Téléchargement d'un classeur. L'API Sheets n'est pas activée sur le projet
// Cloud (voir CTB - Suivi) et ne rendrait de toute façon pas les valeurs aussi
// simplement : l'export xlsx du Drive est la voie fiable.
async function fetchWorkbook(clients, file) {
  const isNative = file.mimeType === 'application/vnd.google-apps.spreadsheet'
  const res = isNative
    ? await clients.drive.files.export(
      { fileId: file.id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { responseType: 'arraybuffer' })
    : await clients.drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
  return xlsx.read(Buffer.from(res.data), { type: 'buffer', cellFormula: true })
}

// ── Scan ─────────────────────────────────────────────────────────────────────
export async function scanDriveInventory({ accountEmail = null, maxFiles = SCAN_LIMITS.maxFiles, withTabs = true } = {}) {
  const started = Date.now()
  const account = resolveAccount(accountEmail || DEFAULT_ACCOUNT_EMAIL)
  if (!account) throw new Error('Aucun compte Google connecté (page Connecteurs)')

  const drive = await getDriveClient(account.id)
  const clients = { drive }

  let files
  try {
    files = await listAllFiles(drive, maxFiles)
  } catch (e) {
    // `corpora: allDrives` est refusé sur certains comptes sans Drive partagé.
    if (!/corpora|allDrives|invalid/i.test(String(e.message))) throw e
    const mimeQ = [...SPREADSHEET_MIMES, ...DOC_MIMES].map(m => `mimeType='${m}'`).join(' or ')
    const res = await drive.files.list({
      q: `trashed=false and (${mimeQ})`, fields: FILE_FIELDS, orderBy: 'modifiedTime desc', pageSize: 200,
    })
    files = res.data.files || []
  }

  const folderNames = await resolveFolderNames(drive, files, SCAN_LIMITS.maxFolderLookups)
  const sharedDriveNames = await resolveSharedDriveNames(drive, files)
  const registry = knownSyncedRegistry()

  const rows = files.map((f) => {
    const folderName = folderNames.get(f.parents?.[0]) || null
    const cls = classify(f, { registry, folderName })
    const freq = computeFrequency(f)
    return { file: f, folderName, cls, freq }
  })

  // Contenu des onglets : pour les candidats et les fichiers déjà synchronisés
  // (les seuls où le détail sert à décider), du plus récemment modifié au plus
  // ancien, dans la limite du plafond. Un seul téléchargement par classeur sert
  // à la fois aux noms d'onglets, à leur nature et à leur échantillon.
  let tabTargets = []
  if (withTabs) {
    tabTargets = rows
      .filter(r => (r.cls.status === 'candidate' || r.cls.status === 'synced') && kindOfMime(r.file.mimeType) === 'spreadsheet')
      .slice(0, SCAN_LIMITS.maxTabFetches)
  }
  for (const r of tabTargets) {
    try {
      const wb = await fetchWorkbook(clients, r.file)
      r.tabDetails = readWorkbookTabs(wb)
      r.tabs = r.tabDetails.map(t => t.tab_name)
      const fileSync = r.cls.status === 'synced' ? r.cls.syncTarget : null
      for (const t of r.tabDetails) {
        t.cls = classifyTab(t, { registryTabs: registry.tabs, fileId: r.file.id, fileSync })
      }
      // Le statut du fichier découle de ses onglets : « déjà synchronisé » ne
      // tient que si TOUS les onglets sont couverts.
      const derived = deriveItemStatus(r.tabDetails.map(t => t.cls), r.cls.status)
      if (derived !== r.cls.status) {
        const open = r.tabDetails.filter(t => t.cls.status === 'candidate' || t.cls.status === 'partial').length
        r.cls = {
          ...r.cls, status: derived,
          reason: derived === 'partial'
            ? `Partiellement repris : ${open} onglet${open > 1 ? 's' : ''} sur ${r.tabDetails.length} restent à trancher`
            : r.cls.reason,
        }
      }
    } catch (e) { r.tabsError = String(e.message).slice(0, 200) }
  }

  const upsert = db.prepare(`
    INSERT INTO drive_inventory_items (
      id, drive_file_id, name, mime_type, kind, owner_email, owner_name, web_view_link,
      parent_folder_id, parent_folder_name, created_time, modified_time, last_modified_by,
      version, size_bytes, tabs, tabs_error, edits_per_month, days_since_modified, frequency,
      status, status_reason, sync_target, match_terms, source, scanned_account, last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'scan',?, ${NOW})
    ON CONFLICT(drive_file_id) WHERE deleted_at IS NULL DO UPDATE SET
      name=excluded.name, mime_type=excluded.mime_type, kind=excluded.kind,
      owner_email=excluded.owner_email, owner_name=excluded.owner_name,
      web_view_link=excluded.web_view_link, parent_folder_id=excluded.parent_folder_id,
      parent_folder_name=excluded.parent_folder_name, created_time=excluded.created_time,
      modified_time=excluded.modified_time, last_modified_by=excluded.last_modified_by,
      version=excluded.version, size_bytes=excluded.size_bytes,
      tabs=COALESCE(excluded.tabs, drive_inventory_items.tabs),
      tabs_error=excluded.tabs_error, edits_per_month=excluded.edits_per_month,
      days_since_modified=excluded.days_since_modified, frequency=excluded.frequency,
      status=excluded.status, status_reason=excluded.status_reason,
      sync_target=excluded.sync_target, match_terms=excluded.match_terms,
      scanned_account=excluded.scanned_account, last_seen_at=${NOW},
      updated_at=${NOW}, deleted_at=NULL
  `)

  // Onglets : upsert par (fichier, nom d'onglet). Comme pour les fichiers, la
  // décision de l'utilisateur et le jugement de pertinence déjà rendu ne sont
  // jamais écrasés par un re-scan.
  const upsertTab = db.prepare(`
    INSERT INTO drive_inventory_tabs (
      id, item_id, tab_name, tab_index, rows_count, cols_count, header_json, sample_json,
      sections_json, nature, status, status_reason, sync_target
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id, tab_name) WHERE deleted_at IS NULL DO UPDATE SET
      tab_index=excluded.tab_index, rows_count=excluded.rows_count, cols_count=excluded.cols_count,
      header_json=excluded.header_json, sample_json=excluded.sample_json,
      sections_json=excluded.sections_json, nature=excluded.nature,
      status=excluded.status, status_reason=excluded.status_reason, sync_target=excluded.sync_target,
      updated_at=${NOW}, deleted_at=NULL
  `)
  const findItem = db.prepare('SELECT id FROM drive_inventory_items WHERE drive_file_id=? AND deleted_at IS NULL')
  // Un onglet renommé ou supprimé dans le fichier disparaît de l'inventaire.
  const retireMissing = db.prepare(`
    UPDATE drive_inventory_tabs SET deleted_at=${NOW}
    WHERE item_id=? AND deleted_at IS NULL AND tab_name NOT IN (SELECT value FROM json_each(?))
  `)

  const counts = { synced: 0, partial: 0, candidate: 0, ignore: 0 }
  const run = db.transaction(() => {
    for (const r of rows) {
      const f = r.file
      counts[r.cls.status] = (counts[r.cls.status] || 0) + 1
      const owner = ownerOf(f, sharedDriveNames)
      upsert.run(
        newRecordId(), f.id, f.name || null, f.mimeType || null, kindOfMime(f.mimeType),
        owner.email, owner.name,
        f.webViewLink || null, f.parents?.[0] || null, r.folderName,
        f.createdTime || null, f.modifiedTime || null,
        f.lastModifyingUser?.displayName || f.lastModifyingUser?.emailAddress || null,
        Number(f.version) || null, f.size != null ? Number(f.size) : null,
        r.tabs ? JSON.stringify(r.tabs) : null, r.tabsError || null,
        r.freq.editsPerMonth, r.freq.daysSinceModified, r.freq.frequency,
        r.cls.status, r.cls.reason, r.cls.syncTarget, JSON.stringify(r.cls.terms || []),
        account.account_email || null,
      )

      if (!r.tabDetails) continue
      const itemId = findItem.get(f.id)?.id
      if (!itemId) continue
      for (const t of r.tabDetails) {
        upsertTab.run(newRecordId(), itemId, t.tab_name, t.tab_index, t.rows_count, t.cols_count,
          JSON.stringify(t.header), JSON.stringify(t.sample), JSON.stringify(t.sections || []),
          t.nature, t.cls.status, t.cls.reason, t.cls.syncTarget)
      }
      retireMissing.run(itemId, JSON.stringify(r.tabDetails.map(t => t.tab_name)))
    }
  })
  run()

  const durationMs = Date.now() - started
  db.prepare(`
    INSERT INTO drive_inventory_state (id, last_scan_at, last_status, last_error, last_account, files_seen, duration_ms)
    VALUES (1, ${NOW}, 'ok', NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_scan_at=${NOW}, last_status='ok', last_error=NULL,
      last_account=excluded.last_account, files_seen=excluded.files_seen, duration_ms=excluded.duration_ms
  `).run(account.account_email || null, rows.length, durationMs)

  logSync('drive-inventory', 'manual', { status: 'success', modified: rows.length, durationMs })

  return {
    account: account.account_email, files_seen: rows.length, counts,
    // Le Drive est parcouru du plus récemment modifié au plus ancien : quand le
    // plafond est atteint, ce qui manque est nécessairement plus dormant que le
    // reste — mais il faut le dire.
    capped: rows.length >= maxFiles, max_files: maxFiles,
    files_opened: tabTargets.filter(r => r.tabDetails).length,
    tabs_read: tabTargets.reduce((n, r) => n + (r.tabDetails?.length || 0), 0),
    duration_ms: durationMs,
  }
}

export function recordScanError(message) {
  db.prepare(`
    INSERT INTO drive_inventory_state (id, last_scan_at, last_status, last_error)
    VALUES (1, ${NOW}, 'error', ?)
    ON CONFLICT(id) DO UPDATE SET last_scan_at=${NOW}, last_status='error', last_error=excluded.last_error
  `).run(String(message || '').slice(0, 500))
}

// ── Passage complet, en arrière-plan ─────────────────────────────────────────
// Le recensement ouvre plus de cent classeurs puis interroge le modèle pour
// chacun : plusieurs minutes, bien au-delà de ce qu'une requête HTTP peut
// tenir. Le bouton de la page lance donc un job et la page suit sa progression.
// Un seul passage à la fois — deux scans concurrents se marcheraient dessus sur
// les mêmes lignes.
let running = false

export function isRunning() { return running }

export function getState() {
  return db.prepare('SELECT * FROM drive_inventory_state WHERE id = 1').get() || null
}

function setProgress(fields) {
  const keys = Object.keys(fields)
  db.prepare(`
    INSERT INTO drive_inventory_state (id) VALUES (1) ON CONFLICT(id) DO NOTHING
  `).run()
  db.prepare(`UPDATE drive_inventory_state SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=1`)
    .run(...keys.map(k => fields[k]))
}

export function startFullPass({ accountEmail = null, analyze = true } = {}) {
  if (running) return { started: false, reason: 'Un recensement est déjà en cours' }
  running = true
  setProgress({
    analysis_status: 'running', analysis_error: null, analysis_phase: 'Lecture du Drive',
    analysis_done: 0, analysis_total: 0,
  })

  // Volontairement non attendu : l'appelant HTTP répond tout de suite.
  ;(async () => {
    try {
      const scan = await scanDriveInventory({ accountEmail })
      if (!analyze) {
        setProgress({ analysis_status: 'ok', analysis_phase: null, last_analysis_at: null })
        return
      }
      await analyzeInventory({ onProgress: (done, total, phase) => setProgress({ analysis_done: done, analysis_total: total, analysis_phase: phase }) })
      setProgress({
        analysis_status: 'ok', analysis_phase: null, analysis_error: null,
        last_analysis_at: new Date().toISOString(),
      })
      console.log(`📋 Inventaire Drive : ${scan.files_seen} fichiers, ${scan.tabs_read} onglets lus`)
    } catch (e) {
      console.error('❌ Inventaire Drive :', e.message)
      recordScanError(e.message)
      setProgress({ analysis_status: 'error', analysis_error: String(e.message).slice(0, 500), analysis_phase: null })
    } finally {
      running = false
    }
  })()

  return { started: true }
}
