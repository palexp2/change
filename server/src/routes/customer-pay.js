import { Router } from 'express'
import db from '../db/database.js'
import { getStripeClient, createOrRefreshCheckoutSession } from '../services/stripeInvoices.js'

const router = Router()

function appBaseUrl() {
  return (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
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
