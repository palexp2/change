// Run from server/: node src/scripts/sync-treasury-sheet-mirror.js [--apply]
// Without --apply, reads Google and previews changes only.
import assert from 'node:assert/strict'
import db from '../db/database.js'
import { SYSTEM_AUTOMATIONS } from '../services/systemAutomations.js'
import { syncTreasuryMirror } from '../services/treasurySheetMirror.js'
import { syncSoldeSheet } from '../services/treasurySoldeSheet.js'
import { getSoldeSheetConfig } from '../services/treasurySoldeSheet.js'
import { getSheetsClient } from '../connectors/google.js'

if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify(await syncTreasuryMirror({ dryRun: true, trigger: 'manual' }), null, 2))
} else {
  const config = SYSTEM_AUTOMATIONS.find(a => a.id === 'sys_treasury_sheet_mirror')
  // First installation only. A later operator pause remains respected.
  db.prepare(`INSERT INTO automations
    (id,name,description,trigger_type,trigger_config,action_type,action_config,active,system)
    VALUES (?,?,?,'system',?,'system',?,1,1) ON CONFLICT(id) DO NOTHING`)
    .run(config.id, config.name, config.description, JSON.stringify(config.trigger_config), JSON.stringify(config.action_config))
  const result = await syncTreasuryMirror({ trigger: 'manual' })
  console.log(JSON.stringify(result, null, 2))
  if (!result.skipped) {
    const verify = await syncTreasuryMirror({ dryRun: true, trigger: 'manual' })
    assert.equal(verify.changed_cells, 0, 'Le Sheet relu doit correspondre exactement à Boréal')
    const cfg = getSoldeSheetConfig()
    const account = db.prepare("SELECT id FROM connector_oauth WHERE connector='google' AND account_email='michel@orisha.io'").get()
    const sheets = await getSheetsClient(account.id)
    const lastCell = result.movements ? `D${result.movements + 1}` : 'F2'
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.spreadsheet_id,
      range: `'${cfg.sheet_name.replace(/'/g, "''")}'!${lastCell}`, valueRenderOption: 'UNFORMATTED_VALUE' })
    assert.equal(Math.round(data.values?.[0]?.[0] * 100), Math.round(result.final_balance * 100), 'Solde calculé par Google identique à Boréal')
    assert.equal((await syncSoldeSheet({ apply: true })).skipped, true, 'Ancien import bloqué')
    console.log('Vérifié : Sheet identique à la projection, aucun doublon, ancien import bloqué.')
  }
}
