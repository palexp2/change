import { Router } from 'express'
import db from '../db/database.js'
import { getStripeClient, createOrRefreshCheckoutSession } from '../services/stripeInvoices.js'
import { APP_URL } from '../config/appUrl.js'
import { createSoumissionCheckout, SOUMISSION_PAY_KINDS } from '../services/soumissionCheckout.js'
import { ensureSoumissionSystemBuilder } from '../services/soumissionSystemBuilder.js'

const router = Router()

function appBaseUrl() {
  return APP_URL
}

function htmlPage(title, bodyHtml, statusCode = 200) {
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
</style>
</head><body><div class="box">${bodyHtml}</div></body></html>` }
}

// GET /pay/soumission/:id/:kind — boutons « S'abonner » / « Acheter » du PDF
// d'une soumission. kind = abonnement | achat | annule (retour de Stripe).
const SOUMISSION_ERRORS = {
  not_found: [404, 'Lien introuvable', 'Cette soumission n’existe plus.'],
  expired: [410, 'Soumission expirée', 'Cette soumission a expiré. Écrivez-nous pour la renouveler.'],
  empty: [400, 'Rien à payer', 'Cette option ne comporte aucun montant.'],
  mixed_discounts: [400, 'Paiement à confirmer', 'Les rabais de cette soumission doivent être appliqués par notre équipe. Écrivez-nous.'],
  no_tax_place: [400, 'Adresse manquante', 'Nous devons confirmer votre adresse avant le paiement. Écrivez-nous.'],
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
  try {
    const { url } = await createSoumissionCheckout({ stripe: getStripeClient(), soumissionId: id, kind })
    return res.redirect(303, url)
  } catch (e) {
    const [status, title, text] = SOUMISSION_ERRORS[e.code]
      || [500, 'Erreur', 'Le paiement n’a pas pu être préparé. Écrivez-nous pour le régler autrement.']
    if (!SOUMISSION_ERRORS[e.code]) console.error('soumission pay error:', id, kind, e.message)
    const { html } = htmlPage(title,
      `<h1 class="error">${title}</h1><p>${text}</p><a class="btn" href="mailto:info@orisha.io">info@orisha.io</a>`, status)
    return res.status(status).type('html').send(html)
  }
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
