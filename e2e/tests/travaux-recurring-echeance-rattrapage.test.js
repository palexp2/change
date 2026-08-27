// Travaux récurrents — échéance mensuelle et rattrapage du mois précédent.
//
// Deux besoins exprimés par l'utilisateur :
//  1. « Payer Visa » est dû le 25 : la ligne doit crier avant l'échéance et
//     après, pas rester une ligne comme les autres → badge d'échéance calculé
//     à partir du jour du mois (saisi sur la ligne, en autosave).
//  2. Une tâche mensuelle faite début août correspond souvent à JUILLET :
//     cocher marquait août, et juillet restait ouvert sans qu'on le voie.
//     Le mois terminé jamais coché est donc proposé à part, nommément, et
//     cocher cette ligne-là marque juillet.
//
// Le rattrapage ne peut pas être provoqué avec des données honnêtes (le serveur
// refuse — à raison — d'inventer un retard antérieur à la création du travail) :
// le rendu et le câblage sont donc vérifiés en injectant `catch_up` dans la
// réponse de liste, mais le cochage part VRAIMENT au serveur, sur un travail
// jetable, et est vérifié via l'historique de complétions.
//
// Aucun record réel n'est touché : un travail jetable, décoché puis supprimé.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const LABEL = `E2E échéance mensuelle ${Date.now()}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return { status: r.status, body: await r.json() }
  }, { method, path: p, body })
}
const apiGet = (page, p) => apiFetch(page, 'GET', p).then(r => r.body)

async function waitFor(fn, { timeout = 25000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

const rowFor = (page, id) => page.locator(`[data-task-id="${id}"]`)

/** Mois précédent d'une clé `YYYY-MM`. */
function previousMonth(key) {
  const [y, m] = key.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

describe('Travaux récurrents — échéance mensuelle et rattrapage', () => {
  let browser, ctx, page
  let task = null
  let extra = null
  let period = null      // '2026-08'
  let prevPeriod = null  // '2026-07'
  let today = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    const created = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL, cadence: 'mensuel', owner: 'AL' })
    task = created.body
    assert.ok(task?.id, 'travail mensuel jetable créé')

    const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
    period = tasks.find(t => t.id === task.id)?.period_key
    assert.match(period, /^\d{4}-\d{2}$/, 'période mensuelle')
    prevPeriod = previousMonth(period)
    today = await page.evaluate(() =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
  })

  after(async () => {
    if (page) {
      await page.unroute('**/*').catch(() => {})
      if (task?.id) {
        for (const key of [period, prevPeriod]) {
          await apiFetch(page, 'POST', `/travaux/recurring/${task.id}/completion`, { done: false, period_key: key })
        }
        await apiFetch(page, 'DELETE', `/travaux/recurring/${task.id}`)
      }
      if (extra?.id) await apiFetch(page, 'DELETE', `/travaux/recurring/${extra.id}`)
    }
    await browser?.close()
  })

  test('un jour d\'échéance dépassé affiche « en retard » sur la ligne', async () => {
    const dayOfMonth = Number(today.slice(8))
    // Un jour déjà passé ce mois-ci ; le 1er du mois, l'échéance du jour même
    // compte comme « à faire aujourd'hui » (due_soon), pas comme un retard.
    const dueDay = Math.max(1, dayOfMonth - 2)
    const expected = dueDay < dayOfMonth ? 'overdue' : 'due_soon'
    await apiFetch(page, 'PATCH', `/travaux/recurring/${task.id}`, { due_day: dueDay })

    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    const badge = rowFor(page, task.id).locator('[data-testid="recurring-due-badge"]')
    await badge.waitFor({ timeout: 15000 })
    assert.equal(await badge.getAttribute('data-due-status'), expected)
    if (expected === 'overdue') assert.match(await badge.innerText(), /En retard de \d+ j/)
  })

  test('le jour d\'échéance se saisit sur la ligne, en autosave', async () => {
    const row = rowFor(page, task.id)
    // Les réglages de ligne vivent derrière le bouton (plus de barre flottante).
    await row.hover()
    await row.locator('[data-testid="recurring-settings"]').click()
    const input = row.locator('[data-testid="recurring-due-day"]')
    await input.fill('24')
    await input.blur()
    const saved = await waitFor(async () => {
      const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
      const t = tasks.find(x => x.id === task.id)
      return t?.due_day === 24 ? t : null
    }, { label: 'jour d\'échéance sauvegardé' })
    assert.equal(saved.due_day, 24)
  })

  test('un mois terminé jamais coché est proposé à part, et le cocher marque CE mois-là', async () => {
    // Injection du retard : le serveur ne peut pas en produire pour un travail
    // créé aujourd'hui (garde-fou volontaire, couvert par les tests unitaires).
    await page.route(u => u.pathname.endsWith('/api/travaux/recurring'), async route => {
      const res = await route.fetch()
      const json = await res.json()
      const t = json.tasks?.find(x => x.id === task.id)
      if (t) t.catch_up = [{ period_key: prevPeriod, period_label: 'mois précédent', due_date: null, ends_on: null }]
      await route.fulfill({ response: res, json })
    })
    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })

    const catchUp = page.locator(`[data-catchup="${task.id}:${prevPeriod}"]`)
    await catchUp.waitFor({ timeout: 15000 })
    await catchUp.locator('input[type="checkbox"]').click()

    // Le POST, lui, n'est pas intercepté : c'est une vraie complétion.
    const completions = await waitFor(async () => {
      const { completions } = await apiGet(page, `/travaux/recurring/${task.id}/completions`)
      return completions.some(c => c.period_key === prevPeriod) ? completions : null
    }, { label: 'complétion du mois précédent enregistrée' })
    assert.ok(completions.some(c => c.period_key === prevPeriod), 'le mois précédent est marqué fait')
    assert.ok(!completions.some(c => c.period_key === period), 'le mois courant, lui, reste à faire')

    await page.unroute('**/*').catch(() => {})
  })

  test('le jour d\'échéance peut être posé dès la création', async () => {
    const created = await apiFetch(page, 'POST', '/travaux/recurring',
      { label: `${LABEL} bis`, cadence: 'mensuel', owner: 'AL', due_day: 12 })
    extra = created.body
    assert.equal(extra.due_day, 12, 'le jour fourni à la création doit être conservé')
    // Valeur farfelue → champ vidé plutôt qu'écrit tel quel.
    const patched = await apiFetch(page, 'PATCH', `/travaux/recurring/${extra.id}`, { due_day: 99 })
    assert.equal(patched.body.due_day, null)
  })

  test('une clé de période incohérente avec la cadence est refusée', async () => {
    const r = await apiFetch(page, 'POST', `/travaux/recurring/${task.id}/completion`, { done: true, period_key: '2026-W32' })
    assert.equal(r.status, 400, 'une clé de semaine sur un travail mensuel doit être refusée')
  })
})
