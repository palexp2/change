import { chromium } from 'playwright-core'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { findChromium } from '../utils/emailHtmlPdf.js'
import { uploadsPath } from '../config/uploads.js'
import { APP_URL } from '../config/appUrl.js'
import { totalsOf } from './soumissionTotals.js'

// PDF client d'une soumission, calqué sur l'ancien outil (devis.orisha.ca) :
// couverture, choix Abonnement / Achat, détail par serre, totaux, témoignages.
// Le même HTML sert l'aperçu en direct de la page de création (iframe) et
// l'impression Chromium : ce qu'on voit est ce que le client reçoit.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SOUMISSION_ASSETS_DIR = path.resolve(__dirname, '../../assets/soumission')
// URL publique des images/polices du gabarit (aperçu dans le navigateur).
export const SOUMISSION_ASSETS_URL = '/erp/api/soumission-assets'

const FARM_GROUP = 'Pour toute la ferme'
const SALES_EMAIL = 'info@orisha.io'

// Lien permanent d'un bouton du PDF → session Stripe Checkout (customer-pay.js).
export const soumissionPayUrl = (soumissionId, kind) =>
  `${APP_URL}/erp/pay/soumission/${encodeURIComponent(soumissionId)}/${kind}`

// Page « comment ça marche » du site, par produit.
const DETAILS_SLUG = {
  'SVC-005': 'disease-prevention',
  'SVC-007': 'side-ventilation',
  'SVC-008': 'irrigation',
  'SVC-009': 'advanced-ventilation',
  'SVC-010': 'advanced-ventilation',
  'SVC-011': 'heating',
  'SVC-014': 'rain-protection',
  'SVC-015': 'wind-protection',
}

const T = {
  English: {
    cover: ['Get', 'Orisha', 'on your', 'Farm'], validUntil: 'Valid until',
    pick: 'Pick what option fits you best',
    payg: 'Pay as You Go', lifetime: 'Lifetime Access', perMonth: '/month',
    paygPros: ['No upfront costs. Equipment is lent free of charge.', 'No commitment. Stop or adapt subscription anytime.', 'Infinite warranty', 'Possibility to switch to Lifetime Access later on'],
    lifetimePros: ['No recurring costs', 'Includes equipment', '5 years limited warranty'],
    recommended: 'Recommended when',
    paygWhen: ['Money is tight', "You'd rather keep money in the bank to weather bad surprises", 'Lifetime replacements sounds good'],
    lifetimeWhen: ['You receive a government grant to buy', 'Financial resilience is not an issue on your farm'],
    subscribe: 'Subscribe', buy: 'Buy Now', detailsBelow: 'Details on your project below',
    product: 'Product', colPayg: 'Pay as you go<br>($/month)', colLifetime: 'Lifetime access ($)',
    details: 'click here for more details', farm: 'For the farm', total: 'Total', discount: 'Discount', until: 'until',
    currency: { USD: 'In American Dollars', CAD: 'In Canadian Dollars' },
    help: ['Don’t waste time looking for answers!', 'They’ll get them to you within 10 minutes.', 'For sales. Or support.', 'Anytime on Eastern business hours.'],
    locale: 'en-US',
  },
  French: {
    cover: ['Obtenez', 'Orisha', 'pour votre', 'ferme'], validUntil: 'Valide jusqu’au',
    pick: 'Choisissez ce qui convient',
    payg: 'Au fur et à mesure', lifetime: 'Accès à vie', perMonth: '/mois',
    paygPros: ['Aucun frais initial. Le matériel est prêté gratuitement.', 'Aucun engagement. Arrêtez ou adaptez votre abonnement à tout moment.', 'Garantie infinie', 'Possibilité de passer ultérieurement à l’accès à vie'],
    lifetimePros: ['Pas de frais récurrents', 'Comprend l’équipement', 'Garantie limitée de 5 ans'],
    recommended: 'Recommandé quand',
    paygWhen: ['L’endettement n’est pas une option', 'Vous préférez garder de l’argent en banque pour éviter les mauvaises surprises', 'Les remplacements à vie vous semblent bons'],
    lifetimeWhen: ['Vous obtenez une subvention si vous achetez', 'La résilience financière n’est pas un problème sur votre ferme'],
    subscribe: 'S’abonner', buy: 'Acheter', detailsBelow: 'Détails sur votre projet ci-dessous',
    product: 'Produit', colPayg: 'Sans engagement<br>($/mois)', colLifetime: 'Accès à vie ($)',
    details: 'cliquez ici pour plus de détails', farm: 'Pour toute la ferme', total: 'Total', discount: 'Rabais', until: 'jusqu’au',
    currency: { USD: 'En dollars américains', CAD: 'En dollars canadiens' },
    help: ['Ne perdez pas de temps à chercher des réponses !', 'Notre équipe vous répond en moins de 10 minutes.', 'Pour les ventes. Ou le soutien.', 'En tout temps, heures ouvrables de l’Est.'],
    locale: 'fr-CA',
  },
}

// Témoignages : ceux de l'ancien outil, laissés dans leur langue d'origine.
const TESTIMONIALS = [
  { pre: 'I can ', strong: 'take a lot of work out of my head', post: ' while Orisha makes sure that the environment stays optimal for plant growth.', name: 'Ben Hartman', farm: 'Clay Bottom Farm', photo: 'ben-hartman.webp', side: 'left' },
  { pre: 'I ', strong: 'got my cucumbers to market 2 weeks earlier this year', post: '. On May 31st vs mid-June. With Orisha, I keep more heat in my unheated tunnel and avoid transplant shock.', name: 'Kevin Drouin', farm: 'Leger Amelot Farm' },
  { pre: 'As of today, August 30th, ', strong: 'we have DOUBLED tomato production', post: ' compared to last year. That’s more than 2000 lbs of tomatoes harvested this summer ! Orisha allowed us to regulate temp and humidity as well as prevent splits with water management', name: 'Drew Cramer', farm: 'Ghosthouse Farm', photo: 'drew-cramer.jpg', side: 'right' },
]

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export { totalsOf }

/**
 * HTML complet de la soumission.
 * @param {object} o
 * @param {'file'|'web'} o.mode  file = impression Chromium (chemins locaux), web = aperçu
 */
export function buildSoumissionHtml({ soumission, items, discounts, company, contact, mode = 'web' }) {
  const lang = soumission.language === 'English' ? 'English' : 'French'
  const t = T[lang]
  const isFr = lang === 'French'
  const currency = soumission.currency === 'USD' ? 'USD' : 'CAD'
  const asset = f => (mode === 'file' ? `file://${path.join(SOUMISSION_ASSETS_DIR, f)}` : `${SOUMISSION_ASSETS_URL}/${f}`)
  const productImg = url => {
    if (!url) return ''
    const m = /\/api\/product-images\/(.+)$/.exec(url)
    if (mode === 'file' && m) return `file://${path.join(uploadsPath('products'), decodeURIComponent(m[1]))}`
    return url
  }
  const num = n => new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 0 }).format(Math.round(n || 0))
  const money = n => (isFr ? `${num(n)} $` : `$${num(n)}`)
  const off = n => `- ${num(n)}`
  const longDate = d => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(t.locale, { year: 'numeric', month: 'long', day: 'numeric' })
  const date = soumission.expiration_date ? longDate(soumission.expiration_date) : ''
  const totals = totalsOf(items, discounts)
  const ref = soumission.title || ''
  // Soumission enregistrée → paiement Stripe ; aperçu (pas encore d'id) → courriel.
  const mail = kind => `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`${ref} — ${kind}`)}`
  const href = (pay, kind) => (soumission.id ? soumissionPayUrl(soumission.id, pay) : mail(kind))
  const btn = (label, kind, pay) => `<a class="btn" href="${esc(href(pay, kind))}">${esc(label)}</a>`
  const contactName = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ')
  const groupLabel = g => (g === FARM_GROUP ? t.farm : g)

  // Lignes du tableau, un bandeau à chaque changement de serre.
  let rows = ''
  let group
  for (const it of items) {
    if (it.group_name && it.group_name !== group) {
      rows += `<tr class="grp"><td colspan="3">${esc(groupLabel(it.group_name))}</td></tr>`
      group = it.group_name
    }
    const qty = it.qty || 1
    const name = (isFr ? (it.description_fr || it.name_fr) : (it.description_en || it.name_en || it.description_fr)) || ''
    const slug = DETAILS_SLUG[it.sku]
    const img = productImg(it.image_url)
    rows += `<tr class="item">
      <td><div class="prod">${img ? `<img src="${esc(img)}" alt="">` : '<span class="noimg"></span>'}<div>
        <div>${qty > 1 ? `${qty} × ` : ''}${esc(name)}</div>
        ${slug ? `<a class="more" href="https://www.orisha.io/how-it-works-${slug}">${esc(t.details)}</a>` : ''}
      </div></div></td>
      <td>${num(qty * (it.unit_monthly_price || 0))}</td>
      <td>${num(qty * (it.unit_price_cad || 0))}</td>
    </tr>`
  }
  for (const l of totals.lines) {
    const until = l.until ? ` <span class="until">(${t.until} ${esc(longDate(l.until))})</span>` : ''
    rows += `<tr class="disc"><td>${esc(l.name || t.discount)}${until}</td><td>${off(l.monthly)}</td><td>${off(l.amount)}</td></tr>`
  }
  const head = `<thead><tr><th>${t.product}</th><th>${t.colPayg}</th><th>${t.colLifetime}</th></tr></thead>`
  const li = list => list.map(x => `<li>${esc(x)}</li>`).join('')

  const testimonial = x => `<div class="quote ${x.side ? `has-photo ${x.side}` : ''}">
      <p>“${esc(x.pre)}<b>${esc(x.strong)}</b>${esc(x.post)}”</p>
      <div class="who"><b>${esc(x.name)}</b><br><b>${esc(x.farm)}</b></div>
      ${x.photo ? `<img class="face" src="${asset(x.photo)}" alt="">` : ''}
    </div>`

  return `<!doctype html>
<html lang="${isFr ? 'fr' : 'en'}"><head><meta charset="utf-8">
<title>Orisha - ${isFr ? 'Soumission' : 'Quote'}</title>
${mode === 'web' ? '<base target="_blank">' : ''}
<style>
@font-face { font-family: Poppins; font-weight: 400; src: url(${asset('Poppins-Regular.ttf')}); }
@font-face { font-family: Poppins; font-weight: 500; src: url(${asset('Poppins-Medium.ttf')}); }
@font-face { font-family: Poppins; font-weight: 600; src: url(${asset('Poppins-SemiBold.ttf')}); }
@font-face { font-family: Poppins; font-weight: 700; src: url(${asset('Poppins-Bold.ttf')}); }
@font-face { font-family: Rubik; font-weight: 300 900; src: url(${asset('Rubik.ttf')}); }
@page { size: letter; margin: 0; }
@page flow { size: letter; margin: 0.6in 0.75in; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Poppins, sans-serif; color: #1f2937; -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff; }
a { color: inherit; text-decoration: none; }
.page { width: 8.5in; height: 11in; position: relative; overflow: hidden; break-after: page; background: #fff; }
.green { color: #25b14e; }
.btn { display: inline-block; background: #1a5c2a; color: #fff; border-radius: 999px; padding: 0.5em 2.4em; font-size: 10.5pt; }

/* Couverture */
.cover-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cover-veil { position: absolute; top: 0; left: 0; bottom: 0; width: 50%; background: #fff; opacity: .9; }
.cover-text { position: absolute; top: 0; left: 0; bottom: 0; width: 50%; padding-left: .75in; }
.cover-text h1 { position: absolute; top: 1.6in; font-family: Rubik; font-weight: 700; color: #25b14e; font-size: 34pt; line-height: 1.75; margin: 0; }
.cover-who { position: absolute; top: 7.05in; font-weight: 700; font-size: 11pt; line-height: 1.6; }
.cover-valid { position: absolute; top: 8.7in; font-size: 7.5pt; line-height: 1.9; }
.cover-valid b { font-size: 8.5pt; }

/* Choix */
.pick { padding: 1in .75in; }
.pick h2 { font-family: Rubik; font-weight: 700; color: #25b14e; font-size: 25pt; margin: 0 0 .55in; }
.cards { display: flex; gap: .4in; }
.card { flex: 1; border: 1px solid #25b14e; border-radius: 12px; padding: .6in .3in .5in; display: flex; flex-direction: column; min-height: 6.6in; }
.card h3 { font-family: Rubik; font-weight: 600; color: #25b14e; font-size: 18pt; text-align: center; margin: 0 0 .35in; }
.card .price { font-family: Rubik; font-weight: 600; font-size: 18pt; text-align: center; color: #374151; margin-bottom: .35in; }
.card ul { margin: 0; padding-left: 1.2em; font-size: 7.2pt; line-height: 1.6; }
.card li { margin-bottom: .5em; }
.card .when { font-size: 7.2pt; font-weight: 700; margin: .28in 0 .1in; }
.card .cta { margin-top: auto; text-align: center; padding-top: .3in; }
.below { text-align: center; font-size: 8.5pt; margin-top: .25in; }
.below::after { content: ''; display: block; margin: 6px auto 0; width: 0; height: 0; border: 4px solid transparent; border-top-color: #1f2937; border-bottom: 0; }

/* Détail */
.flow { page: flow; break-after: page; }
table.lines { width: 100%; border-collapse: separate; border-spacing: 0 2px; font-size: 8pt; }
table.lines th { background: #25b14e; color: #fff; font-weight: 600; text-align: left; padding: 10px 8px; font-size: 8pt; }
table.lines th:nth-child(2) { text-align: center; }
table.lines td { padding: 6px 8px; vertical-align: middle; }
table.lines td:nth-child(1) { width: 52%; }
table.lines td:nth-child(2) { width: 22%; padding-left: 3%; }
table.lines tr.grp td { padding: 9px 8px; font-size: 7.5pt; }
table.lines tr.item td { background: #f7f8fa; }
table.lines tr { break-inside: avoid; }
.prod { display: flex; align-items: center; gap: 12px; padding-left: 4px; }
.prod img, .prod .noimg { width: 14px; height: 14px; object-fit: contain; flex: none; }
.more { display: block; color: #4f6bed; font-size: 5.5pt; line-height: 1.2; }
tr.disc td { color: #b91c1c; font-weight: 700; padding-top: 4px; }
tr.disc td:first-child { color: #c81e1e; }
tr.disc .until { font-weight: 400; }
.cur { text-align: right; font-size: 6.5pt; margin-top: 6px; }
.totals { break-inside: avoid; margin-top: .45in; }
table.lines tr.tot td { font-weight: 700; padding-top: 8px; }
.ctas { display: flex; justify-content: space-around; margin-top: .3in; }

/* Témoignages */
.quotes { position: absolute; top: .6in; left: .65in; right: .65in; display: flex; gap: .3in; }
.quotes .col { flex: 1; display: flex; flex-direction: column; gap: .3in; }
.quotes .col.r { padding-top: .4in; }
.quote { position: relative; background: #fcf7ed; border-radius: 12px; padding: .4in .4in .35in; font-size: 7.6pt; line-height: 1.8; }
.quote p { margin: 0 0 .15in; }
.quote .who { color: #25b14e; font-size: 7pt; line-height: 1.4; }
.quote.has-photo.left .who { padding-left: .9in; }
.face { position: absolute; width: .95in; height: .95in; border-radius: 50%; object-fit: cover; }
.quote.left .face { left: -.15in; bottom: -.2in; }
.quote.right .face { right: -.2in; bottom: -.35in; }
.team { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 3.85in; object-fit: cover; }
.help { position: absolute; z-index: 1; right: 0; bottom: 3.6in; width: 2.8in; background: #25b14e; color: #fff; border-radius: 10px 0 0 10px; padding: .15in .2in .2in; text-align: right; font-size: 6.6pt; line-height: 1.6; }
.help b { display: block; text-align: left; font-size: 7.4pt; margin-bottom: .12in; }

.page:last-child { break-after: auto; }
@media screen {
  body { background: #e2e8f0; padding: 32px 0; }
  .page, .flow { margin: 0 auto 32px; box-shadow: 0 2px 12px rgba(15,23,42,.15); }
  .flow { width: 8.5in; min-height: 11in; padding: .6in .75in; background: #fff; }
}
</style></head><body>

<section class="page">
  <img class="cover-img" src="${asset('cover-v3.jpg')}" alt="">
  <div class="cover-veil"></div>
  <div class="cover-text">
    <h1>${t.cover.map(esc).join('<br>')}</h1>
    <div class="cover-who">${esc(contactName)}${contactName && company?.name ? '<br>' : ''}${esc(company?.name || '')}</div>
    ${date ? `<div class="cover-valid">${t.validUntil}<br><b>${esc(date)}</b></div>` : ''}
  </div>
</section>

<section class="page pick">
  <h2>${t.pick}</h2>
  <div class="cards">
    <div class="card">
      <h3>${t.payg}</h3>
      <div class="price">${money(totals.monthly)}${t.perMonth}</div>
      <ul>${li(t.paygPros)}</ul>
      <div class="when">${t.recommended}</div>
      <ul>${li(t.paygWhen)}</ul>
      <div class="cta">${btn(t.subscribe, t.payg, 'abonnement')}</div>
    </div>
    <div class="card">
      <h3>${t.lifetime}</h3>
      <div class="price">${money(totals.amount)}</div>
      <ul>${li(t.lifetimePros)}</ul>
      <div class="when" style="margin-top:auto">${t.recommended}</div>
      <ul style="min-height:5.2em">${li(t.lifetimeWhen)}</ul>
      <div class="cta">${btn(t.buy, t.lifetime, 'achat')}</div>
    </div>
  </div>
  <div class="below">${t.detailsBelow}</div>
</section>

<section class="flow">
  <table class="lines">${head}<tbody>${rows}</tbody></table>
  <div class="cur">${t.currency[currency]}</div>
  <div class="totals">
    <table class="lines">${head}<tbody>
      <tr class="tot"><td>${t.total}</td><td>${num(totals.monthly)}</td><td>${num(totals.amount)}</td></tr>
    </tbody></table>
    <div class="cur">${t.currency[currency]}</div>
    <div class="ctas">${btn(t.subscribe, t.payg, 'abonnement')}${btn(t.buy, t.lifetime, 'achat')}</div>
  </div>
</section>

<section class="page">
  <div class="quotes">
    <div class="col">${testimonial(TESTIMONIALS[0])}${testimonial(TESTIMONIALS[1])}</div>
    <div class="col r">${testimonial(TESTIMONIALS[2])}</div>
  </div>
  <div class="help"><b>${esc(t.help[0])}</b>${t.help.slice(1).map(esc).join('<br>')}</div>
  <img class="team" src="${asset('team-orisha.jpg')}" alt="">
</section>
</body></html>`
}

/** Imprime le HTML (mode 'file') en PDF. @returns {Promise<Buffer>} */
export async function renderSoumissionPdf(html) {
  const executablePath = findChromium()
  if (!executablePath) throw new Error('aucun Chromium disponible')
  const htmlPath = path.join(tmpdir(), `erp-soumission-${randomUUID()}.html`)
  writeFileSync(htmlPath, html)
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'] })
  try {
    const page = await browser.newPage()
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 30000 })
    await page.evaluate(() => globalThis.document.fonts.ready)
    return await page.pdf({ preferCSSPageSize: true, printBackground: true })
  } finally {
    await browser.close().catch(() => {})
    try { unlinkSync(htmlPath) } catch {}
  }
}
