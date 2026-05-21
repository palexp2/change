const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

describe('Dashboard — Abonnements + Ventes (cartes scindées, 12 mois)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('la carte Abonnements affiche 12 mois avec comparaison An. préc.', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('[data-section-id="section_stripe_subscriptions"]')
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const cardText = await card.innerText()
    assert.ok(cardText.includes('Abonnement'), `Légende Abonnement attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(cardText.includes('Abonnement an. préc.'), `Légende « Abonnement an. préc. » attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(!/[^.]Vente[^s]/.test(cardText), `La légende Vente ne devrait pas apparaître dans la carte Abonnements. Reçu: ${cardText.slice(0, 300)}`)

    const monthGroups = card.locator('[data-testid^="stripe-revenue-month-"]')
    const count = await monthGroups.count()
    assert.equal(count, 12, `Devrait afficher 12 mois, reçu ${count}`)
  })

  test('la carte Ventes affiche 12 mois avec comparaison An. préc.', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('[data-section-id="section_stripe_sales"]')
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const cardText = await card.innerText()
    assert.ok(cardText.includes('Vente'), `Légende Vente attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(cardText.includes('Vente an. préc.'), `Légende « Vente an. préc. » attendue. Reçu: ${cardText.slice(0, 300)}`)
    assert.ok(!cardText.includes('Abonnement'), `La légende Abonnement ne devrait pas apparaître dans la carte Ventes. Reçu: ${cardText.slice(0, 300)}`)

    const monthGroups = card.locator('[data-testid^="stripe-revenue-month-"]')
    const count = await monthGroups.count()
    assert.equal(count, 12, `Devrait afficher 12 mois, reçu ${count}`)
  })

  test('cliquer sur une barre abonnement affiche la liste des factures sous le graphique', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('[data-section-id="section_stripe_subscriptions"]')
    await card.waitFor({ state: 'visible', timeout: 8000 })

    // Si la DB est vide → message d'état vide, on skip.
    const emptyMsg = await card.locator('text=/Aucun abonnement Stripe/').count()
    if (emptyMsg > 0) return

    const aboBar = card.locator('svg path[fill="#21B14B"], svg path[fill="#1B8E3C"]').first()
    const hasAbo = await aboBar.count()
    if (!hasAbo) return // pas de données ce mois-ci, skip

    await aboBar.click()

    // L'utilisateur reste sur le dashboard ; pas de navigation vers /factures.
    assert.ok(!page.url().includes('/factures'), `URL ne devrait pas changer vers /factures, reçu: ${page.url()}`)

    const drilldown = card.locator('[data-testid="stripe-revenue-drilldown"]')
    await drilldown.waitFor({ state: 'visible', timeout: 5000 })

    const heading = drilldown.locator('h3')
    const headingText = await heading.innerText()
    assert.match(headingText, /^Abonnements de /, `Titre attendu, reçu: ${headingText}`)

    // Attendre que le tableau ou le message vide soit affiché (fin du
    // chargement). Le polling laisse le temps à l'API de répondre.
    await page.waitForFunction(
      () => {
        const dd = document.querySelector('[data-testid="stripe-revenue-drilldown"]')
        if (!dd) return false
        if (dd.querySelector('table')) return true
        return /Aucune facture/.test(dd.textContent || '')
      },
      { timeout: 10000 }
    )

    // Si la requête a renvoyé des factures, vérifier les en-têtes du tableau.
    // Comparaison case-insensitive (le CSS uppercase les en-têtes). Le drilldown
    // Abonnement (type=service) inclut une colonne « Intervalle » (Mensuel/Annuel)
    // que le drilldown Vente n'a pas.
    const tableCount = await drilldown.locator('table').count()
    if (tableCount > 0) {
      const headers = (await drilldown.locator('thead th').allInnerTexts()).map(s => s.trim().toLowerCase())
      const expected = ['date', 'n°', 'client', 'statut', 'montant ht (orig.)', 'montant ht (cad)', 'intervalle', 'date de constatation']
      for (const h of expected) {
        assert.ok(headers.includes(h), `En-tête attendu « ${h} », reçu: ${JSON.stringify(headers)}`)
      }
      // Chaque ligne doit avoir un intervalle renseigné (Mensuel ou Annuel) ou
      // un fallback explicite — pas de cellule vide.
      const intervalCells = await drilldown.locator('tbody tr td[data-testid^="drilldown-interval-"]').allInnerTexts()
      assert.equal(intervalCells.length, await drilldown.locator('tbody tr').count(),
        `Une cellule Intervalle attendue par ligne, reçu ${intervalCells.length}`)
      for (const c of intervalCells) {
        assert.match(c.trim(), /^(Mensuel|Annuel|—|.+)$/, `Cellule Intervalle invalide: « ${c} »`)
      }
    }

    // Re-cliquer sur la même barre referme la liste.
    await aboBar.click()
    await drilldown.waitFor({ state: 'hidden', timeout: 5000 })
  })

  test('cliquer sur une barre vente affiche le drilldown des factures dans la même carte', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    const card = page.locator('[data-section-id="section_stripe_sales"]')
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const emptyMsg = await card.locator('text=/Aucune vente Stripe/').count()
    if (emptyMsg > 0) return

    const venteBar = card.locator('svg path[fill="#f59e0b"], svg path[fill="#d97706"]').first()
    const hasVente = await venteBar.count()
    if (!hasVente) return

    await venteBar.click()

    // L'utilisateur reste sur le dashboard ; pas de navigation vers /factures.
    assert.ok(!page.url().includes('/factures'), `URL ne devrait pas changer vers /factures, reçu: ${page.url()}`)

    const drilldown = card.locator('[data-testid="stripe-revenue-drilldown"]')
    await drilldown.waitFor({ state: 'visible', timeout: 5000 })

    const heading = drilldown.locator('h3')
    const headingText = await heading.innerText()
    assert.match(headingText, /^Ventes de /, `Titre attendu, reçu: ${headingText}`)

    await page.waitForFunction(
      () => {
        const dd = document.querySelector('[data-testid="stripe-revenue-drilldown"]')
        if (!dd) return false
        if (dd.querySelector('table')) return true
        return /Aucune facture/.test(dd.textContent || '')
      },
      { timeout: 10000 }
    )

    const tableCount = await drilldown.locator('table').count()
    if (tableCount > 0) {
      const headers = (await drilldown.locator('thead th').allInnerTexts()).map(s => s.trim().toLowerCase())
      const expected = ['date', 'n°', 'client', 'statut', 'montant ht (orig.)', 'montant ht (cad)', 'date de constatation']
      for (const h of expected) {
        assert.ok(headers.includes(h), `En-tête attendu « ${h} », reçu: ${JSON.stringify(headers)}`)
      }
    }

    await venteBar.click()
    await drilldown.waitFor({ state: 'hidden', timeout: 5000 })
  })

  test('endpoint /stripe-revenue/factures retourne montants HT (taxes exclues)', async () => {
    // Compare la somme du drilldown du mois courant à la barre du graphique
    // pour le même mois — doivent être ~égales (les deux en HT). Si la route
    // renvoyait du TTC, la somme du drilldown dépasserait la barre de ~14%
    // (TPS+TVQ) sur les lignes CAD taxables.
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const agg = await (await fetch('/erp/api/dashboard/stripe-revenue', { headers: { Authorization: `Bearer ${tok}` } })).json()
      // Trouve un mois passé non vide pour les ventes (achat > 0).
      const candidate = (agg.byMonth || []).filter(m => m.achat > 50).sort((a, b) => b.month.localeCompare(a.month))[0]
      if (!candidate) return null
      const det = await (await fetch(`/erp/api/dashboard/stripe-revenue/factures?month=${candidate.month}&type=achat`, { headers: { Authorization: `Bearer ${tok}` } })).json()
      // amount_cad est déjà signé (négatif pour remboursements), donc la
      // somme reproduit directement le net agrégé.
      const sumCad = (det.data || []).reduce((s, r) => s + (Number(r.amount_cad) || 0), 0)
      return { month: candidate.month, agg: candidate.achat, sum: Math.round(sumCad * 100) / 100 }
    })
    if (!data) return // pas de mois exploitable
    const tolerance = Math.max(2, Math.abs(data.agg) * 0.01)  // 1 % ou 2 $
    assert.ok(
      Math.abs(data.sum - data.agg) <= tolerance,
      `Drilldown (HT) attendu ~${data.agg} pour ${data.month}, reçu ${data.sum} (écart > ${tolerance}). Si l'écart est ~14 %, la route renvoie du TTC au lieu du HT.`
    )
  })

  test('drilldown affiche les remboursements en négatif avec badge et total qui matche la barre', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Trouve un mois avec un remboursement (côté achat ou service) via l'API.
    const target = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const agg = await (await fetch('/erp/api/dashboard/stripe-revenue', { headers: { Authorization: `Bearer ${tok}` } })).json()
      const months = (agg.byMonth || []).map(m => m.month).sort().reverse()
      for (const month of months) {
        for (const t of ['achat', 'service']) {
          const det = await (await fetch(`/erp/api/dashboard/stripe-revenue/factures?month=${month}&type=${t}`, { headers: { Authorization: `Bearer ${tok}` } })).json()
          const refunds = (det.data || []).filter(r => r.sync_source === 'Remboursements Stripe')
          if (refunds.length > 0) {
            const total = (det.data || []).reduce((s, r) => s + (Number(r.amount_cad) || 0), 0)
            return { month, type: t, expectedTotal: Math.round(total * 100) / 100, refundCount: refunds.length }
          }
        }
      }
      return null
    })
    if (!target) return // pas de remboursement dans la fenêtre 24 mois

    const sectionId = target.type === 'service' ? 'section_stripe_subscriptions' : 'section_stripe_sales'
    const card = page.locator(`[data-section-id="${sectionId}"]`)
    await card.waitFor({ state: 'visible', timeout: 8000 })

    const monthGroup = card.locator(`[data-testid="stripe-revenue-month-${target.month}"]`)
    await monthGroup.waitFor({ state: 'visible', timeout: 5000 })

    // Sur la carte ventes, la barre achat est orange (#f59e0b/#d97706) ; sur la
    // carte abonnements, la barre service est verte (#21B14B/#1B8E3C).
    const colors = target.type === 'service'
      ? ['#21B14B', '#1B8E3C']
      : ['#f59e0b', '#d97706']
    const bar = monthGroup.locator(colors.map(c => `path[fill="${c}"]`).join(', ')).first()
    await bar.click()

    const drilldown = card.locator('[data-testid="stripe-revenue-drilldown"]')
    await drilldown.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => {
      const dd = document.querySelector('[data-testid="stripe-revenue-drilldown"]')
      return dd && dd.querySelector('table')
    }, { timeout: 10000 })

    // Au moins un badge « Remboursement » est visible.
    const badges = drilldown.locator('tbody tr td span:has-text("Remboursement")')
    const badgeCount = await badges.count()
    assert.ok(badgeCount >= target.refundCount,
      `Attendu ≥ ${target.refundCount} badge(s) Remboursement, reçu ${badgeCount} pour ${target.month}/${target.type}`)

    // Le total en pied de tableau doit correspondre au montant de la barre du chart.
    const totalText = await drilldown.locator('[data-testid="drilldown-total-cad"]').innerText()
    // Parse "1 234,56 $" ou "-1 234,56 $" → number. Intl fr-CA utilise espace insécable + virgule + suffixe $.
    const cleaned = totalText.replace(/[\s  $CADUSD]/g, '').replace(',', '.').replace(/−/g, '-')
    const totalNum = parseFloat(cleaned)
    assert.ok(!Number.isNaN(totalNum), `Total non parsable: « ${totalText} »`)
    const tolerance = Math.max(2, Math.abs(target.expectedTotal) * 0.01)
    assert.ok(
      Math.abs(totalNum - target.expectedTotal) <= tolerance,
      `Total drilldown attendu ~${target.expectedTotal} pour ${target.month}/${target.type}, reçu ${totalNum} (texte: « ${totalText} »)`
    )
  })

  test('cliquer sur la date de payout dans le drilldown ouvre le détail du payout', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Cherche la première carte Vente ou Abonnement avec une barre cliquable
    // qui contiendra au moins une ligne avec un payout. On essaye Ventes
    // d'abord (plus de variété historique), puis Abonnements en fallback.
    const cards = [
      page.locator('[data-section-id="section_stripe_sales"]'),
      page.locator('[data-section-id="section_stripe_subscriptions"]'),
    ]

    let payoutLink = null
    let cardUsed = null
    for (const card of cards) {
      if (await card.count() === 0) continue
      await card.waitFor({ state: 'visible', timeout: 8000 })
      const bars = card.locator('svg path[fill="#21B14B"], svg path[fill="#1B8E3C"], svg path[fill="#f59e0b"], svg path[fill="#d97706"]')
      const n = await bars.count()
      if (!n) continue

      // Itère du mois le plus récent au plus ancien jusqu'à trouver un
      // drilldown avec au moins un lien de payout.
      for (let i = n - 1; i >= 0 && !payoutLink; i--) {
        await bars.nth(i).click()
        const dd = card.locator('[data-testid="stripe-revenue-drilldown"]')
        try {
          await dd.waitFor({ state: 'visible', timeout: 5000 })
        } catch { continue }
        await page.waitForFunction(
          () => {
            const d = document.querySelector('[data-testid="stripe-revenue-drilldown"]')
            if (!d) return false
            if (d.querySelector('table')) return true
            return /Aucune facture/.test(d.textContent || '')
          },
          { timeout: 10000 }
        )
        // Cherche un lien dans la dernière colonne (Payout) qui pointe vers /stripe-payouts/
        const links = dd.locator('tbody tr td:last-child a[href*="/stripe-payouts/"]')
        if (await links.count() > 0) {
          payoutLink = links.first()
          cardUsed = card
          break
        }
        // Refermer pour passer à la barre suivante
        await bars.nth(i).click()
        await dd.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      }
      if (payoutLink) break
    }

    if (!payoutLink) {
      // Pas de payout disponible dans les données — on skip avec assertion molle.
      return
    }

    const href = await payoutLink.getAttribute('href')
    assert.match(href, /\/stripe-payouts\/po_/, `href payout devrait pointer vers /stripe-payouts/po_..., reçu: ${href}`)

    await payoutLink.click()
    await page.waitForURL(u => /\/stripe-payouts\/po_/.test(u.toString()), { timeout: 8000 })
    // Vérifie qu'on a bien chargé une page de détail (pas une 404 / liste).
    await page.locator('button:has-text("Retour aux payouts")').first().waitFor({ state: 'visible', timeout: 5000 })
  })

  test('la colonne Montant CAD utilise le taux BoC du payout (fallback document_date)', async () => {
    // Invariant : deux factures USD payées dans le même payout doivent avoir
    // le même ratio CAD/native (taux BoC à l'arrival_date du payout). Si le
    // ratio variait entre elles, c'est que la conversion utilisait toujours
    // le document_date — ce qui était l'ancien comportement.
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const agg = await (await fetch('/erp/api/dashboard/stripe-revenue', { headers: { Authorization: `Bearer ${tok}` } })).json()
      // On essaye chaque mois récent jusqu'à trouver un cas exploitable.
      const months = (agg.byMonth || []).map(m => m.month).sort().reverse()
      for (const month of months) {
        for (const t of ['achat', 'service']) {
          const det = await (await fetch(`/erp/api/dashboard/stripe-revenue/factures?month=${month}&type=${t}`, { headers: { Authorization: `Bearer ${tok}` } })).json()
          const usd = (det.data || []).filter(r =>
            r.currency === 'USD'
            && r.payout_arrival_date
            && r.amount_native > 1   // ignore montants trop faibles (rounding)
            && r.sync_source !== 'Remboursements Stripe'  // signe inversé
          )
          // Groupe par payout_arrival_date, garde un groupe avec ≥ 2 lignes
          // dont les document_date diffèrent (sinon le test ne prouve rien).
          const byPayout = {}
          for (const r of usd) {
            const k = r.payout_arrival_date.slice(0, 10)
            byPayout[k] = byPayout[k] || []
            byPayout[k].push(r)
          }
          for (const [arrivalDate, rows] of Object.entries(byPayout)) {
            const docDates = new Set(rows.map(r => r.document_date.slice(0, 10)))
            if (rows.length >= 2 && docDates.size >= 2) {
              return {
                month, type: t, arrivalDate,
                rows: rows.map(r => ({
                  doc: r.document_date.slice(0, 10),
                  native: r.amount_native,
                  cad: r.amount_cad,
                  ratio: r.amount_cad / r.amount_native,
                })),
              }
            }
          }
        }
      }
      return null
    })

    if (!data) {
      // Pas de cas exploitable dans la DB (besoin de ≥ 2 factures USD dans le
      // même payout, avec des document_date différents). Skip avec note.
      console.log('[skip] Pas de cas USD multi-factures dans un même payout pour valider l\'invariant.')
      return
    }

    const ratios = data.rows.map(r => r.ratio)
    const minR = Math.min(...ratios)
    const maxR = Math.max(...ratios)
    // Tolérance à 0,1 % pour absorber les arrondis au cent.
    assert.ok(
      (maxR - minR) / maxR < 0.001,
      `Toutes les lignes USD du payout ${data.arrivalDate} (mois ${data.month}/${data.type}) devraient partager le même ratio CAD/USD ` +
      `(taux BoC du payout). Ratios observés: ${JSON.stringify(data.rows)}`
    )
  })

  test('la légende affiche le total an. préc. en montant CAD (Abonnements + Ventes)', async () => {
    // Régression : la légende montrait juste « Abonnement an. préc. » / « Vente
    // an. préc. » sans le total, contrairement aux totaux année courante qui
    // s'affichaient en CAD à côté du libellé. On vérifie maintenant que la
    // légende inclut un montant formaté ($/CAD) après le libellé an. préc.
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })

    // Format attendu : « Abonnement an. préc. 12 345 $ » ou similaire. Le total
    // peut être 0 $ si pas de données pour l'année précédente — mais le suffixe
    // monétaire doit toujours apparaître.
    const moneyRe = /an\. préc\.[^\n]*?-?[\d\s ]+(?:[.,]\d+)?\s*\$/

    const subsCard = page.locator('[data-section-id="section_stripe_subscriptions"]')
    await subsCard.waitFor({ state: 'visible', timeout: 8000 })
    const subsText = await subsCard.innerText()
    assert.ok(
      moneyRe.test(subsText),
      `Légende « Abonnement an. préc. » devrait inclure un total CAD ($). Reçu: ${subsText.slice(0, 500)}`
    )

    const salesCard = page.locator('[data-section-id="section_stripe_sales"]')
    await salesCard.waitFor({ state: 'visible', timeout: 8000 })
    const salesText = await salesCard.innerText()
    assert.ok(
      moneyRe.test(salesText),
      `Légende « Vente an. préc. » devrait inclure un total CAD ($). Reçu: ${salesText.slice(0, 500)}`
    )
  })

  test('le bouton X efface le filtre depuis la page Factures', async () => {
    const monthKey = (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    })()
    await page.goto(`${URL}/factures?month=${monthKey}&type=service`, { waitUntil: 'networkidle' })

    const banner = page.locator('text=/Ventes & abonnements — facturées en/').first()
    await banner.waitFor({ state: 'visible', timeout: 5000 })

    await page.locator('button[aria-label="Effacer le filtre"]').click()
    await page.waitForURL(u => !u.toString().includes('month='), { timeout: 5000 })
    await page.waitForTimeout(300)
    const stillThere = await page.locator('text=/Ventes & abonnements — facturées en/').count()
    assert.equal(stillThere, 0, 'Le bandeau de filtre devrait disparaître après clic sur X')
  })
})
