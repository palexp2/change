// Gestes communs aux collecteurs de portails (bell, bellBusiness, digikey,
// fedex, newark, pishop, simplex) : le filet réseau qui garde les PDF, la
// remontée d'un lien vers la ligne qui porte date et montant, le
// téléchargement par lien ou par clic, l'impression d'une page HTML en PDF et
// la lecture d'une date dans ses formes anglaises/françaises. Aucune logique
// propre à un portail ici — les sélecteurs et les URL restent dans chaque
// collecteur.

// ── Filet réseau ────────────────────────────────────────────────────────────
// Tout PDF qui redescend est gardé (souvent la seule façon d'attraper un
// téléchargement déclenché en JavaScript) ; les endpoints JSON qui ressemblent
// à de la facturation sont journalisés pour pouvoir les appeler directement à
// la prochaine itération. Retourne la Map url → Buffer.
export function pdfNet(page, log, apiPattern) {
  const captured = new Map()
  page.on('response', async (res) => {
    try {
      const type = (res.headers()['content-type'] || '').toLowerCase()
      const url = res.url()
      if (type.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
        if (!captured.has(url)) captured.set(url, Buffer.from(await res.body()))
        log(`📄 PDF capturé : ${url.slice(0, 120)}`)
      } else if (type.includes('json') && apiPattern.test(url)) {
        log(`↪︎ API vue : ${url.slice(0, 160)}`)
      }
    } catch { /* corps déjà consommé ou réponse annulée */ }
  })
  return captured
}

export const lastCaptured = captured => [...captured.values()].pop() || null

export const isPdf = buffer => !!buffer && buffer.slice(0, 5).toString() === '%PDF-'

// ── Lignes de facture ───────────────────────────────────────────────────────
// Fonction exécutée DANS la page : pour chaque lien, remonte jusqu'à l'ancêtre
// qui porte des chiffres (date + montant), au plus 10 niveaux. `filterSrc`
// (source de regex, optionnelle) ne garde que les liens dont href + texte y
// répondent.
const linkRowsInPage = (els, filterSrc) => {
  const keep = filterSrc ? new RegExp(filterSrc, 'i') : null
  return els
    .filter(a => !keep || keep.test(`${a.getAttribute('href')} ${a.innerText}`))
    .map(a => {
      let node = a
      let row = ''
      for (let i = 0; i < 10 && node; i++) {
        const text = node.innerText || ''
        if (/\d/.test(text) && text.length > 12) { row = text; break }
        node = node.parentElement
      }
      return { href: a.getAttribute('href') || '', text: (a.innerText || '').trim(), row }
    })
}

// [{ href, text, row }] pour les liens de `selector` ; [] si la page refuse.
export function invoiceLinkRows(page, selector, filter = null) {
  return page.$$eval(selector, linkRowsInPage, filter ? filter.source : null).catch(() => [])
}

// Lignes de grille qui portent un montant mais aucun lien (le téléchargement
// est un bouton) — l'en-tête et les lignes de total n'ont pas de « $ ».
export function amountGridRows(page) {
  return page.$$eval('table tr, [role="row"]', els => els
    .filter(tr => /\$/.test(tr.innerText || '') && !tr.querySelector('a[href]'))
    .map(tr => ({ href: '', text: '', row: tr.innerText || '' }))).catch(() => [])
}

// ── Téléchargement ──────────────────────────────────────────────────────────
// Lien direct : on demande le fichier ; si le lien ouvre une visionneuse plutôt
// que le PDF, on navigue dessus et on reprend ce que le filet a attrapé.
export async function fetchPdfByUrl({ context, page, url, captured }) {
  const res = await context.request.get(url, { timeout: 60_000 })
  const buffer = res.ok() ? await res.body() : null
  if (isPdf(buffer)) return buffer
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
  const late = lastCaptured(captured)
  if (late) return late
  throw new Error(`réponse non-PDF (HTTP ${res.status()})`)
}

// Ligne de grille sans lien : on retrouve la ligne par son texte (l'ordre peut
// changer entre deux rendus, pas le contenu), on clique son contrôle, on attend
// le téléchargement PUIS on se rabat sur le filet réseau.
export async function downloadRowPdf({ page, marker, controlSelector, captured, downloadTimeout = 30_000, settleMs = 3000 }) {
  const row = page.locator('table tr, [role="row"]').filter({ hasText: marker }).first()
  if (!(await row.count())) throw new Error('ligne de facture introuvable au moment du téléchargement')
  const control = row.locator(controlSelector).first()
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: downloadTimeout }).catch(() => null),
    control.click({ timeout: 15_000 }).catch(() => {}),
  ])
  if (download) {
    const { readFile } = await import('fs/promises')
    return await readFile(await download.path())
  }
  await page.waitForTimeout(settleMs)
  const late = lastCaptured(captured)
  if (late) return late
  throw new Error("le clic sur la ligne n'a produit aucun PDF")
}

// Page HTML imprimée par Chromium, format lettre — pour les portails qui ne
// servent aucun PDF.
export async function printPagePdf(tab) {
  await tab.emulateMedia({ media: 'print' }).catch(() => {})
  return await tab.pdf({
    format: 'Letter',
    printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
  })
}

// ── Dates ───────────────────────────────────────────────────────────────────
// « 2026-09-04 », « 04 Sep 2026 », « Sep 4, 2026 », « 4 sept. 2026 »,
// « 04/09/2026 » — la langue du compte (en-CA ou fr-CA) change la forme sans
// prévenir. Retourne YYYY-MM-DD ou null.
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const NUM_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/
const TEXT_DATE_DMY = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zéû]{3,9})\.?\s+(\d{4})\b/i
const TEXT_DATE_MDY = /\b([a-zéû]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i

const MONTHS = {
  jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, jui: 6,
  jul: 7, aug: 8, aou: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function monthNumber(word) {
  const key = String(word || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3)
  // « juillet » et « juin » partagent « jui » : le mois exact se lit sur la 4e lettre.
  if (key === 'jui') return /^juil/i.test(word) ? 7 : 6
  return MONTHS[key] || null
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

export function parsePortalDate(text) {
  const s = String(text || '')
  const direct = s.match(ISO_DATE)
  if (direct) return direct[0]
  const dmy = s.match(TEXT_DATE_DMY)
  if (dmy) {
    const month = monthNumber(dmy[2])
    if (month) return iso(dmy[3], month, dmy[1])
  }
  const mdy = s.match(TEXT_DATE_MDY)
  if (mdy) {
    const month = monthNumber(mdy[1])
    if (month) return iso(mdy[3], month, mdy[2])
  }
  const num = s.match(NUM_DATE)
  if (num) {
    // Boutique canadienne : jj/mm/aaaa quand le premier nombre ne peut pas être un mois.
    const [, a, b, year] = num
    const day = Number(a) > 12 ? a : b
    const month = Number(a) > 12 ? b : a
    return iso(year, month, day)
  }
  return null
}
