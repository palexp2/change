// Vérifie que l'en-tête de la modale "Détails de l'abonnement" affiche le
// montant facturé par cycle (pas le mensuel) avec le suffixe d'intervalle
// correct.
//
// Régression : pour un sub annuel à 5 $/mois, la modale montrait
// "5,00 $ CA / an" — montant mensuel mélangé avec suffixe annuel. Le client
// paie en réalité 60 $/an, donc il faut soit afficher 5/mois soit 60/an,
// jamais un mélange.
//
// Stratégie : on insère deux subs synthétiques en DB (un yearly, un monthly)
// rattachés à une entreprise existante, on ouvre la modale via la page
// Abonnements, on lit le texte de l'en-tête, on cleanup en after().
//
// On utilise un company_id existant pour garder l'affichage propre et
// passer le filtre `company_id IS NOT NULL` éventuel.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = '/home/ec2-user/erp/server/data/erp.db'

describe('AbonnementDetailModal — montant et suffixe d\'intervalle', () => {
  let browser, ctx, page, db
  const yearlyId = `__test_sub_yearly_${Date.now()}`
  const monthlyId = `__test_sub_monthly_${Date.now()}`
  let companyId = null
  let companyName = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Pick an existing company — n'importe laquelle fait l'affaire, on
    // l'utilise juste comme rattachement pour éviter les surprises côté
    // route /abonnements (filtres, JOIN, etc.).
    const co = db.prepare(`
      SELECT id, name FROM companies WHERE name IS NOT NULL AND name != '' LIMIT 1
    `).get()
    if (!co) throw new Error('Aucune entreprise trouvée')
    companyId = co.id
    companyName = co.name

    // Montants distincts pour pouvoir cibler la bonne ligne via le texte
    // affiché dans la colonne "Montant (CAD)" de la page Abonnements.
    // - yearly : amount_monthly=10 → affichage liste "10,00 $ CA", modale doit
    //   montrer "120,00 $ CA / an" (10 × 12).
    // - monthly : amount_monthly=7 → affichage liste "7,00 $ CA", modale doit
    //   montrer "7,00 $ CA / mois" (tel quel).
    db.prepare(`
      INSERT INTO subscriptions (
        id, company_id, status, amount_monthly, currency,
        start_date, interval_count, interval_type, created_at
      ) VALUES (?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(
      yearlyId, companyId, 'active', 10, 'CAD',
      '2025-01-01', 1, 'year'
    )

    db.prepare(`
      INSERT INTO subscriptions (
        id, company_id, status, amount_monthly, currency,
        start_date, interval_count, interval_type, created_at
      ) VALUES (?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(
      monthlyId, companyId, 'active', 7, 'CAD',
      '2025-01-02', 1, 'month'
    )

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    try { await browser?.close() } catch {}
    try {
      // Best-effort cleanup ; events n'auront pas été créés sur ces ids.
      db.prepare('DELETE FROM subscription_events WHERE subscription_id IN (?,?)').run(yearlyId, monthlyId)
      db.prepare('DELETE FROM subscriptions WHERE id IN (?,?)').run(yearlyId, monthlyId)
    } finally {
      db?.close()
    }
  })

  // Helper : ouvre la modale du sub `id` via la page Abonnements. On cible la
  // ligne par son montant unique (10,00 $ CA pour yearly, 7,00 $ CA pour
  // monthly) — distinct grâce aux amounts différents injectés ci-dessus.
  async function openModalFor(subId) {
    // Reload pour repartir d'un état propre.
    await page.goto(`${URL}/abonnements`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/\\d+\\s+lignes?/', { timeout: 10000 })

    // Recherche par nom d'entreprise pour réduire la liste : sans filtre, le
    // DataTable virtualise (>200 subs) et nos lignes ne sont pas dans le DOM.
    const search = page.locator('input[placeholder*="Recherche"]').first()
    await search.waitFor({ state: 'visible', timeout: 5000 })
    await search.fill(companyName)
    // Petit délai pour le re-render filtré
    await page.waitForTimeout(800)

    // DataTable rend chaque ligne comme un <div class="cursor-pointer..."> (pas
    // un <tr>). On filtre par fragment de montant (10,00 vs 7,00) qui est
    // unique parmi les subs de cette company puisque nos inserts utilisent
    // des amounts distincts.
    const amountFragment = subId === yearlyId ? '10,00' : '7,00'
    const row = page.locator('div.cursor-pointer').filter({ hasText: amountFragment }).first()
    await row.waitFor({ state: 'visible', timeout: 5000 })

    // Clique droite de la ligne pour éviter le <Link> company_name à gauche
    // (il intercepte le clic et navigue vers /companies/:id au lieu d'ouvrir
    // la modale via onRowClick).
    const box = await row.boundingBox()
    assert.ok(box, 'ligne doit avoir une bounding box')
    await page.mouse.click(box.x + box.width - 50, box.y + box.height / 2)

    await page.waitForSelector('text=/Détails de l.abonnement/', { timeout: 5000 })
  }

  test('sub annuel : montant × 12 avec suffixe /an', async () => {
    await openModalFor(yearlyId)

    // L'en-tête contient "120,00 $ CA" + "/an"
    // fr-CA Intl.NumberFormat CAD utilise espace insécable et "$ CA"
    // On cherche le span montant directement.
    const modal = page.locator('text=/Détails de l.abonnement/').locator('..')

    // L'en-tête a le pattern "<montant>/<intervalle>" où le montant est le
    // gros texte et "/an" est le petit slash-sufixe. On cherche un texte
    // qui contient à la fois "120,00" et "/an".
    const headerArea = page.locator('span.text-lg.font-bold').filter({ hasText: '/an' }).first()
    await headerArea.waitFor({ state: 'visible', timeout: 5000 })
    const text = await headerArea.innerText()
    assert.ok(text.includes('120,00'), `attendu "120,00" dans l'en-tête, vu: "${text}"`)
    assert.ok(text.includes('/an'), `attendu "/an" dans l'en-tête, vu: "${text}"`)
    // Sanity : ne doit PAS afficher "10,00 $ / an" (ancien bug : montant
    // mensuel collé au suffixe annuel).
    assert.ok(!/\b10,00\b/.test(text), `ne doit PAS afficher "10,00" pour un sub annuel (montant mensuel mélangé), vu: "${text}"`)

    // Ferme la modale
    await page.keyboard.press('Escape')
  })

  test('sub mensuel : montant tel quel avec suffixe /mois', async () => {
    await openModalFor(monthlyId)

    const headerArea = page.locator('span.text-lg.font-bold').filter({ hasText: '/mois' }).first()
    await headerArea.waitFor({ state: 'visible', timeout: 5000 })
    const text = await headerArea.innerText()
    assert.ok(text.includes('7,00'), `attendu "7,00" dans l'en-tête, vu: "${text}"`)
    assert.ok(text.includes('/mois'), `attendu "/mois" dans l'en-tête, vu: "${text}"`)
    assert.ok(!text.includes('84,00'), `ne doit PAS afficher 7×12 pour un sub mensuel, vu: "${text}"`)

    await page.keyboard.press('Escape')
  })
})
