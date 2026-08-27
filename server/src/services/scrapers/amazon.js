// Collecteur Amazon (amazon.ca — compte Business d'Orisha).
//
// Pourquoi du scraping alors qu'une API existe : l'API Amazon Business est
// derrière un onboarding « Solution Provider Portal » (vérification d'identité
// par appel vidéo) qui n'a pas abouti — cf. connectors/amazon.js, resté
// scaffoldé. En attendant, la facture ne vit que derrière le login.
//
// Le chemin est celui qu'emprunte la page « Vos commandes » du compte Business :
//   1. /ab/your-orders porte, par commande, un déclencheur de popover
//      `data-a-popover='{"url":"/your-orders/invoice/popover?orderId=…"}'` ;
//   2. ce popover renvoie un fragment HTML listant les documents de la
//      commande — « Invoice » et parfois « Credit note » — chacun pointant sur
//      /documents/download/<uuid>/invoice.pdf ;
//   3. ce dernier est le PDF officiel d'Amazon, celui qu'il nous faut.
//
// Ce qui a été essayé et abandonné : imprimer /gp/css/summary/print.html en PDF.
// Cette URL répond « We're unable to load your order details » sur ce compte, et
// même quand elle marche elle produit un récapitulatif de commande, pas la
// facture. Ne pas y revenir. Ne pas non plus récolter les numéros de commande
// par expression régulière sur le HTML : le gabarit contient un numéro factice
// (000-0000000-8675309) qui se retrouvait importé.
// Compte Business : la liste des commandes est sous /ab/, pas /your-orders.
const ORDERS_PATH = '/ab/your-orders'
const MAX_PAGES = 6

const BASE = 'https://www.amazon.ca'

// Les boutons Amazon sont des `<input type="submit">` masqués derrière un
// `<span class="a-button">` : Playwright les voit « not visible » et son clic
// expire. On soumet donc au clavier depuis le champ courant — ce que fait un
// humain — avec repli sur un clic forcé puis sur le span cliquable.
async function submitForm(page, field, selector) {
  if (field) {
    try { await field.press('Enter'); await page.waitForLoadState('domcontentloaded'); return } catch { /* formulaire sans submit implicite */ }
  }
  const target = page.locator(selector).first()
  if (await target.count()) {
    try { await target.click({ force: true, timeout: 5000 }) }
    catch { await target.evaluate(el => el.click()).catch(() => {}) }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {})
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion…')
  await page.goto(`${BASE}/ap/signin?openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(BASE + ORDERS_PATH)}&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2Fidentifier_select&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2Fidentifier_select&openid.assoc_handle=caflex&openid.pape.max_auth_age=0`, { waitUntil: 'domcontentloaded' })

  // Étape courriel (parfois fusionnée avec le mot de passe sur un seul écran).
  const email = page.locator('input[type="email"], #ap_email, input[name="email"]').first()
  if (await email.count()) {
    await email.fill(ctx.credentials.username)
    await submitForm(page, email, '#continue, input#continue, [type="submit"]')
  }

  const pwd = page.locator('#ap_password, input[type="password"]').first()
  await pwd.waitFor({ state: 'visible', timeout: 20_000 })
  await pwd.fill(credentials.password)
  const remember = page.locator('input[name="rememberMe"]').first()
  if (await remember.count()) await remember.check().catch(() => {})
  await submitForm(page, pwd, '#signInSubmit, [type="submit"]')

  await handleChallenges(ctx)

  if (/\/ap\/signin/.test(page.url())) {
    await ctx.snapshot('amazon-login-echec')
    throw new Error('Connexion Amazon refusée (mot de passe, captcha ou blocage) — voir la capture de la tournée')
  }
  log('connecté')
}

// Captcha, OTP, « approuver la connexion sur votre appareil » : Amazon en
// enchaîne parfois plusieurs. On boucle tant qu'un défi connu est à l'écran.
async function handleChallenges(ctx) {
  const { page, log } = ctx
  for (let i = 0; i < 4; i++) {
    const captcha = page.locator('#auth-captcha-image, form[action*="captcha"] img').first()
    if (await captcha.count()) {
      await ctx.snapshot(`amazon-captcha-${i}`)
      throw new Error('Amazon demande un captcha — se reconnecter une fois à la main depuis le compte, ou activer la 2FA par application (TOTP)')
    }

    const otpField = page.locator('#auth-mfa-otpcode, input[name="otpCode"], input[name="code"]').first()
    if (await otpField.count()) {
      const code = ctx.totp() || await ctx.askOtp('Code Amazon (application, SMS ou courriel)')
      log('saisie du code de vérification')
      await otpField.fill(code)
      const trust = page.locator('#auth-mfa-remember-device').first()
      if (await trust.count()) await trust.check().catch(() => {})
      await submitForm(page, otpField, '#auth-signin-button, [type="submit"]')
      continue
    }
    break
  }
}

async function ensureSignedIn(ctx) {
  const { page, log } = ctx
  await page.goto(`${BASE}${ORDERS_PATH}`, { waitUntil: 'domcontentloaded' })
  if (/\/ap\/signin/.test(page.url()) || await page.locator('#ap_password').count()) {
    await signIn(ctx)
    await page.goto(`${BASE}${ORDERS_PATH}`, { waitUntil: 'domcontentloaded' })
  } else {
    log('session déjà valide')
  }
  await handleChallenges(ctx)
}

// « Order placed August 20, 2026 » / « Commande effectuée le 20 août 2026 ».
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
}
const deaccent = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function parseCardDate(cardText) {
  const t = deaccent(cardText)
  let m = t.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m && MONTHS[m[1]]) return `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`
  m = t.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/)
  if (m && MONTHS[m[2]]) return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return null
}

// Total de la commande — la clé de la collecte ciblée : il dit AVANT tout
// téléchargement si la commande correspond à une ligne bancaire. Le libellé
// « Total » précède le montant ; les prix d'articles (« CA$19.99 ») figurent
// plus bas dans la carte et ne doivent pas être confondus avec lui.
export function parseCardTotal(cardText) {
  const m = deaccent(cardText).match(/\btotal\b[^\d$]{0,20}(?:ca)?\$?\s*([\d,. ]+)/)
  if (!m) return null
  const n = parseFloat(m[1].replace(/\s/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// Cartes de commande de /ab/your-orders : numéro, date, total et URL du popover
// qui liste les documents. On remonte du déclencheur de popover jusqu'à
// l'ancêtre portant le numéro de commande — chercher le motif plutôt que
// compter les niveaux, Amazon en insère régulièrement.
async function collectOrderCards(ctx) {
  const { page, log, lookbackDays } = ctx
  const filters = lookbackDays <= 100
    ? ['months-3']
    : ['months-3', `year-${new Date().getUTCFullYear()}`, `year-${new Date().getUTCFullYear() - 1}`]

  const out = []
  const seen = new Set()
  for (const timeFilter of filters) {
    for (let p = 0; p < MAX_PAGES; p++) {
      const url = `${BASE}${ORDERS_PATH}?timeFilter=${timeFilter}&startIndex=${p * 10}`
      // `networkidle` est indispensable : les cartes (bouton « Invoice », date,
      // total) sont injectées par le JS bien après domcontentloaded. Sans cette
      // attente la page semble vide et la tournée conclut à tort qu'il n'y a
      // rien à collecter.
      await page.goto(url, { waitUntil: 'networkidle' })
      if (/\/ap\/signin/.test(page.url())) { await signIn(ctx); await page.goto(url, { waitUntil: 'networkidle' }) }
      await page.locator('[data-a-popover]').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})

      const raw = await page.$$eval('[data-a-popover]', (els) => els.map((el) => {
        const cfg = el.getAttribute('data-a-popover') || ''
        if (!cfg.includes('invoice/popover')) return null
        let node = el
        let card = ''
        for (let i = 0; i < 14 && node; i++) {
          const text = node.innerText || ''
          if (/\d{3}-\d{7}-\d{7}/.test(text) && /total/i.test(text)) { card = text; break }
          node = node.parentElement
        }
        return { cfg, card }
      }).filter(Boolean))

      let fresh = 0
      for (const { cfg, card } of raw) {
        let parsed
        try { parsed = JSON.parse(cfg) } catch { continue }
        if (!parsed.url) continue
        const orderId = (parsed.url.match(/orderId=([\d-]+)/) || [])[1]
        if (!orderId || seen.has(orderId)) continue
        seen.add(orderId)
        out.push({ orderId, popoverUrl: parsed.url, date: parseCardDate(card), total: parseCardTotal(card) })
        fresh++
      }
      log(`${timeFilter} p${p + 1} : ${raw.length} commande(s), ${fresh} nouvelle(s)`)
      if (fresh === 0) break
    }
  }
  return out
}

// Documents facturables listés par le popover d'une commande. « Printable Order
// Summary » et « Request Invoice » sont écartés — ce ne sont pas des factures.
export function parseInvoiceLinks(html) {
  const docs = []
  for (const m of String(html || '').matchAll(/href="([^"]*\/documents\/download\/[^"]+)"[^>]*>([^<]*)</g)) {
    const href = m[1].replace(/&amp;/g, '&')
    const label = m[2].replace(/\s+/g, ' ').trim() || 'Invoice'
    // ⚠️ NE PAS dériver l'identifiant de l'uuid de l'URL : Amazon le régénère à
    // CHAQUE appel du popover. Il avait fait exploser scraper_documents (12
    // lignes pour une seule commande en 2 tournées) et rendait la déduplication
    // inopérante — chaque tournée re-téléchargeait tout. Le TYPE de document,
    // lui, est stable.
    docs.push({ kind: /credit/i.test(label) ? 'note-de-credit' : 'facture', href, label })
  }
  // Deux documents du même type sur une commande : on les numérote pour garder
  // des identifiants distincts et stables d'une tournée à l'autre.
  const counts = {}
  for (const d of docs) {
    counts[d.kind] = (counts[d.kind] || 0) + 1
    d.slot = counts[d.kind] > 1 ? `${d.kind}-${counts[d.kind]}` : d.kind
  }
  return docs
}

async function downloadDoc(context, href) {
  const url = href.startsWith('http') ? href : `${BASE}${href}`
  const res = await context.request.get(url, { timeout: 60_000 })
  const buffer = res.ok() ? await res.body() : null
  // Une session périmée renvoie une page HTML avec un 200 : le magic number est
  // le seul contrôle qui ne ment pas.
  if (!buffer || buffer.slice(0, 5).toString() !== '%PDF-') {
    throw new Error(`réponse non-PDF (HTTP ${res.status()})`)
  }
  return buffer
}

export default {
  label: 'Amazon',
  fields: { username: 'Courriel du compte Amazon', password: 'Mot de passe', totp: 'Secret 2FA (optionnel)' },

  async list(ctx) {
    const { context, log } = ctx
    await ensureSignedIn(ctx)

    const orders = await collectOrderCards(ctx)
    log(`${orders.length} commande(s) dans la fenêtre`)
    if (orders.length === 0) {
      await ctx.snapshot('amazon-aucun-popover')
      throw new Error("Aucun bouton « Invoice » sur la page des commandes — session expirée ou gabarit changé, voir la capture")
    }

    const out = []
    for (const o of orders) {
      let docs = []
      try {
        const res = await context.request.get(`${BASE}${o.popoverUrl}`, { timeout: 30_000 })
        docs = parseInvoiceLinks(await res.text())
      } catch (e) {
        log(`⚠️ ${o.orderId} : popover illisible (${e.message.split('\n')[0]})`)
        continue
      }
      if (docs.length === 0) {
        // Vendeur tiers sans facture émise : Amazon n'offre qu'un récapitulatif
        // et un formulaire « Request Invoice ».
        log(`⏭️ ${o.orderId} : aucune facture PDF publiée par le vendeur`)
        continue
      }
      for (const doc of docs) {
        out.push({
          externalId: `${o.orderId}:${doc.slot}`,
          date: o.date,
          // Le total de la carte est celui de la FACTURE ; une note de crédit
          // porte un autre montant, qu'on ne connaît pas ici — laissé nul, elle
          // ne sera donc jamais appariée à un débit (ce qui est correct).
          amount: doc.kind === 'facture' ? o.total : null,
          currency: 'CAD',
          filename: `Amazon-${o.orderId}${doc.kind === 'facture' ? '' : `-${doc.slot}`}.pdf`,
          url: doc.href.startsWith('http') ? doc.href : `${BASE}${doc.href}`,
          fetch: () => downloadDoc(context, doc.href),
        })
      }
    }
    return out
  },
}
