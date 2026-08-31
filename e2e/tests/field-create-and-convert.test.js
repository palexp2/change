const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

const TABLE = 'paies'
const STAMP = Date.now()

// Palier 4 : une seule route de création, discriminée par `kind`, et conversion
// d'un champ d'un kind à l'autre.
//
// La conversion data → calculé ne détruit JAMAIS la colonne physique : elle sort
// simplement de la vue <table>_v. Sans cette exclusion, la vue exposerait deux
// colonnes homonymes et la lecture par nom renverrait la physique — la formule
// serait calculée puis silencieusement ignorée. C'est le piège que ce test garde.
//
// Test HTTP pur (pas de navigateur) : il ne touche que ses propres champs
// jetables sur `paies`, supprimés en after() (ligne + colonne physique).
describe('Champs — création unifiée et conversion de kind', () => {
  let token, db
  const created = []

  const api = async (method, path, body) => {
    const r = await fetch(`${URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const create = async (body) => {
    const res = await api('POST', `/custom-fields/${TABLE}`, body)
    if (res.status === 201) created.push(res.body)
    return res
  }

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const r = await fetch(`${URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    })
    const body = await r.json()
    assert.ok(body.token, `login échoué : ${JSON.stringify(body)}`)
    token = body.token
  })

  after(() => {
    try {
      for (const row of db.prepare('SELECT id, column_name FROM custom_fields WHERE erp_table=? AND name LIKE ?')
        .all(TABLE, `P4 ${STAMP}%`)) {
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(row.id)
        try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${row.column_name}`) } catch { /* colonne virtuelle */ }
      }
    } catch { /* nettoyage best-effort */ }
    db?.close()
  })

  test('un seul endpoint crée tous les kinds', async () => {
    const data = await create({ name: `P4 ${STAMP} data`, type: 'text' })
    assert.equal(data.status, 201, JSON.stringify(data.body))
    assert.equal(data.body.kind, 'data')

    const devise = await create({ name: `P4 ${STAMP} devise`, type: 'currency', decimals: 2 })
    assert.equal(devise.status, 201, JSON.stringify(devise.body))
    assert.equal(devise.body.decimals, 2)

    const formule = await create({ name: `P4 ${STAMP} formule`, kind: 'formula', formula_expr: "'x'", result_type: 'text' })
    assert.equal(formule.status, 201, JSON.stringify(formule.body))
    assert.equal(formule.body.kind, 'formula')

    const auto = await create({ name: `P4 ${STAMP} auto`, kind: 'created_time' })
    assert.equal(auto.status, 201, JSON.stringify(auto.body))
    assert.equal(auto.body.kind, 'created_time')
  })

  test('les refus gardent leur message précis', async () => {
    const inconnu = await create({ name: `P4 ${STAMP} zz`, kind: 'zzz' })
    assert.equal(inconnu.status, 400)
    assert.match(inconnu.body.error, /Type de champ inconnu/)

    // Unicité du libellé : contrôle désormais appliqué à TOUS les kinds.
    const doublon = await create({ name: `P4 ${STAMP} data`, type: 'text' })
    assert.equal(doublon.status, 409, JSON.stringify(doublon.body))

    const mauvaisType = await create({ name: `P4 ${STAMP} bad`, type: 'nope' })
    assert.equal(mauvaisType.status, 400)

    const formuleCassee = await create({
      name: `P4 ${STAMP} bad2`, kind: 'formula', formula_expr: 'colonne_inexistante', result_type: 'text',
    })
    assert.equal(formuleCassee.status, 400)
    assert.match(formuleCassee.body.error, /introuvable/)
  })

  test('convertir data → formule : la formule gagne, les données survivent', async () => {
    const res = await create({ name: `P4 ${STAMP} conv`, type: 'text' })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const col = res.body.column_name
    db.prepare(`UPDATE ${TABLE} SET ${col} = ?`).run('valeur originale')
    assert.equal(db.prepare(`SELECT ${col} AS v FROM ${TABLE}_v LIMIT 1`).get()?.v, 'valeur originale')

    const conv = await api('PUT', `/custom-fields/${res.body.id}`, {
      kind: 'formula', formula_expr: "'CALCULE'", result_type: 'text',
    })
    assert.equal(conv.status, 200, JSON.stringify(conv.body))
    assert.equal(conv.body.kind, 'formula')

    // La vue renvoie la valeur CALCULÉE — la colonne physique ne la masque pas.
    assert.equal(db.prepare(`SELECT ${col} AS v FROM ${TABLE}_v LIMIT 1`).get()?.v, 'CALCULE')
    // …et la donnée d'origine est intacte sous le capot.
    assert.equal(db.prepare(`SELECT ${col} AS v FROM ${TABLE} LIMIT 1`).get()?.v, 'valeur originale')

    // Conversion inverse : les valeurs reviennent telles quelles.
    const back = await api('PUT', `/custom-fields/${res.body.id}`, { kind: 'data', type: 'text' })
    assert.equal(back.status, 200, JSON.stringify(back.body))
    assert.equal(back.body.kind, 'data')
    assert.equal(db.prepare(`SELECT ${col} AS v FROM ${TABLE}_v LIMIT 1`).get()?.v, 'valeur originale')
  })

  test('un champ de liaison ne se convertit pas', async () => {
    const res = await create({ name: `P4 ${STAMP} lien`, type: 'text' })
    const conv = await api('PUT', `/custom-fields/${res.body.id}`, { kind: 'link' })
    assert.equal(conv.status, 400)
    assert.match(conv.body.error, /liaison ne se convertit pas/)
  })
})
