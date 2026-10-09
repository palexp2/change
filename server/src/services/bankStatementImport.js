// Dépôt de relevés bancaires : un PDF, un export CSV/XLSX ou une CAPTURE
// D'ÉCRAN déposés dans l'ERP deviennent des transactions du rapprochement.
//
// POURQUOI. Plaid ne livre plus les mouvements (un seul compte sur dix en
// recevait vraiment), et le tuyau de remplacement — coller chaque relevé dans
// TRX_Orisha.xlsx — est du travail à la main deux fois par semaine. Ici le
// fichier de la banque entre directement : on le lit, on devine DE QUEL COMPTE
// il parle, on ne garde que les lignes que la base n'a pas déjà, et on montre
// tout ça AVANT d'écrire quoi que ce soit.
//
// Le garde-fou qui rend une capture d'écran fiable n'est pas le prompt, c'est
// l'arithmétique : solde d'ouverture + somme des mouvements doit retomber sur le
// solde de fermeture imprimé (ou, à défaut, la colonne Solde doit s'enchaîner
// ligne à ligne). Quand ça ne balance pas, on renvoie l'écart CHIFFRÉ au modèle
// et il recommence ; si ça résiste, l'aperçu le dit en rouge et l'humain
// tranche. Même recette que la réconciliation des factures
// (services/saleReceiptExtraction.js).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import xlsx from 'xlsx'
import sharp from 'sharp'
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { logSync } from './syncLog.js'
import { parseStatementTable, importTransactions, autoMatchAccount, applyStatesFromRows, findSupersededPending, promoteSupersededPending, findShiftedTwins, findRevisedAmounts, applyRevisedAmounts, findSumDuplicates } from './bankReconciliation.js'
import { planImportFromCounts, existingSignatureCounts, statementInvertsSign } from './bankTrxSheet.js'
import { shiftDate } from '../utils/datetime.js'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
export const TABLE_EXT = ['.csv', '.tsv', '.txt', '.xlsx', '.xls']
export const ALLOWED_EXT = ['.pdf', ...IMAGE_EXT, ...TABLE_EXT]

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

// ── Lecture du fichier ───────────────────────────────────────────────────────

// Un CSV ne se découpe pas sur les virgules : les libellés de relevé en
// contiennent (« PAIEMENT, MERCI »). Guillemets doublés gérés.
export function splitCsvLine(line, sep) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === sep) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

// Séparateur dominant : celui qui découpe le plus régulièrement les 10
// premières lignes (un relevé français en CSV est souvent point-virgule).
export function detectSeparator(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim()).slice(0, 10)
  if (!lines.length) return ','
  let best = ','
  let bestScore = -1
  for (const sep of ['\t', ';', ',']) {
    const counts = lines.map((l) => splitCsvLine(l, sep).length)
    const max = Math.max(...counts)
    if (max < 2) continue
    const regular = counts.filter((n) => n === max).length
    const score = max * 10 + regular
    if (score > bestScore) { bestScore = score; best = sep }
  }
  return best
}

export function csvToTable(text) {
  const sep = detectSeparator(text)
  return String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
    .map((l) => splitCsvLine(l, sep))
}

function sheetToTable(filePath) {
  const wb = xlsx.readFile(filePath, { cellDates: false })
  // On prend l'onglet qui donne le plus de lignes lisibles : un export de banque
  // met parfois une page de garde en premier.
  let best = { rows: [], errors: ['Classeur vide'], columns: [], table: [] }
  for (const name of wb.SheetNames) {
    const table = xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' })
    const parsed = parseStatementTable(table)
    if (parsed.rows.length > best.rows.length) best = { ...parsed, table }
  }
  return best
}

function pdfText(filePath) {
  const r = spawnSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
  return r.stdout || ''
}

// Un relevé scanné n'a pas de couche texte : on le rend en images et c'est la
// VISION du modèle qui lit. Seuil bas volontairement (une page de relevé
// texte dépasse largement 400 caractères).
export const MAX_VISION_PAGES = 8

function pdfPagesAsImages(filePath, maxPages = MAX_VISION_PAGES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'releve-'))
  try {
    spawnSync('pdftoppm', ['-png', '-r', '150', '-l', String(maxPages), filePath, path.join(dir, 'p')], { timeout: 120000 })
    return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
      .map((f) => ({ dataUrl: `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}` }))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* déjà parti */ }
  }
}

// Une capture 4K coûte cher en « detail: high » ET se lit moins bien une fois
// recompressée : on redimensionne à 2000 px de large avant de l'envoyer.
export async function imageDataUrl(filePath, ext) {
  try {
    const buf = await sharp(filePath).rotate().resize({ width: 2000, withoutEnlargement: true }).png().toBuffer()
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    // Format que sharp ne sait pas ouvrir : on envoie l'original tel quel.
    const mime = MIME_BY_EXT[String(ext).toLowerCase()] || 'image/png'
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
  }
}

// → { source, pages, pageCount, table? }
// `table` présent = fichier déjà tabulaire, aucun modèle n'est appelé.
export async function readStatement(filePath, ext) {
  const e = String(ext || path.extname(filePath)).toLowerCase()
  if (TABLE_EXT.includes(e)) {
    const parsed = e === '.xlsx' || e === '.xls'
      ? sheetToTable(filePath)
      : { ...parseStatementTable(csvToTable(fs.readFileSync(filePath, 'utf8'))) }
    return { source: 'tableur', pages: [], pageCount: 1, parsed }
  }
  if (IMAGE_EXT.includes(e)) {
    return { source: 'image', pages: [{ dataUrl: await imageDataUrl(filePath, e) }], pageCount: 1 }
  }
  if (e !== '.pdf') throw new Error(`Type de fichier non supporté : ${e}`)
  const text = pdfText(filePath)
  if (text.replace(/\s/g, '').length >= 400) {
    const pages = text.split('\f').filter((t) => t.trim()).map((t) => ({ text: t }))
    return { source: 'pdf_texte', pages, pageCount: pages.length }
  }
  const pages = pdfPagesAsImages(filePath)
  if (!pages.length) throw new Error('PDF illisible : ni texte ni image')
  return { source: 'pdf_image', pages, pageCount: pages.length }
}

// ── Lecture par le modèle ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu lis un RELEVÉ BANCAIRE ou un relevé de CARTE DE CRÉDIT (PDF, export ou capture d'écran) appartenant à l'entreprise « Automatisation Orisha Inc ». Tu retournes UNIQUEMENT un JSON valide, sans texte autour, sans bloc de code.

AVANT TOUT — QUEL DOCUMENT EST-CE ? Le fichier déposé n'est pas toujours un relevé : c'est parfois une FACTURE ou un REÇU d'un fournisseur (un seul vendeur, des articles, un sous-total, des taxes, un total à payer), qui n'a rien à faire dans un relevé. Dans ce cas, retourne exactement { "document_kind": "facture", "rows": [] } et rien d'autre. Un relevé, lui, liste les mouvements d'UN COMPTE sur une période, avec des soldes : retourne "document_kind": "releve" et le reste de la structure.

Structure exacte attendue :
{
  "document_kind": "releve ou facture",
  "institution": "nom de l'institution (BNC / Banque Nationale, Desjardins, Venn, …) ou null",
  "account_label": "intitulé du compte tel qu'imprimé (ex. « Compte chèque », « MasterCard Platine », « Marge de crédit ») ou null",
  "account_number_masked": "numéro de compte ou de carte tel qu'imprimé, masqué compris (ex. « 5258-8186-****-1234 ») ou null",
  "currency": "CAD ou USD",
  "kind": "bank (compte bancaire) ou card (carte de crédit / marge)",
  "period_start": "YYYY-MM-DD ou null",
  "period_end": "YYYY-MM-DD ou null",
  "opening_balance": nombre ou null,
  "closing_balance": nombre ou null,
  "rows": [
    { "txn_date": "YYYY-MM-DD",
      "description": "libellé de la transaction",
      "details": "second libellé du relevé (« Autres détails » du BNC) ou null",
      "reference": "numéro de référence/chèque ou null",
      "debit": nombre positif ou null,
      "credit": nombre positif ou null,
      "balance": solde affiché sur la ligne ou null }
  ]
}

RÈGLES IMPÉRATIVES :
- "debit" et "credit" sont SÉMANTIQUES, pas des noms de colonnes. Ne te fie pas à l'en-tête ni au signe imprimé, mais au SENS de l'argent :
  • compte bancaire : "debit" = argent qui SORT (retrait, paiement, frais) ; "credit" = argent qui ENTRE (dépôt, virement reçu).
  • carte de crédit ou marge : "debit" = un ACHAT / une avance / des intérêts (ce qui augmente la dette) ; "credit" = un PAIEMENT du solde, un remboursement ou un crédit du marchand.
  Certains relevés de carte impriment les achats en positif et les paiements avec un « CR » ou un signe moins : c'est la NATURE de l'opération qui décide, pas le signe.
- Exactement UN des deux ("debit" ou "credit") est rempli par ligne, l'autre est null. Les deux valeurs sont POSITIVES.
- Recopie TOUTES les lignes de mouvement, dans l'ordre du document, sans en sauter ni en inventer. N'inclus PAS les totaux, sous-totaux, reports, en-têtes de section ni les paiements programmés à venir.
- UN SEUL COMPTE PAR LECTURE. Un relevé peut regrouper PLUSIEURS comptes (Desjardins : un même folio liste le compte à opérations « EOP », les épargnes « ET »/« CS », la marge de crédit « MC »…, chacun dans sa section avec son propre « Solde reporté » et sa propre colonne Solde). Ne lis que le compte visé (repère COMPTE VISÉ s'il est donné, sinon le premier compte à opérations) : ses lignes, SON solde reporté en "opening_balance", SON dernier solde en "closing_balance". Les lignes des autres sections n'appartiennent pas à ce compte — ne les recopie jamais, même quand elles semblent être l'autre côté d'un virement.
- Un relevé SANS AUCUN MOUVEMENT (« Aucune transaction », ou un sommaire où paiements et achats valent 0) est un relevé valide : "rows": [], avec les soldes imprimés et la période (sur une carte, la date du relevé est "period_end").
- Dates : toujours YYYY-MM-DD. Si le relevé n'imprime pas l'année, déduis-la de la période du relevé ; ne produis jamais une date dans le futur.
- Montants : nombres purs, point décimal, sans symbole ni séparateur de milliers.
- "opening_balance" / "closing_balance" : les soldes imprimés (solde précédent / solde final ; pour une carte, le solde DÛ). Mets null si le document ne les imprime pas — ne les calcule pas.
- Si une information n'est pas lisible, mets null. N'invente jamais.`

async function callOpenAI(messages) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // Un relevé mensuel de carte dépasse facilement les 100 lignes : le JSON
    // tronqué est invalide, donc large.
    body: JSON.stringify({
      model: 'gpt-6-astra', messages, max_completion_tokens: 24000,
      reasoning_effort: 'medium', response_format: { type: 'json_object' },
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }
  const data = await resp.json()
  return parseStatementResponse(data)
}

export function parseStatementResponse(data) {
  const choice = data.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw new Error('Relevé trop long : déposez moins de pages à la fois.')
  }
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw new Error('La capture n’a pas pu être lue. Réessayez avec une capture nette du tableau des transactions.')
  }
  const raw = choice?.message?.content?.trim() || ''
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  let parsed
  try { parsed = JSON.parse(cleaned) } catch {
    throw new Error('Réponse de lecture invalide. Relancez l’analyse de la capture.')
  }
  // Une facture n'a pas de lignes de relevé : c'est une réponse valide, elle
  // part à l'extraction de données au lieu d'être importée au compte.
  if (parsed?.document_kind === 'facture') return { document_kind: 'facture', rows: [] }
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error('Aucune liste de transactions lisible. Déposez une capture du tableau ou un relevé PDF.')
  }
  return parsed
}

// Les relevés de carte n'impriment PAS l'année (« 07 17 »), et le modèle, laissé
// seul, invente (2023 sur un relevé d'août 2026). Le nom du fichier la porte
// presque toujours : « CARTCRED_CREDCARD_4807_20260816.pdf ».
export function dateHintFromName(fileName) {
  const m = String(fileName || '').match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])[-_ ]?(0[1-9]|[12]\d|3[01])/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const ym = String(fileName || '').match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])(?!\d)/)
  return ym ? `${ym[1]}-${ym[2]}-01` : null
}

function userContent(pages) {
  const content = []
  const texts = []
  pages.forEach((p, i) => {
    if (p.dataUrl) content.push({ type: 'image_url', image_url: { url: p.dataUrl, detail: 'high' } })
    else if (p.text) texts.push(`[Page ${i + 1}]\n${p.text}`)
  })
  if (texts.length) content.push({ type: 'text', text: `Contenu du relevé :\n\n${texts.join('\n\n').slice(0, 60000)}` })
  if (!content.length) throw new Error('Rien à lire dans ce fichier')
  return content
}

// L'écart, chiffré, renvoyé au modèle — le prompt seul ne suffit jamais.
export function buildBalanceCorrection(check) {
  const { delta, opening, closing, sum, rowCount, orientation } = check
  const debt = orientation === 'dette'
  const obtained = debt ? opening - sum : opening + sum
  const formula = debt
    ? `Solde d'ouverture ${opening.toFixed(2)} MOINS la somme de tes ${rowCount} mouvements (${sum.toFixed(2)}) = ${obtained.toFixed(2)} — sur un relevé de carte le solde est une DETTE, qu'un achat fait monter`
    : `Solde d'ouverture ${opening.toFixed(2)} PLUS la somme de tes ${rowCount} mouvements (${sum.toFixed(2)}) = ${obtained.toFixed(2)}`
  // Une somme trop petite pour retomber sur la fermeture = des lignes manquent.
  const missing = obtained < closing
  return `ERREUR DE RÉCONCILIATION — ta lecture ne balance pas. ${formula}, alors que le solde de fermeture imprimé est ${closing.toFixed(2)}. Écart : ${Math.abs(delta).toFixed(2)}. ${missing ? `Il MANQUE ${Math.abs(delta).toFixed(2)} : tu as sauté une ou plusieurs lignes, ou tu as mis en "credit" une ligne qui est un "debit".` : `Il y a ${Math.abs(delta).toFixed(2)} EN TROP : une ligne est en double, un total ou un sous-total a été pris pour un mouvement, ou un "debit" a été inscrit en "credit".`} Relis le document ligne par ligne, du début à la fin, et retourne le JSON COMPLET corrigé (toutes les lignes, pas seulement les corrections), au même format.`
}

// Lit le relevé, et fait recommencer le modèle tant que l'arithmétique ne
// retombe pas (2 passes de rattrapage). On garde la meilleure tentative.
function userContentWithHint(pages, dateHint, accountHint = null) {
  const content = userContent(pages)
  const today = new Date().toISOString().slice(0, 10)
  if (accountHint) content.unshift({ type: 'text', text: accountHintText(accountHint) })
  content.unshift({
    type: 'text',
    text: dateHint
      ? `REPÈRE DE DATE — ce relevé est arrêté aux environs du ${dateHint} (nous sommes le ${today}). Toute date imprimée sans année appartient à cette période : donne-lui l'année qui place la transaction JUSTE AVANT cette date d'arrêté, jamais une autre année.`
      : `REPÈRE DE DATE — nous sommes le ${today}. Une date imprimée sans année appartient à la période couverte par ce relevé, la plus récente qui ne soit pas dans le futur.`,
  })
  return content
}

// Le compte auquel le fichier est destiné (dossier Drive, choix de l'aperçu) :
// c'est lui qui départage les sections d'un relevé à plusieurs comptes.
export function accountHintText(account) {
  const kind = account.kind === 'card' ? 'carte de crédit' : 'compte bancaire'
  const hints = String(account.statement_hints || '').trim()
  return `COMPTE VISÉ — ce fichier est le relevé du compte « ${account.name} » (${kind}, ${account.currency || 'devise inconnue'})${hints ? `, reconnu sur ses relevés par : ${hints}` : ''}. Si le document présente plusieurs comptes, ne lis QUE celui-là. Ce repère ne dicte rien d'autre : "currency" et les soldes restent ceux IMPRIMÉS sur le document, même s'ils ne ressemblent pas à ce compte.`
}

export async function extractStatement(pages, { call = callOpenAI, maxRetries = 2, dateHint = null, accountHint = null } = {}) {
  const content = userContentWithHint(pages, dateHint, accountHint)
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ]
  let best = null
  let bestCheck = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const extracted = await call(messages)
    const rows = normalizeExtracted(extracted).rows
    const isolated = isolateAccountChain(rows, extracted.opening_balance, extracted.closing_balance)
    const check = checkBalance(isolated?.rows || rows, extracted.opening_balance, extracted.closing_balance, { kind: extracted.kind })
    if (!best || betterCheck(check, bestCheck)) { best = extracted; bestCheck = check }
    if (check.ok || check.method !== 'soldes') break
    if (attempt === maxRetries) break
    messages.push({ role: 'assistant', content: JSON.stringify(extracted) })
    messages.push({ role: 'user', content: buildBalanceCorrection(check) })
  }
  return { extracted: best, check: bestCheck }
}

// Une passe corrective SUPPLÉMENTAIRE, quand l'écart n'apparaît qu'après coup :
// le solde d'ouverture des relevés de carte ne vient pas du document mais du
// relevé précédent (inferOpeningBalance), donc la boucle d'extraction, elle,
// n'avait rien à contrôler. On renvoie la réponse et l'écart chiffré.
export async function refineWithBalance(pages, extracted, check, { call = callOpenAI, dateHint = null, accountHint = null } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContentWithHint(pages, dateHint, accountHint) },
    { role: 'assistant', content: JSON.stringify(extracted) },
    { role: 'user', content: buildBalanceCorrection(check) },
  ]
  return call(messages)
}

function betterCheck(a, b) {
  if (!b) return true
  if (a.ok !== b.ok) return a.ok
  return Math.abs(a.delta ?? Infinity) < Math.abs(b.delta ?? Infinity)
}

// ── Normalisation ────────────────────────────────────────────────────────────

// debit/credit sémantiques → amount signé de l'ERP (négatif = argent sorti).
export function normalizeExtracted(extracted) {
  const errors = []
  const rows = []
  for (const [i, r] of (extracted?.rows || []).entries()) {
    const date = String(r?.txn_date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`Ligne ${i + 1} : date illisible`); continue }
    const debit = r?.debit == null ? null : Math.abs(Number(r.debit))
    const credit = r?.credit == null ? null : Math.abs(Number(r.credit))
    let amount = null
    if (Number.isFinite(debit) && debit !== 0) amount = -debit
    else if (Number.isFinite(credit) && credit !== 0) amount = credit
    else if (Number.isFinite(Number(r?.amount))) amount = Number(r.amount)
    if (amount == null) { errors.push(`Ligne ${i + 1} : montant illisible`); continue }
    rows.push({
      txn_date: date,
      description: String(r?.description ?? '').trim() || null,
      details: String(r?.details ?? '').trim() || null,
      reference: String(r?.reference ?? '').trim() || null,
      amount: round2(amount),
      balance: r?.balance == null ? null : round2(Number(r.balance)),
    })
  }
  return { rows, errors }
}

// Deux contrôles possibles, dans l'ordre de force :
//  • 'soldes' : ouverture + Σ mouvements = fermeture (le vrai juge) ;
//  • 'chaine' : à défaut, la colonne Solde doit s'enchaîner d'une ligne à
//    l'autre — ce qu'affiche presque toujours une capture d'écran.
// Aucun des deux → 'aucun' : la lecture n'est pas vérifiable, l'aperçu le dira.
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export function checkBalance(rows, opening, closing, { kind = null } = {}) {
  const sum = round2(rows.reduce((s, r) => s + r.amount, 0))
  const rowCount = rows.length
  const o = numOrNull(opening)
  const c = numOrNull(closing)
  if (o != null && c != null) {
    // Deux arithmétiques selon ce que le solde imprimé représente :
    //  • compte bancaire — de l'ARGENT : ouverture + mouvements = fermeture ;
    //  • carte de crédit — une DETTE, qu'un achat fait MONTER, donc
    //    ouverture − mouvements = fermeture.
    // L'orientation vient du TYPE du compte. On n'élit surtout pas celle qui
    // donne le plus petit écart : quand rien ne balance, ce choix-là masquerait
    // la ligne manquante qu'on cherche justement à débusquer. L'autre
    // orientation ne l'emporte que si elle tombe juste, elle.
    const asMoney = round2(o + sum - c)
    const asDebt = round2(o - sum - c)
    let debt = kind === 'card'
    const preferred = debt ? asDebt : asMoney
    const other = debt ? asMoney : asDebt
    if (Math.abs(preferred) > 0.01 && Math.abs(other) <= 0.01) debt = !debt
    const delta = debt ? asDebt : asMoney
    return {
      method: 'soldes', ok: Math.abs(delta) <= 0.01, delta,
      orientation: debt ? 'dette' : 'argent',
      opening: o, closing: c, sum, rowCount,
    }
  }
  const chained = rows.filter((r) => r.balance != null)
  if (chained.length >= 2) {
    // L'ordre du document peut être du plus récent au plus ancien : on essaie
    // les deux sens et on garde celui qui casse le moins la chaîne.
    const breaks = (list) => {
      let n = 0
      for (let i = 1; i < list.length; i++) {
        if (Math.abs(round2(list[i - 1].balance + list[i].amount - list[i].balance)) > 0.01) n++
      }
      return n
    }
    const asc = breaks(chained)
    const desc = breaks([...chained].reverse())
    const bad = Math.min(asc, desc)
    return { method: 'chaine', ok: bad === 0, breaks: bad, checked: chained.length, sum, rowCount }
  }
  return { method: 'aucun', ok: null, sum, rowCount }
}

// Un relevé Desjardins liste plusieurs comptes sur le même folio (EOP, ET, CS,
// MC…). Si le modèle a recopié les lignes d'une autre section, la colonne
// Solde les trahit : elles forment leur propre chaîne, qui ne part pas du solde
// d'ouverture. On ne garde la chaîne qui va de l'ouverture à la fermeture que
// si elle est UNIQUE et que tout le reste est lui-même chaîné — sinon on ne
// touche à rien et l'écart reste affiché.
export function isolateAccountChain(rows, opening, closing) {
  const o = numOrNull(opening)
  const c = numOrNull(closing)
  if (o == null || c == null || rows.length < 2) return null
  if (Math.abs(round2(o + rows.reduce((s, r) => s + r.amount, 0) - c)) <= 0.01) return null
  if (rows.some((r) => r.balance == null)) return null
  const segments = [[rows[0]]]
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    if (Math.abs(round2(prev.balance + rows[i].amount - rows[i].balance)) <= 0.01) segments.at(-1).push(rows[i])
    else segments.push([rows[i]])
  }
  const fits = segments.filter((s) => Math.abs(round2(o + s[0].amount - s[0].balance)) <= 0.01
    && Math.abs(round2(s.at(-1).balance - c)) <= 0.01)
  if (fits.length !== 1) return null
  return { rows: fits[0], dropped: rows.length - fits[0].length }
}

// Le relevé contredit le compte auquel on l'attribue : autre devise, ou « aucun
// mouvement » alors que l'ERP connaît un autre solde. Un tel relevé ne doit pas
// passer pour vérifié — le robot QuickBooks rapprocherait le mauvais chiffre.
export const ACCOUNT_MISMATCH = 'Relevé d’un autre compte ?'

export function accountMismatch(account, { currency = null, rowCount = 0, closing = null, knownBalance = null } = {}) {
  if (!account) return null
  const cur = String(currency || '').toUpperCase()
  if (cur && account.currency && cur !== String(account.currency).toUpperCase()) {
    return `${ACCOUNT_MISMATCH} Relevé en ${cur}, compte « ${account.name} » en ${account.currency}`
  }
  const c = numOrNull(closing)
  const k = numOrNull(knownBalance?.balance)
  if (!rowCount && c != null && k != null) {
    // Une carte peut porter sa dette signée d'un côté ou de l'autre.
    const differs = account.kind === 'card' ? Math.abs(Math.abs(k) - Math.abs(c)) > 0.01 : Math.abs(k - c) > 0.01
    if (differs) {
      return `${ACCOUNT_MISMATCH} Aucun mouvement au relevé (solde ${c.toFixed(2)}), mais « ${account.name} » est à ${k.toFixed(2)} au ${knownBalance.txn_date}`
    }
  }
  return null
}

function knownBalanceAt(accountId, date) {
  if (!accountId || !date) return null
  return db.prepare(`
    SELECT txn_date, balance FROM bank_transactions
    WHERE account_id=? AND txn_date <= ? AND balance IS NOT NULL AND deleted_at IS NULL
    ORDER BY txn_date DESC, rowid DESC LIMIT 1
  `).get(accountId, date) || null
}

function mismatchFor(account, rows, { currency, closing, periodEnd }) {
  return accountMismatch(account, {
    currency, rowCount: rows.length, closing,
    knownBalance: rows.length ? null : knownBalanceAt(account?.id, periodEnd),
  })
}

// Verdict stocké : l'arithmétique, sauf si le relevé contredit son compte.
const balanceOkFlag = (check, mismatch) => (mismatch ? 0 : check.ok == null ? null : (check.ok ? 1 : 0))

// ── Détection du compte ──────────────────────────────────────────────────────

const digitsOf = (s) => String(s || '').replace(/\D/g, '')
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Faisceau de preuves, chacune lisible par l'humain qui validera l'aperçu.
// `overlaps` : nb de lignes (date|montant) du relevé déjà présentes sur ce
// compte — la preuve la plus difficile à tromper.
export function scoreAccount(account, extracted, overlaps = 0, fileName = '', chains = 0) {
  const evidence = []
  let score = 0
  // Un export de banque ne dit souvent rien de lui-même, mais son NOM si :
  // « Desj CAD août.csv », « visa-usd-2026-09.pdf ». On compare les mots du nom
  // du compte, pas la chaîne entière (les séparateurs varient).
  const file = norm(fileName).replace(/[^a-z0-9]+/g, ' ')
  const words = norm(account.name).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3)
  if (file && words.length && words.every((w) => file.includes(w))) {
    score += 4
    evidence.push({ label: 'Nom du fichier', detail: account.name })
  }
  // Le numéro connu d'une carte est masqué AU MILIEU (« 5258-8186-**** ») et le
  // relevé imprime le numéro complet (« 5258 818668 114807 ») : les 4 derniers
  // chiffres ne se rencontrent jamais. C'est le PRÉFIXE qui les rapproche.
  const masked = digitsOf(extracted?.account_number_masked)
  const known = digitsOf(account.account_number)
  if (masked.length >= 4 && known.length >= 4) {
    if (known.endsWith(masked.slice(-4)) || masked.endsWith(known.slice(-4))) {
      score += 5
      evidence.push({ label: 'Numéro', detail: `se termine par ${masked.slice(-4)}` })
    } else if (known.length >= 6 && masked.startsWith(known.slice(0, 6))) {
      score += 5
      evidence.push({ label: 'Numéro', detail: `commence par ${known.slice(0, 6)}` })
    }
  }
  const hints = String(account.statement_hints || '').split(/[,;\n]/).map((h) => norm(h).trim()).filter(Boolean)
  const haystack = norm([extracted?.institution, extracted?.account_label, extracted?.account_number_masked].join(' '))
  const hitHints = hints.filter((h) => h.length >= 3 && haystack.includes(h))
  if (hitHints.length) {
    score += 4
    evidence.push({ label: 'Appris', detail: hitHints.join(', ') })
  }
  const inst = norm(extracted?.institution)
  const mine = norm(account.institution)
  if (inst && mine && (inst.includes(mine) || mine.includes(inst) ||
      (mine === 'bnc' && /banque nationale|national bank/.test(inst)))) {
    score += 2
    evidence.push({ label: 'Institution', detail: account.institution })
  }
  const cur = String(extracted?.currency || '').toUpperCase()
  if (cur) {
    if (cur === account.currency) { score += 1; evidence.push({ label: 'Devise', detail: cur }) }
    else score -= 3
  }
  const kind = String(extracted?.kind || '').toLowerCase()
  if (kind === 'bank' || kind === 'card') {
    if (kind === account.kind) score += 1
    else score -= 2
  }
  // LA preuve la plus difficile à tromper : des lignes du document existent
  // déjà, au cent et au jour près, sur ce compte. Ça vaut mieux que n'importe
  // quel mot imprimé — une capture qui ne dit nulle part « épargne » se
  // reconnaît quand même à ses mouvements passés.
  if (overlaps > 0) {
    score += Math.min(overlaps, 8) * 1.5
    evidence.push({ label: 'Recoupement', detail: `${overlaps} ligne${overlaps > 1 ? 's' : ''} déjà au compte` })
  }
  // Un document entièrement neuf (aucune ligne connue) se reconnaît encore à
  // son SOLDE : le solde d'avant sa première ligne est le dernier solde connu
  // d'un seul compte, au cent près.
  if (chains > 0) {
    score += 6
    evidence.push({ label: 'Solde', detail: 'suit le dernier solde connu' })
  }
  return { score, evidence, overlaps, chains }
}

// Combien de lignes du relevé existent déjà, compte par compte.
function overlapsByAccount(rows) {
  if (!rows.length) return new Map()
  const dates = rows.map((r) => r.txn_date).sort()
  const sigs = new Set(rows.map((r) => `${r.txn_date}|${r.amount.toFixed(2)}`))
  const found = db.prepare(`
    SELECT account_id, txn_date || '|' || printf('%.2f', amount) AS sig
    FROM bank_transactions WHERE txn_date BETWEEN ? AND ?
  `).all(dates[0], dates[dates.length - 1])
  const out = new Map()
  for (const r of found) {
    if (sigs.has(r.sig)) out.set(r.account_id, (out.get(r.account_id) || 0) + 1)
  }
  return out
}

// Soldes d'avant-ligne du document (solde − montant, dans les deux sens : le
// signe d'un export n'est tranché qu'après la détection) retrouvés comme
// solde porté par une transaction connue, compte par compte.
const CHAIN_WINDOW_DAYS = 45
export function chainsByAccount(rows, extracted = {}) {
  const cents = (x) => Math.round(Number(x) * 100)
  const wanted = new Set()
  const add = (x) => { if (x != null && Number.isFinite(Number(x)) && Math.abs(Number(x)) >= 1) wanted.add(cents(x)) }
  add(numOrNull(extracted?.opening_balance))
  for (const r of rows) {
    if (r.balance == null || !Number.isFinite(Number(r.balance))) continue
    add(r.balance); add(Number(r.balance) - r.amount); add(Number(r.balance) + r.amount)
  }
  const dates = rows.map((r) => r.txn_date).filter(Boolean).sort()
  if (!wanted.size || !dates.length) return new Map()
  const found = db.prepare(`
    SELECT account_id, balance FROM bank_transactions
    WHERE balance IS NOT NULL AND deleted_at IS NULL
      AND txn_date BETWEEN date(?, '-${CHAIN_WINDOW_DAYS} days') AND ?
  `).all(dates[0], dates[dates.length - 1])
  const out = new Map()
  for (const r of found) {
    if (!wanted.has(cents(r.balance))) continue
    const set = out.get(r.account_id) || new Set()
    set.add(cents(r.balance))
    out.set(r.account_id, set)
  }
  return new Map([...out].map(([k, v]) => [k, v.size]))
}

// En dessous, on ne pré-sélectionne RIEN : « Desjardins CAD » et « Marge
// Desjardins » ont la même institution, la même devise et le même type — un
// choix arbitraire serait pris pour une certitude.
export const MIN_DETECT_CONFIDENCE = 0.3

export function detectAccount(extracted, rows, accounts, overlaps = new Map(), fileName = '', chains = new Map()) {
  const scored = accounts.map((a) => {
    const s = scoreAccount(a, extracted, overlaps.get(a.id) || 0, fileName, chains.get(a.id) || 0)
    return { account: a, ...s }
  }).sort((x, y) => y.score - x.score)
  const best = scored[0]
  const second = scored[1]
  if (!best || best.score <= 0) return { account_id: null, confidence: 0, evidence: [] }

  // Un recoupement franc tranche à lui seul : au moins deux lignes retrouvées,
  // et deux fois plus que le compte suivant. Le texte du document peut dire
  // n'importe quoi, les mouvements passés, eux, ne mentent pas.
  const byOverlap = [...scored].sort((x, y) => (y.overlaps || 0) - (x.overlaps || 0))
  const top = byOverlap[0]
  const next = byOverlap[1]
  if (top?.overlaps >= 2 && top.overlaps >= 2 * (next?.overlaps || 0)) {
    return { account_id: top.account.id, confidence: 1, evidence: top.evidence }
  }
  // Un seul compte dont le solde enchaîne avec le document, et rien qui le
  // contredise (devise, type) : c'est lui.
  const chained = scored.filter((x) => x.chains > 0)
  if (!top?.overlaps && chained.length === 1 && chained[0].score > 0) {
    return { account_id: chained[0].account.id, confidence: 1, evidence: chained[0].evidence }
  }
  // Confiance = à quel point le premier se détache du second. Deux comptes qui
  // marquent pareil (BNC CAD vs BNC Épargne sur un relevé sans numéro) doivent
  // sortir peu sûrs, pas « 90 % ».
  const gap = best.score - (second?.score > 0 ? second.score : 0)
  const confidence = round2(Math.max(0, Math.min(1, (best.score / 10) * 0.5 + (gap / 5) * 0.5)))
  if (confidence < MIN_DETECT_CONFIDENCE) {
    return { account_id: null, confidence, evidence: best.evidence, ambiguous: true }
  }
  return { account_id: best.account.id, confidence, evidence: best.evidence }
}

// Beaucoup de relevés n'impriment PAS de solde d'ouverture — les relevés de
// carte BNC n'affichent que le solde dû à l'arrêté. Sans ouverture, aucun
// contrôle arithmétique n'est possible… sauf que l'ERP connaît déjà le chiffre :
//  • pour une carte, c'est le solde du relevé PRÉCÉDENT (table card_statements,
//    alimentée par services/cardStatementImport.js) ;
//  • pour un compte, c'est le solde porté par la dernière transaction connue
//    avant la période.
export function inferOpeningBalance(account, rows, periodStart = null) {
  if (!account || !rows.length) return null
  const first = rows.map((r) => r.txn_date).sort()[0]
  if (account.kind === 'card') {
    // Le relevé cherché est celui ARRÊTÉ à l'ouverture de la période (un cycle
    // ferme le 15, le suivant s'ouvre le 15) — d'où le <=, et l'ancrage sur le
    // début de période plutôt que sur la première ligne : un cran plus tôt et
    // on remonte d'un cycle entier.
    const anchor = periodStart || first
    const prev = db.prepare(`
      SELECT balance FROM card_statements
      WHERE account_name=? AND statement_date <= ? AND balance IS NOT NULL
      ORDER BY statement_date DESC LIMIT 1
    `).get(account.name, anchor)
    if (prev) return { value: prev.balance, source: 'relevé précédent' }
  }
  const last = db.prepare(`
    SELECT balance FROM bank_transactions
    WHERE account_id=? AND txn_date < ? AND balance IS NOT NULL AND deleted_at IS NULL
    ORDER BY txn_date DESC, rowid DESC LIMIT 1
  `).get(account.id, first)
  return last ? { value: last.balance, source: 'dernier solde connu' } : null
}

// Un relevé dont les dates s'éloignent de plusieurs mois de son propre arrêté a
// été mal daté (année devinée : 2023 sur un relevé d'août 2026). On ne corrige
// pas en douce — on le dit, et l'humain tranche devant l'aperçu.
export function yearDriftAgainstHint(hint, rows, maxDays = 200) {
  if (!hint || !rows?.length) return null
  const dates = rows.map((r) => r.txn_date).sort()
  const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000)
  const drift = Math.min(days(dates[0], hint), days(dates[dates.length - 1], hint))
  if (drift <= maxDays) return null
  return `Dates suspectes : relevé arrêté vers le ${hint}, mais transactions du ${dates[0]} au ${dates[dates.length - 1]} — vérifier l'année avant d'importer`
}

// ── Lignes neuves ────────────────────────────────────────────────────────────

// Dédup tolérante (date + montant signé), la même que la sync du fichier : tant
// que TRX_Orisha alimente les mêmes comptes, un relevé qui chevauche ne crée
// aucun doublon.
export function planStatementRows(accountId, rows) {
  if (!rows.length) return { fresh: [], duplicates: 0, flags: [] }
  const since = rows.map((r) => r.txn_date).sort()[0]
  const existing = existingSignatureCounts(accountId, since)
  const maxDate = shiftDate(new Date().toISOString().slice(0, 10), 1)
  const { toInsert, skipped } = planImportFromCounts(rows, existing, { maxDate })
  // Un achat déjà entré « En attente » à une autre date n'est pas neuf.
  const superseded = findSupersededPending(accountId, rows)
  // Ni un achat déjà connu à une autre date (référence, ou montant + marchand).
  const twins = findShiftedTwins(accountId, rows, new Set(superseded.keys()))
  // Ni un achat déjà connu à un autre montant (en attente, puis passé).
  const revised = findRevisedAmounts(accountId, rows, new Set([...superseded.keys(), ...twins]))
  // Ni le total d'un paiement déjà détaillé (intérêts + capital de la marge).
  const totals = findSumDuplicates(accountId, rows)
  const fresh = new Set(toInsert.filter((r) => { const i = rows.indexOf(r); return !superseded.has(i) && !twins.has(i) && !revised.has(i) && !totals.has(i) }))
  const kept = toInsert.filter((r) => fresh.has(r))
  return { fresh: kept, duplicates: skipped + (toInsert.length - kept.length), flags: rows.map((r) => fresh.has(r)) }
}

// ── Orchestration ────────────────────────────────────────────────────────────

const SELECT_UPLOAD = 'SELECT * FROM bank_statement_uploads WHERE id=?'

export function getUpload(id) {
  const row = db.prepare(SELECT_UPLOAD).get(id)
  if (!row) return null
  return {
    ...row,
    detect_evidence: safeJson(row.detect_evidence, []),
    rows_json: safeJson(row.rows_json, []),
  }
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw || '') } catch { return fallback }
}

function listAccounts() {
  return db.prepare('SELECT * FROM bank_accounts WHERE deleted_at IS NULL AND active=1 ORDER BY sort_order').all()
}

function touch(id, patch) {
  const keys = Object.keys(patch)
  db.prepare(`UPDATE bank_statement_uploads SET ${keys.map((k) => `${k}=?`).join(', ')},
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...keys.map((k) => patch[k]), id)
}

// Lit un dépôt et le range en 'pret' (ou 'erreur'). N'écrit JAMAIS dans
// bank_transactions : c'est commitUpload qui le fait, sur geste humain.
// Le fichier déposé est une facture : on le remet à l'extraction de données
// (même chemin que les factures reçues par courriel ou par les collecteurs) et
// la carte du dépôt ne montre plus qu'un lien vers le document créé.
export async function sendUploadToExtractor(id, up = null) {
  const row = up || db.prepare(SELECT_UPLOAD).get(id)
  if (!row) throw new Error('Dépôt introuvable')
  const { ingestReceiptBuffer } = await import('./receiptIngest.js')
  const ext = (path.extname(row.original_name || row.file_path) || '.pdf').toLowerCase()
  const res = ingestReceiptBuffer({
    buffer: fs.readFileSync(row.file_path),
    originalName: row.original_name,
    ext,
    source: 'depot_rapprochement',
    userId: row.created_by || null,
  })
  touch(id, {
    document_kind: 'facture',
    sale_receipt_id: res.id || null,
    rows_json: '[]',
    status: 'pret',
    error: res.status === 'duplicate' ? 'Document déjà présent dans l’extraction de données' : null,
  })
  logSync('bank:statement-upload', 'manual', { status: 'success' })
  return getUpload(id)
}

// `accountId` : le compte auquel le fichier est destiné (dossier Drive). Il
// s'impose à la détection et oriente la lecture d'un relevé à plusieurs
// comptes. À défaut, une relecture reprend le compte déjà choisi — imposé s'il
// vient du dossier Drive, simple repère sinon.
export async function analyzeUpload(id, { extract = extractStatement, refine = refineWithBalance, accountId = null } = {}) {
  const up = db.prepare(SELECT_UPLOAD).get(id)
  if (!up) throw new Error('Dépôt introuvable')
  if (!accountId && up.drive_file_id && up.account_id) accountId = up.account_id
  // Marqué AVANT de lire : une relecture laissait la ligne en 'pret', donc
  // l'écran reprenait l'ancien résultat comme s'il était le nouveau.
  touch(id, { status: 'en_analyse', error: null })
  try {
    const hintId = accountId || up.account_id
    const accountHint = hintId ? db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(hintId) || null : null
    const dateHint = dateHintFromName(up.original_name)
    const read = await readStatement(up.file_path, path.extname(up.original_name || up.file_path))
    let extracted = {}
    let rows = []
    let check = null
    let readErrors = []
    if (read.parsed) {
      // Fichier tabulaire : aucune lecture par le modèle. Le sens du montant
      // d'une colonne « Montant » unique dépend du compte (les Visa Desjardins
      // impriment les achats en positif) — tranché après la détection.
      rows = read.parsed.rows
      readErrors = read.parsed.errors
      extracted = { columns: read.parsed.columns }
    } else {
      const out = await extract(read.pages, { dateHint, accountHint })
      extracted = out.extracted || {}
      const normalized = normalizeExtracted(extracted)
      rows = normalized.rows
      readErrors = normalized.errors
      check = out.check
      const isolated = isolateAccountChain(rows, extracted.opening_balance, extracted.closing_balance)
      if (isolated) {
        rows = isolated.rows
        readErrors.push(`${isolated.dropped} ligne${isolated.dropped > 1 ? 's' : ''} d'un autre compte du relevé écartée${isolated.dropped > 1 ? 's' : ''}`)
      }
    }
    // Facture déposée sur l'écran de rapprochement : elle part à l'extraction
    // de données, exactement comme si elle y avait été déposée.
    if (String(extracted.document_kind || '').toLowerCase() === 'facture') {
      return await sendUploadToExtractor(id, up)
    }
    // Un mois sans mouvement est un vrai relevé, s'il le prouve : soldes
    // d'ouverture et de clôture imprimés, égaux, et une date d'arrêté.
    const opening0 = numOrNull(extracted.opening_balance)
    const closing0 = numOrNull(extracted.closing_balance)
    const emptyMonth = !rows.length && !readErrors.length && !read.parsed && extracted.period_end
      && opening0 != null && closing0 != null && Math.abs(opening0 - closing0) <= 0.01
    if (!rows.length && !emptyMonth) throw new Error(readErrors[0] || 'Aucune transaction reconnue dans ce fichier')

    const accounts = listAccounts()
    const det = detectAccount(extracted, rows, accounts, overlapsByAccount(rows), up.original_name || '', chainsByAccount(rows, extracted))
    if (accountId && accountHint) {
      det.account_id = accountHint.id
      det.confidence = 1
      det.evidence = [{ label: 'Dossier', detail: accountHint.name }]
    }
    const account = accounts.find((a) => a.id === det.account_id) || (accountId ? accountHint : null)
    const invertible = isInvertible(extracted)
    rows = applySignConvention(rows, account, invertible)
    let opening = numOrNull(extracted.opening_balance)
    let openingSource = null
    if (opening == null) {
      const inferred = inferOpeningBalance(account, rows, extracted.period_start || null)
      if (inferred) { opening = inferred.value; openingSource = inferred.source }
    }
    check = checkBalance(rows, opening, extracted.closing_balance, { kind: account?.kind || extracted.kind })
    if (openingSource && check.method === 'soldes') {
      det.evidence.push({ label: 'Ouverture', detail: openingSource })
      // L'écart n'existait pas encore pendant l'extraction (l'ouverture vient du
      // relevé précédent) : c'est ici, et seulement ici, qu'on peut renvoyer le
      // modèle à sa copie. Une seule passe — au-delà, l'écart est réel.
      if (!check.ok && !read.parsed) {
        try {
          const again = await refine(read.pages, extracted, check, { dateHint, accountHint: account || accountHint })
          const retried = normalizeExtracted(again)
          const againClosing = again.closing_balance ?? extracted.closing_balance
          const retriedRows = isolateAccountChain(retried.rows, opening, againClosing)?.rows || retried.rows
          const signed = applySignConvention(retriedRows, account, isInvertible(again))
          const recheck = checkBalance(signed, opening, againClosing, { kind: account?.kind || extracted.kind })
          if (Math.abs(recheck.delta) < Math.abs(check.delta)) {
            extracted = again
            rows = signed
            readErrors = retried.errors
            check = recheck
          }
        } catch (e) {
          console.error('bankStatementImport.refine:', e.message)
        }
      }
    }

    const plan = account ? planStatementRows(account.id, rows) : null
    const marked = rows.map((r, i) => ({ ...r, _new: plan ? plan.flags[i] : true }))
    // Un PDF scanné plus long que ce qu'on envoie au modèle : le dire, plutôt
    // que de laisser croire que le relevé est entré en entier.
    if (read.source === 'pdf_image' && read.pageCount >= MAX_VISION_PAGES) {
      readErrors.push(`Seules les ${MAX_VISION_PAGES} premières pages ont été lues`)
    }
    // Le repère de date du nom de fichier sert aussi de juge après coup.
    const drift = yearDriftAgainstHint(dateHint, rows)
    if (drift) readErrors.push(drift)
    const periodEnd = extracted.period_end || rows.map((r) => r.txn_date).sort().at(-1) || null
    const mismatch = mismatchFor(account, rows, { currency: extracted.currency, closing: extracted.closing_balance, periodEnd })
    if (mismatch) readErrors.unshift(mismatch)
    touch(id, {
      source: read.source,
      page_count: read.pageCount,
      invertible: invertible ? 1 : 0,
      account_id: det.account_id,
      detect_confidence: det.confidence,
      detect_evidence: JSON.stringify(det.evidence),
      institution: extracted.institution || null,
      account_number_masked: extracted.account_number_masked || null,
      currency: extracted.currency || null,
      period_start: extracted.period_start || rows.map((r) => r.txn_date).sort()[0] || null,
      period_end: periodEnd,
      opening_balance: opening,
      closing_balance: numOrNull(extracted.closing_balance),
      balance_check: check.method === 'soldes' ? check.delta : null,
      balance_method: check.method,
      balance_ok: balanceOkFlag(check, mismatch),
      rows_json: JSON.stringify(marked),
      status: 'pret',
      error: readErrors.length ? readErrors.slice(0, 3).join(' · ') : null,
    })
    logSync('bank:statement-upload', 'manual', { status: 'success', modified: rows.length })
  } catch (e) {
    touch(id, { status: 'erreur', error: e.message })
    logSync('bank:statement-upload', 'manual', { status: 'error', error: `${up.original_name} : ${e.message}` })
  }
  return getUpload(id)
}

// Une colonne « Montant » seule ne dit pas son sens : sur les cartes Visa
// Desjardins, le relevé note les achats en POSITIF. Un fichier à colonnes
// Débit/Crédit explicites, ou une lecture par le modèle (débit/crédit
// sémantiques), n'a rien à inverser.
export function isInvertible(extracted) {
  const cols = extracted?.columns
  if (!Array.isArray(cols)) return false
  return !cols.includes('debit') && !cols.includes('credit')
}

// Le sens est recalculé depuis `amount_raw` à CHAQUE fois que le compte change :
// corriger « Desjardins CAD » en « VISA Desjardins CAD » dans l'aperçu doit
// retourner le signe, et on ne rappelle pas le modèle pour ça.
export function applySignConvention(rows, account, invertible) {
  const flip = Boolean(invertible) && account && statementInvertsSign(account.name)
  return rows.map((r) => {
    const raw = r.amount_raw ?? r.amount
    return { ...r, amount_raw: raw, amount: flip ? round2(-raw) : round2(raw) }
  })
}

// Le geste humain : écrit les lignes retenues. `only` = indices des lignes
// cochées dans l'aperçu (défaut : toutes les neuves).
export function commitUpload(id, userId, { only = null } = {}) {
  const up = getUpload(id)
  if (!up) throw new Error('Dépôt introuvable')
  if (up.status === 'importe') throw new Error('Ce dépôt est déjà importé')
  if (up.document_kind === 'facture') throw new Error("Ce document est une facture : elle est partie à l'extraction de données")
  if (!up.account_id) throw new Error('Aucun compte choisi')
  const superseded = findSupersededPending(up.account_id, up.rows_json)
  const twins = only ? new Set() : findShiftedTwins(up.account_id, up.rows_json, new Set(superseded.keys()))
  const revised = only ? new Map() : findRevisedAmounts(up.account_id, up.rows_json, new Set([...superseded.keys(), ...twins]))
  const totals = only ? new Set() : findSumDuplicates(up.account_id, up.rows_json)
  const picked = up.rows_json
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => !superseded.has(i) && !twins.has(i) && !revised.has(i) && !totals.has(i) && (only ? only.includes(i) : r._new))
    .map(({ r }) => {
      const { _new: _ignored, ...row } = r
      return row
    })
  // Même sans ligne neuve, le document peut mettre à jour l'état des lignes
  // qu'il retrouve (« En attente » devenu « Autorisée »).
  const restated = applyStatesFromRows(up.account_id, up.rows_json)
    + promoteSupersededPending(up.account_id, up.rows_json, superseded)
    + applyRevisedAmounts(up.account_id, up.rows_json, revised)
  if (!picked.length) {
    if (restated) {
      touch(id, { status: 'importe', inserted_count: 0, duplicate_count: up.rows_json.length })
      return { batchId: null, rowCount: up.rows_json.length, inserted: 0, duplicates: up.rows_json.length, restated }
    }
    throw new Error('Aucune ligne à importer')
  }
  const result = importTransactions(up.account_id, picked, userId)
  const auto = autoMatchAccount(up.account_id)
  touch(id, {
    status: 'importe',
    import_batch_id: result.batchId,
    inserted_count: result.inserted,
    duplicate_count: result.duplicates,
  })
  return { ...result, autoMatched: auto.matched, account_id: up.account_id }
}

// Corriger le compte deviné apprend au compte à se reconnaître la prochaine
// fois (numéro masqué et intitulé lus sur CE relevé).
export function learnAccountHints(accountId, upload) {
  const tokens = [upload.account_number_masked, upload.institution]
    .map((t) => String(t || '').trim()).filter((t) => t.length >= 3)
  if (!tokens.length) return
  const cur = db.prepare('SELECT statement_hints FROM bank_accounts WHERE id=?').get(accountId)?.statement_hints || ''
  const set = new Set(cur.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean))
  for (const t of tokens) set.add(t)
  db.prepare('UPDATE bank_accounts SET statement_hints=? WHERE id=?').run([...set].join(', '), accountId)
}

// Changer le compte deviné : on re-signe (le sens dépend du compte quand le
// fichier n'a qu'une colonne « Montant »), on replanifie la dédup contre CE
// compte, et le compte apprend à se reconnaître la prochaine fois.
export function setUploadAccount(id, accountId) {
  const up = getUpload(id)
  if (!up) throw new Error('Dépôt introuvable')
  if (up.status === 'importe') throw new Error('Ce dépôt est déjà importé')
  const account = accountId ? db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(accountId) : null
  if (accountId && !account) throw new Error('Compte inconnu')
  touch(id, { account_id: accountId || null })
  if (account && accountId !== up.account_id) learnAccountHints(accountId, up)
  return replanUpload(id)
}

// Re-planifie la dédup (et le signe) après un changement de compte ou une
// correction de ligne.
export function replanUpload(id) {
  const up = getUpload(id)
  if (!up) return null
  const account = up.account_id ? db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(up.account_id) : null
  const rows = applySignConvention(
    up.rows_json.map(({ _new: _ignored, ...r }) => r), account, up.invertible,
  )
  const plan = account ? planStatementRows(account.id, rows) : null
  // Le type du compte décide de l'arithmétique du solde : passer d'une carte à
  // un compte chèque refait le contrôle, il ne le garde pas.
  const check = checkBalance(rows, up.opening_balance, up.closing_balance, { kind: account?.kind })
  const mismatch = mismatchFor(account, rows, { currency: up.currency, closing: up.closing_balance, periodEnd: up.period_end })
  // L'avertissement suit le compte choisi : posé s'il le contredit, retiré sinon.
  const others = String(up.error || '').split(' · ').filter((e) => e && !e.startsWith(ACCOUNT_MISMATCH))
  touch(id, {
    rows_json: JSON.stringify(rows.map((r, i) => ({ ...r, _new: plan ? plan.flags[i] : true }))),
    balance_check: check.method === 'soldes' ? check.delta : null,
    balance_method: check.method,
    balance_ok: balanceOkFlag(check, mismatch),
    error: [mismatch, ...others].filter(Boolean).join(' · ') || null,
  })
  return getUpload(id)
}

// Un pm2 restart pendant une lecture laisse le dépôt figé en 'en_analyse' :
// personne ne le reprendra jamais tout seul, autant le dire.
export function sweepStaleUploads(minutes = 30) {
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString()
  return db.prepare(`
    UPDATE bank_statement_uploads
    SET status='erreur', error='Lecture interrompue (redémarrage du serveur) — relancer',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE status='en_analyse' AND created_at < ?
  `).run(cutoff).changes
}

export function listUploads(limit = 40) {
  return db.prepare(`
    SELECT u.id, u.original_name, u.source, u.status, u.error, u.account_id, a.name AS account_name,
           u.detect_confidence, u.period_start, u.period_end, u.balance_check,
           u.inserted_count, u.duplicate_count, u.created_at
    FROM bank_statement_uploads u LEFT JOIN bank_accounts a ON a.id=u.account_id
    ORDER BY u.created_at DESC LIMIT ?
  `).all(limit)
}

export function createUpload({ filePath, originalName, mime, userId }) {
  const id = newRecordId()
  db.prepare(`
    INSERT INTO bank_statement_uploads (id, file_path, original_name, mime, status, created_by)
    VALUES (?,?,?,?,'en_analyse',?)
  `).run(id, filePath, originalName, mime || null, userId || null)
  return id
}

export function deleteUpload(id) {
  const up = db.prepare(SELECT_UPLOAD).get(id)
  if (!up) return false
  try { fs.unlinkSync(up.file_path) } catch { /* fichier déjà parti */ }
  db.prepare('DELETE FROM bank_statement_uploads WHERE id=?').run(id)
  return true
}
