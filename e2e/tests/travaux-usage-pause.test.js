// Page Travaux : bandeau de consommation Claude, pause / reprise de la file, et
// le drapeau « arrêter après celle-ci » sur un item.
//
// Aucun vrai record touché : le seul prompt utilisé est créé par le test « de côté »
// (status paused) — il ne peut donc JAMAIS déclencher une exécution réelle — puis
// supprimé. L'état de pause de la file est capturé avant et restauré après, même en
// cas d'échec : le laisser en pause gèlerait la vraie file de travaux.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Travaux — utilisation Claude, pause de la file, arrêt après une tâche', () => {
  let browser, ctx, page
  let promptId = null
  let initialPaused = null

  before(async () => {
    browser = await chromium.launch()
    // Fuseau du vrai utilisateur : le bandeau rend les heures de réinitialisation dans
    // le fuseau du navigateur (convention de l'app). Le serveur, lui, tourne en UTC —
    // sans ce réglage, le test validerait un affichage que personne ne voit.
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/Montreal' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // État de pause d'origine : à restaurer coûte que coûte (hook after).
    initialPaused = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/queue/pause', { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).paused
    })
  })

  // Restauration vérifiée, pas seulement tentée : une pause laissée en place gèlerait
  // la vraie file de travaux sans que personne ne le sache. On relit et on réessaie
  // jusqu'à ce que le serveur confirme l'état d'origine.
  after(async () => {
    if (page) {
      const restored = await page.evaluate(async ({ promptId, initialPaused }) => {
        const token = localStorage.getItem('erp_token')
        const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        if (promptId) await fetch(`/erp/api/travaux/prompts/${promptId}`, { method: 'DELETE', headers: h }).catch(() => {})
        for (let i = 0; i < 5; i++) {
          await fetch('/erp/api/travaux/queue/pause', {
            method: 'POST', headers: h, body: JSON.stringify({ paused: !!initialPaused }),
          }).catch(() => {})
          const r = await fetch('/erp/api/travaux/queue/pause', { headers: h }).catch(() => null)
          if (r && (await r.json()).paused === !!initialPaused) return true
          await new Promise(res => setTimeout(res, 500))
        }
        return false
      }, { promptId, initialPaused }).catch(() => false)
      if (!restored) console.error('⚠️  État de pause de la file NON restauré — à vérifier sur /travaux')
    }
    await browser?.close()
  })

  test("le bandeau des quotas Claude s'affiche en haut de la page", async () => {
    await page.goto(URL + '/travaux', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Travaux")', { timeout: 10000 })

    const strip = page.locator('[data-testid="claude-usage-strip"]')
    await strip.waitFor({ timeout: 10000 })
    // Attendre les VRAIES données : le bandeau existe avant la réponse de l'API et
    // afficherait « 0 jetons » partout — on validerait alors un écran vide.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="usage-strip-today"]')
      return el && !/^\s*0\s+jetons/.test(el.textContent || '')
    }, { timeout: 20000 })

    const text = await strip.innerText()
    assert.match(text, /jetons aujourd'hui/, 'les jetons consommés depuis minuit doivent être visibles')
    // Fenêtre de 5 h GLISSANTE, pas « session » : c'est la formulation exacte vérifiée
    // auprès de l'API (kind 'session', resets_at 5 h après le premier message).
    assert.match(text, /Fenêtre 5 h/, 'le plafond de la fenêtre de 5 h doit être nommé comme tel')
    assert.doesNotMatch(text, /Session 5 h/, 'ancien libellé « Session 5 h » à ne plus afficher')
    assert.match(text, /Semaine/, 'le plafond hebdomadaire doit être visible')
    // La note qui corrige la lecture fausse « j'ai un quota par jour ».
    assert.match(text, /Pas de limite par jour/, 'la note sur l\'absence de limite journalière doit être là')
    assert.match(text, /reste \d+ %|\d+ jetons/, 'ni % restant ni jetons affichés')

    // Le troisième plafond (hebdo d'un modèle) ne s'affiche que si le forfait en a un :
    // on croise avec l'API plutôt que d'exiger sa présence en dur.
    const scoped = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/agent/usage', { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).weekScoped
    })
    const scopedShown = await page.locator('[data-testid="usage-strip-scoped"]').count()
    if (scoped) {
      assert.equal(scopedShown, 1, 'le plafond hebdomadaire du modèle doit être affiché quand il existe')
      assert.match(text, new RegExp(`Semaine ${scoped.label}`), 'le nom du modèle plafonné doit être visible')
    } else {
      assert.equal(scopedShown, 0, 'aucun plafond de modèle à afficher quand l\'API n\'en donne pas')
    }

    // Heure de réinitialisation : relatif + jour et heure exacts (« dans 51 min (mar. 14:40) »).
    const sessionLine = await page.locator('[data-testid="usage-strip-session"]').innerText()
    assert.match(sessionLine, /réinit\. dans /, 'le décompte de réinitialisation doit être affiché')
    assert.match(sessionLine, /\([a-zéû]+\.? \d{2}:\d{2}\)/,
      `l'heure exacte de réinitialisation doit être affichée — reçu : ${sessionLine}`)
  })

  // La page Agent affiche les mêmes quotas en version détaillée (cartes) : elle doit
  // porter les mêmes libellés vérifiés, sinon les deux pages se contrediraient.
  test('la page Agent montre les mêmes plafonds en version détaillée', async () => {
    await page.goto(URL + '/agent', { waitUntil: 'domcontentloaded' })
    const bar = page.locator('[data-testid="claude-usage-bar"]')
    await bar.waitFor({ timeout: 15000 })
    // On attend le POURCENTAGE, pas les jetons : tant que l'API n'a pas répondu, les
    // cartes affichent déjà « 0 jetons » (état de repli), et le texte serait lu avant
    // que le plafond propre au modèle ait eu la chance d'apparaître.
    await page.waitForSelector('[data-testid="claude-usage-bar"] [data-testid="usage-pct"]', { timeout: 20000 })

    // Les libellés des cartes sont mis en majuscules par CSS — `innerText` rend le
    // texte transformé, d'où les comparaisons insensibles à la casse.
    const text = await bar.innerText()
    assert.match(text, /Fenêtre 5 h/i, 'la fenêtre glissante de 5 h doit être nommée comme telle')
    assert.match(text, /Cette semaine/i, 'le total hebdomadaire doit être visible')
    // Note retirée à la demande : la page Agent ne commente plus l'absence de quota
    // journalier ni les crédits de dépassement — seules les jauges parlent.
    assert.doesNotMatch(text, /Aucune limite journalière/i, 'la note sur le quota journalier ne doit plus être affichée')
    assert.doesNotMatch(text, /crédit de dépassement/i, 'la note sur les crédits de dépassement ne doit plus être affichée')

    const scoped = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/agent/usage', { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).weekScoped
    })
    if (scoped) assert.match(text, new RegExp(`Semaine ${scoped.label}`, 'i'), 'le plafond du modèle doit apparaître')
  })

  test('pause puis reprise de la file — le serveur suit, la file repart d\'où elle était', async () => {
    // Retour explicite sur Travaux : le test précédent est parti sur la page Agent.
    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const btn = page.locator('[data-testid="travaux-pause-queue"]')
    await btn.waitFor({ timeout: 10000 })

    // Point de départ propre : si la file était déjà en pause, on la reprend d'abord.
    if (await btn.getAttribute('data-paused') === '1') {
      await btn.click()
      await page.waitForFunction(
        () => document.querySelector('[data-testid="travaux-pause-queue"]')?.dataset.paused === '0',
        { timeout: 10000 })
    }

    await btn.click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-pause-queue"]')?.dataset.paused === '1',
      { timeout: 10000 })

    // Preuve côté serveur, pas seulement côté DOM.
    const paused = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/queue/pause', { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).paused
    })
    assert.equal(paused, true, 'la pause doit être persistée côté serveur')

    // Le bandeau d'avertissement apparaît dans l'onglet « Ma file ».
    await page.locator('[data-testid="travaux-queue-paused-banner"]').waitFor({ timeout: 10000 })
    assert.equal(await page.locator('button:has-text("Lancer la file")').isDisabled(), true,
      '« Lancer la file » doit être désactivé en pause')

    await btn.click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="travaux-pause-queue"]')?.dataset.paused === '0',
      { timeout: 10000 })
    const resumed = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/queue/pause', { headers: { Authorization: `Bearer ${token}` } })
      return (await r.json()).paused
    })
    assert.equal(resumed, false, 'la reprise doit être persistée côté serveur')
    assert.equal(await page.locator('[data-testid="travaux-queue-paused-banner"]').count(), 0,
      'le bandeau de pause doit disparaître à la reprise')
  })

  test('« arrêter après celle-ci » se coche sur un item et se persiste', async () => {
    // Item « de côté » : jamais ramassé par l'ordonnanceur, aucune exécution réelle.
    const created = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/travaux/prompts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `E2E arrêt après ${Date.now()}`,
          prompt: 'Prompt jetable E2E — ne pas exécuter.',
          status: 'paused',
        }),
      })
      return r.json()
    })
    promptId = created.id
    assert.ok(promptId, 'création du prompt jetable')

    // Le drapeau ne s'offre que sur un item qui peut encore partir : on le remet en
    // file (statut 'queued'), le temps du test — la file, elle, est en pause… non :
    // elle vient d'être reprise. On repasse donc l'item « de côté » aussitôt après.
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      // Pause de la file d'abord : garantit qu'aucune exécution ne démarre pendant
      // que l'item est brièvement « en file ».
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      await fetch('/erp/api/travaux/queue/pause', { method: 'POST', headers: h, body: JSON.stringify({ paused: true }) })
      await fetch(`/erp/api/travaux/prompts/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ status: 'queued' }) })
    }, promptId)

    await page.goto(URL + '/travaux?onglet=file', { waitUntil: 'domcontentloaded' })
    const card = page.locator(`[data-prompt-id="${promptId}"]`)
    await card.waitFor({ timeout: 15000 })

    const stop = card.locator('[data-testid="travaux-stop-after"]')
    await stop.waitFor({ timeout: 10000 })
    assert.equal(await stop.getAttribute('data-active'), '0', 'drapeau inactif au départ')
    await stop.click()

    // Autosave : l'état DOM immédiat n'est pas une preuve — on valide par API.
    const flagged = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 20; i++) {
        const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
        const d = await r.json()
        const p = d.prompts.find(x => x.id === id)
        if (p?.stop_after) return true
        await new Promise(res => setTimeout(res, 400))
      }
      return false
    }, promptId)
    assert.equal(flagged, true, 'le drapeau « arrêter après celle-ci » doit être persisté')

    // Décochage : le drapeau se retire aussi bien qu'il se pose.
    await stop.click()
    const cleared = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 20; i++) {
        const r = await fetch('/erp/api/travaux/prompts', { headers: { Authorization: `Bearer ${token}` } })
        const d = await r.json()
        const p = d.prompts.find(x => x.id === id)
        if (p && !p.stop_after) return true
        await new Promise(res => setTimeout(res, 400))
      }
      return false
    }, promptId)
    assert.equal(cleared, true, 'le drapeau doit pouvoir être retiré')

    // La file a été mise en pause pour sécuriser ce test : on la rend tout de suite,
    // sans attendre le hook de nettoyage (qui vérifie de toute façon derrière).
    await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      await fetch('/erp/api/travaux/queue/pause', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: false }),
      })
    })
  })
})
