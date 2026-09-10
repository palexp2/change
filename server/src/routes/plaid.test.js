import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webhookAction } from './plaid.js'

test('les webhooks de transactions déclenchent une sync', () => {
  for (const code of ['SYNC_UPDATES_AVAILABLE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE', 'TRANSACTIONS_REMOVED']) {
    assert.equal(webhookAction({ webhook_type: 'TRANSACTIONS', webhook_code: code }).action, 'sync')
  }
})

test('ITEM/ERROR remonte le message de Plaid, sans sync', () => {
  const r = webhookAction({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_message: 'La banque refuse' } })
  assert.equal(r.action, 'issue')
  assert.equal(r.message, 'La banque refuse')
})

test('ITEM/ERROR sans message garde un texte lisible', () => {
  const r = webhookAction({ webhook_type: 'ITEM', webhook_code: 'ERROR' })
  assert.equal(r.action, 'issue')
  assert.ok(r.message)
})

test('les codes de connexion mourante deviennent des alertes', () => {
  for (const code of ['PENDING_DISCONNECT', 'PENDING_EXPIRATION', 'USER_PERMISSION_REVOKED', 'USER_ACCOUNT_REVOKED', 'NEW_ACCOUNTS_AVAILABLE']) {
    const r = webhookAction({ webhook_type: 'ITEM', webhook_code: code })
    assert.equal(r.action, 'issue', code)
    assert.ok(r.message, code)
  }
})

test('LOGIN_REPAIRED efface l’alerte', () => {
  assert.equal(webhookAction({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED' }).action, 'clear')
})

test('le reste est ignoré, jamais synchronisé', () => {
  assert.equal(webhookAction({ webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED' }).action, 'ignore')
  assert.equal(webhookAction({ webhook_type: 'STATEMENTS', webhook_code: 'STATEMENTS_REFRESH_COMPLETE' }).action, 'ignore')
  assert.equal(webhookAction({}).action, 'ignore')
  assert.equal(webhookAction(null).action, 'ignore')
})
