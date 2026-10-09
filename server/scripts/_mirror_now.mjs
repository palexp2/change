import db from '../src/db/database.js'
import { issueSession } from '../src/services/sessionSecurity.js'
const u = db.prepare("SELECT * FROM users WHERE email='claude@orisha.io' AND active=1").get()
const t = issueSession(u)
const r = await fetch('http://127.0.0.1:3004/erp/api/bank/trx-sheet/mirror', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{}' })
const j = await r.json()
console.log(r.status, JSON.stringify(j.tabs?.map(x => [x.tab, x.added, x.painted, x.cells, x.formatted, x.numbers_fixed, x.error]) ?? j))
process.exit(0)
