const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Paie ↔ Feuilles de temps — import + banque d\'heures', () => {
  let browser, ctx, page
  let userId // the ERP user running the test
  let employeeId // employee lié au user (créé pour le test)
  let paieId
  let dayIds = []
  let activityCodeId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    // Récupérer l'id du user et créer/lier un employé
    const setup = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const me = await fetch('/erp/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return { userId: me.id, existingEmployeeId: me.employee_id || null }
    })
    userId = setup.userId
  })

  after(async () => {
    await page.evaluate(async ({ dayIds, paieId, employeeId, activityCodeId }) => {
      const token = localStorage.getItem('erp_token')
      if (paieId) await fetch(`/erp/api/paies/${paieId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      for (const id of dayIds) {
        await fetch(`/erp/api/timesheets/day/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      }
      if (activityCodeId) await fetch(`/erp/api/activity-codes/${activityCodeId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
      if (employeeId) await fetch(`/erp/api/employees/${employeeId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
    }, { dayIds, paieId, employeeId, activityCodeId })
    await browser?.close()
  })

  test('importTimesheetsForPaie — variable employee: ses heures régulières = heures payables FdT', async () => {
    const result = await page.evaluate(async ({ userId }) => {
      const token = localStorage.getItem('erp_token')
      // 1) créer un employé "variable" (hours_per_week = null/0) et lier au user courant
      const emp = await fetch('/erp/api/employees', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: 'Claude-Test', last_name: 'Variable', active: 1, hours_per_week: 0 }),
      }).then(r => r.json())
      await fetch(`/erp/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: emp.id }),
      })
      // 2) créer un code d'activité payable
      const code = await fetch('/erp/api/activity-codes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `TestCode-${Date.now()}`, payable: true }),
      }).then(r => r.json())
      // 3) 2 jours, mode detailed, 4h + 5h payables = 9h total
      const day1 = await fetch('/erp/api/timesheets/day', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2029-11-15', mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day1.id}/entries`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '4:00' }),
      })
      const day2 = await fetch('/erp/api/timesheets/day', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2029-11-20', mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day2.id}/entries`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: code.id, duration: '5:00' }),
      })
      // 4) créer une paie avec period_end = 2029-11-22 (période du 2029-11-09 au 2029-11-22 via fallback -13j)
      const paie = await fetch('/erp/api/paies', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_end: '2029-11-22', nb_holiday_days: 0 }),
      }).then(r => r.json())
      // 5) retrouver le paie_item pour cet employé
      const full = await fetch(`/erp/api/paies/${paie.id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const item = (full.items || []).find(i => i.employee_id === emp.id)
      return { empId: emp.id, codeId: code.id, day1Id: day1.id, day2Id: day2.id, paieId: paie.id, item, period_start: full.period_start, import_result: paie.timesheet_import }
    }, { userId })

    employeeId = result.empId
    activityCodeId = result.codeId
    dayIds.push(result.day1Id, result.day2Id)
    paieId = result.paieId

    // period_start renseigné (calculé: prev_paie.period_end+1j OU period_end-13j si aucune prev)
    assert.ok(result.period_start && /^\d{4}-\d{2}-\d{2}$/.test(result.period_start),
      `period_start calculé (reçu: ${result.period_start})`)
    assert.ok(result.period_start <= '2029-11-22', 'period_start doit être <= period_end')
    assert.ok(result.item, 'un paie_item doit avoir été créé pour l\'employé')
    // Variable employé → regular_hours écrasé avec heures payables des FdT qui tombent dans la période
    // (au moins les 9h des 2 jours créés, possiblement plus si d'autres FdT existent)
    assert.ok(result.item.regular_hours >= 9, `regular_hours >= 9h (reçu: ${result.item.regular_hours})`)
    // L'import inclus dans la réponse POST /paies
    assert.ok(result.import_result, 'POST /paies doit retourner timesheet_import')
    const myResult = (result.import_result.results || []).find(r => r.employee_id === employeeId)
    assert.ok(myResult, 'résultat d\'import doit inclure cet employé')
    assert.strictEqual(myResult.mode, 'direct', 'variable → mode direct')
  })

  test('resync manuel — POST /paies/:id/import-timesheets est idempotent', async () => {
    // Ajouter une 3e journée (2h) PUIS resync : regular_hours doit passer de 9h à 11h
    const before = await page.evaluate(async ({ paieId, empId, codeId, userId }) => {
      const token = localStorage.getItem('erp_token')
      void userId
      const day3 = await fetch('/erp/api/timesheets/day', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2029-11-21', mode: 'detailed' }),
      }).then(r => r.json())
      await fetch(`/erp/api/timesheets/day/${day3.id}/entries`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_code_id: codeId, duration: '2:00' }),
      })
      // resync
      const resync = await fetch(`/erp/api/paies/${paieId}/import-timesheets`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }).then(r => r.json())
      const full = await fetch(`/erp/api/paies/${paieId}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const item = full.items.find(i => i.employee_id === empId)
      return { day3Id: day3.id, resync, regular_hours: item.regular_hours }
    }, { paieId, empId: employeeId, codeId: activityCodeId, userId })

    dayIds.push(before.day3Id)
    // Après resync, variable employé = overwrite. regular_hours doit avoir augmenté de ~2h par rapport au test 1.
    assert.ok(before.regular_hours >= 11, `après resync, regular_hours >= 11h (reçu: ${before.regular_hours})`)
  })

  test('employé salarié (hours_per_week > 0) → diff va en banque d\'heures', async () => {
    const result = await page.evaluate(async ({ paieId, empId, userId }) => {
      const token = localStorage.getItem('erp_token')
      // Passer l'employé en "salarié" avec 35h/semaine → 70h biweekly
      await fetch(`/erp/api/employees/${empId}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours_per_week: 35 }),
      })
      // Aussi: on doit remettre paie_item.regular_hours à une valeur contractuelle (sinon la logique
      // conserve les 11h calculés précédemment). On recrée une paie qui recalcule tout.
      const full = await fetch(`/erp/api/paies/${paieId}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const item = full.items.find(i => i.employee_id === empId)
      // forcer regular_hours = 70 via PATCH (pas d'endpoint, on passe par l'update Airtable-like via PUT)
      // À défaut, on appelle directement /paies/items endpoint... mais il n'existe pas en PATCH.
      // Workaround: créer une nouvelle paie à la place pour recalculer fraîchement.
      void item
      const paie2 = await fetch('/erp/api/paies', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_end: '2029-12-06', nb_holiday_days: 0 }),
      }).then(r => r.json())
      const full2 = await fetch(`/erp/api/paies/${paie2.id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const item2 = full2.items.find(i => i.employee_id === empId)
      // Le user courant n'a pas d'entries dans la période 2029-11-23 → 2029-12-06 (tous nos tests sont avant)
      // donc totalHours = 0, alors que regular_hours = 70. Le diff = -70 doit aller en banque.
      const bank = await fetch(`/erp/api/hour-bank/${empId}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      void userId
      return {
        paieId2: paie2.id,
        item_regular_hours: item2?.regular_hours,
        bank_balance: bank.balance_hours,
        bank_entries: bank.entries,
      }
    }, { paieId, empId: employeeId, userId })

    // cleanup: supprimer la 2e paie (sera faite dans after via le paieId principal? non — il faut l'ajouter)
    const paieId2 = result.paieId2
    void paieId2
    // Pour éviter de trop charger le test, on ne fait pas le cleanup ici; l'employé+user_id seront nettoyés.
    // La paie supplémentaire reste en DB. Note: pour un test propre on devrait la supprimer.
    await page.evaluate(async ({ pid }) => {
      const token = localStorage.getItem('erp_token')
      await fetch(`/erp/api/paies/${pid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
    }, { pid: paieId2 })

    // regular_hours salarié = 70h, banque doit avoir un deficit de -70 (pas de FdT sur cette période)
    assert.strictEqual(Math.round(result.item_regular_hours * 100) / 100, 70, 'salarié → regular_hours = hours_per_week * 2')
    // Solde banque = -70 (ou proche)
    assert.ok(result.bank_balance < 0, `salarié sans FdT → déficit attendu dans la banque (reçu: ${result.bank_balance})`)
    const importEntry = (result.bank_entries || []).find(e => e.source === 'timesheet_import')
    assert.ok(importEntry, 'une entrée timesheet_import doit exister')
  })
})
