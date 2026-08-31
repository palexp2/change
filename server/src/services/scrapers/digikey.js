// Collecteur DigiKey (compte MyDigiKey — digikey.ca).
//
// Contexte : le compte DigiKey (courriel `achat@orisha.io`) reçoit les accusés
// de bon de commande et les avis d'expédition par courriel, mais PAS les
// factures PDF — digikey.ca n'a aucun réglage self-service pour l'adresse de
// facturation (voir [[project_digikey_invoice_email_setup]], demande en cours
// auprès du service commandes). En attendant que ce courriel arrive, la facture
// existe déjà sur le portail MyDigiKey ; ce collecteur va la chercher là.
//
// Ce collecteur est posé sans avoir pu explorer le portail authentifié (pas
// d'identifiants au moment de l'écriture — 404 systématique sur les pages de
// compte sans session, DigiKey ne redirige pas vers le login comme Bell/Wix).
// Comme pour bell.js, il est donc volontairement bavard : capture tous les PDF
// et endpoints JSON de facturation croisés, et ne suppose pas l'URL exacte de
// l'historique de commandes — il la trouve en cherchant un lien plausible
// depuis la page de compte, exactement la démarche qui a servi à calibrer Wix
// et Bell sur leur première tournée réelle.

const LOGIN_URL = 'https://www.digikey.ca/MyDK/Login?site=CA&lang=en'
const ACCOUNT_URL = 'https://www.digikey.ca/en/mypage'
// Auth DigiKey : formulaire propre à digikey.ca, pas de sous-domaine dédié connu.
const LOGIN_HOST_MARKER = /\/MyDK\/Login/i

// Premier vrai passage (2026-08-29) : digikey.ca interpose une vérification
// Cloudflare (Turnstile) même avec une session déjà valide — la page de compte
// répond par l'écran « Vérification de sécurité en cours », pas par la page
// attendue. Sans ce garde-fou le collecteur fonçait dessus en cherchant des
// liens de facture sur l'écran Cloudflare et échouait avec un message qui ne
// pointait pas vers la vraie cause. Un headless ne peut pas cocher la case
// Turnstile ; seule l'import d'une session (cookies `cf_clearance` compris)
// depuis un navigateur qui a déjà passé l'épreuve peut contourner ça — même
// voie que Wix pour son captcha/connexion Google.
const CLOUDFLARE_MARKER = /Vérification de sécurité en cours|Just a moment|Checking your browser|Attention Required/i
const NEEDS_SESSION_CF =
  "DigiKey bloque la connexion automatisée par une vérification Cloudflare — se connecter à la main dans un navigateur (jusqu'à passer l'épreuve), puis « Importer une session » depuis cet ERP."

async function cloudflareBlocked(page) {
  const title = await page.title().catch(() => '')
  if (CLOUDFLARE_MARKER.test(title)) return true
  const bodyText = await page.locator('body').innerText().then(t => t.slice(0, 300)).catch(() => '')
  if (CLOUDFLARE_MARKER.test(bodyText)) return true
  return await page.locator('.cf-turnstile, #challenge-form, iframe[src*="challenges.cloudflare.com"]').count()
    .then(n => n > 0).catch(() => false)
}

const MONEY = /(?:\$\s*([\d.,\s]+))|(?:([\d.,\s]+)\s*\$)/
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
const NUM_DATE = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/

export function parseDigikeyDate(text) {
  const iso = String(text || '').match(ISO_DATE)
  if (iso) return iso[0]
  const m = String(text || '').match(NUM_DATE)
  if (m) {
    // DigiKey CA affiche parfois en jj/mm/aaaa, parfois mm/jj/aaaa selon la
    // langue du compte — sans certitude, on privilégie jj/mm (marché CA/FR).
    const [, a, b, year] = m
    const day = Number(a) > 12 ? a : b
    const month = Number(a) > 12 ? b : a
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return null
}

export function parseDigikeyAmount(text) {
  const m = String(text || '').match(MONEY)
  if (!m) return null
  const raw = (m[1] || m[2] || '').replace(/\s/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion à MyDigiKey…')
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' })

  if (await cloudflareBlocked(page)) {
    await ctx.snapshot('digikey-cloudflare-login')
    throw new Error(NEEDS_SESSION_CF)
  }

  const cookies = page.locator('#onetrust-accept-btn-handler')
  await cookies.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await cookies.count()) {
    await cookies.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
  }

  const user = page.locator('input[type="email"], input[name*="user" i], input[name*="email" i], #userId').first()
  await user.waitFor({ state: 'visible', timeout: 20_000 })
  await user.fill(credentials.username)

  let pwd = page.locator('input[type="password"]:visible').first()
  if (!(await pwd.count())) {
    await page.locator('button[type="submit"], #logonIdSubmit, button:has-text("Next"), button:has-text("Continue")').first()
      .click({ timeout: 10_000 }).catch(() => {})
    pwd = page.locator('input[type="password"]:visible').first()
  }
  await pwd.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (!(await pwd.count())) {
    await ctx.snapshot('digikey-etape-mot-de-passe')
    throw new Error("MyDigiKey n'a pas présenté de champ mot de passe — identifiant refusé ou écran inattendu, voir la capture")
  }
  await pwd.fill(credentials.password)
  await pwd.press('Enter').catch(() => {})
  await page.locator('button[type="submit"], #signOnSubmit').first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})

  const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="code" i]:visible, input[inputmode="numeric"]:visible').first()
  if (await otp.count()) {
    const code = ctx.totp() || await ctx.askOtp('Code de validation DigiKey')
    await otp.fill(code)
    await otp.press('Enter').catch(() => {})
    await page.waitForLoadState('networkidle').catch(() => {})
  }

  if (LOGIN_HOST_MARKER.test(page.url())) {
    await ctx.snapshot('digikey-login-echec')
    throw new Error('Connexion MyDigiKey refusée — voir la capture de la tournée, ou importer une session ouverte à la main')
  }
  log('connecté')
}

export default {
  label: 'DigiKey',
  fields: { username: 'Courriel du compte MyDigiKey', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  async list(ctx) {
    const { page, context, log } = ctx

    const captured = new Map()
    page.on('response', async (res) => {
      try {
        const type = (res.headers()['content-type'] || '').toLowerCase()
        const url = res.url()
        if (type.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
          if (!captured.has(url)) captured.set(url, Buffer.from(await res.body()))
          log(`📄 PDF capturé : ${url.slice(0, 120)}`)
        } else if (type.includes('json') && /order|invoice|factur|billing/i.test(url)) {
          log(`↪︎ API vue : ${url.slice(0, 160)}`)
        }
      } catch { /* corps déjà consommé ou réponse annulée */ }
    })

    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded' })
    if (await cloudflareBlocked(page)) {
      await ctx.snapshot('digikey-cloudflare')
      throw new Error(NEEDS_SESSION_CF)
    }
    if (LOGIN_HOST_MARKER.test(page.url()) || await page.locator('input[type="password"]').count()) {
      await signIn(ctx)
      await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded' })
      if (await cloudflareBlocked(page)) {
        await ctx.snapshot('digikey-cloudflare-post-login')
        throw new Error(NEEDS_SESSION_CF)
      }
    } else {
      log('session déjà valide')
    }
    await page.waitForLoadState('networkidle').catch(() => {})

    // Pas d'URL d'historique de commandes connue à l'avance (portail jamais
    // exploré authentifié) : on cherche un lien plausible depuis la page de
    // compte plutôt que de deviner un chemin figé.
    const orderHistoryHref = await page.locator(
      'a:has-text("Order History"), a:has-text("Historique"), a[href*="orderhistory" i], a[href*="order-history" i]'
    ).first().getAttribute('href').catch(() => null)

    if (orderHistoryHref) {
      const url = orderHistoryHref.startsWith('http') ? orderHistoryHref : `https://www.digikey.ca${orderHistoryHref}`
      await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
      if (await cloudflareBlocked(page)) {
        await ctx.snapshot('digikey-cloudflare-commandes')
        throw new Error(NEEDS_SESSION_CF)
      }
    } else {
      log('⚠️ aucun lien « Order History » trouvé sur la page de compte — recherche de facture sur la page courante')
    }
    await ctx.snapshot('digikey-commandes')

    const rows = await page.$$eval(
      'a:has-text("Invoice"), a:has-text("Facture"), a[href*="invoice" i], a[href$=".pdf"], a[download]',
      (els) => els.map((el) => {
        let node = el
        let row = ''
        for (let i = 0; i < 10 && node; i++) {
          const text = node.innerText || ''
          if (/\d/.test(text) && text.length > 12) { row = text; break }
          node = node.parentElement
        }
        return { href: el.getAttribute('href') || '', text: (el.innerText || '').trim(), row }
      }),
    ).catch(() => [])
    log(`${rows.length} lien(s) de facture détecté(s)`)
    if (rows.length === 0) {
      await ctx.snapshot('digikey-aucun-lien')
      throw new Error("Aucun lien de facture trouvé sur MyDigiKey — gabarit à calibrer à partir de la capture et des « API vue » du journal")
    }

    const seen = new Set()
    const out = []
    for (const r of rows) {
      const date = parseDigikeyDate(r.row) || parseDigikeyDate(r.text)
      const amount = parseDigikeyAmount(r.row)
      if (!date && amount == null) continue
      const externalId = `digikey:${date || r.href.slice(-24)}`
      if (seen.has(externalId)) continue
      seen.add(externalId)

      const url = r.href.startsWith('http') ? r.href : `https://www.digikey.ca${r.href}`
      out.push({
        externalId,
        date,
        amount,
        currency: 'CAD',
        filename: `DigiKey-${date || externalId}.pdf`,
        url,
        fetch: async () => {
          const res = await context.request.get(url, { timeout: 60_000 })
          const buffer = res.ok() ? await res.body() : null
          if (buffer && buffer.slice(0, 5).toString() === '%PDF-') return buffer
          await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {})
          const late = [...captured.values()].pop()
          if (late) return late
          throw new Error(`réponse non-PDF (HTTP ${res.status()})`)
        },
      })
    }
    return out
  },
}
