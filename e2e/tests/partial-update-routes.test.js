const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que les routes PUT acceptent un patch partiel (autosave n'envoie
// souvent qu'un champ) sans écraser les autres colonnes. Avant le fix, un PUT
// avec juste { company_id } sur /contacts cassait first_name en NOT NULL.
describe('Routes PUT — vrais partial updates (pas de full-row écrasant)', () => {
  let browser, ctx, page, token
  const createdIds = { products: [], projects: [], tasks: [], tickets: [] }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Soft cleanup : delete any test entity we created
    for (const [kind, ids] of Object.entries(createdIds)) {
      for (const id of ids) {
        await page.evaluate(async ({ t, k, i }) => {
          await fetch(`/erp/api/${k}/${i}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
        }, { t: token, k: kind, i: id }).catch(() => {})
      }
    }
    await browser?.close()
  })

  async function api(path, opts = {}) {
    return page.evaluate(async ({ url, options, tok }) => {
      const r = await fetch(url, {
        ...options,
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      })
      return { status: r.status, data: await r.json().catch(() => null) }
    }, { url: `/erp/api${path}`, options: opts, tok: token })
  }

  test('products PUT { notes: "..." } préserve name_fr', async () => {
    const create = await api('/products', {
      method: 'POST',
      body: JSON.stringify({ name_fr: 'Produit Test Partial', unit_cost: 10 }),
    })
    assert.equal(create.status, 201, `create: ${JSON.stringify(create)}`)
    createdIds.products.push(create.data.id)

    const patch = await api(`/products/${create.data.id}`, {
      method: 'PUT',
      body: JSON.stringify({ notes: 'Juste les notes' }),
    })
    assert.equal(patch.status, 200)
    assert.equal(patch.data.name_fr, 'Produit Test Partial', 'name_fr préservé')
    assert.equal(patch.data.notes, 'Juste les notes', 'notes mis à jour')
  })

  test('products PUT { name_fr: "" } est rejeté', async () => {
    const create = await api('/products', {
      method: 'POST',
      body: JSON.stringify({ name_fr: 'Produit Test Reject', unit_cost: 5 }),
    })
    assert.equal(create.status, 201)
    createdIds.products.push(create.data.id)

    const patch = await api(`/products/${create.data.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name_fr: '' }),
    })
    assert.equal(patch.status, 400, 'name_fr vide doit être rejeté')
  })

  test('projects PUT { status: "Gagné" } préserve name', async () => {
    const create = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Projet Test Partial' }),
    })
    assert.equal(create.status, 201, `create: ${JSON.stringify(create)}`)
    createdIds.projects.push(create.data.id)

    const patch = await api(`/projects/${create.data.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Gagné' }),
    })
    assert.equal(patch.status, 200)
    assert.equal(patch.data.name, 'Projet Test Partial', 'name préservé')
    assert.equal(patch.data.status, 'Gagné')
  })

  test('tasks PUT { priority: "Haute" } préserve title', async () => {
    const create = await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Tâche Test Partial' }),
    })
    assert.equal(create.status, 201, `create: ${JSON.stringify(create)}`)
    createdIds.tasks.push(create.data.id)

    const patch = await api(`/tasks/${create.data.id}`, {
      method: 'PUT',
      body: JSON.stringify({ priority: 'Haute' }),
    })
    assert.equal(patch.status, 200)
    assert.equal(patch.data.title, 'Tâche Test Partial', 'title préservé')
    assert.equal(patch.data.priority, 'Haute')
  })

  test('tickets PUT { status: "..." } préserve title', async () => {
    const create = await api('/tickets', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ticket Test Partial', description: 'Description originale' }),
    })
    assert.equal(create.status, 201, `create: ${JSON.stringify(create)}`)
    createdIds.tickets.push(create.data.id)

    const patch = await api(`/tickets/${create.data.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Waiting on customer' }),
    })
    assert.equal(patch.status, 200)
    assert.equal(patch.data.title, 'Ticket Test Partial', 'title préservé')
    assert.equal(patch.data.description, 'Description originale', 'description préservée')
    assert.equal(patch.data.status, 'Waiting on customer')
  })
})
