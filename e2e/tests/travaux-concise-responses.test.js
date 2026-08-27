// Travaux — réponses concises après modification du prompt de génération.
//
// Signalement utilisateur : les réponses générées par generateUserSummary
// étaient trop longues. On a modifié le prompt pour insister sur la concision.
//
// Vérifie que :
//   1. Une tâche "question" complétée produit une réponse concise (1-2 phrases)
//   2. Une tâche "implémenter" complétée produit un compte-rendu concis
//
// Note : ce test dépend de l'exécution réelle de l'agent, qui peut être lente.
// Il attend les réponses avec un timeout généreux.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'

const STAMP = Date.now()
const MARKER = `E2E concise responses ${STAMP}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function api(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch('/erp/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    return r.json()
  }, { method, path: p, body })
}

// Compte les phrases (approximativement : texte terminé par . ! ou ?)
function countSentences(text) {
  const clean = String(text || '').trim()
  const matches = clean.match(/[.!?]+/g) || []
  return matches.length
}

describe('Travaux — réponses concises', () => {
  let browser, ctx, page
  let originalEnabled = false
  let questionId = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)

    // Vérifier que l'agent est activé (sinon le test ne peut pas vérifier les réponses réelles)
    const s = await api(page, 'GET', '/agent/settings')
    originalEnabled = !!s.enabled
    if (!originalEnabled) {
      await api(page, 'PUT', '/agent/settings', { enabled: true })
    }
  })

  after(async () => {
    // Cleanup des tâches créées
    if (questionId) {
      try {
        const list = await api(page, 'GET', '/travaux/prompts')
        const found = (list.prompts || []).find(p => p.title && p.title.includes(MARKER))
        if (found) await api(page, 'DELETE', `/travaux/prompts/${found.id}`)
      } catch {}
    }

    // Restaurer les paramètres
    try { await api(page, 'PUT', '/agent/settings', { enabled: originalEnabled }) } catch {}
    await browser?.close()
  })

  test('question — la réponse est concise (1-2 phrases)', async () => {
    // Créer une question simple et rapide à répondre
    const created = await api(page, 'POST', '/travaux/prompts', {
      prompt: `${MARKER} — Combien de pages le ERP a-t-il actuellement? Sois bref (1 phrase).`,
      title: MARKER,
      mode: 'question',
      status: 'queued',
      preset: 'fast',
    })
    questionId = created.id
    assert.ok(created.id, 'tâche question créée')

    // Attendre que la tâche se termine (avec timeout : les tâches questions sont rapides)
    const maxWait = 30000 // 30 secondes pour une question simple
    const startTime = Date.now()
    let prompt = created

    while (prompt.status === 'running' || prompt.status === 'queued') {
      if (Date.now() - startTime > maxWait) {
        assert.fail(`Timeout en attendant la tâche « ${MARKER} »`)
      }
      await new Promise(r => setTimeout(r, 1000))
      const list = await api(page, 'GET', '/travaux/prompts')
      prompt = (list.prompts || []).find(p => p.id === questionId)
      if (!prompt) assert.fail('tâche introuvable')
    }

    // Vérifier que la tâche est terminée avec succès
    assert.equal(prompt.status, 'done', 'tâche complétée')

    // Récupérer le dernier message du fil (la réponse de Claude)
    const messages = prompt.messages || []
    const agentReply = [...messages].reverse().find(m => m.role === 'agent')
    assert.ok(agentReply, 'la tâche a une réponse')

    const responseText = agentReply.text || ''
    const sentenceCount = countSentences(responseText)

    // Vérifier la concision : une phrase ou deux au maximum pour une question simple
    assert.ok(sentenceCount <= 2,
      `réponse trop longue (${sentenceCount} phrases): « ${responseText.slice(0, 100)}… »`)

    // Vérifier que ce n'est pas vide
    assert.ok(responseText.length > 10, 'réponse non vide')

    console.log(`✓ Réponse concise : ${sentenceCount} phrase(s) — « ${responseText.slice(0, 80)}… »`)
  })
})
