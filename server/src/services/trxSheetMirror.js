// Miroir sortant : Boreal entretient le fichier TRX_Orisha au lieu de le lire.
//
// POURQUOI. Le sens a été inversé le 2026-09-15. Avant, les relevés étaient
// collés à la main dans le fichier et coloriés à la main, et l'ERP lisait ces
// couleurs. Maintenant les relevés entrent directement dans l'ERP (bouton
// « Déposer » de la page Rapprochement bancaire) et c'est BOREAL QUI A LE
// DERNIER MOT : il ajoute les lignes manquantes et repeint les couleurs.
//
// C'EST LE MÊME FICHIER, pas une copie : même adresse, mêmes onglets, et
// surtout LA MÊME MISE EN PAGE. Chaque onglet a la sienne — c'est le collage
// brut du site de chaque banque, avec ses propres colonnes (« Retraits /
// Dépôts » au BNC, « Intérêts / Avance / Remb » sur la marge, « Transaction
// Type » chez Venn). On n'impose rien : on retrouve les colonnes du même œil
// que la lecture (findHeader + mapColumns de bankTrxSheet.js) et on écrit aux
// mêmes places. Le fichier a seulement été converti d'Excel en Google Sheet,
// ce qui permet d'écrire case par case au lieu de tout réécrire.
//
// Rien n'est jamais effacé : on INSÈRE les lignes que le fichier n'a pas, et on
// repeint. Une ligne ajoutée à la main y reste — elle sera simplement peinte
// selon ce que Boreal en sait.
import db from '../db/database.js'
import { getSheetsClient, getDriveClient } from '../connectors/google.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import {
  findHeader, mapColumns, tabDescending, specForTab, parseTrxDate, parseTrxAmount,
  getTrxSheetConfig,
} from './bankTrxSheet.js'
import { plaidBalanceFor } from './plaidSync.js'
import { round2 } from '../utils/money.js'
import { touchBankTxns } from './realtimeEmitters.js'

export const MIRROR_AUTOMATION_ID = 'sys_trx_sheet_mirror'

export const MIRROR_DEFAULT_CONFIG = {
  // Le fichier de Charles, converti en Google Sheet : même identifiant, même
  // lien. Vide = on reprend celui de la sync entrante.
  spreadsheet_id: '',
  google_account_email: 'michel@orisha.io',
  // Ce qu'on AJOUTE au fichier : au-delà, l'historique reste tel quel, on n'y
  // insère rien.
  since_date: '2026-07-01',
  // Ce qu'on COLORIE. Charles veut la couleur du statut sur tout l'historique
  // que l'ERP connaît (2026-09-19), pas seulement sur la fenêtre d'ajout : une
  // ligne sans couleur veut dire « pas encore traitée », pas « trop vieille ».
  paint_since_date: '2000-01-01',
  // Tout ce qui est antérieur à cette date est VERT, apparié ou non : ces
  // exercices sont clos, la couleur n'y pose plus de question (Charles,
  // 2026-09-19). Vide = on ne colorie que ce que l'ERP reconnaît.
  green_before: '2026-06-01',
}

export function getMirrorConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(MIRROR_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* config vide */ }
  const merged = { ...MIRROR_DEFAULT_CONFIG }
  for (const k of Object.keys(MIRROR_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  if (!merged.spreadsheet_id) merged.spreadsheet_id = getTrxSheetConfig().file_id
  return merged
}

function googleAccountId(email) {
  const row = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='google' AND account_email=? AND refresh_token IS NOT NULL",
  ).get(email)
  if (row) return row.id
  const any = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL ORDER BY created_at LIMIT 1",
  ).get()
  return any?.id || null
}

// ── Couleurs ─────────────────────────────────────────────────────────────────

// Exactement les teintes du fichier (SHEET_COLORS de bankTrxSheet.js), en
// valeurs Google : rien à réapprendre pour qui lisait déjà le classeur.
export const STATUS_FILL = {
  rapproche: { red: 0x92 / 255, green: 0xD0 / 255, blue: 0x50 / 255 },     // vert
  comptabilise: { red: 1, green: 1, blue: 0 },                             // jaune
  facture_recue: { red: 0, green: 0xB0 / 255, blue: 0xF0 / 255 },          // bleu
  a_traiter: { red: 0xF7 / 255, green: 0xCA / 255, blue: 0xAC / 255 },     // rouge
  ignore: { red: 0.85, green: 0.85, blue: 0.85 },                          // gris
}

// ── Ce que le fichier contient déjà ──────────────────────────────────────────

const sigOf = (date, amount) => `${date}|${(Math.round(amount * 100) / 100).toFixed(2)}`

// Deux couleurs se valent-elles ? Google rend des flottants ; on compare au
// 1/255 près, la finesse d'une teinte de tableur.
export function sameFill(a, b) {
  if (!a || !b) return false
  return ['red', 'green', 'blue'].every((k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 0.004)
}

// Ne garder que les lignes dont la couleur CHANGE. Sans ça, chaque passage
// repeignait un millier de lignes déjà bonnes et épuisait le quota d'écriture.
export function paintsToApply(paint, currentFills) {
  return paint.filter((p) => !sameFill(currentFills.get(p.rowIndex), STATUS_FILL[p.status]))
}

// Les lignes du fichier, avec leur numéro de ligne réel — on a besoin de
// l'emplacement pour peindre, pas seulement du contenu.
// « 8/3/2026 », est-ce le 8 mars ou le 3 août ? L'onglet tranche par ses dates
// non ambiguës. C'est la MÊME réponse qui doit servir à écrire, sinon une ligne
// posée ne se relit pas et se repose au passage suivant.
export function monthFirstOf(grid, cols) {
  let monthVotes = 0
  let dayVotes = 0
  for (let r = 0; r < grid.length; r++) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-]\d{4}/.exec(String((grid[r] || [])[cols.date] ?? '').trim())
    if (!m) continue
    if (Number(m[1]) > 12) dayVotes++
    else if (Number(m[2]) > 12) monthVotes++
  }
  return monthVotes > dayVotes
}

export function readTabRows(grid, cols, spec, { todayIso } = {}) {
  const today = todayIso || new Date().toISOString().slice(0, 10)
  const monthFirst = monthFirstOf(grid, cols)
  const out = []
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || []
    const date = parseTrxDate(row[cols.date], { todayIso: today, monthFirst })
    if (!date) continue
    const amount = amountOfRow(row, cols, spec)
    // Les lignes d'intérêts seuls d'une marge de crédit ne déplacent pas le
    // solde : elles n'ont pas de montant. Boreal en garde pourtant d'anciennes
    // en base, importées quand les intérêts comptaient comme un mouvement —
    // `alt_amount` les reconnaît, sinon le miroir les réécrirait en double
    // dans le fichier de Michel.
    const alt = legacyAmountOfRow(row, cols, spec)
    if (amount == null && alt == null) continue
    out.push({ rowIndex: r, txn_date: date, amount, alt_amount: alt !== amount ? alt : null })
  }
  return out
}

// La convention d'avant : les intérêts d'une marge comptaient comme un
// mouvement. Elle ne sert plus qu'à reconnaître les lignes déjà en base.
export function legacyAmountOfRow(row, cols, spec) {
  if (cols.interest == null) return null
  const interest = parseTrxAmount(row[cols.interest])
  const advance = cols.advance != null ? parseTrxAmount(row[cols.advance]) : null
  const remb = cols.remb != null ? parseTrxAmount(row[cols.remb]) : null
  if (interest == null && advance == null && remb == null) return null
  let amount = (interest || 0) + (advance || 0) - Math.abs(remb || 0)
  if (!amount) return null
  if (spec?.invert) amount = -amount
  return Math.round(amount * 100) / 100
}

export function amountOfRow(row, cols, spec) {
  let amount = null
  if (cols.interest != null || cols.advance != null || cols.remb != null) {
    // Marge de crédit : seuls l'avance et le remboursement bougent le solde
    // utilisé. Les intérêts sortent du compte courant avec le capital — même
    // convention que la lecture du relevé, sinon la ligne du fichier ne se
    // reconnaîtrait plus dans celle de Boreal et serait réécrite en double.
    const interest = cols.interest != null ? parseTrxAmount(row[cols.interest]) : null
    const advance = cols.advance != null ? parseTrxAmount(row[cols.advance]) : null
    const remb = cols.remb != null ? parseTrxAmount(row[cols.remb]) : null
    if (interest == null && advance == null && remb == null) return null
    amount = (advance || 0) - Math.abs(remb || 0)
  } else if (cols.amount != null && parseTrxAmount(row[cols.amount]) != null) {
    amount = parseTrxAmount(row[cols.amount])
  } else {
    const debit = cols.debit != null ? parseTrxAmount(row[cols.debit]) : null
    const credit = cols.credit != null ? parseTrxAmount(row[cols.credit]) : null
    if (debit == null && credit == null) return null
    amount = (credit != null ? Math.abs(credit) : 0) - (debit != null ? Math.abs(debit) : 0)
  }
  if (amount == null || amount === 0) return null
  if (spec?.invert) amount = -amount
  return Math.round(amount * 100) / 100
}

// ── Ce que Boreal veut y voir ────────────────────────────────────────────────

export function txnsForAccount(accountId, sinceDate) {
  const rows = db.prepare(`
    SELECT id, txn_date, description, details, reference, amount, balance, status, bank_state,
           review_flag, review_flag_at, review_sheet_base, comment, comment_sheet_base
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND txn_date >= ?
    ORDER BY txn_date ASC, rowid ASC
  `).all(accountId, sinceDate)
  return rows
}

// Le solde lu à la banque, dans la convention que le relevé imprime : le solde
// du compte (`current`), pas l'argent utilisable. Vérifié le 2026-09-15 : sur le
// BNC CAD, `current` vaut 0,69 $ — le compte est balayé chaque jour — alors
// qu'`available` affiche 43 681,69 $ (la marge comprise). C'est bien `current`
// que la colonne « Solde » d'un relevé imprime, et sur une carte c'est le
// montant DÛ.
function bankBalanceFor(accountId) {
  let read = null
  try { read = plaidBalanceFor(accountId) } catch { return null }
  if (!read) return null
  return read.current ?? read.available ?? null
}

// Chaque onglet écrit ses dates à sa façon : « 2026-09-11 » au BNC,
// « 8/1/2026 » sur la Visa USD, « 23 DÉC23 Décembre » chez Desjardins. Une
// ligne ajoutée doit ressembler à ses voisines, sinon elle saute aux yeux. On
// apprend la forme dominante de l'onglet plutôt que de l'imposer.
export function dateShape(rawDates) {
  let iso = 0
  let monthFirst = 0
  let dayFirst = 0
  for (const raw of rawDates) {
    const v = String(raw ?? '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { iso++; continue }
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
    if (!m) continue
    if (Number(m[1]) > 12) dayFirst++
    else if (Number(m[2]) > 12) monthFirst++
  }
  if (monthFirst > dayFirst && monthFirst >= iso) return 'M/D/YYYY'
  if (dayFirst > monthFirst && dayFirst >= iso) return 'D/M/YYYY'
  return 'ISO'
}

export function formatDateLike(iso, shape) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m || shape === 'ISO') return iso
  const [, y, mo, d] = m
  const n = (x) => String(Number(x))
  return shape === 'M/D/YYYY' ? `${n(mo)}/${n(d)}/${y}` : `${n(d)}/${n(mo)}/${y}`
}

// Une transaction de l'ERP, écrite dans les colonnes DE CET ONGLET. Les colonnes
// que l'ERP ne connaît pas (transit émetteur, heure, numéro de carte) restent
// vides plutôt que d'être inventées.
// Largeur des colonnes de DONNÉES. La colonne « X » (relecture de Michel) vit
// à droite du bloc, après une colonne vide : l'inclure ferait peindre la marge
// et écrire des cellules vides chez les commentaires.
export function dataWidth(cols) {
  const vals = Object.entries(cols).filter(([k, v]) => k !== 'review' && k !== 'comment' && v != null).map(([, v]) => v)
  return Math.max(...vals) + 1
}

export function rowForTab(txn, cols, spec, shape = 'ISO', kind = 'bank') {
  const width = dataWidth(cols)
  const cells = new Array(width).fill('')
  const money = (n) => (Math.round(Math.abs(n) * 100) / 100).toFixed(2)
  // Le fichier note ce que la banque imprime : sur les Visa Desjardins, un
  // achat est POSITIF. On repasse donc dans la convention de l'onglet.
  const amount = spec?.invert ? -txn.amount : txn.amount

  cells[cols.date] = formatDateLike(txn.txn_date, shape)
  if (cols.description != null) cells[cols.description] = txn.description || ''
  if (cols.details != null) cells[cols.details] = txn.details || ''
  if (cols.reference != null) cells[cols.reference] = txn.reference || ''
  // Le solde garde SON SIGNE (une marge de crédit passe en négatif) : `money()`
  // prend la valeur absolue, il ne convient qu'aux colonnes débit/crédit. Une
  // ligne neuve sans solde connu sort vide : la passe de solde la remplira dans
  // l'ordre du fichier (voir `balanceCells`).
  if (cols.balance != null) {
    cells[cols.balance] = txn.balance == null ? '' : (Math.round(txn.balance * 100) / 100).toFixed(2)
  }
  // L'état à la banque : le fichier le laissait souvent vide, il est maintenant
  // écrit sur chaque ligne que Boreal pose.
  if (cols.status != null && txn.bank_state) cells[cols.status] = stateWord(txn.bank_state, kind) || ''

  if (cols.interest != null || cols.advance != null || cols.remb != null) {
    // Marge de crédit : une avance augmente le solde utilisé, un remboursement
    // le réduit.
    if (amount >= 0 && cols.advance != null) cells[cols.advance] = money(amount)
    else if (amount < 0 && cols.remb != null) cells[cols.remb] = money(amount)
  } else if (cols.debit != null || cols.credit != null) {
    if (amount < 0 && cols.debit != null) cells[cols.debit] = money(amount)
    else if (amount > 0 && cols.credit != null) cells[cols.credit] = money(amount)
  } else if (cols.amount != null) {
    cells[cols.amount] = (Math.round(amount * 100) / 100).toFixed(2)
  }
  return cells
}

// UNE LIGNE POSÉE DOIT POUVOIR SE RELIRE. Le miroir reconnaît ce qu'il a déjà
// écrit à la date et au montant ; une ligne qu'il ne sait pas relire lui paraît
// manquante à chaque passage et se repose indéfiniment. Vécu : une opération de
// 0,00 $ (une autorisation Plaid sans montant) recopiée 335 fois sur l'onglet
// Visa USD, toutes les 20 minutes pendant des jours. On refuse donc d'écrire
// une ligne qui ne se relit pas telle quelle — un montant nul n'est jamais lu,
// et une date écrite dans le mauvais sens se relirait à une autre date.
export function readsBack(txn, cols, spec, shape, kind, monthFirst) {
  const cells = rowForTab(txn, cols, spec, shape, kind)
  const date = parseTrxDate(cells[cols.date], { monthFirst })
  if (date !== txn.txn_date) return false
  const amount = amountOfRow(cells, cols, spec)
  return amount != null && Math.abs(amount - round2(txn.amount)) < 0.005
}

// Les mots que le fichier emploie déjà dans sa colonne « Status ».
// Les mots que le fichier emploie DÉJÀ, et ils ne sont pas les mêmes partout.
// Une carte ne « complète » rien : sur l'onglet MasterCard une opération est
// « En attente » puis « Autorisée » — c'est ce que Michel y écrit depuis
// toujours, et y poser « Completed » était faux. Les onglets Venn, eux, sont en
// anglais parce que c'est ce que Venn exporte.
const STATE_WORDS = {
  bank: { complete: 'Completed', en_attente: 'Pending', autorise: 'Authorized' },
  // Une carte : « En attente » tant que la banque la montre en attente,
  // « Autorisée » une fois qu'elle ne l'est plus (décision de Charles,
  // 2026-09-16). Ces mots ne sont JAMAIS déduits : ils viennent de la colonne
  // « Statut » du document déposé (export du portail, onglet du classeur).
  // Sans état connu, la cellule reste vide.
  card: { complete: 'Autorisée', en_attente: 'En attente', autorise: 'Autorisée' },
}

export const stateWord = (state, kind) => (STATE_WORDS[kind === 'card' ? 'card' : 'bank'][state] || null)

// Ce qui manque au fichier, et à quelle ligne repeindre ce qui y est déjà.
// Signature (date + montant signé) : la même monnaie que la déduplication de
// l'import, parce que les libellés ne se formulent jamais pareil.
export function planTab(fileRows, txns) {
  const counts = new Map()
  const add = (sig, rowIndex) => {
    if (!counts.has(sig)) counts.set(sig, [])
    counts.get(sig).push(rowIndex)
  }
  for (const r of fileRows) {
    if (r.amount != null) add(sigOf(r.txn_date, r.amount), r.rowIndex)
    // Même ligne, ancienne façon de la chiffrer : elle reste reconnaissable.
    if (r.alt_amount != null) add(sigOf(r.txn_date, r.alt_amount), r.rowIndex)
  }
  // Une ligne du fichier indexée sous deux montants ne doit servir qu'une fois.
  const taken = new Set()
  const missing = []
  const paint = []
  for (const t of txns) {
    const slot = (counts.get(sigOf(t.txn_date, t.amount)) || []).find((idx) => !taken.has(idx))
    if (slot != null) {
      taken.add(slot)
      // `txn` accompagne la ligne appariée : c'est lui qui porte l'état à la
      // banque et le solde à écrire dans les cellules de CETTE ligne.
      paint.push({ rowIndex: slot, status: t.status, txn: t })
    } else {
      missing.push(t)
    }
  }
  return { missing, paint }
}

// ── Écriture ─────────────────────────────────────────────────────────────────

// Les onglets réels du fichier, rangés par compte ERP : les titres du classeur
// (« Desj CAD », « MasterCard ») ne sont pas les noms des comptes, et c'est la
// lecture qui sait les rapprocher.
// Google plafonne les écritures à 60 par minute et par utilisateur. Plutôt que
// d'abandonner l'onglet en cours, on patiente et on recommence.
async function withRetry(fn, { tries = 5 } = {}) {
  let wait = 2000
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= tries || !/quota|rate limit|429/i.test(String(e.message))) throw e
      await new Promise((r) => setTimeout(r, wait))
      wait *= 2
    }
  }
}

async function tabsByAccount(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' })
  const map = new Map()
  for (const sh of meta.data.sheets || []) {
    const spec = specForTab(sh.properties.title)
    if (spec) map.set(spec.account, { title: sh.properties.title, sheetId: sh.properties.sheetId, spec })
  }
  return map
}

function colLetter(i) {
  let s = ''
  let n = i
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 }
  return s
}

// Une requête de peinture par PLAGE de lignes voisines de même statut — une par
// ligne ferait des milliers d'appels.
// Remise à blanc d'une ligne qui vient d'être insérée : aucun fond hérité, sur
// toute sa largeur. Le repère de couleur de Michel vit à droite des données et
// ne doit jamais être recopié sur une transaction neuve.
export function blankRowFill(sheetId, rowIndex) {
  return [{
    repeatCell: {
      range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1 },
      cell: { userEnteredFormat: { backgroundColorStyle: { themeColor: 'BACKGROUND' } } },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle',
    },
  }]
}

// La hauteur d'une ligne neuve = celle de la ligne de données la plus proche.
// Sans ça, elle hérite de sa voisine, qui peut être une ligne de séparation de
// quelques pixels : la transaction devient illisible.
export function rowHeightFill(sheetId, rowIndex, pixelSize) {
  if (!pixelSize) return []
  return [{
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  }]
}

// Hauteur d'une ligne de données type : la plus fréquente parmi les lignes lues.
export function dataRowHeight(fileRows, rowHeights) {
  const count = new Map()
  for (const r of fileRows) {
    const h = rowHeights[r.rowIndex]
    if (h) count.set(h, (count.get(h) || 0) + 1)
  }
  let best = null
  for (const [h, n] of count) if (best == null || n > count.get(best)) best = h
  return best
}

export function paintRuns(paints, sheetId, width) {
  const sorted = paints.slice().sort((a, b) => a.rowIndex - b.rowIndex)
  const out = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length
      && sorted[j + 1].rowIndex === sorted[j].rowIndex + 1
      && sorted[j + 1].status === sorted[i].status) j++
    out.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: sorted[i].rowIndex,
          endRowIndex: sorted[j].rowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: width,
        },
        cell: { userEnteredFormat: { backgroundColor: STATUS_FILL[sorted[i].status] || { red: 1, green: 1, blue: 1 } } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    })
    i = j + 1
  }
  return out
}

// ── Les cellules d'une ligne DÉJÀ au fichier ────────────────────────────────
//
// Le miroir n'écrivait que les lignes qu'il ajoutait ; celles déjà présentes
// n'étaient que repeintes. Résultat : leur colonne « Statut » restait vide et
// leur colonne « Solde » gardait ce que la banque avait imprimé — rien, sur une
// carte. On réécrit donc ces deux cellules, et SEULEMENT quand elles diffèrent :
// Google plafonne les écritures, et une recopie qui ne change rien doit ne rien
// coûter.
export function cellsToWrite(paired, cols, title, kind = 'bank') {
  if (cols.status == null) return []
  const out = []
  for (const p of paired) {
    if (p.fresh || !p.txn) continue
    const want = stateWord(p.txn.bank_state, kind)
    const have = String(p.current?.status ?? '').trim()
    // On REMPLIT les trous ; on ne réécrit une cellule que dans UN cas : une
    // ligne encore « en attente » au fichier que la banque déclare maintenant
    // passée. Une transaction ne recule jamais, et le reste de ce que quelqu'un
    // a écrit à la main n'est jamais touché.
    const settled = want && !/attente|pending/i.test(want)
    if (want && (!have || (settled && /attente|pending/i.test(have)))) {
      out.push({ range: `${title}!${colLetter(cols.status)}${p.rowIndex + 1}`, values: [[want]] })
    }
  }
  return out
}

// ── La colonne « X » : ce que Charles envoie relire à Michel ────────────────
//
// Le classeur porte déjà cette colonne sur chaque onglet (légende « Trx non
// révisée (Mike) »). La marque se pose DES DEUX CÔTÉS — dans Boréal ou à la
// main dans le fichier — et se synchronise comme le commentaire : on retient le
// dernier état commun (`review_sheet_base`) et le côté qui s'en écarte gagne.
// Sans état commun connu, le X l'emporte : une marque n'est jamais retirée par
// Boréal sans qu'on l'ait vue retirée ailleurs. Tout autre texte (« AL », une
// phrase) est laissé intact et ne compte pas.
export function resolveReview(erpFlag, fileRaw, base) {
  const raw = String(fileRaw ?? '').trim()
  if (raw && raw.toUpperCase() !== 'X') return { skip: true }
  const e = erpFlag ? 'X' : ''
  const f = raw ? 'X' : ''
  const b = base == null ? null : (String(base).trim().toUpperCase() === 'X' ? 'X' : '')
  if (e === f) return { value: e }
  if (b != null && e === b) return { value: f, toErp: true }
  if (b != null && f === b) return { value: e, toFile: true }
  return e === 'X' ? { value: 'X', toFile: true } : { value: 'X', toErp: true }
}

// Cellules X à écrire au fichier ; met à jour l'ERP pour les marques venues du fichier.
export function syncReviewMarks(paired, cols, title) {
  if (cols.review == null) return { cells: [], toErp: [] }
  const setErp = db.prepare(
    "UPDATE bank_transactions SET review_flag=?, review_flag_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), review_sheet_base=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  )
  const setBase = db.prepare('UPDATE bank_transactions SET review_sheet_base=? WHERE id=?')
  const cells = []
  const toErp = []
  for (const p of paired) {
    if (!p.txn) continue
    const r = resolveReview(p.txn.review_flag, p.fresh ? '' : p.current?.review, p.txn.review_sheet_base)
    if (r.skip) continue
    if (r.toFile) cells.push({ range: `${title}!${colLetter(cols.review)}${p.rowIndex + 1}`, values: [[r.value]] })
    if (r.toErp) {
      setErp.run(r.value ? 1 : 0, r.value, p.txn.id)
      toErp.push(p.txn.id)
    } else if ((p.txn.review_sheet_base ?? null) !== r.value) {
      setBase.run(r.value, p.txn.id)
    }
    p.txn.review_flag = r.value ? 1 : 0
    p.txn.review_sheet_base = r.value
  }
  return { cells, toErp }
}

// ── Commentaire : dans les deux sens ─────────────────────────────────────────
//
// Le fichier ne date pas ses cellules : on retient le dernier texte commun
// (`comment_sheet_base`) et le côté qui s'en écarte est celui qui a changé.
// Les deux ont changé : on garde les deux textes, rien ne se perd.
export function resolveComment(erp, file, base) {
  const e = String(erp ?? '').trim()
  const f = String(file ?? '').trim()
  const b = String(base ?? '').trim()
  if (e === f) return { value: e }
  if (e === b) return { value: f, toErp: true }
  if (f === b) return { value: e, toFile: true }
  if (!e) return { value: f, toErp: true }
  if (!f) return { value: e, toFile: true }
  if (f.includes(e)) return { value: f, toErp: true }
  if (e.includes(f)) return { value: e, toFile: true }
  return { value: `${f} · ${e}`, toErp: true, toFile: true }
}

// Cellules à écrire au fichier ; met à jour l'ERP pour ce qui vient du fichier.
export function syncComments(paired, cols, title) {
  if (cols.comment == null) return { cells: [], toErp: [] }
  const setErp = db.prepare(
    `UPDATE bank_transactions SET comment=?, comment_sheet_base=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
  )
  const setBase = db.prepare('UPDATE bank_transactions SET comment_sheet_base=? WHERE id=?')
  const cells = []
  const toErp = []
  for (const p of paired) {
    if (!p.txn) continue
    const file = p.fresh ? '' : p.current?.comment
    const r = resolveComment(p.txn.comment, file, p.txn.comment_sheet_base)
    if (r.toFile) cells.push({ range: `${title}!${colLetter(cols.comment)}${p.rowIndex + 1}`, values: [[r.value]] })
    if (r.toErp) {
      setErp.run(r.value || null, r.value, p.txn.id)
      toErp.push(p.txn.id)
    } else if (String(p.txn.comment_sheet_base ?? '').trim() !== r.value) {
      setBase.run(r.value, p.txn.id)
    }
    p.txn.comment = r.value || null
    p.txn.comment_sheet_base = r.value
  }
  return { cells, toErp }
}

// ── Le solde, dans l'ordre DU FICHIER ────────────────────────────────────────
//
// Une colonne « Solde » se lit de haut en bas : chaque ligne doit valoir la
// précédente plus son montant, tel que le fichier les range. L'ordre de l'ERP
// (chronologique) n'est pas celui de l'onglet (l'ordre des collages), donc le
// solde se calcule ICI, sur les lignes du fichier.
//
// Deux règles :
//  • un solde DÉJÀ imprimé fait autorité : on ne le réécrit jamais, et il sert
//    d'ancre pour les cellules vides qui l'entourent (chaque trou est comblé
//    depuis le solde connu le plus proche) ;
//  • une ligne GRISE (exclue dans l'ERP — les pré-autorisations de 2 $ qui ne
//    passeront jamais) ne déplace pas le solde : elle porte celui de sa voisine.
//
// Aucun solde imprimé nulle part (les onglets de carte) : on ancre sur le solde
// lu à la banque, posé sur la ligne la plus récente de l'onglet.
// Les lignes de l'onglet préparées pour le calcul du solde : leur montant, si
// elles sont grises, et — le point délicat — si leur cellule solde FAIT AUTORITÉ.
//
// Fait autorité : une cellule que la banque a imprimée, c'est-à-dire une ligne
// dont l'ERP connaît le solde (`balance` non nul), ou une ligne que l'ERP ne
// connaît pas du tout (saisie à la main dans le fichier). Tout le reste a été
// écrit par ce calcul lors d'un passage précédent : on le recalcule au lieu de
// s'ancrer dessus, sinon une erreur d'un passage se figerait pour toujours.
// Un solde nul s'écrit «  -  » dans un format comptable : sans ça, on le lisait
// comme une cellule vide et on y réécrivait « 0.00 » à chaque passage.
export function balanceOfCell(raw) {
  const txt = String(raw ?? '').trim()
  if (!txt) return null
  if (/^[-–—\s$]+$/.test(txt)) return 0
  return parseTrxAmount(txt)
}

export function rowsForBalancePass(fileRows, grid, cols, txns) {
  const bySig = new Map()
  for (const t of txns) {
    const k = sigOf(t.txn_date, t.amount)
    if (!bySig.has(k)) bySig.set(k, [])
    bySig.get(k).push(t)
  }
  const used = new Map()
  return fileRows.map((r) => {
    const k = sigOf(r.txn_date, r.amount)
    const slot = used.get(k) || 0
    const txn = (bySig.get(k) || [])[slot] || null
    if (txn) used.set(k, slot + 1)
    const cell = balanceOfCell((grid[r.rowIndex] || [])[cols.balance])
    return {
      rowIndex: r.rowIndex,
      amount: r.amount,
      grey: txn?.status === 'ignore',
      printed: cell != null && (!txn || txn.balance != null) ? cell : null,
      current: cell,
      // Le solde que la banque a imprimé pour CETTE ligne, quand l'ERP le
      // connaît : il fait autorité sur ce que le fichier affiche.
      bank: txn?.balance ?? null,
    }
  })
}

// Le sens du solde de CET onglet, déduit de ses propres soldes imprimés : un
// compte de banque monte avec un dépôt (+1), une carte monte avec un achat (-1).
// Moins de deux soldes imprimés : rien à déduire, on prend la nature du compte.
export function detectTabDirection(rows, descending, fallback = 1) {
  const printed = rows.filter((r) => r.printed != null)
  if (printed.length < 2) return fallback
  let best = fallback
  let bestErr = Infinity
  for (const direction of [1, -1]) {
    const move = (r) => (r.grey ? 0 : round2(direction * r.amount))
    let err = 0
    let checks = 0
    let acc = null
    for (let i = 0; i < rows.length; i++) {
      // Même récurrence que `balanceCells` : en descendant on retire le
      // mouvement de la ligne qu'on quitte, en montant on ajoute le sien.
      if (acc != null) acc = round2(descending ? acc - move(rows[i - 1]) : acc + move(rows[i]))
      if (rows[i].printed != null) {
        if (acc != null) { checks++; err += Math.abs(round2(rows[i].printed - acc)) }
        acc = round2(rows[i].printed)
      }
    }
    if (checks && err < bestErr) { bestErr = err; best = direction }
  }
  return best
}

export function balanceCells(rows, { direction, descending, bankBalance = null, title, balanceCol }) {
  if (balanceCol == null || !rows.length) return []
  // `rows` : { rowIndex, amount, printed (ou null), grey } dans l'ordre du fichier.
  const move = (r) => (r.grey ? 0 : round2(direction * r.amount))
  const known = new Map()
  for (const r of rows) if (r.printed != null) known.set(r.rowIndex, round2(r.printed))

  if (!known.size) {
    if (bankBalance == null) return []
    // La ligne la plus récente porte le solde d'aujourd'hui.
    const newest = descending ? rows[0] : rows[rows.length - 1]
    known.set(newest.rowIndex, round2(Number(bankBalance)))
  }

  // Descendre : sur un onglet qui descend, la ligne du dessous est PLUS ANCIENNE
  // (on retire son mouvement) ; sur un onglet qui monte, elle est plus récente.
  const values = new Map(known)
  for (let i = 0; i < rows.length; i++) {
    if (values.has(rows[i].rowIndex)) continue
    // Ancre au-dessus ?
    let j = i - 1
    while (j >= 0 && !values.has(rows[j].rowIndex)) j--
    if (j >= 0) {
      let acc = values.get(rows[j].rowIndex)
      for (let k = j + 1; k <= i; k++) {
        acc = round2(descending ? acc - move(rows[k - 1]) : acc + move(rows[k]))
        values.set(rows[k].rowIndex, acc)
      }
      continue
    }
    // Sinon, ancre en dessous : on remonte.
    let m = i + 1
    while (m < rows.length && !values.has(rows[m].rowIndex)) m++
    if (m >= rows.length) break
    let acc = values.get(rows[m].rowIndex)
    for (let k = m - 1; k >= i; k--) {
      acc = round2(descending ? acc + move(rows[k]) : acc - move(rows[k + 1]))
      values.set(rows[k].rowIndex, acc)
    }
  }

  const out = []
  for (const r of rows) {
    // Le fichier affiche autre chose que ce que la banque a imprimé (un signe
    // perdu, une valeur périmée) : c'est la banque qui a raison.
    if (r.bank != null && r.current != null && Math.abs(r.current - r.bank) > 0.005) {
      out.push({
        range: `${title}!${colLetter(balanceCol)}${r.rowIndex + 1}`,
        values: [[round2(r.bank).toFixed(2)]],
      })
      continue
    }
    if (r.printed != null) continue
    const v = values.get(r.rowIndex)
    if (v == null) continue
    // Déjà la bonne valeur dans la cellule : rien à écrire.
    if (r.current != null && Math.abs(r.current - v) <= 0.005) continue
    out.push({
      range: `${title}!${colLetter(balanceCol)}${r.rowIndex + 1}`,
      values: [[v.toFixed(2)]],
    })
  }
  return out
}

// Dans QUEL SENS l'onglet grandit. `tabDescending` regarde tout l'onglet, ce
// qui suffit pour lire des dates mais pas pour écrire : les onglets sont une
// pile de collages successifs et le plus ancien n'a pas forcément le même sens
// que le plus récent. VISA CAD en est l'exemple : un bloc 2024-2025 rangé du
// plus récent au plus ancien, puis tout le reste rangé à l'endroit — 22 pas vers
// le bas, 22 vers le haut, et la nouvelle ligne serait tombée EN TÊTE, au milieu
// de 2024. On se fie donc à la FIN de l'onglet, là où les lignes s'ajoutent.
export function growthDescending(dates, { tail = 20 } = {}) {
  const last = dates.slice(-Math.max(2, tail))
  let down = 0
  let up = 0
  for (let i = 1; i < last.length; i++) {
    if (last[i] === last[i - 1]) continue
    if (last[i] < last[i - 1]) down++
    else up++
  }
  if (!down && !up) return tabDescending(dates) // fin plate : on reprend l'onglet entier
  return down >= up
}

// Où insérer chaque ligne absente pour qu'elle tombe à sa date. On cherche
// depuis LA FIN la dernière ligne qui doit rester au-dessus d'elle — plus
// récente sur un onglet qui descend, plus ancienne sur un onglet qui monte — et
// on se pose juste en dessous. Chercher depuis le début accrochait le vieux
// bloc en tête des onglets qui en portent un. Les emplacements tiennent compte
// des insertions déjà décidées, donc la liste s'applique dans l'ordre rendu.
export function placeMissing(fileRows, missing, descending, headerIdx, gridLength) {
  const rows = fileRows.map((r) => ({ ...r }))
  const out = []
  // De la plus ancienne à la plus récente sur un onglet descendant : chaque
  // nouvelle insertion se place ainsi au-dessus des précédentes.
  const order = [...missing].sort((a, b) => (descending
    ? a.txn_date.localeCompare(b.txn_date)
    : b.txn_date.localeCompare(a.txn_date)))
  for (const txn of order) {
    let at = null
    for (let i = rows.length - 1; i >= 0; i--) {
      const above = descending ? rows[i].txn_date >= txn.txn_date : rows[i].txn_date <= txn.txn_date
      if (above) { at = rows[i].rowIndex + 1; break }
    }
    // Rien au-dessus : juste avant la PREMIÈRE ligne de données, pas sous
    // l'en-tête — une fine ligne vide de séparation peut les séparer, la
    // transaction neuve se range sous elle (Venn USD, 2026-09-22).
    if (at == null) at = rows.length ? Math.min(...rows.map((r) => r.rowIndex)) : Math.max(headerIdx + 1, gridLength)
    out.push({ at, txn })
    for (const r of rows) if (r.rowIndex >= at) r.rowIndex += 1
    rows.push({ rowIndex: at, txn_date: txn.txn_date })
    rows.sort((a, b) => a.rowIndex - b.rowIndex)
  }
  return out
}

// Les valeurs d'un onglet, relues après insertion : les numéros de ligne ont
// bougé, et le solde se calcule sur les lignes telles qu'elles sont rangées.
async function readTabGrid(sheets, spreadsheetId, title) {
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId, range: `${title}!A1:Z100000`, valueRenderOption: 'FORMATTED_VALUE',
  }))
  return res.data.values || []
}

async function mirrorTab(sheets, spreadsheetId, account, tab, cfg) {
  const { title, sheetId, spec } = tab
  // Valeurs ET couleurs en une seule lecture : les couleurs servent à ne
  // repeindre que ce qui change.
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [`${title}!A1:Z100000`],
    fields: 'sheets(data(rowMetadata(pixelSize),rowData(values(formattedValue,effectiveFormat/backgroundColor))))',
  })
  const rowHeights = (res.data.sheets?.[0]?.data?.[0]?.rowMetadata || []).map((m) => m.pixelSize)
  const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData || []
  const grid = rowData.map((r) => (r.values || []).map((c) => c.formattedValue ?? ''))
  const currentFills = new Map()
  rowData.forEach((r, i) => {
    const bg = r.values?.[0]?.effectiveFormat?.backgroundColor
    if (bg) currentFills.set(i, bg)
  })
  const headerIdx = findHeader(grid)
  if (headerIdx < 0) return { tab: title, skipped: 'entêtes introuvables' }
  const cols = mapColumns(Array.from(grid[headerIdx] || []))
  if (cols.date == null) return { tab: title, skipped: 'colonne date introuvable' }

  const fileRows = readTabRows(grid.slice(headerIdx + 1), cols, spec)
    .map((r) => ({ ...r, rowIndex: r.rowIndex + headerIdx + 1 }))
  // On APPARIE tout l'historique que l'ERP connaît — c'est ce qui permet de
  // colorier les lignes d'avant la fenêtre — mais on n'AJOUTE que les lignes de
  // la fenêtre : l'ancien du fichier reste tel quel.
  const txns = txnsForAccount(account.id, cfg.paint_since_date)
  const plan = planTab(fileRows, txns)
  const paint = plan.paint
  const missing = plan.missing.filter((t) => t.txn_date >= cfg.since_date)
  // La passe de solde, elle, reste dans la fenêtre : au-delà, le fichier porte
  // des soldes collés à la main qu'on n'a aucune raison de recalculer.
  const windowTxns = txns.filter((t) => t.txn_date >= cfg.since_date)

  // Ce que le fichier porte AUJOURD'HUI dans les cellules qu'on va peut-être
  // réécrire : relevé avant toute insertion, car les insertions décalent les
  // numéros de ligne (et donc l'index dans `grid`).
  for (const p of paint) {
    const gridRow = grid[p.rowIndex] || []
    p.current = {
      status: cols.status != null ? gridRow[cols.status] : null,
      balance: cols.balance != null ? gridRow[cols.balance] : null,
      review: cols.review != null ? gridRow[cols.review] : null,
      comment: cols.comment != null ? gridRow[cols.comment] : null,
    }
  }

  const descending = growthDescending(fileRows.map((r) => r.txn_date))
  const width = dataWidth(cols)
  const monthFirst = monthFirstOf(grid.slice(headerIdx + 1), cols)
  let shape = dateShape(grid.slice(headerIdx + 1).map((r) => (r || [])[cols.date]))
  // Un onglet en barres obliques s'écrit dans le sens où il se LIT, pas dans le
  // sens deviné : les deux votes ne comptent pas les mêmes lignes.
  if (shape !== 'ISO') shape = monthFirst ? 'M/D/YYYY' : 'D/M/YYYY'
  const writable = missing.filter((t) => readsBack(t, cols, spec, shape, account.kind, monthFirst))
  const unreadable = missing.length - writable.length
  if (unreadable) console.log(`Miroir ${title} : ${unreadable} ligne(s) non relisibles, laissées de côté`)

  // Chaque ligne neuve va À SA DATE, pas en tête. Les onglets sont une pile de
  // collages successifs : un relevé de janvier posé au-dessus du bloc de
  // septembre serait illisible. On insère une ligne à la fois, en repartant de
  // la plus ancienne, pour que les positions restent valides.
  const placements = placeMissing(fileRows, writable, descending, headerIdx, grid.length)
  const rowHeight = dataRowHeight(fileRows, rowHeights)
  for (const { at, txn } of placements) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: { sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + 1 },
              inheritFromBefore: false,
            },
          },
          // Une ligne insérée hérite du format de sa voisine — donc, à droite du
          // bloc de données, du repère de couleur que Michel y a posé (rouge « à
          // vérifier », orange « rendu ici »). Une transaction neuve n'a rien à
          // dire de sa relecture : on rend la ligne vierge, la peinture du
          // statut ne couvrira ensuite que les colonnes de données.
          ...blankRowFill(sheetId, at),
          ...rowHeightFill(sheetId, at, rowHeight),
        ],
      },
    }))
    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A${at + 1}:${colLetter(width - 1)}${at + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowForTab(txn, cols, spec, shape, account.kind)] },
    }))
    for (const p of paint) if (p.rowIndex >= at) p.rowIndex += 1
    // `fresh` : la ligne vient d'être écrite en entier, ses cellules sont déjà bonnes.
    paint.push({ rowIndex: at, status: txn.status, txn, fresh: true })
  }
  const ordered = placements

  // L'état à la banque sur les lignes déjà au fichier.
  const cells = cellsToWrite(paint, cols, title, account.kind)
  const reviews = syncReviewMarks(paint, cols, title)
  cells.push(...reviews.cells)
  const adopted = reviews.toErp.length
  const comments = syncComments(paint, cols, title)
  cells.push(...comments.cells)
  if (comments.toErp.length || reviews.toErp.length) touchBankTxns([...new Set([...comments.toErp, ...reviews.toErp])])

  // Puis le solde. Il se calcule sur le fichier TEL QU'IL EST après insertion
  // (les nouvelles lignes ont décalé les numéros), donc on le relit.
  if (cols.balance != null) {
    const after = placements.length ? await readTabGrid(sheets, spreadsheetId, title) : grid
    const rows2 = readTabRows(after.slice(headerIdx + 1), cols, spec)
      .map((r) => ({ ...r, rowIndex: r.rowIndex + headerIdx + 1 }))
    const rowsForBalance = rowsForBalancePass(rows2, after, cols, windowTxns)
    const desc2 = growthDescending(rows2.map((r) => r.txn_date))
    const direction = detectTabDirection(rowsForBalance, desc2, account.kind === 'card' ? -1 : 1)
    // Sur un onglet aux montants inversés (les Visa Desjardins impriment les
    // achats en positif), on ne sait pas si le solde imprimé suit la même
    // convention : on ne corrige rien, on se contente de combler les trous.
    if (spec?.invert) for (const r of rowsForBalance) r.bank = null
    cells.push(...balanceCells(rowsForBalance, {
      direction, descending: desc2, bankBalance: bankBalanceFor(account.id),
      title, balanceCol: cols.balance,
    }))
  }

  for (let i = 0; i < cells.length; i += 200) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: cells.slice(i, i + 200) },
    }))
  }

  // Les exercices clos : vert d'office, même sur une ligne que l'ERP ne
  // reconnaît pas. Elles ne reçoivent QUE la couleur — aucune cellule écrite,
  // aucune marque de relecture : le fichier reste le seul à savoir ce qu'elles
  // disent.
  const known = new Set(paint.map((p) => p.rowIndex))
  const closed = cfg.green_before
    ? fileRows.filter((r) => !known.has(r.rowIndex) && r.txn_date < cfg.green_before)
      .map((r) => ({ rowIndex: r.rowIndex, status: 'rapproche' }))
    : []

  const todo = paintsToApply([...paint, ...closed], currentFills)
  const fills = paintRuns(todo, sheetId, width)
  for (let i = 0; i < fills.length; i += 500) {
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId, requestBody: { requests: fills.slice(i, i + 500) },
    }))
  }
  return {
    tab: title, added: ordered.length, painted: todo.length,
    cells: cells.length, in_file: fileRows.length, review_adopted: adopted,
    comments_to_file: comments.cells.length, comments_to_erp: comments.toErp.length,
  }
}

// Un seul passage à la fois : deux passages simultanés inséreraient deux fois
// la même ligne. Une demande pendant un passage en relance un seul après.
let running = null
let rerun = null

export async function syncMirror(opts = {}) {
  if (running) {
    if (!rerun) rerun = running.catch(() => {}).then(() => { rerun = null; return syncMirror(opts) })
    return rerun
  }
  running = syncMirrorOnce(opts)
  try { return await running } finally {
    // Ce que Boréal vient d'écrire ne doit pas passer pour une modification de
    // Michel : on repart de la date du fichier APRÈS le passage.
    await fileModifiedTime().then((t) => { if (t) lastSeenModified = t }).catch(() => {})
    running = null
  }
}

async function syncMirrorOnce({ trigger = 'manuel', force = false } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(MIRROR_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getMirrorConfig()
    if (!cfg.spreadsheet_id) throw new Error('Aucun fichier configuré')
    const accountId = googleAccountId(cfg.google_account_email)
    if (!accountId) throw new Error('Aucun compte Google connecté (page Connecteurs)')
    const sheets = await getSheetsClient(accountId)

    // `kind` en fait partie : c'est lui qui décide des mots du statut (une carte
    // est « Autorisée », jamais « Completed ») et du sens du solde.
    const accounts = db.prepare(
      'SELECT id, name, kind FROM bank_accounts WHERE deleted_at IS NULL AND active=1 ORDER BY sort_order',
    ).all()

    const byAccount = await tabsByAccount(sheets, cfg.spreadsheet_id)
    const tabs = []
    for (const account of accounts) {
      const tab = byAccount.get(account.name)
      if (!tab) { tabs.push({ tab: account.name, skipped: 'aucun onglet' }); continue }
      try {
        tabs.push(await mirrorTab(sheets, cfg.spreadsheet_id, account, tab, cfg))
      } catch (e) {
        // Un onglet qui résiste n'empêche pas les dix autres.
        tabs.push({ tab: tab.title, error: e.message })
      }
    }
    const added = tabs.reduce((n, t) => n + (t.added || 0), 0)
    const painted = tabs.reduce((n, t) => n + (t.painted || 0), 0)
    const cells = tabs.reduce((n, t) => n + (t.cells || 0), 0)
    const result = {
      spreadsheetId: cfg.spreadsheet_id,
      url: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheet_id}`,
      tabs, added, painted, cells,
    }
    const summary = `${added} ligne(s) ajoutée(s) · ${painted} peinte(s) · ${cells} cellule(s) mise(s) à jour`
    logSync('bank:trx-mirror', 'success', summary)
    logSystemRun(MIRROR_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
      result: { summary, ...result },
    })
    return result
  } catch (e) {
    logSync('bank:trx-mirror', 'error', e.message)
    logSystemRun(MIRROR_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger } })
    throw e
  }
}

// ── Recopie automatique ─────────────────────────────────────────────────────
//
// Le fichier doit refléter le rapprochement sans qu'on pense à appuyer sur un
// bouton. Chaque écriture de la page annonce le changement ici ; la recopie
// part quelques secondes plus tard, une seule fois pour toute une rafale
// (rapprocher 40 lignes d'un coup, c'est 40 annonces et un seul aller-retour
// vers Google).
const MIRROR_DEBOUNCE_MS = 8000
let pendingMirror = null

export function mirrorOnChange(reason = 'changement') {
  if (pendingMirror) return
  try { if (!isSystemAutomationActive(MIRROR_AUTOMATION_ID)) return } catch { return }
  pendingMirror = setTimeout(() => {
    pendingMirror = null
    syncMirror({ trigger: `auto:${reason}` })
      .catch((e) => console.error('trxSheetMirror.auto:', e.message))
  }, MIRROR_DEBOUNCE_MS)
  pendingMirror.unref?.()
}

// ── Ce que Michel écrit au fichier ──────────────────────────────────────────
//
// Google ne prévient pas d'une modification sans adresse publique à rappeler et
// abonnement à renouveler ; on demande plutôt, toutes les 20 s, la date de
// dernière modification du fichier (un appel minuscule). Boréal écrit avec le
// compte Google de Michel : « modifié par moi » ne distingue rien. Ce qui
// compte, c'est une date qui bouge alors qu'aucun passage n'écrivait.
const WATCH_MS = 20_000
let lastSeenModified = null

async function fileModifiedTime() {
  const cfg = getMirrorConfig()
  const accountId = cfg.spreadsheet_id && googleAccountId(cfg.google_account_email)
  if (!accountId) return null
  const drive = await getDriveClient(accountId)
  const { data } = await drive.files.get({ fileId: cfg.spreadsheet_id, fields: 'modifiedTime', supportsAllDrives: true })
  return data.modifiedTime || null
}

export async function checkFileEdits() {
  try { if (!isSystemAutomationActive(MIRROR_AUTOMATION_ID)) return false } catch { return false }
  if (running || pendingMirror) return false
  const t = await fileModifiedTime()
  if (!t || running) return false
  const changed = lastSeenModified != null && t !== lastSeenModified
  lastSeenModified = t
  if (!changed) return false
  mirrorOnChange('fichier')
  return true
}

export function watchFileEdits() {
  const t = setInterval(() => {
    checkFileEdits().catch((e) => console.error('trxSheetMirror.watch:', e.message))
  }, WATCH_MS)
  t.unref?.()
}

export function mirrorStatus() {
  const cfg = getMirrorConfig()
  const auto = db.prepare('SELECT active FROM automations WHERE id=? AND system=1').get(MIRROR_AUTOMATION_ID)
  const last = db.prepare(`
    SELECT status, result, error, created_at FROM automation_logs
    WHERE automation_id=? ORDER BY created_at DESC LIMIT 1
  `).get(MIRROR_AUTOMATION_ID) || null
  let result = null
  if (last?.result) { try { result = JSON.parse(last.result) } catch { result = { summary: last.result } } }
  return {
    active: auto ? !!auto.active : false,
    spreadsheet_id: cfg.spreadsheet_id || null,
    url: cfg.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${cfg.spreadsheet_id}` : null,
    last_run: last ? { status: last.status, executed_at: last.created_at, error: last.error, ...result } : null,
  }
}
