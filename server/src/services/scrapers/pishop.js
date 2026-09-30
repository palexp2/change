// Collecteur PiShop.ca (pièces Raspberry Pi — achats par carte sur le site).
//
// PiShop envoie une confirmation de commande par courriel, mais pas de facture
// PDF : le seul document qui porte les taxes et le total final est la facture
// imprimable du compte client. Le site tourne sur BigCommerce (thème Stencil),
// dont l'espace client suit des chemins stables et documentés :
//
//   POST /login.php?action=check_login  (login_email + login_pass)
//   GET  /account.php?action=order_status            → liste des commandes
//   GET  /account.php?action=print_invoice&order_id= → facture imprimable (HTML)
//
// BigCommerce ne produit aucun PDF : la facture est une page HTML. On l'imprime
// donc nous-mêmes avec Chromium — c'est ce que ferait l'humain, et le pipeline
// d'extraction reçoit un vrai PDF comme pour les autres portails.
//
// La liste des commandes n'est pas parsée par sélecteurs de thème (un thème
// BigCommerce se modifie librement) mais par les liens `order_id=` et le texte
// de leur bloc — même démarche que le collecteur DigiKey.

const ORIGIN = 'https://www.pishop.ca'
const LOGIN_URL = `${ORIGIN}/login.php`
const ORDERS_URL = `${ORIGIN}/account.php?action=order_status`
const INVOICE_URL = id => `${ORIGIN}/account.php?action=print_invoice&order_id=${id}`
const ORDER_URL = id => `${ORIGIN}/account.php?action=order_status&order_id=${id}`
const LOGIN_MARKER = /\/login\.php/i

const MONEY = /(?:\$\s*([\d.,\s]+))|(?:([\d.,\s]+)\s*\$)/
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/
// « 4th Sep 2026 », « Sep 4, 2026 », « 4 sept. 2026 » — BigCommerce écrit la
// date selon la langue de la boutique, qui peut changer sans prévenir.
const TEXT_DATE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zéû]{3,9})\.?\s+(\d{4})\b/i
const TEXT_DATE_MDY = /\b([a-zéû]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
const NUM_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/

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

export function parsePishopDate(text) {
  const s = String(text || '')
  const direct = s.match(ISO_DATE)
  if (direct) return direct[0]
  const dmy = s.match(TEXT_DATE)
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

export function parsePishopAmount(text) {
  // Un bloc de commande porte plusieurs montants (sous-total, port, total) :
  // on prend le plus grand, qui est le total facturé.
  const matches = String(text || '').match(/\$\s*[\d.,\s]+/g) || []
  let best = null
  for (const raw of matches) {
    const m = raw.match(MONEY)
    if (!m) continue
    const cleaned = (m[1] || m[2] || '').replace(/\s/g, '').replace(/,(\d{2})\b/, '.$1').replace(/,/g, '')
    const n = parseFloat(cleaned)
    if (Number.isFinite(n) && (best === null || n > best)) best = n
  }
  return best
}

async function signIn(ctx) {
  const { page, log, credentials } = ctx
  log('connexion à PiShop.ca…')
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' })

  const email = page.locator('input[name="login_email"], #login_email, input[type="email"]').first()
  await email.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (!(await email.count())) {
    await ctx.snapshot('pishop-login-introuvable')
    throw new Error("Le formulaire de connexion de PiShop.ca n'a pas été trouvé — voir la capture de la tournée")
  }
  await email.fill(credentials.username)

  const pwd = page.locator('input[name="login_pass"], #login_pass, input[type="password"]').first()
  await pwd.waitFor({ state: 'visible', timeout: 20_000 })
  await pwd.fill(credentials.password)
  await pwd.press('Enter').catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})

  if (LOGIN_MARKER.test(page.url())) {
    const alert = await page.locator('.alertBox-message, .form-inlineMessage, [role="alert"]').first()
      .innerText().then(t => t.trim().slice(0, 160)).catch(() => '')
    await ctx.snapshot('pishop-login-echec')
    throw new Error(alert
      ? `Connexion PiShop.ca refusée — ${alert}`
      : 'Connexion PiShop.ca refusée — identifiants à vérifier, ou importer une session ouverte à la main')
  }
  log('connecté')
}

export default {
  label: 'PiShop.ca',
  fields: { username: 'Courriel du compte PiShop.ca', password: 'Mot de passe' },

  async list(ctx) {
    const { page, log } = ctx

    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' })
    if (LOGIN_MARKER.test(page.url()) || await page.locator('input[name="login_pass"]').count()) {
      await signIn(ctx)
      await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' })
    } else {
      log('session déjà valide')
    }
    await page.waitForLoadState('networkidle').catch(() => {})

    if (LOGIN_MARKER.test(page.url())) {
      await ctx.snapshot('pishop-commandes-refusees')
      throw new Error("L'historique des commandes PiShop.ca reste inaccessible après connexion — voir la capture")
    }

    // Une commande = un lien `order_id=` ; sa date et son total se lisent dans
    // le bloc qui l'entoure, quel que soit le gabarit du thème.
    const rows = await page.$$eval('a[href*="order_id="]', els => els.map((el) => {
      let node = el
      let block = ''
      for (let i = 0; i < 8 && node; i++) {
        const text = node.innerText || ''
        if (text.includes('$') && text.length > 20) { block = text; break }
        block = text || block
        node = node.parentElement
      }
      return { href: el.getAttribute('href') || '', text: (el.innerText || '').trim(), block }
    })).catch(() => [])

    const byOrder = new Map()
    for (const r of rows) {
      const id = (r.href.match(/order_id=(\d+)/) || [])[1]
      if (!id) continue
      const prior = byOrder.get(id)
      // Plusieurs liens pointent la même commande (numéro, « Voir », facture) :
      // on garde celui dont le bloc porte le plus d'information.
      if (!prior || (r.block || '').length > (prior.block || '').length) byOrder.set(id, r)
    }
    log(`${byOrder.size} commande(s) au compte`)

    if (byOrder.size === 0) {
      await ctx.snapshot('pishop-aucune-commande')
      throw new Error("Aucune commande trouvée sur le compte PiShop.ca — gabarit à recalibrer à partir de la capture")
    }

    return [...byOrder.entries()].map(([id, r]) => {
      const date = parsePishopDate(r.block) || parsePishopDate(r.text)
      const amount = parsePishopAmount(r.block)
      return {
        externalId: `pishop:${id}`,
        date,
        amount,
        currency: 'CAD',
        filename: `PiShop-${id}.pdf`,
        url: INVOICE_URL(id),
        // BigCommerce ne sert que du HTML : on imprime la facture nous-mêmes.
        fetch: async () => {
          const tab = await ctx.context.newPage()
          try {
            await tab.goto(INVOICE_URL(id), { waitUntil: 'networkidle' })
            const body = await tab.locator('body').innerText().catch(() => '')
            const failed = LOGIN_MARKER.test(tab.url()) || body.trim().length < 40
            if (failed) {
              // Facture imprimable indisponible (commande annulée, thème sans
              // cette page) : la page de la commande porte les mêmes montants.
              await tab.goto(ORDER_URL(id), { waitUntil: 'networkidle' })
              if (LOGIN_MARKER.test(tab.url())) throw new Error('session expirée à l’ouverture de la facture')
            }
            await tab.emulateMedia({ media: 'print' }).catch(() => {})
            return await tab.pdf({
              format: 'Letter',
              printBackground: true,
              margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
            })
          } finally {
            await tab.close().catch(() => { /* onglet déjà fermé */ })
          }
        },
      }
    })
  },
}
