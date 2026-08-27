// Collecteur Wix (facturation de NOTRE compte Wix, pas les factures de nos clients).
//
// Wix n'expose aucune API publique pour ses propres factures — le REST public
// sert à gérer un site, pas le compte qui le paie — et le courriel de
// prélèvement ne porte pas le PDF. Mais la console de facturation, elle, parle
// à deux endpoints internes qu'on peut appeler directement avec la session :
//
//   GET /_api/billing-management/v1/payments-history/first-invoices-with-filters
//       → { userInvoiceResults: { results: [ { invoiceDocId, eventDate, amount,
//           currencyCode, status, lineItems… } ], totalCount } }
//   GET /premium-invoice/api/v1/invoice/<invoiceDocId>   → le PDF
//
// C'est nettement plus solide que de cliquer : la liste est un JSON stable,
// alors que la page est une SPA dont les boutons (`data-hook="invoice-number"`)
// ouvrent un onglet au lieu de télécharger. On ne garde de la page que
// l'ouverture initiale — elle valide la session et fixe les en-têtes que les
// endpoints internes attendent.
//
// La connexion par mot de passe est tentée mais échoue en pratique : Wix
// protège son formulaire par un reCAPTCHA et le compte passe par Google. La
// voie normale est donc « Importer une session » dans l'ERP (cf. session.js).

const BILLING_URL = 'https://manage.wix.com/account/billing-history'
const LIST_API = 'https://manage.wix.com/_api/billing-management/v1/payments-history/first-invoices-with-filters'
const PDF_API = id => `https://manage.wix.com/premium-invoice/api/v1/invoice/${id}`
const SIGNIN_HOST = /users\.wix\.com|www\.wix\.com\/signin/

const NEEDS_SESSION =
  "Connexion Wix bloquée (captcha ou connexion Google) — se connecter à la main dans un navigateur puis « Importer une session ». Voir la capture de la tournée."

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion…')
  await page.goto('https://users.wix.com/signin', { waitUntil: 'domcontentloaded' })

  const email = page.locator('input[type="email"], input[name="email"], #input_0').first()
  await email.waitFor({ state: 'visible', timeout: 20_000 })
  await email.fill(credentials.username)

  let pwd = page.locator('input[type="password"]').first()
  if (!(await pwd.count())) {
    await page.locator('button:has-text("Continuer"), button:has-text("Continue"), [type="submit"]').first().click().catch(() => {})
    pwd = page.locator('input[type="password"]').first()
  }
  await pwd.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (await pwd.count()) {
    await pwd.fill(credentials.password)
    await pwd.press('Enter').catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  if (SIGNIN_HOST.test(page.url())) {
    await ctx.snapshot('wix-login-echec')
    throw new Error(NEEDS_SESSION)
  }
  log('connecté')
}

export default {
  label: 'Wix',
  fields: { username: 'Courriel du compte Wix', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  // Liste des factures SANS les télécharger : le JSON de la console porte déjà
  // le montant et la date, ce qui permet à l'orchestrateur de ne descendre que
  // les factures réclamées par une transaction bancaire.
  async list(ctx) {
    const { page, context, log } = ctx

    await page.goto(BILLING_URL, { waitUntil: 'domcontentloaded' })
    if (SIGNIN_HOST.test(page.url()) || await page.locator('input[type="password"]').count()) {
      await signIn(ctx)
      await page.goto(BILLING_URL, { waitUntil: 'domcontentloaded' })
    } else {
      log('session déjà valide')
    }

    const listRes = await context.request.get(LIST_API, { timeout: 30_000 })
    if (!listRes.ok()) {
      await ctx.snapshot('wix-liste-echec')
      // Une session expirée fait répondre du HTML de connexion, pas un 200 JSON.
      throw new Error(`Liste des factures refusée (HTTP ${listRes.status()}) — ${NEEDS_SESSION}`)
    }
    let results
    try {
      results = (await listRes.json())?.userInvoiceResults?.results || []
    } catch {
      await ctx.snapshot('wix-liste-illisible')
      throw new Error(`Réponse inattendue de Wix — ${NEEDS_SESSION}`)
    }
    log(`${results.length} facture(s) au relevé`)

    return results.map(inv => {
      const id = String(inv.invoiceDocId)
      const url = PDF_API(id)
      return {
        externalId: id,
        date: inv.eventDate ? new Date(inv.eventDate).toISOString().slice(0, 10) : null,
        amount: typeof inv.amount === 'number' ? inv.amount : null,
        currency: inv.currencyCode || null,
        filename: `Wix-${id}.pdf`,
        url,
        fetch: async () => {
          const res = await context.request.get(url, { timeout: 45_000 })
          const buffer = res.ok() ? await res.body() : null
          // Une session périmée renvoie 200 + page HTML : le magic number tranche.
          if (!buffer || buffer.slice(0, 5).toString() !== '%PDF-') {
            throw new Error(`réponse non-PDF (HTTP ${res.status()})`)
          }
          return buffer
        },
      }
    })
  },
}
