// Collecteur Newark (canada.newark.com — groupe element14 / Premier Farnell).
//
// Les achats Newark sont payés par carte et le portail garde la facture de
// chaque commande ; rien n'arrive par courriel côté facture. Le compte vit sur
// la plateforme commune à newark.com / farnell.com / element14.com :
//
//   GET  /auth/login            → formulaire (champs `logonId` + `password`)
//   GET  /account/order-history → historique, redirigé vers /auth/login sans session
//   GET  /account/dashboard     → page de compte
//
// Vérifié sans session (2026-09-29) : les pages `/account/*` répondent 302 vers
// `/auth/login`, ce qui donne un marqueur de session franc — contrairement à
// DigiKey qui répond 404. Le reste du portail (URL exacte d'une commande, lien
// de facture, format du PDF) n'a pas pu être exploré faute d'identifiants : le
// collecteur ne devine donc aucun chemin de facture, il cherche les liens
// plausibles depuis l'historique et, à défaut de PDF servi par le portail,
// imprime lui-même la page de la commande — même démarche que pishop.js.
//
// Le site est derrière Akamai et la page de connexion embarque un reCAPTCHA
// conditionnel : s'il se déclenche, la tournée s'arrête avec le geste à faire
// (envoyer une session depuis le module de navigateur) plutôt que d'insister.

import { pdfNet, parsePortalDate, printPagePdf } from './portalPage.js'

const ORIGIN = 'https://canada.newark.com'
const LOGIN_URL = `${ORIGIN}/auth/login`
const ORDERS_URL = `${ORIGIN}/account/order-history`
// Page de compte : repli si l'historique se dérobe.
const ACCOUNT_URL = `${ORIGIN}/account/dashboard`
const LOGIN_MARKER = /\/auth\/(login|register)/i

const NEEDS_SESSION =
  "Newark demande une vérification « je ne suis pas un robot » — se connecter à la main dans un navigateur, puis envoyer la session à l'ERP depuis le module de navigateur."

const CAPTCHA_SELECTOR = 'iframe[src*="recaptcha"], .g-recaptcha, iframe[title*="challenge" i]'

export const parseNewarkDate = parsePortalDate

export function parseNewarkAmount(text) {
  // Un bloc de commande porte sous-total, port, taxes et total : le total est
  // le plus grand. Le `(?<![\d\-/.,])` évite d'avaler la fin d'une date, piège
  // déjà payé sur Simplex (« 2026-07-31 128,74 $ »).
  const matches = String(text || '').match(/(?<![\d\-/.,])(?:(?:CAD|USD|C?\$)\s*)?\d[\d.,\s]*\s*(?:\$|CAD|USD)?/g) || []
  let best = null
  for (const raw of matches) {
    if (!/[$]|CAD|USD/i.test(raw)) continue
    const cleaned = raw.replace(/[^\d.,]/g, '').replace(/\s/g, '')
      .replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
    const n = parseFloat(cleaned)
    if (Number.isFinite(n) && (best === null || n > best)) best = n
  }
  return best
}

async function captchaPresent(page) {
  return await page.locator(CAPTCHA_SELECTOR).first().isVisible({ timeout: 1500 }).catch(() => false)
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion à Newark…')
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

  const cookies = page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first()
  await cookies.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await cookies.count()) {
    await cookies.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
  }

  const user = page.locator('input[name="logonId"], #authentication\\.login\\.form__logon-id-input, input[type="email"]:visible').first()
  await user.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (!(await user.count())) {
    await ctx.snapshot('newark-login-introuvable')
    throw new Error("Le formulaire de connexion de Newark n'a pas été trouvé — voir la capture de la tournée")
  }
  await user.fill(credentials.username)

  const pwd = page.locator('input[name="password"]:visible, input[type="password"]:visible').first()
  await pwd.waitFor({ state: 'visible', timeout: 20_000 })
  await pwd.fill(credentials.password)

  if (await captchaPresent(page)) {
    await ctx.snapshot('newark-captcha')
    throw new Error(NEEDS_SESSION)
  }

  await pwd.press('Enter').catch(() => {})
  await page.locator('button[type="submit"]:visible').first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})

  // Code de vérification par courriel : un secret TOTP s'il est configuré,
  // sinon on le demande dans l'ERP.
  const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[inputmode="numeric"]:visible').first()
  if (await otp.count()) {
    const code = ctx.totp() || await ctx.askOtp('Code de vérification Newark')
    await otp.fill(code)
    await otp.press('Enter').catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  if (LOGIN_MARKER.test(page.url())) {
    if (await captchaPresent(page)) {
      await ctx.snapshot('newark-captcha-apres-envoi')
      throw new Error(NEEDS_SESSION)
    }
    const alert = await page.locator('[role="alert"], .bx--form-requirement, .error, .alert').first()
      .innerText().then(t => t.trim().slice(0, 160)).catch(() => '')
    await ctx.snapshot('newark-login-echec')
    throw new Error(alert
      ? `Connexion Newark refusée — ${alert}`
      : 'Connexion Newark refusée — identifiants à vérifier, ou envoyer une session ouverte à la main')
  }
  log('connecté')
}

export default {
  label: 'Newark',
  fields: {
    username: 'Courriel ou identifiant du compte canada.newark.com',
    password: 'Mot de passe',
    totp: 'Secret 2FA (optionnel)',
  },

  async list(ctx) {
    const { page, context, log } = ctx

    // Portail jamais exploré authentifié : on journalise les PDF et les appels
    // de facturation croisés, c'est ce qui permettra de câbler un appel direct
    // au premier vrai passage plutôt que de deviner.
    pdfNet(page, log, /order|invoice|factur|billing/i)

    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' })
    if (LOGIN_MARKER.test(page.url()) || await page.locator('input[name="password"]').count()) {
      await signIn(ctx)
      await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' })
    } else {
      log('session déjà valide')
    }
    await page.waitForLoadState('networkidle').catch(() => {})

    if (LOGIN_MARKER.test(page.url())) {
      await ctx.snapshot('newark-commandes-refusees')
      throw new Error("L'historique des commandes Newark reste inaccessible après connexion — voir la capture")
    }
    // L'historique se remplit côté client : attendre qu'une commande paraisse.
    await page.locator('a[href*="order" i]').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})

    // Historique vide à cette adresse (chemin déplacé, compte multi-sociétés) :
    // on repart de la page de compte et on suit le lien qui y mène.
    if (!(await page.locator('a[href*="order" i]').count())) {
      log('⚠️ aucune commande à l’adresse attendue — recherche depuis la page de compte')
      await page.goto(ACCOUNT_URL, { waitUntil: 'networkidle' }).catch(() => {})
      const entry = page.locator('a:has-text("Order History"), a:has-text("Historique"), a[href*="order-history" i]').first()
      if (await entry.count()) {
        await entry.click({ timeout: 10_000 }).catch(() => {})
        await page.waitForLoadState('networkidle').catch(() => {})
      }
    }
    await ctx.snapshot('newark-commandes')

    // Une commande = un lien qui porte son numéro ; sa date et son total se
    // lisent dans le bloc qui l'entoure, quel que soit le gabarit.
    const rows = await page.$$eval(
      'a[href*="order-details" i], a[href*="orderId" i], a[href*="order-history/" i], a[href*="invoice" i], a[href$=".pdf"]',
      els => els.map((el) => {
        let node = el
        let block = ''
        for (let i = 0; i < 10 && node; i++) {
          const text = node.innerText || ''
          if (/\d/.test(text) && text.length > 20) { block = text; break }
          block = text || block
          node = node.parentElement
        }
        return { href: el.getAttribute('href') || '', text: (el.innerText || '').trim(), block }
      }),
    ).catch(() => [])

    const byOrder = new Map()
    for (const r of rows) {
      const id = (r.href.match(/(?:orderId=|order-details[/=]|order-history\/)([A-Za-z0-9_-]+)/i) || [])[1]
        || (r.text.match(/\b\d{6,}\b/) || [])[0]
      if (!id) continue
      const prior = byOrder.get(id)
      if (!prior || (r.block || '').length > (prior.block || '').length) byOrder.set(id, r)
    }
    log(`${byOrder.size} commande(s) au compte`)

    if (byOrder.size === 0) {
      await ctx.snapshot('newark-aucune-commande')
      throw new Error("Aucune commande trouvée sur le compte Newark — gabarit à calibrer à partir de la capture et des « API vue » du journal")
    }

    const absolute = href => (href.startsWith('http') ? href : `${ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`)

    return [...byOrder.entries()].map(([id, r]) => {
      const date = parseNewarkDate(r.block) || parseNewarkDate(r.text)
      const amount = parseNewarkAmount(r.block)
      const url = absolute(r.href)
      return {
        externalId: `newark:${id}`,
        date,
        amount,
        currency: 'CAD',
        filename: `Newark-${id}.pdf`,
        url,
        fetch: async () => {
          // 1) le lien sert peut-être déjà le PDF.
          const res = await context.request.get(url, { timeout: 60_000 }).catch(() => null)
          const buffer = res?.ok() ? await res.body() : null
          if (buffer && buffer.slice(0, 5).toString() === '%PDF-') return buffer

          // 2) sinon la page de la commande : on y cherche un lien de facture,
          //    et à défaut on imprime la page elle-même, qui porte les totaux.
          const tab = await context.newPage()
          try {
            const pdfs = []
            tab.on('response', async (r2) => {
              try {
                const type = (r2.headers()['content-type'] || '').toLowerCase()
                if (type.includes('pdf') || /\.pdf(\?|$)/i.test(r2.url())) pdfs.push(Buffer.from(await r2.body()))
              } catch { /* corps déjà consommé */ }
            })
            await tab.goto(url, { waitUntil: 'networkidle' })
            if (LOGIN_MARKER.test(tab.url())) throw new Error('session expirée à l’ouverture de la commande')

            const invoice = tab.locator('a:has-text("Invoice"), a:has-text("Facture"), a[href*="invoice" i], a[download]').first()
            if (await invoice.count()) {
              const href = await invoice.getAttribute('href').catch(() => null)
              if (href) {
                const inv = await context.request.get(absolute(href), { timeout: 60_000 }).catch(() => null)
                const body = inv?.ok() ? await inv.body() : null
                if (body && body.slice(0, 5).toString() === '%PDF-') return body
              }
              await invoice.click({ timeout: 10_000 }).catch(() => {})
              await tab.waitForTimeout(3000)
              if (pdfs.length) return pdfs[pdfs.length - 1]
            }

            return await printPagePdf(tab)
          } finally {
            await tab.close().catch(() => { /* onglet déjà fermé */ })
          }
        },
      }
    })
  },
}
