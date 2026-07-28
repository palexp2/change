// Réconciliation des factures de transport multi-expéditions : quand la somme des
// "shipments" extraits par l'IA ne retombe pas sur le montant total dû imprimé,
// extractWithOpenAI relance l'appel avec l'écart chiffré (jusqu'à 2 corrections) et
// garde la meilleure tentative. Cas réel : facture NovoXpress 250954 — expédition de
// 137,52 $ sautée, total stocké 381,63 $ vs lignes 244,11 $.

import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key'

const { extractWithOpenAI, shipmentsImbalance, buildImbalanceCorrection } = await import('./saleReceiptExtraction.js')

// Page image factice : évite pdftotext, readFileSync se contente de base64er le contenu.
const dir = mkdtempSync(path.join(tmpdir(), 'e2e-reconcile-'))
const fakePage = path.join(dir, 'page.jpg')
writeFileSync(fakePage, 'fake-image-bytes')
const PAGES = [{ filePath: fakePage, fileExt: '.jpg' }]

const QC = { carrier: 'Purolator', destination_province: 'QC', destination_country: 'CA', total: 100, taxes: [{ label: 'TPS', amount: 4.35 }, { label: 'TVQ', amount: 8.68 }] }
const MISSED = { carrier: 'Canada Post', destination_province: 'QC', destination_country: 'CA', total: 137.52, taxes: [{ label: 'TPS', amount: 5.98 }, { label: 'TVQ', amount: 11.93 }] }

function docWith(shipments) {
  return {
    receipt_date: '2026-07-16', company: 'NovoXpress', receipt_number: '250954',
    items: [], shipments, subtotal: 207.06, tps: 10.33, tvq: 20.61, other_taxes: 0,
    total: 237.52, currency: 'CAD',
  }
}

// Mock fetch OpenAI : rejoue les réponses dans l'ordre et capture les messages envoyés.
function mockOpenAI(responses) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    calls.push(body.messages)
    const payload = responses[Math.min(calls.length - 1, responses.length - 1)]
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    }
  }
  return calls
}

test('shipmentsImbalance — écart entre total imprimé et somme des expéditions', () => {
  assert.equal(shipmentsImbalance(docWith([QC, MISSED])), 0)
  assert.equal(shipmentsImbalance(docWith([QC])), 137.52)
  assert.equal(shipmentsImbalance({ items: [{ total: 5 }], total: 5 }), 0) // pas une facture transport
  assert.equal(shipmentsImbalance({ shipments: [QC], total: 0 }), 0) // pas de total imprimé → rien à réconcilier
})

test('réponse balancée du premier coup — un seul appel OpenAI', async () => {
  const calls = mockOpenAI([docWith([QC, MISSED])])
  const out = await extractWithOpenAI(PAGES)
  assert.equal(calls.length, 1)
  assert.equal(out.shipments.length, 2)
})

test('expédition manquée — relance avec l\'écart chiffré, garde la réponse corrigée', async () => {
  const calls = mockOpenAI([docWith([QC]), docWith([QC, MISSED])])
  const out = await extractWithOpenAI(PAGES)
  assert.equal(calls.length, 2)
  // La relance contient la réponse fautive de l'assistant + la correction chiffrée.
  const retryMessages = calls[1]
  assert.equal(retryMessages.at(-2).role, 'assistant')
  assert.equal(retryMessages.at(-1).role, 'user')
  assert.match(retryMessages.at(-1).content, /137\.52/)
  assert.match(retryMessages.at(-1).content, /manque/)
  assert.equal(out.shipments.length, 2)
  assert.equal(shipmentsImbalance(out), 0)
})

test('jamais balancé — s\'arrête après 2 corrections et garde la meilleure tentative', async () => {
  const closer = docWith([QC, { ...MISSED, total: 130, taxes: [] }]) // écart 7.52
  const calls = mockOpenAI([docWith([QC]), closer, docWith([QC])])
  const out = await extractWithOpenAI(PAGES)
  assert.equal(calls.length, 3) // 1 essai + 2 corrections, pas plus
  assert.equal(shipmentsImbalance(out), 7.52) // la tentative la moins déséquilibrée gagne
})

test('doublon (somme trop haute) — le message de correction parle de doublon', () => {
  const doc = docWith([QC, MISSED, MISSED])
  const delta = shipmentsImbalance(doc)
  assert.equal(delta, -137.52)
  const msg = buildImbalanceCorrection(doc, delta)
  assert.match(msg, /en trop/)
  assert.match(msg, /double/)
})
