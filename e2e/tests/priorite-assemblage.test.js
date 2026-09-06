const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Page « Priorité d'assemblage » — dashboard d'action tactile à 5 boîtes-étapes.
// Étapes 1 & 2 : lanceurs externes Airtable. Étape 3 : commandes « à envoyer »
// (status = 'À envoyer', même source que la page Commandes). Étape 4 : liste
// production en LECTURE SEULE (produits Fabriqué en manque, triés par statut
// d'assemblage ASC). Étape 5 : commande de pièces.
describe("Priorité d'assemblage", () => {
  let browser, ctx, page, token
  // Records créés par les tests → supprimés dans after() (même en cas d'échec).
  const createdPurchaseIds = []
  const snoozedProductNames = new Set() // pièces dont on a touché purchase_snooze_until

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Montreal',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  // Appel API authentifié depuis le contexte navigateur (token du localStorage).
  async function apiCall(method, path, body) {
    return page.evaluate(async ({ method, url, body, token }) => {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      })
      let json = null
      try { json = await res.json() } catch { /* no body */ }
      return { status: res.status, json }
    }, { method, url: `${URL}/api${path}`, body, token })
  }

  after(async () => {
    // Cleanup : supprimer les achats créés + remettre les snooze touchés à null.
    for (const id of createdPurchaseIds) {
      try { await apiCall('DELETE', `/purchases/${id}`) } catch { /* ignore */ }
    }
    if (snoozedProductNames.size && token) {
      try {
        const { json } = await apiCall('GET', '/products?limit=all')
        for (const p of (json?.data || [])) {
          if (snoozedProductNames.has(p.name_fr) && p.purchase_snooze_until) {
            await apiCall('PUT', `/products/${p.id}`, { purchase_snooze_until: null })
          }
        }
      } catch { /* ignore */ }
    }
    await browser?.close()
  })

  test('le lien du menu mène à la page', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.click('a[href$="/priorite-assemblage"]')
    await page.waitForURL(u => u.toString().includes('/priorite-assemblage'), { timeout: 10000 })
    await page.waitForSelector('[data-testid="priorite-assemblage"]', { timeout: 15000 })
    await assert.equal(await page.locator('h1:has-text("Priorité d\'assemblage")').count(), 1)
  })

  test('les 5 boîtes-étapes sont présentes', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    for (const n of [1, 2, 3, 4, 5]) {
      await page.waitForSelector(`[data-testid="step-${n}"]`, { timeout: 15000 })
    }
    assert.equal(await page.locator('h2:has-text("Signature des documents")').count(), 1)
    assert.equal(await page.locator('h2:has-text("Réception de pièces")').count(), 1)
    assert.equal(await page.locator('h2:has-text("Production")').count(), 1)
  })

  test('étape 1 & 2 : lanceurs externes Airtable (nouvel onglet, noopener)', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    const sign = page.locator('[data-testid="step-1"] a[target="_blank"]')
    await assert.equal(await sign.count(), 1)
    assert.match(await sign.getAttribute('href'), /airtable\.com/)
    assert.match(await sign.getAttribute('rel'), /noopener/)

    // Étape 2 = deux boutons externes (Achats + Retour client)
    const recep = page.locator('[data-testid="step-2"] a[target="_blank"]')
    assert.equal(await recep.count(), 2)
    assert.equal(await page.locator('[data-testid="step-2"] a:has-text("Achats")').count(), 1)
    assert.equal(await page.locator('[data-testid="step-2"] a:has-text("Retour client")').count(), 1)
  })

  test('étapes 1 & 2 côte à côte (même rangée, deux colonnes)', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-1"]', { timeout: 15000 })
    await page.waitForSelector('[data-testid="step-2"]', { timeout: 15000 })
    const b1 = await page.locator('[data-testid="step-1"]').boundingBox()
    const b2 = await page.locator('[data-testid="step-2"]').boundingBox()
    // Même rangée : tops quasi alignés (tolérance) et étape 2 à droite de étape 1.
    assert.ok(Math.abs(b1.y - b2.y) < 20, `tops alignés (${b1.y} vs ${b2.y})`)
    assert.ok(b2.x > b1.x + b1.width - 5, `étape 2 à droite de étape 1 (x1=${b1.x}, x2=${b2.x})`)
  })

  test('étape 1 : le point d’interrogation ouvre une modale d’instructions', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-1"]', { timeout: 15000 })

    const help = page.locator('[data-testid="step-1-help"]')
    await assert.equal(await help.count(), 1, 'le bouton ? est présent')
    await help.click()

    await page.waitForSelector('[data-testid="step-1-help-modal"]', { timeout: 5000 })
    const txt = await page.locator('[data-testid="step-1-help-modal"]').innerText()
    assert.match(txt, /Personne is/)
    assert.match(txt, /Signature pour/)
    assert.match(txt, /has none of/)
    assert.match(txt, /votre nom/i)

    // L'illustration est présente et se charge réellement (naturalWidth > 0).
    const img = page.locator('[data-testid="step-1-help-image"]')
    await assert.equal(await img.count(), 1)
    await page.waitForFunction(
      el => el && el.complete && el.naturalWidth > 0,
      await img.elementHandle(),
      { timeout: 10000 },
    )

    // Clic sur l'image → lightbox plein écran qui se charge réellement.
    await img.click()
    const lightbox = page.locator('[data-testid="image-lightbox"]')
    await lightbox.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(
      el => el && el.complete && el.naturalWidth > 0,
      await page.locator('[data-testid="image-lightbox-img"]').elementHandle(),
      { timeout: 10000 },
    )
    // Clic sur le fond → fermeture du lightbox.
    await lightbox.click({ position: { x: 5, y: 5 } })
    await lightbox.waitFor({ state: 'detached', timeout: 5000 })
  })

  test('étape 4 : liste production lecture seule, compteur = nb de lignes', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-4"]', { timeout: 15000 })
    // Attendre la fin du chargement : soit des lignes, soit l'état vide.
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-testid="step-4"]')
      if (!box) return false
      return !box.textContent.includes('Chargement')
    }, { timeout: 20000 })

    const rows = await page.locator('[data-testid="production-row"]').count()

    if (rows === 0) {
      // État vide assumé.
      assert.match(
        await page.locator('[data-testid="step-4"]').innerText(),
        /Rien à produire/,
      )
      return
    }

    // Le compteur d'en-tête doit refléter le nombre de lignes.
    const badge = await page.locator('[data-testid="step-4-count"]').innerText()
    assert.equal(parseInt(badge, 10), rows, 'compteur = nb de lignes')

    // Tri ASC sur le statut d'assemblage (%) : les % affichés sont non-décroissants.
    const pcts = await page.locator('[data-testid="production-row"] >> text=/^\\d+%$/').allInnerTexts()
    const nums = pcts.map(t => parseInt(t, 10))
    for (let i = 1; i < nums.length; i++) {
      assert.ok(nums[i] >= nums[i - 1], `statut trié ASC (${nums[i - 1]}% puis ${nums[i]}%)`)
    }
  })

  test('étape 5 : le bouton Reporter révèle Demain / Sem. prochaine', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-5"]', { timeout: 15000 })
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-testid="step-5"]')
      return box && !box.textContent.includes('Chargement')
    }, { timeout: 20000 })

    const rows = await page.locator('[data-testid="achat-row"]').count()
    if (rows === 0) return // rien à commander → affordance non testable

    await page.locator('[data-testid="achat-reporter"]').first().click()
    await page.waitForSelector('[data-testid="step-5"] button:has-text("Demain")', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="step-5"] button:has-text("Demain")').count(), 1)
    assert.equal(await page.locator('[data-testid="step-5"] button:has-text("Sem. prochaine")').count(), 1)
  })

  test('étape 5 : aucune pièce pile au seuil (stock == seuil, ex. 5/5) n’apparaît', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-5"]', { timeout: 15000 })
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-testid="step-5"]')
      return box && !box.textContent.includes('Chargement')
    }, { timeout: 20000 })

    const rows = await page.locator('[data-testid="achat-row"]').count()
    if (rows === 0) return // rien à commander → invariant trivialement vrai

    // Chaque ligne affiche « stock / seuil ». Une pièce ne doit apparaître que
    // si stock < seuil (strictement) : une pièce pile au seuil est correcte.
    const pairs = await page.locator('[data-testid="achat-row"]').evaluateAll(els =>
      els.map(el => {
        const m = el.innerText.match(/(\d+)\s*\/\s*(\d+)/)
        return m ? { stock: parseInt(m[1], 10), seuil: parseInt(m[2], 10) } : null
      }),
    )
    for (const p of pairs) {
      assert.ok(p, 'chaque ligne affiche « stock / seuil »')
      assert.ok(p.stock < p.seuil, `pièce affichée doit être sous le seuil (got ${p.stock}/${p.seuil})`)
    }

    // Cross-check API : aucune pièce Acheté avec stock_qty === min_stock ne doit
    // se retrouver dans la liste (elles doivent être filtrées).
    const { json } = await apiCall('GET', '/products?limit=all')
    const atThreshold = (json?.data || []).filter(p =>
      p.procurement_type === 'Acheté' && p.min_stock > 0 && p.stock_qty === p.min_stock)
    if (atThreshold.length) {
      const shownNames = await page.locator('[data-testid="achat-row"] .truncate').allInnerTexts()
      for (const p of atThreshold) {
        assert.ok(!shownNames.includes(p.name_fr),
          `pièce pile au seuil « ${p.name_fr} » (${p.stock_qty}/${p.min_stock}) ne doit pas apparaître`)
      }
    }
  })

  test('étape 5 : Commander crée un achat interne LIA-ERP (avec avertissement)', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-5"]', { timeout: 15000 })
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-testid="step-5"]')
      return box && !box.textContent.includes('Chargement')
    }, { timeout: 20000 })

    const rows = await page.locator('[data-testid="achat-row"]').count()
    if (rows === 0) return // rien à commander

    // Achats LIA-ERP existants avant (pour identifier le nouveau).
    const before = await apiCall('GET', '/purchases?limit=all')
    const beforeIds = new Set((before.json?.data || []).map(p => p.id))

    // Ouvrir le mini-formulaire de la 1re pièce.
    await page.locator('[data-testid="achat-commander"]').first().click()
    await page.waitForSelector('[data-testid="commander-modal"]', { timeout: 5000 })

    // Avertissement « interne ERP, PAS Airtable » présent.
    const warn = await page.locator('[data-testid="commander-warning"]').innerText()
    assert.match(warn, /interne dans l'ERP/)
    assert.match(warn, /PAS dans Airtable/)

    // Saisir une quantité et créer.
    await page.fill('[data-testid="commander-modal"] input[type="number"]', '3')
    await page.click('[data-testid="commander-submit"]')
    await page.waitForSelector('[data-testid="commander-modal"]', { state: 'detached', timeout: 10000 })

    // Vérifier qu'un achat a bien été créé, avec référence LIA-ERP-n et statut Commandé.
    const after = await apiCall('GET', '/purchases?limit=all')
    const created = (after.json?.data || []).filter(p => !beforeIds.has(p.id))
    assert.equal(created.length, 1, 'exactement un achat créé')
    const purchase = created[0]
    createdPurchaseIds.push(purchase.id) // cleanup
    assert.match(purchase.reference, /^LIA-ERP-\d+$/, `référence LIA-ERP (got ${purchase.reference})`)
    assert.equal(purchase.status, 'Commandé')
    assert.equal(purchase.qty_ordered, 3)
  })

  test('chaque boîte est repliable via la flèche (collapse/expand)', async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="priorite-assemblage"]', { timeout: 15000 })

    // Toutes les boîtes ont une flèche de repli.
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(await page.locator(`[data-testid="step-${n}-collapse"]`).count(), 1, `step-${n} a une flèche`)
    }

    // Replier l'étape 2 (lanceurs Airtable, contenu stable) masque son corps.
    const body = page.locator('[data-testid="step-2"]:has-text("Achats")')
    assert.equal(await body.count(), 1, 'corps visible au départ')
    await page.locator('[data-testid="step-2-collapse"]').click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="step-2"]').textContent.includes('Achats'),
      { timeout: 5000 },
    )
    // Déplier le ré-affiche.
    await page.locator('[data-testid="step-2-collapse"]').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="step-2"]').textContent.includes('Achats'),
      { timeout: 5000 },
    )
  })

  test("étape 3 : commandes « à envoyer » identiques à la vue de la page Commandes", async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-3"]', { timeout: 15000 })

    // Source de vérité : le pill « À envoyer » de la table orders (= la vue de la
    // page Commandes). On lit ses statuts (filtre status is_any_of [...]) et on
    // applique le même filtre à l'API orders.
    const viewsRes = await apiCall('GET', '/views/orders')
    const pill = (viewsRes.json?.pills || []).find(p => p.label === 'À envoyer')
    assert.ok(pill, 'le pill « À envoyer » doit exister sur la table orders')
    const rules = pill.filters?.rules || (Array.isArray(pill.filters) ? pill.filters : [])
    const statusRule = rules.find(r => r.field === 'status')
    assert.ok(statusRule, 'le pill « À envoyer » filtre sur status')
    const statuses = new Set(Array.isArray(statusRule.value) ? statusRule.value : [statusRule.value])

    const { json } = await apiCall('GET', '/orders?limit=all')
    const expected = (json?.data || []).filter(o => statuses.has(o.status))

    // Attendre la fin du chargement du cache (le compteur d'en-tête apparaît).
    await page.waitForSelector('[data-testid="step-3-count"]', { timeout: 20000 })

    if (expected.length === 0) {
      assert.match(
        await page.locator('[data-testid="step-3"]').innerText(),
        /Aucune commande à envoyer/,
      )
      return
    }

    // Attendre que toutes les lignes soient rendues (cache hydraté).
    await page.waitForFunction(
      n => document.querySelectorAll('[data-testid="envoi-row"]').length === n,
      expected.length,
      { timeout: 20000 },
    )

    const badge = await page.locator('[data-testid="step-3-count"]').innerText()
    assert.equal(parseInt(badge, 10), expected.length, 'compteur = nb de commandes à envoyer')

    const rows = await page.locator('[data-testid="envoi-row"]').count()
    assert.equal(rows, expected.length, 'nb de lignes = nb de commandes à envoyer (API)')

    // Chaque ligne pointe vers la fiche commande en mode expédition.
    const hrefs = await page.locator('[data-testid="envoi-row"]').evaluateAll(
      els => els.map(e => e.getAttribute('href')),
    )
    for (const o of expected) {
      assert.ok(
        hrefs.some(h => h && h.includes(`/orders/${o.id}`) && h.includes('mode=expedition')),
        `commande #${o.order_number} (id ${o.id}) présente dans l'étape 3 (lien mode=expedition)`,
      )
    }
  })

  test("étape 3 : commandes urgentes en premier + tag « Urgent » (#166ee1) à côté du nom", async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-3"]', { timeout: 15000 })
    await page.waitForSelector('[data-testid="step-3-count"]', { timeout: 20000 })

    const rows = await page.locator('[data-testid="envoi-row"]').count()
    if (rows === 0) return // aucune commande à envoyer

    // Y a-t-il au moins une commande urgente ? (sinon rien à vérifier sur le tri/tag)
    const urgentCount = await page.locator('[data-testid="envoi-urgent-tag"]').count()
    if (urgentCount === 0) return

    // 1) Toutes les lignes urgentes précèdent les non-urgentes.
    const flags = await page.locator('[data-testid="envoi-row"]').evaluateAll(
      els => els.map(e => !!e.querySelector('[data-testid="envoi-urgent-tag"]')),
    )
    const firstNonUrgent = flags.indexOf(false)
    if (firstNonUrgent !== -1) {
      assert.ok(
        flags.slice(firstNonUrgent).every(f => f === false),
        'aucune commande urgente ne doit apparaître après une non-urgente',
      )
    }

    // 2) Le tag est un tile arrondi de couleur #166ee1 (= rgb(22,110,225)).
    const tag = page.locator('[data-testid="envoi-urgent-tag"]').first()
    assert.match((await tag.innerText()).trim(), /Urgent/i)
    const { bg, radius } = await tag.evaluate(el => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, radius: s.borderTopLeftRadius }
    })
    assert.equal(bg.replace(/\s/g, ''), 'rgb(22,110,225)', `couleur du tag = #166ee1 (got ${bg})`)
    assert.ok(parseFloat(radius) >= 8, `tag arrondi (border-radius ${radius})`)
  })

  test("étape 3 : cliquer une commande ouvre la fiche directement en mode expédition", async () => {
    await page.goto(URL + '/priorite-assemblage', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="step-3"]', { timeout: 15000 })
    await page.waitForSelector('[data-testid="step-3-count"]', { timeout: 20000 })

    const rows = await page.locator('[data-testid="envoi-row"]').count()
    if (rows === 0) return // aucune commande à envoyer → rien à cliquer

    await page.locator('[data-testid="envoi-row"]').first().click()
    await page.waitForURL(u => /\/orders\/[^/]+\?.*mode=expedition/.test(u.toString()), { timeout: 10000 })
    // La fiche s'ouvre bien en mode expédition (et pas en vue commerciale).
    await page.waitForSelector('[data-testid="expedition-view"]', { timeout: 15000 })
    assert.equal(await page.locator('button:has-text("Vue commerciale")').count(), 1,
      'le bouton de bascule « Vue commerciale » confirme le mode expédition')
  })
})
