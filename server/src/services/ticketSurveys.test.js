// Tests du sondage de satisfaction — logique pure uniquement.
//
// AUCUN SMS N'EST ENVOYÉ ICI, ni ne peut l'être : sms.js refuse tout appel
// réseau dès que NODE_ENV === 'test'. La DB de ce serveur EST la DB de prod,
// un test qui parlerait à Telnyx ferait sonner le téléphone d'un vrai client.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'

const { toE164, smsEnabled, sendSms } = await import('./sms.js')
const { buildSmsText, CALLBACK_QUESTION_MIN_RATING, SURVEY_EXPIRY_DAYS } = await import('./ticketSurveys.js')
const { generateBase62Token } = await import('../utils/shortToken.js')

test('toE164 — formats nord-américains courants', () => {
  assert.equal(toE164('5145551234'), '+15145551234')
  assert.equal(toE164('(514) 555-1234'), '+15145551234')
  assert.equal(toE164('514-555-1234'), '+15145551234')
  assert.equal(toE164('1 514 555 1234'), '+15145551234')
  assert.equal(toE164('+1 (514) 555-1234'), '+15145551234')
  assert.equal(toE164(' 514.555.1234 '), '+15145551234')
})

test('toE164 — rejette ce que Telnyx refuserait', () => {
  assert.equal(toE164(null), null)
  assert.equal(toE164(''), null)
  assert.equal(toE164('555-1234'), null)          // trop court
  assert.equal(toE164('123456789012'), null)      // trop long pour du NANP
  assert.equal(toE164('0145551234'), null)        // indicatif régional commence par 0
  assert.equal(toE164('5140551234'), null)        // central office commence par 0
})

test('toE164 — un indicatif hors Amérique du Nord est respecté tel quel', () => {
  assert.equal(toE164('+33 6 12 34 56 78'), '+33612345678')
})

test('sendSms ne fait AUCUN appel réseau en test', async () => {
  assert.equal(smsEnabled(), false)
  const res = await sendSms({ to: '514-555-1234', text: 'test' })
  assert.equal(res.ok, true)
  assert.equal(res.simulated, true)
  assert.equal(res.to, '+15145551234')
})

test('sendSms refuse un numéro invalide ou un message vide', async () => {
  assert.equal((await sendSms({ to: 'allo', text: 'x' })).ok, false)
  assert.equal((await sendSms({ to: '5145551234', text: '  ' })).ok, false)
})

test('buildSmsText — bilingue, tient sur un segment, contient le lien', () => {
  const url = 'https://customer.orisha.io/erp/s/B4Fehk9jYd4s4B'
  const fr = buildSmsText({ language: 'French', firstName: 'Marie', url })
  const en = buildSmsText({ language: 'English', firstName: 'Marie', url })

  assert.match(fr, /^Bonjour Marie, ici Orisha\./)
  assert.match(en, /^Hi Marie, this is Orisha\./)
  for (const t of [fr, en]) {
    assert.ok(t.includes(url), 'le lien doit être dans le message')
    assert.ok(t.length <= 160, `un seul segment attendu, reçu ${t.length} caractères`)
    // Pas de mention STOP : sondage transactionnel, hors champ LCAP.
    assert.ok(!/STOP/i.test(t))
  }
})

test('buildSmsText — sans prénom, la salutation reste correcte', () => {
  const url = 'https://x.test/s/abc'
  assert.match(buildSmsText({ language: 'French', firstName: null, url }), /^Bonjour, ici Orisha/)
  assert.match(buildSmsText({ language: 'English', firstName: '  ', url }), /^Hi, this is Orisha/)
})

test('generateBase62Token — format Airtable, non biaisé, non répétitif', () => {
  const t = generateBase62Token(14)
  assert.equal(t.length, 14)
  assert.match(t, /^[0-9A-Za-z]{14}$/)

  const seen = new Set()
  for (let i = 0; i < 500; i++) seen.add(generateBase62Token(14))
  assert.equal(seen.size, 500, 'aucune collision attendue sur 500 tirages')
})

test('constantes du parcours — le seuil de rappel vise les clients satisfaits', () => {
  assert.equal(CALLBACK_QUESTION_MIN_RATING, 3)
  assert.equal(SURVEY_EXPIRY_DAYS, 30)
})
