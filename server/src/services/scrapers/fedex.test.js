import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyFedex as fedex } from './fedex.js'

function scenario({ initialLogin = false, rejectSession = false, usernameOnly = false } = {}) {
  let url = ''
  let login = false
  let authenticated = false
  let submissions = 0
  const snapshots = []
  const page = {
    on() {},
    url: () => url,
    async goto(target) {
      url = target
      login = target.includes('accountSummary') ? !authenticated || rejectSession : initialLogin
      // Same-URL login forms also exist; do not rely solely on URL redirects.
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForURL() {},
    locator(selector) {
      const locator = {
        first: () => locator,
        async waitFor() {},
        async count() {
          if (/onetrust|one-time-code/.test(selector)) return 0
          if (selector.includes('username') || selector.includes('userId')) return Number(login)
          if (selector.includes('password')) return Number(login && !usernameOnly)
          return 0
        },
        async fill() {},
        async click() {
          if (selector.includes('login_button')) {
            submissions++
            authenticated = true
            login = false
          } else if (selector.includes('Continue')) usernameOnly = false
        },
      }
      return locator
    },
    async $$eval(selector) {
      return selector === 'a[href]' ? [{ href: '/invoice.pdf', text: 'PDF', row: 'Invoice 812345678 09/12/2026 $12.00' }] : []
    },
  }
  return {
    ctx: { page, context: {}, log() {}, credentials: { username: 'test', password: 'test' }, snapshot: async name => snapshots.push(name) },
    submissions: () => submissions,
    snapshots,
  }
}

test('FedEx connects when only the invoice summary requests authentication', async () => {
  const s = scenario()
  assert.equal((await fedex.list(s.ctx)).length, 1)
  assert.equal(s.submissions(), 1)
})

test('FedEx recognizes an initial username-only form without a login URL', async () => {
  const s = scenario({ initialLogin: true, usernameOnly: true })
  assert.equal((await fedex.list(s.ctx)).length, 1)
  assert.equal(s.submissions(), 1)
})

test('FedEx stops after one login if billing still requests authentication', async () => {
  const s = scenario({ initialLogin: true, rejectSession: true })
  await assert.rejects(fedex.list(s.ctx), /Session FedEx non authentifiée/)
  assert.equal(s.submissions(), 1)
  assert.ok(s.snapshots.includes('fedex-session-refusee'))
})
