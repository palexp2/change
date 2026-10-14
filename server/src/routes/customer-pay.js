import { Router } from 'express'
import db from '../db/database.js'
import { getStripeClient, createOrRefreshCheckoutSession } from '../services/stripeInvoices.js'
import { APP_URL } from '../config/appUrl.js'
import { createSoumissionCheckout, SOUMISSION_PAY_KINDS, previewSoumissionUpgrade, applySoumissionUpgrade } from '../services/soumissionCheckout.js'
import { ensureSoumissionSystemBuilder } from '../services/soumissionSystemBuilder.js'
import { recordSoumissionLinkClick } from '../services/soumissionLinkClick.js'
import { pagePayPlan, createPageCheckout, applyPageUpgrade } from '../services/pageCheckout.js'
import { getPageByToken } from '../services/hostedPages.js'
import { createPaymentFailedTask } from '../services/paymentFailedTask.js'
import { placeAutocomplete, placeDetails } from '../services/geocode.js'
import { readFileSync } from 'node:fs'

// Formulaire d'adresse maison de la page de carte (voir assets/pay-address.js).
const PAY_ADDRESS_JS = readFileSync(new URL('./assets/pay-address.js', import.meta.url), 'utf8')

const router = Router()

function appBaseUrl() {
  return APP_URL
}

// brand : logo Orisha en tête et bouton aux couleurs des PDF de soumission.
function htmlPage(title, bodyHtml, statusCode = 200, { brand = false } = {}) {
  return { statusCode, html: `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1f2937;margin:0;padding:40px 20px;line-height:1.5}
.box{max-width:560px;margin:60px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{margin:0 0 12px;font-size:20px}
p{margin:8px 0;color:#475569}
a.btn{display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px}
.muted{color:#94a3b8;font-size:13px}
.error{color:#b91c1c}
${brand ? `.logo{display:block;height:36px;margin:40px auto 24px}.box{margin-top:0}a.btn{background:#1a5c2a;border-radius:999px;padding:10px 28px}a.btn:hover{background:#25b14e}` : ''}
</style>
</head><body>${brand ? `<img class="logo" src="${appBaseUrl()}/erp/orisha-logo.png" alt="Orisha">` : ''}<div class="box">${bodyHtml}</div></body></html>` }
}

// GET /pay/soumission/:id/:kind — boutons « S'abonner » / « Acheter » du PDF
// d'une soumission. kind = abonnement | achat | annule (retour de Stripe).
// [statut, titre FR, texte FR, titre EN, texte EN] — langue de la soumission ou de la page.
const SOUMISSION_ERRORS = {
  not_found: [404, 'Lien introuvable', 'Ce lien n’existe plus.', 'Link not found', 'This link no longer exists.'],
  empty: [400, 'Rien à payer', 'Cette option ne comporte aucun montant.', 'Nothing to pay', 'This option has no amount.'],
  mixed_discounts: [400, 'Paiement à confirmer', 'Les rabais de cette soumission doivent être appliqués par notre équipe. Écrivez-nous.',
    'Payment to be confirmed', 'The discounts on this quote must be applied by our team. Please write to us.'],
  currency_mismatch: [400, 'Paiement à confirmer', 'La devise de ce paiement doit être confirmée par notre équipe. Écrivez-nous.',
    'Payment to be confirmed', 'The currency of this payment must be confirmed by our team. Please write to us.'],
  no_tax_place: [400, 'Adresse manquante', 'Nous devons confirmer votre adresse avant le paiement. Écrivez-nous.',
    'Address missing', 'We need to confirm your address before payment. Please write to us.'],
  no_subscription: [409, 'Abonnement introuvable', 'Votre abonnement n’est plus actif. Écrivez-nous.',
    'Subscription not found', 'Your subscription is no longer active. Please write to us.'],
  payment_failed: [402, 'Paiement refusé', 'Votre carte a été refusée : rien n’a été modifié. Écrivez-nous.',
    'Payment declined', 'Your card was declined: nothing has been changed. Please write to us.'],
}
const GENERIC_ERROR = [500, 'Erreur', 'Le paiement n’a pas pu être préparé. Écrivez-nous pour le régler autrement.',
  'Error', 'The payment could not be prepared. Please write to us to settle it another way.']

// Langue d'un lien de paiement : celle de la soumission, sinon de la page.
function langOf(kind, id) {
  if (kind === 'page') return getPageByToken(id)?.config.language === 'en' ? 'en' : 'fr'
  return db.prepare('SELECT language FROM soumissions WHERE id = ?').get(id)?.language === 'English' ? 'en' : 'fr'
}

function soumissionErrorPage(res, e, id, kind) {
  const [status, tfr, xfr, ten, xen] = SOUMISSION_ERRORS[e.code] || GENERIC_ERROR
  if (!SOUMISSION_ERRORS[e.code]) console.error('soumission pay error:', id, kind, e.message)
  const en = langOf(kind, id) === 'en'
  const title = en ? ten : tfr
  const text = en ? xen : xfr
  const { html } = htmlPage(title,
    `<h1 class="error">${title}</h1><p>${text}</p><a class="btn" href="mailto:info@orisha.io">info@orisha.io</a>`, status)
  return res.status(status).type('html').send(html)
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Client déjà abonné : page « Ajouter à mon abonnement » (actuel vs ajout).
function upgradePage(p, action) {
  const fr = p.isFr
  const money = cents => new Intl.NumberFormat(fr ? 'fr-CA' : 'en-CA', { style: 'currency', currency: p.currency.toUpperCase() }).format(cents / 100)
  const rows = list => list.map(l => `<tr><td>${esc(l.name)}${l.qty > 1 ? ` × ${l.qty}` : ''}</td><td class="r">${money(l.cents)}</td></tr>`).join('')
  const sum = list => list.reduce((t, l) => t + l.cents, 0)
  const now = sum(p.current)
  const after = now + sum(p.added) - (p.offCents || 0)
  const when = p.startsAt && new Date(p.startsAt.at * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Montreal' })
  const t = fr
    ? { title: 'Ajouter à votre abonnement', cur: 'Actuel', add: when ? `Ajout le ${when}` : 'Ajout', off: 'Rabais', total: 'Nouveau total mensuel, avant taxes', btn: 'Approuver',
      note: !when ? 'Le mois en cours est facturé au prorata sur votre carte enregistrée.' : p.startsAt.prorate ? `Rien à payer avant le ${when} ; ce premier mois sera facturé au prorata sur votre carte enregistrée.` : `Rien à payer avant le ${when}, sur votre carte enregistrée.` }
    : { title: 'Add to your subscription', cur: 'Current', add: when ? `Added on ${when}` : 'Added', off: 'Discount', total: 'New monthly total, before taxes', btn: 'Approve',
      note: !when ? 'The current month is prorated and charged to your card on file.' : p.startsAt.prorate ? `Nothing to pay before ${when}; that first month will be prorated on your card on file.` : `Nothing to pay before ${when}, on your card on file.` }
  return htmlPage(t.title, `<style>table{width:100%;border-collapse:collapse;margin:4px 0 14px}td{padding:4px 0;border-bottom:1px solid #f1f5f9}.r{text-align:right;white-space:nowrap}h2{font-size:13px;text-transform:uppercase;color:#94a3b8;margin:16px 0 4px}button{background:#1a5c2a;color:#fff;border:0;padding:12px 28px;border-radius:999px;font-weight:600;font-size:15px;cursor:pointer;margin-top:8px}.tot td{font-weight:700;border:0;padding-top:10px}button:hover{background:#25b14e}</style>
<h1>${t.title}</h1>
<h2>${t.cur}</h2><table>${rows(p.current)}<tr class="tot"><td></td><td class="r">${money(now)}</td></tr></table>
<h2>${t.add}</h2><table>${rows(p.added)}${p.offCents ? `<tr><td>${t.off}</td><td class="r">−${money(p.offCents)}</td></tr>` : ''}</table>
<table><tr class="tot"><td>${t.total}</td><td class="r">${money(after)}</td></tr></table>
<form method="post" action="${esc(action)}"><button type="submit">${t.btn}</button></form>
<p class="muted">${t.note}</p>`, 200, { brand: true }).html
}
// Client déjà abonné à une autre fréquence : abonnement séparé, carte au dossier.
function separatePage(p, action) {
  const fr = p.isFr
  const money = cents => new Intl.NumberFormat(fr ? 'fr-CA' : 'en-CA', { style: 'currency', currency: p.currency.toUpperCase() }).format(cents / 100)
  const per = { month: fr ? 'mois' : 'month', year: fr ? 'an' : 'year', week: fr ? 'semaine' : 'week', day: fr ? 'jour' : 'day' }[p.price.recurring?.interval] || ''
  const card = `${esc(String(p.card.brand || '').replace(/^\w/, ch => ch.toUpperCase()))}${p.card.last4 ? ` •••• ${esc(p.card.last4)}` : ''}`
  const when = p.billingStart?.date || null
  const t = fr
    ? { title: 'Confirmer votre abonnement', note: p.like ? 'Abonnement séparé de vos abonnements actuels.' : '', tax: 'avant taxes', pay: `Premier paiement ${when ? `le ${when}` : 'aujourd’hui'} sur ${card}.`, btn: 'Approuver' }
    : { title: 'Confirm your subscription', note: p.like ? 'Separate from your current subscriptions.' : '', tax: 'before taxes', pay: `First payment ${when ? `on ${when}` : 'today'} on ${card}.`, btn: 'Approve' }
  const rows = p.added.map(l => `<tr><td>${esc(l.name)}</td><td class="r">${money(l.cents)} / ${per}</td></tr>`).join('')
  return htmlPage(t.title, `<style>table{width:100%;border-collapse:collapse;margin:4px 0 6px}td{padding:6px 0;border-bottom:1px solid #f1f5f9;font-weight:600}.r{text-align:right;white-space:nowrap}button{background:#1a5c2a;color:#fff;border:0;padding:12px 28px;border-radius:999px;font-weight:600;font-size:15px;cursor:pointer;margin-top:8px}button:hover{background:#25b14e}</style>
<h1>${t.title}</h1>
<table>${rows}</table>
<p class="muted">${t.tax}${t.note ? ` · ${t.note}` : ''}</p>
<p>${t.pay}</p>
<form method="post" action="${esc(action)}"><button type="submit">${t.btn}</button></form>`, 200, { brand: true }).html
}

// Nouvel abonnement : notre page de carte (Stripe Elements sur la session
// Checkout) — même session, mêmes taxes, mais bouton « Confirmer ».
function stripePublishableKey() {
  return db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='publishable_key'").get()?.value || ''
}
function cardPage(p, { session, needsEmail }, billing = {}) {
  const fr = p.isFr
  const money = cents => new Intl.NumberFormat(fr ? 'fr-CA' : 'en-CA', { style: 'currency', currency: p.currency.toUpperCase() }).format(cents / 100)
  const per = { month: fr ? 'mois' : 'month', year: fr ? 'an' : 'year', week: fr ? 'semaine' : 'week', day: fr ? 'jour' : 'day' }[p.price.recurring?.interval] || ''
  const when = p.billingStart?.date || null
  const t = fr
    ? { title: 'Votre abonnement', tax: 'avant taxes', taxes: 'Taxes', total: 'Total, taxes incluses', addr: 'selon l’adresse', first: when ? `Premier paiement le ${when}.` : '', today: 'Aujourd’hui', btn: 'Confirmer', err: 'Le paiement n’a pas pu être confirmé.' }
    : { title: 'Your subscription', tax: 'before taxes', taxes: 'Taxes', total: 'Total, taxes included', addr: 'based on address', first: when ? `First payment on ${when}.` : '', today: 'Due today', btn: 'Confirm', err: 'The payment could not be confirmed.' }
  const cfg = { pk: stripePublishableKey(), secret: session.client_secret, needsEmail, locale: fr ? 'fr-CA' : 'en', currency: p.currency.toUpperCase(), err: t.err, fr,
    addrUrl: `/erp/pay/page/${encodeURIComponent(p.c.token)}/adresse`, initial: billing.initial || null, defaultCountry: billing.defaultCountry || 'CA' }
  return htmlPage(t.title, `<style>table{width:100%;border-collapse:collapse;margin:4px 0 6px}td{padding:6px 0;border-bottom:1px solid #f1f5f9;font-weight:600}.r{text-align:right;white-space:nowrap}
.el{margin:14px 0}button{width:100%;background:#1a5c2a;color:#fff;border:0;padding:13px 28px;border-radius:999px;font-weight:600;font-size:15px;cursor:pointer;margin-top:12px}button:hover{background:#25b14e}button:disabled{opacity:.5;cursor:default}#today{font-weight:400}td.sub{font-weight:400;color:#64748b}#msg{margin-top:10px}</style>
<h1>${t.title}</h1>
<table><tr><td>${esc(p.price.product.name)}</td><td class="r">${money(p.price.unit_amount || 0)} / ${per}</td></tr>
<tbody id="taxes"><tr><td class="sub">${t.taxes}</td><td class="r sub">${t.addr}</td></tr></tbody>
<tr id="tot" hidden><td>${t.total}</td><td class="r"><span id="totv"></span> / ${per}</td></tr></table>
${t.first ? `<p class="muted">${t.first}</p>` : ''}
<form id="f">${needsEmail ? '<div id="contact" class="el"></div>' : ''}<div id="address" class="el"></div><div id="payment" class="el"></div>
<p class="muted" id="today"></p>
<button id="go" type="submit" disabled>${t.btn}</button><p id="msg" class="error"></p></form>
<script src="https://js.stripe.com/dahlia/stripe.js"></script>
<script>${PAY_ADDRESS_JS.replace(/<\//g, '<\\/')}</script>
<script>
(function(){
  var cfg = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};
  var stripe = Stripe(cfg.pk, { locale: cfg.locale });
  var checkout = stripe.initCheckoutElementsSdk({ clientSecret: cfg.secret, elementsOptions: { appearance: { theme: 'stripe', variables: { colorPrimary: '#1a5c2a', borderRadius: '8px' } } } });
  var go = document.getElementById('go'), msg = document.getElementById('msg');
  var actionsP = checkout.loadActions(), canConfirm = false;
  var addr = PayAddress.mount(document.getElementById('address'), { fr: cfg.fr, endpoint: cfg.addrUrl, initial: cfg.initial, defaultCountry: cfg.defaultCountry, onChange: function (a) {
    refresh(); if (lastSession) render(lastSession);
    // Adresse complète → Stripe recalcule les taxes.
    if (a.valid()) pushAddress();
  } });
  function pushAddress() {
    actionsP.then(function (r) { if (r.type !== 'error') return r.actions.updateBillingAddress(addr.value()) })
      .then(function (u) { if (u && u.type === 'error') console.warn('[pay] adresse', u.error && u.error.message) })
      .catch(function (e) { console.warn('[pay] adresse', e && e.message) });
  }
  function refresh() { go.disabled = !(canConfirm && addr.valid()); }
  if (addr.valid()) pushAddress();
  var lastSession = null;
  checkout.on('change', function (s) {
    lastSession = s; canConfirm = s.canConfirm; refresh();
    try { document.getElementById('today').textContent = ${JSON.stringify(t.today)} + ' : ' + s.total.total.amount; } catch (e) {}
    render(s);
  });
  function render(s) {
    // Mensualité (prochaine échéance — 0 $ aujourd'hui pendant l'essai) ; ventilation
    // TPS/TVQ par les pourcentages connus, sinon une seule ligne « Taxes ».
    try {
      var n = s.recurring && s.recurring.dueNext, tot = n ? n.total : s.total.total
      var tax = n ? n.taxExclusive : s.total.taxExclusive, base = n ? n.subtotal : s.total.subtotal
      var ready = !s.tax || s.tax.status === 'ready'
      // Stripe calcule l'aperçu sur l'adresse au dossier du client tant que le
      // paiement n'est pas confirmé : adresse modifiée → taxes « selon l'adresse ».
      var src = s.tax && s.tax.automaticTax && s.tax.automaticTax.addressSource
      if (src === 'customer' && addr.edited()) {
        document.getElementById('taxes').hidden = false; document.getElementById('tot').hidden = true
        document.getElementById('taxes').innerHTML = '<tr><td class="sub">' + ${JSON.stringify(t.taxes)} + '</td><td class="r sub">' + ${JSON.stringify(t.addr)} + '</td></tr>'
        return
      }
      // Aucune taxe une fois l'adresse connue (ex. client aux É.-U.) : ni ligne Taxes ni total.
      document.getElementById('taxes').hidden = ready && !(tax && tax.minorUnitsAmount)
      if (!tax || !tax.minorUnitsAmount) { document.getElementById('tot').hidden = true; return }
      var fmt = function (c) { return new Intl.NumberFormat(cfg.locale === 'en' ? 'en-CA' : 'fr-CA', { style: 'currency', currency: cfg.currency }).format(c / 100) }
      var pcts = (s.taxAmounts || []).filter(function (x) { return x.percentage && !x.inclusive })
      var rows = pcts.length ? pcts.map(function (x) { return [x.displayName + ' (' + x.percentage + ' %)', fmt(Math.round(base.minorUnitsAmount * x.percentage / 100))] })
        : [[${JSON.stringify(t.taxes)}, tax.amount]]
      document.getElementById('taxes').innerHTML = rows.map(function (r) {
        var d = document.createElement('td'); d.className = 'sub'; d.textContent = r[0]
        var v = document.createElement('td'); v.className = 'r sub'; v.textContent = r[1]
        return '<tr>' + d.outerHTML + v.outerHTML + '</tr>'
      }).join('')
      document.getElementById('totv').textContent = tot.amount
      document.getElementById('tot').hidden = false
    } catch (e) {}
  }
  if (cfg.needsEmail) checkout.createContactDetailsElement().mount('#contact');
  checkout.createPaymentElement({ wallets: { googlePay: 'never', link: 'never' }, fields: { billingDetails: { name: 'never', address: 'never' } } }).mount('#payment');
  document.getElementById('f').addEventListener('submit', async function (e) {
    e.preventDefault(); if (!addr.valid()) return; go.disabled = true; msg.textContent = '';
    try {
      var r = await actionsP;
      if (r.type === 'error') throw r.error;
      // Taxes automatiques : l'adresse passe par updateBillingAddress, jamais par confirm().
      var u = await r.actions.updateBillingAddress(addr.value());
      if (u && u.type === 'error') throw u.error;
      var c = await r.actions.confirm();
      if (c.type === 'error') { msg.textContent = c.error.message || cfg.err; go.disabled = false; }
    } catch (err) { msg.textContent = (err && err.message) || cfg.err; go.disabled = false; }
  });
})();
</script>`, 200, { brand: true }).html
}

// Session payée (ou sans montant dû : rabais de 100 %), et bien celle de cette soumission.
async function paidSoumissionSession(soumissionId, sessionId) {
  if (!sessionId) return { state: 'invalid' }
  let session
  try { session = await getStripeClient().checkout.sessions.retrieve(String(sessionId)) }
  catch { return { state: 'invalid' } }
  if (session.metadata?.erp_soumission_id !== soumissionId) return { state: 'invalid' }
  if (session.status !== 'complete' || !['paid', 'no_payment_required'].includes(session.payment_status)) return { state: 'pending', session }
  return { state: 'paid', session }
}

// GET /pay/soumission/:id/paye?session_id=… — retour de Stripe après paiement :
// le System builder de la soumission est créé et le client est redirigé vers
// son lien public. Automation désactivée ou soumission sans serre : ancien
// parcours post-paiement.
router.get('/soumission/:id/paye', async (req, res) => {
  const { id } = req.params
  const sessionId = req.query.session_id
  const { state, session } = await paidSoumissionSession(id, sessionId)
  if (state === 'invalid') return res.status(404).type('html').send(htmlPage('Lien introuvable', '<h1 class="error">Lien introuvable</h1>', 404).html)
  if (state === 'pending') {
    // Paiement différé (débit préautorisé) : recharger la page une fois confirmé.
    const { html } = htmlPage('Paiement en cours',
      '<h1>Merci !</h1><p>Votre paiement est en cours de confirmation. Rechargez cette page dans quelques minutes.</p><p class="muted">Thank you! Your payment is being confirmed. Reload this page in a few minutes.</p>')
    return res.type('html').send(html)
  }
  let form = null
  try { form = ensureSoumissionSystemBuilder({ soumissionId: id, session, source: 'redirect' }) }
  catch (e) { console.error('soumission system builder error:', id, e.message) }
  if (form?.public_token) return res.redirect(303, `${appBaseUrl()}/erp/d/${form.public_token}`)
  return res.redirect(303, `${appBaseUrl()}/erp/customer/post-payment?session_id=${encodeURIComponent(session.id)}`)
})

router.get('/soumission/:id/:kind', async (req, res) => {
  const { id, kind } = req.params
  if (kind === 'annule') {
    const { html } = htmlPage('Paiement annulé',
      `<h1>Paiement annulé</h1><p>Aucun montant n’a été prélevé.</p><a class="btn" href="mailto:info@orisha.io">info@orisha.io</a>`)
    return res.type('html').send(html)
  }
  if (!SOUMISSION_PAY_KINDS.includes(kind)) return res.status(404).type('html').send(htmlPage('Lien introuvable', '<h1 class="error">Lien introuvable</h1>').html)
  // Compté avant la session Stripe : un clic qui échoue (soumission expirée…) reste un signal.
  // Le client a vu et accepté les nouveaux prix (soumission expirée).
  const acceptNewPrices = req.query.nouveaux_prix === '1'
  const accepted = acceptNewPrices ? '?nouveaux_prix=1' : ''
  // Le clic qui suit la page des nouveaux prix n'est pas un nouveau clic.
  if (!acceptNewPrices) recordSoumissionLinkClick(req, id, kind)
  try {
    const stripe = getStripeClient()
    if (kind === 'abonnement') {
      const p = await previewSoumissionUpgrade({ stripe, soumissionId: id, acceptNewPrices })
      if (p?.alreadyApplied) return res.type('html').send(upgradeDonePage(p.isFr))
      if (p) return res.type('html').send(upgradePage(p, `${appBaseUrl()}/erp/pay/soumission/${encodeURIComponent(id)}/abonnement/approuver${accepted}`))
    }
    const { url } = await createSoumissionCheckout({ stripe, soumissionId: id, kind, acceptNewPrices })
    return res.redirect(303, url)
  } catch (e) {
    if (e.code === 'price_changed') return res.type('html').send(priceChangedPage(e, `${appBaseUrl()}/erp/pay/soumission/${encodeURIComponent(id)}/${kind}?nouveaux_prix=1`, kind))
    return soumissionErrorPage(res, e, id, kind)
  }
})

// Soumission expirée dont des prix ont changé : détail, puis « Continuer ».
export function priceChangedPage(e, nextUrl, kind) {
  const fr = e.isFr
  const money = v => new Intl.NumberFormat(fr ? 'fr-CA' : 'en-CA', { style: 'currency', currency: e.currency.toUpperCase() }).format(v)
  const per = kind === 'abonnement' ? (fr ? ' / mois' : ' / month') : ''
  const rows = e.changes.map(c => `<tr><td>${esc(c.name)}${c.qty > 1 ? ` × ${c.qty}` : ''}</td><td class="r old">${money(c.before)}</td><td class="r">${money(c.now)}${per}</td></tr>`).join('')
  const t = fr
    ? { title: 'Les prix ont changé', text: 'Votre soumission a expiré et certains prix ont changé depuis :', btn: 'Continuer aux nouveaux prix' }
    : { title: 'Prices have changed', text: 'Your quote has expired and some prices have changed since:', btn: 'Continue at the new prices' }
  return htmlPage(t.title, `<style>table{width:100%;border-collapse:collapse;margin:8px 0 16px}td{padding:4px 0;border-bottom:1px solid #f1f5f9}.r{text-align:right;white-space:nowrap;padding-left:12px}.old{color:#94a3b8;text-decoration:line-through}</style>
<h1>${t.title}</h1><p>${t.text}</p><table>${rows}</table>
<a class="btn" href="${esc(nextUrl)}">${t.btn}</a>`, 200, { brand: true }).html
}

const DONE_TEXT = {
  added: ['Ces éléments sont ajoutés à votre abonnement.', 'These items have been added to your subscription.'],
  scheduled: ['L’ajout à votre abonnement est programmé.', 'The addition to your subscription is scheduled.'],
  already: ['Votre abonnement inclut déjà ce produit.', 'Your subscription already includes this product.'],
  new: ['Votre abonnement est activé.', 'Your subscription is active.'],
}
function upgradeDonePage(fr, kind = 'added') {
  const [tfr, ten] = DONE_TEXT[kind] || DONE_TEXT.added
  return htmlPage('Merci', fr ? `<h1>Merci !</h1><p>${tfr}</p>` : `<h1>Thank you!</h1><p>${ten}</p>`, 200, { brand: true }).html
}

// POST /pay/soumission/:id/abonnement/approuver — le client déjà abonné
// approuve l'ajout : abonnement Stripe modifié, puis System builder.
router.post('/soumission/:id/abonnement/approuver', async (req, res) => {
  const { id } = req.params
  try {
    const r = await applySoumissionUpgrade({ stripe: getStripeClient(), soumissionId: id, acceptNewPrices: req.query.nouveaux_prix === '1' })
    const isFr = db.prepare('SELECT language FROM soumissions WHERE id=?').get(id)?.language !== 'English'
    if (r.sub && !r.already) {
      let form = null
      try {
        form = ensureSoumissionSystemBuilder({
          soumissionId: id, source: 'subscription_upgrade',
          session: { id: `upgrade:${r.sub.id}:${id}`, metadata: r.metadata, invoice: r.sub.latest_invoice, subscription: r.sub.id },
        })
      } catch (e) { console.error('soumission system builder error:', id, e.message) }
      if (form?.public_token) return res.redirect(303, `${appBaseUrl()}/erp/d/${form.public_token}`)
    }
    return res.type('html').send(upgradeDonePage(isFr))
  } catch (e) {
    if (e.code === 'payment_failed') createPaymentFailedTask({ source: 'soumission', soumissionId: id, error: e.message })
    return soumissionErrorPage(res, e, id, 'abonnement')
  }
})

// ── Page hébergée avec paiement : bouton « Payer » du bloc d'acceptation.
// GET /pay/page/:token/merci — retour de Stripe (nouvel abonnement).
router.get('/page/:token/merci', (req, res) => {
  const page = getPageByToken(req.params.token)
  if (page?.config.thanks) return res.redirect(303, page.config.thanks)
  const fr = page?.config.language !== 'en'
  return res.type('html').send(upgradeDonePage(fr, 'new'))
})

// Autocomplétion d'adresse de la page de carte (publique : jeton de page exigé,
// débit limité par IP pour ne pas offrir la clé Google au premier venu).
const addrHits = new Map()
function addrGuard(req, res) {
  if (!getPageByToken(req.params.token)) { res.status(404).json({ predictions: [] }); return false }
  const now = Date.now(), h = addrHits.get(req.ip) || { n: 0, t: now }
  if (now - h.t > 60_000) { h.n = 0; h.t = now }
  h.n += 1; addrHits.set(req.ip, h)
  if (addrHits.size > 5000) addrHits.clear()
  if (h.n > 90) { res.status(429).json({ predictions: [] }); return false }
  return true
}
router.get('/page/:token/adresse', async (req, res) => {
  if (!addrGuard(req, res)) return
  try {
    res.json({ predictions: await placeAutocomplete(String(req.query.q || '').slice(0, 200), { sessionToken: String(req.query.s || ''), country: String(req.query.c || '') }) })
  } catch (e) {
    console.error('[pay] autocomplétion adresse', e.message)
    res.json({ predictions: [] })
  }
})
router.get('/page/:token/adresse/:placeId', async (req, res) => {
  if (!addrGuard(req, res)) return
  try {
    res.json((await placeDetails(req.params.placeId, { sessionToken: String(req.query.s || '') })) || {})
  } catch (e) {
    console.error('[pay] détail adresse', e.message)
    res.json({})
  }
})

// Adresse de départ du formulaire : celle du client Stripe, sinon le pays de
// l'entreprise au dossier.
const COUNTRY_CODES = { canada: 'CA', 'united states': 'US', usa: 'US', 'états-unis': 'US', 'etats-unis': 'US' }
async function billingPrefill(stripe, plan, session) {
  const company = plan.contact?.company_id ? db.prepare('SELECT name, country FROM companies WHERE id=?').get(plan.contact.company_id) : null
  const raw = String(company?.country || '').trim()
  const defaultCountry = /^[A-Z]{2}$/.test(raw) ? raw : (COUNTRY_CODES[raw.toLowerCase()] || 'CA')
  const id = typeof session.customer === 'string' ? session.customer : session.customer?.id || plan.customer
  const name = plan.a?.name || ''
  if (!id) return { defaultCountry, initial: name ? { name } : null }
  const cus = await stripe.customers.retrieve(id).catch(() => null)
  const a = cus?.address
  return {
    defaultCountry,
    initial: {
      name: cus?.name || name,
      address: a?.country ? { country: a.country, line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code } : null,
    },
  }
}
async function sendCardPage(res, stripe, plan) {
  const checkout = await createPageCheckout({ stripe, plan })
  return res.type('html').send(cardPage(plan, checkout, await billingPrefill(stripe, plan, checkout.session)))
}

// GET /pay/page/:token/:acceptanceId — client abonné : page d'approbation ;
// sinon Checkout d'un nouvel abonnement.
router.get('/page/:token/:acceptanceId', async (req, res) => {
  const { token, acceptanceId } = req.params
  try {
    const stripe = getStripeClient()
    const plan = await pagePayPlan({ stripe, token, acceptanceId })
    if (plan.mode === 'already') return res.type('html').send(upgradeDonePage(plan.isFr, 'already'))
    if (plan.mode === 'separate') {
      return res.type('html').send(separatePage(plan,
        `${appBaseUrl()}/erp/pay/page/${encodeURIComponent(token)}/${encodeURIComponent(acceptanceId)}/approuver`))
    }
    if (plan.mode === 'upgrade') {
      return res.type('html').send(upgradePage(plan,
        `${appBaseUrl()}/erp/pay/page/${encodeURIComponent(token)}/${encodeURIComponent(acceptanceId)}/approuver`))
    }
    return sendCardPage(res, stripe, plan)
  } catch (e) {
    return soumissionErrorPage(res, e, token, 'page')
  }
})

// GET /pay/page/:token/:acceptanceId/carte — abonnement séparé refusé sur la
// carte au dossier : nouvelle carte sur notre page.
router.get('/page/:token/:acceptanceId/carte', async (req, res) => {
  const { token, acceptanceId } = req.params
  try {
    const stripe = getStripeClient()
    const plan = await pagePayPlan({ stripe, token, acceptanceId })
    if (plan.mode !== 'new' && plan.mode !== 'separate') return res.redirect(303, `${appBaseUrl()}/erp/pay/page/${encodeURIComponent(token)}/${encodeURIComponent(acceptanceId)}`)
    return sendCardPage(res, stripe, plan)
  } catch (e) {
    return soumissionErrorPage(res, e, token, 'page')
  }
})

// POST /pay/page/:token/:acceptanceId/approuver
router.post('/page/:token/:acceptanceId/approuver', async (req, res) => {
  const { token, acceptanceId } = req.params
  try {
    const stripe = getStripeClient()
    let r
    try {
      r = await applyPageUpgrade({ stripe, token, acceptanceId })
    } catch (e) {
      // Abonnement séparé refusé sur la carte au dossier → Checkout (nouvelle carte).
      if (e.code !== 'payment_failed' && e.code !== 'needs_checkout') throw e
      const plan = await pagePayPlan({ stripe, token, acceptanceId })
      if (plan.mode !== 'separate') throw e
      return res.redirect(303, `${appBaseUrl()}/erp/pay/page/${encodeURIComponent(token)}/${encodeURIComponent(acceptanceId)}/carte`)
    }
    const page = getPageByToken(token)
    if (page?.config.thanks && !r.already) return res.redirect(303, page.config.thanks)
    const fr = page?.config.language !== 'en'
    return res.type('html').send(upgradeDonePage(fr, r.already ? 'already' : r.separate ? 'new' : r.scheduled ? 'scheduled' : 'added'))
  } catch (e) {
    if (e.code === 'payment_failed') createPaymentFailedTask({ source: 'page', token, acceptanceId, error: e.message })
    return soumissionErrorPage(res, e, token, 'page')
  }
})

// GET /pay/:pendingId/merci — retour de Stripe après le paiement d'une facture.
router.get('/:pendingId/merci', (req, res) => {
  const { html } = htmlPage('Merci',
    `<h1>Merci !</h1><p>Votre paiement a bien été reçu.</p><p class="muted">Thank you! Your payment has been received.</p>`)
  return res.type('html').send(html)
})

// GET /pay/:pendingId — public permanent payment link.
// Looks up the pending_invoice. If valid + unpaid, redirects to a fresh-or-cached
// Stripe Checkout Session. Otherwise renders an HTML error page.
router.get('/:pendingId', async (req, res) => {
  const pending = db.prepare('SELECT * FROM pending_invoices WHERE id=?').get(req.params.pendingId)
  if (!pending) {
    const { html } = htmlPage('Lien introuvable',
      `<h1 class="error">Lien introuvable</h1><p>Ce lien de paiement n'existe pas ou a été supprimé.</p>`)
    return res.status(404).type('html').send(html)
  }

  if (pending.status === 'paid') {
    const { html } = htmlPage('Déjà payée',
      `<h1>Facture déjà payée</h1><p>Merci, cette facture a déjà été payée.</p><p class="muted">Si vous pensez que c'est une erreur, contactez-nous.</p>`)
    return res.status(200).type('html').send(html)
  }
  if (pending.status === 'cancelled') {
    const { html } = htmlPage('Facture annulée',
      `<h1 class="error">Facture annulée</h1><p>Cette facture a été annulée par notre équipe.</p>`)
    return res.status(410).type('html').send(html)
  }

  let stripe
  try { stripe = getStripeClient() }
  catch (e) {
    const { html } = htmlPage('Service indisponible',
      `<h1 class="error">Service de paiement indisponible</h1><p>${e.message}</p>`)
    return res.status(503).type('html').send(html)
  }

  try {
    const { url } = await createOrRefreshCheckoutSession({
      stripe, pending, baseAppUrl: appBaseUrl(),
    })
    return res.redirect(303, url)
  } catch (e) {
    console.error('pay redirect error:', e.message)
    const { html } = htmlPage('Erreur',
      `<h1 class="error">Erreur lors de la création du paiement</h1><p>${e.message}</p><p class="muted">Veuillez nous contacter pour régler le paiement autrement.</p>`)
    return res.status(500).type('html').send(html)
  }
})

export default router
