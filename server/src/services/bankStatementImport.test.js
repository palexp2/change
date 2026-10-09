// Tests purs du dépôt de relevés : aucune lecture de fichier, aucun réseau,
// aucune base. Ce qui est vérifié ici, c'est ce qui fait mal quand ça rate :
// le SENS du montant, l'arithmétique qui démasque une lecture inventée, et la
// frontière neuf / déjà en base.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitCsvLine, detectSeparator, csvToTable,
  normalizeExtracted, checkBalance, buildBalanceCorrection,
  scoreAccount, detectAccount, isInvertible, applySignConvention,
  extractStatement, MIN_DETECT_CONFIDENCE, dateHintFromName, yearDriftAgainstHint,
  parseStatementResponse, isolateAccountChain, accountMismatch, ACCOUNT_MISMATCH, accountHintText,
} from './bankStatementImport.js'
import { planImportFromCounts } from './bankTrxSheet.js'
import { parseStatementTable } from './bankReconciliation.js'

test('réponse de capture : texte libre, refus et JSON tronqué ne deviennent pas des transactions', () => {
  const response = (content, extra = {}) => ({ choices: [{ message: { content }, ...extra }] })
  assert.throws(() => parseStatementResponse(response('Je ne peux pas lire cette capture.')), /Relancez l’analyse/)
  assert.throws(() => parseStatementResponse(response('{"rows":[]} ', { finish_reason: 'length' })), /moins de pages/)
  assert.throws(() => parseStatementResponse({ choices: [{ message: { refusal: 'refused' } }] }), /capture nette/)
  assert.throws(() => parseStatementResponse(response('{"error":"illlisible"}')), /Aucune liste/)
  const valid = { rows: [{ txn_date: '2026-09-15', description: 'Paiement', debit: 42, credit: null }] }
  assert.deepEqual(parseStatementResponse(response(JSON.stringify(valid))), valid)
})

// ── CSV ──────────────────────────────────────────────────────────────────────

test('splitCsvLine garde les virgules des libellés entre guillemets', () => {
  assert.deepEqual(
    splitCsvLine('2026-09-02,"PAIEMENT, MERCI",-45.20', ','),
    ['2026-09-02', 'PAIEMENT, MERCI', '-45.20'],
  )
})

test('splitCsvLine rend un guillemet doublé', () => {
  assert.deepEqual(splitCsvLine('a,"il a dit ""oui""",b', ','), ['a', 'il a dit "oui"', 'b'])
})

test('detectSeparator reconnaît le point-virgule des exports français', () => {
  const text = 'Date;Description;Montant\n2026-09-02;EPICERIE, DU COIN;-45,20\n2026-09-03;DEPOT;100,00'
  assert.equal(detectSeparator(text), ';')
})

test('csvToTable produit une grille exploitable par parseStatementTable', () => {
  const table = csvToTable('Date,Description,Montant\n2026-09-02,CAFE,-4.50')
  assert.deepEqual(table, [['Date', 'Description', 'Montant'], ['2026-09-02', 'CAFE', '-4.50']])
})

// ── Sens du montant ──────────────────────────────────────────────────────────

const EXTRACT = {
  opening_balance: 1000,
  closing_balance: 1055.5,
  rows: [
    { txn_date: '2026-09-02', description: 'EPICERIE', debit: 45.2, credit: null, balance: 954.8 },
    { txn_date: '2026-09-03', description: 'DEPOT', debit: null, credit: 100.7, balance: 1055.5 },
  ],
}

test('débit sémantique → négatif, crédit → positif', () => {
  const { rows, errors } = normalizeExtracted(EXTRACT)
  assert.equal(errors.length, 0)
  assert.equal(rows[0].amount, -45.2)
  assert.equal(rows[1].amount, 100.7)
})

test('une ligne sans date lisible est écartée, pas devinée', () => {
  const { rows, errors } = normalizeExtracted({ rows: [{ txn_date: '3 août', debit: 10 }] })
  assert.equal(rows.length, 0)
  assert.match(errors[0], /date illisible/)
})

test('un débit et un crédit tous deux nuls écartent la ligne', () => {
  const { rows, errors } = normalizeExtracted({
    rows: [{ txn_date: '2026-09-02', description: 'SOUS-TOTAL', debit: null, credit: null }],
  })
  assert.equal(rows.length, 0)
  assert.match(errors[0], /montant illisible/)
})

test('colonne « Montant » unique : le signe dépend du compte, Débit/Crédit non', () => {
  assert.equal(isInvertible({ columns: ['date', 'description', 'amount'] }), true)
  assert.equal(isInvertible({ columns: ['date', 'debit', 'credit'] }), false)
  // Lecture par le modèle : débit/crédit sémantiques, jamais d'inversion.
  assert.equal(isInvertible({ institution: 'Desjardins' }), false)
})

test('un achat VISA Desjardins, positif au relevé, devient une sortie', () => {
  const rows = [{ txn_date: '2026-09-02', description: 'ACHAT', amount: 45.2 }]
  const visa = { name: 'VISA Desjardins CAD' }
  const flipped = applySignConvention(rows, visa, true)
  assert.equal(flipped[0].amount, -45.2)
  assert.equal(flipped[0].amount_raw, 45.2)
  // Le même fichier attribué à un compte ordinaire garde son signe.
  assert.equal(applySignConvention(rows, { name: 'BNC CAD' }, true)[0].amount, 45.2)
})

test('re-signer part toujours de amount_raw, jamais du montant déjà retourné', () => {
  const rows = [{ txn_date: '2026-09-02', amount: 45.2 }]
  const visa = applySignConvention(rows, { name: 'VISA Desjardins CAD' }, true)
  // Correction du compte dans l'aperçu : on ne doit pas ré-inverser l'inversion.
  const corrected = applySignConvention(visa, { name: 'BNC CAD' }, true)
  assert.equal(corrected[0].amount, 45.2)
  const back = applySignConvention(corrected, { name: 'VISA Desjardins CAD' }, true)
  assert.equal(back[0].amount, -45.2)
})

// ── L'arithmétique qui démasque une lecture inventée ────────────────────────

test('les soldes imprimés font foi quand ils sont là', () => {
  const { rows } = normalizeExtracted(EXTRACT)
  const check = checkBalance(rows, 1000, 1055.5)
  assert.equal(check.method, 'soldes')
  assert.equal(check.ok, true)
  assert.equal(check.delta, 0)
})

test('une ligne sautée sort en écart chiffré', () => {
  const { rows } = normalizeExtracted({ ...EXTRACT, rows: [EXTRACT.rows[0]] })
  const check = checkBalance(rows, 1000, 1055.5)
  assert.equal(check.ok, false)
  assert.equal(check.delta, -100.7)
  const msg = buildBalanceCorrection(check)
  assert.match(msg, /100\.70/)
  assert.match(msg, /MANQUE/)
})

test('sans soldes imprimés, la colonne Solde doit s’enchaîner', () => {
  const { rows } = normalizeExtracted(EXTRACT)
  const check = checkBalance(rows, null, null)
  assert.equal(check.method, 'chaine')
  assert.equal(check.ok, true)
})

test('une chaîne de soldes lue à l’envers reste valide', () => {
  const { rows } = normalizeExtracted(EXTRACT)
  const check = checkBalance([...rows].reverse(), null, null)
  assert.equal(check.method, 'chaine')
  assert.equal(check.ok, true)
})

test('un solde qui ne s’enchaîne pas est signalé', () => {
  const rows = [
    { txn_date: '2026-09-02', amount: -45.2, balance: 954.8 },
    { txn_date: '2026-09-03', amount: 100.7, balance: 2000 },
  ]
  const check = checkBalance(rows, null, null)
  assert.equal(check.ok, false)
  assert.equal(check.breaks, 1)
})

test('ni soldes ni chaîne : la lecture n’est pas vérifiable, et on le dit', () => {
  const check = checkBalance([{ txn_date: '2026-09-02', amount: -10, balance: null }], null, null)
  assert.equal(check.method, 'aucun')
  assert.equal(check.ok, null)
})

test('le modèle est renvoyé à sa copie tant que ça ne balance pas', async () => {
  const seen = []
  let call = 0
  const fake = async (messages) => {
    seen.push(messages.length)
    call++
    // Première réponse : une ligne manquante. Deuxième : complète.
    return call === 1 ? { ...EXTRACT, rows: [EXTRACT.rows[0]] } : EXTRACT
  }
  const { extracted, check } = await extractStatement([{ text: 'relevé' }], { call: fake })
  assert.equal(call, 2)
  assert.equal(check.ok, true)
  assert.equal(extracted.rows.length, 2)
  // La relance porte bien la réponse précédente + la correction chiffrée.
  assert.equal(seen[1], 4)
})

test('après les relances, on garde la meilleure tentative, pas la dernière', async () => {
  let call = 0
  const fake = async () => {
    call++
    // 1re : écart de 100,70. 2e : écart de 500. 3e : écart de 300.
    if (call === 1) return { ...EXTRACT, rows: [EXTRACT.rows[0]] }
    if (call === 2) return { ...EXTRACT, rows: [{ ...EXTRACT.rows[0], debit: 545.2 }] }
    return { ...EXTRACT, rows: [{ ...EXTRACT.rows[0], debit: 345.2 }] }
  }
  const { check } = await extractStatement([{ text: 'x' }], { call: fake })
  assert.equal(call, 3)
  assert.equal(check.delta, -100.7)
})

test('une lecture non vérifiable ne déclenche aucune relance', async () => {
  let call = 0
  const fake = async () => {
    call++
    return { rows: [{ txn_date: '2026-09-02', description: 'X', debit: 10 }] }
  }
  await extractStatement([{ text: 'x' }], { call: fake })
  assert.equal(call, 1)
})

// ── Détection du compte ──────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'a1', name: 'BNC CAD', kind: 'bank', currency: 'CAD', institution: 'BNC', account_number: '0006-10281-0310224' },
  { id: 'a2', name: 'BNC USD', kind: 'bank', currency: 'USD', institution: 'BNC', account_number: '0006-10281-0016' },
  { id: 'a3', name: 'MasterCard BNC', kind: 'card', currency: 'CAD', institution: 'BNC', account_number: '5258-8186-****' },
  { id: 'a4', name: 'Desjardins CAD', kind: 'bank', currency: 'CAD', institution: 'Desjardins' },
  { id: 'a5', name: 'Marge Desjardins', kind: 'bank', currency: 'CAD', institution: 'Desjardins' },
  { id: 'a6', name: 'Venn USD', kind: 'bank', currency: 'USD', institution: 'Venn' },
]

test('le numéro imprimé désigne le compte', () => {
  const det = detectAccount(
    { institution: 'Banque Nationale', account_number_masked: '**** 0224', currency: 'CAD', kind: 'bank' },
    [], ACCOUNTS,
  )
  assert.equal(det.account_id, 'a1')
  assert.ok(det.confidence > 0.5)
  assert.ok(det.evidence.some((e) => e.label === 'Numéro'))
})

test('une carte se distingue du compte chèque de la même banque', () => {
  const det = detectAccount(
    { institution: 'BNC', account_number_masked: '5258-8186-1234', currency: 'CAD', kind: 'card' },
    [], ACCOUNTS,
  )
  assert.equal(det.account_id, 'a3')
})

test('la devise sépare deux comptes de la même banque', () => {
  const det = detectAccount({ institution: 'Venn', currency: 'USD', kind: 'bank' }, [], ACCOUNTS)
  assert.equal(det.account_id, 'a6')
})

test('deux comptes indiscernables : on ne choisit pas à la place de l’humain', () => {
  const det = detectAccount({ institution: 'Desjardins', currency: 'CAD', kind: 'bank' }, [], ACCOUNTS)
  assert.equal(det.account_id, null)
  assert.equal(det.ambiguous, true)
  assert.ok(det.confidence < MIN_DETECT_CONFIDENCE)
})

test('des lignes déjà au compte tranchent une ambiguïté', () => {
  const det = detectAccount(
    { institution: 'Desjardins', currency: 'CAD', kind: 'bank' },
    [], ACCOUNTS, new Map([['a5', 3]]),
  )
  assert.equal(det.account_id, 'a5')
  assert.ok(det.evidence.some((e) => e.label === 'Recoupement'))
})

test('une capture muette se reconnaît à ses mouvements passés', () => {
  // Aucune institution, aucune devise, aucun numéro : rien d'écrit n'aide.
  // Quatre lignes retrouvées sur BNC Épargne suffisent.
  const det = detectAccount({}, [], ACCOUNTS, new Map([['a1', 4]]))
  assert.equal(det.account_id, 'a1')
  assert.equal(det.confidence, 1)
})

test('les mouvements passés l’emportent sur ce qui est écrit', () => {
  // Le document dit « Desjardins », mais ses lignes sont celles du BNC.
  const det = detectAccount(
    { institution: 'Desjardins', currency: 'CAD', kind: 'bank' },
    [], ACCOUNTS, new Map([['a1', 5], ['a4', 1]]),
  )
  assert.equal(det.account_id, 'a1')
})

test('un seul recoupement ne tranche pas tout seul', () => {
  // Une coïncidence de date et de montant arrive ; deux, beaucoup moins.
  const det = detectAccount({}, [], ACCOUNTS, new Map([['a4', 1], ['a5', 1]]))
  assert.notEqual(det.confidence, 1)
})

test('une devise contredite écarte le compte', () => {
  const usd = scoreAccount(ACCOUNTS[1], { institution: 'BNC', currency: 'CAD', kind: 'bank' })
  const cad = scoreAccount(ACCOUNTS[0], { institution: 'BNC', currency: 'CAD', kind: 'bank' })
  assert.ok(cad.score > usd.score)
})

test('un motif appris sur la fiche du compte est une preuve', () => {
  const account = { ...ACCOUNTS[3], statement_hints: 'EOP Compte avec privileges' }
  const s = scoreAccount(account, { institution: 'Desjardins', account_label: 'EOP Compte avec privilèges', currency: 'CAD' })
  assert.ok(s.evidence.some((e) => e.label === 'Appris'))
})

test('aucun indice exploitable : aucun compte deviné', () => {
  assert.equal(detectAccount({}, [], ACCOUNTS).account_id, null)
})

test('un export sans en-tête est reconnu par le nom du fichier', () => {
  // Un CSV de banque ne dit rien de lui-même ; son nom, si.
  const det = detectAccount({}, [], ACCOUNTS, new Map(), 'Desjardins CAD - septembre 2026.csv')
  assert.equal(det.account_id, 'a4')
  assert.ok(det.evidence.some((e) => e.label === 'Nom du fichier'))
})

test('un nom de fichier partiel ne suffit pas à désigner un compte', () => {
  // « Desjardins » seul ne choisit pas entre le compte et la marge.
  assert.equal(detectAccount({}, [], ACCOUNTS, new Map(), 'desjardins.pdf').account_id, null)
})

// ── Neuf ou déjà en base ─────────────────────────────────────────────────────
//
// La dédup du relevé est la MÊME que celle du fichier TRX_Orisha : signature
// (date | montant signé), sans le libellé — une lecture OCR ne formule jamais
// le libellé comme le collage, et la clé SQL, elle, l'inclut : s'y fier
// laisserait entrer chaque transaction une deuxième fois.

const sig = (d, a) => `${d}|${a.toFixed(2)}`

test('une ligne déjà en base ne repasse pas', () => {
  const rows = [
    { txn_date: '2026-09-02', amount: -45.2 },
    { txn_date: '2026-09-03', amount: 100.7 },
  ]
  const existing = new Map([[sig('2026-09-02', -45.2), 1]])
  const { toInsert, skipped } = planImportFromCounts(rows, existing, { maxDate: '2026-12-31' })
  assert.equal(toInsert.length, 1)
  assert.equal(skipped, 1)
  assert.equal(toInsert[0].txn_date, '2026-09-03')
})

test('trois achats identiques au relevé, un seul en base : deux entrent', () => {
  const rows = Array.from({ length: 3 }, () => ({ txn_date: '2026-09-02', amount: -5 }))
  const { toInsert } = planImportFromCounts(rows, new Map([[sig('2026-09-02', -5), 1]]), { maxDate: '2026-12-31' })
  assert.equal(toInsert.length, 2)
})

test('un paiement programmé, daté dans le futur, n’est pas importé', () => {
  const rows = [{ txn_date: '2027-01-15', amount: -800 }]
  const { toInsert, skipped } = planImportFromCounts(rows, new Map(), { maxDate: '2026-09-16' })
  assert.equal(toInsert.length, 0)
  assert.equal(skipped, 1)
})

// ── Ce que les vrais relevés MasterCard BNC ont appris ──────────────────────

test('une carte se reconnaît par son préfixe : le milieu du numéro est masqué', () => {
  // Fiche : « 5258-8186-**** ». Relevé : « 5258 818668 114807 ». Les 4 derniers
  // chiffres ne se rencontrent jamais — seul le préfixe les rapproche.
  const s = scoreAccount(ACCOUNTS[2], { account_number_masked: '5258 818668 114807', currency: 'CAD', kind: 'card' })
  assert.ok(s.evidence.some((e) => e.label === 'Numéro'))
  const det = detectAccount({ account_number_masked: '5258 818668 114807', currency: 'CAD', kind: 'card' }, [], ACCOUNTS)
  assert.equal(det.account_id, 'a3')
})

test('sur une carte, le solde est une DETTE : un achat le fait monter', () => {
  // 1 000 dus, 200 d'achats, 500 payés → 700 dus.
  const rows = [
    { txn_date: '2026-09-02', amount: -200 },
    { txn_date: '2026-09-05', amount: 500 },
  ]
  const check = checkBalance(rows, 1000, 700, { kind: 'card' })
  assert.equal(check.orientation, 'dette')
  assert.equal(check.ok, true)
})

test('sur un compte bancaire, le solde reste de l’argent', () => {
  const rows = [{ txn_date: '2026-09-02', amount: -200 }, { txn_date: '2026-09-05', amount: 500 }]
  const check = checkBalance(rows, 1000, 1300, { kind: 'bank' })
  assert.equal(check.orientation, 'argent')
  assert.equal(check.ok, true)
})

test('quand rien ne balance, l’orientation reste celle du compte', () => {
  // Le piège : élire l'orientation au plus petit écart ferait passer une ligne
  // manquante (−100,70) pour un écart de −10,30, et masquerait le défaut.
  const rows = [{ txn_date: '2026-09-02', amount: -45.2 }]
  const check = checkBalance(rows, 1000, 1055.5, { kind: 'bank' })
  assert.equal(check.orientation, 'argent')
  assert.equal(check.delta, -100.7)
})

test('une orientation qui tombe juste l’emporte sur celle du compte', () => {
  // Filet quand le type est inconnu ou mal deviné : si l'autre arithmétique
  // balance exactement, c'est elle qui a raison.
  const rows = [{ txn_date: '2026-09-02', amount: -200 }, { txn_date: '2026-09-05', amount: 500 }]
  const check = checkBalance(rows, 1000, 700, { kind: 'bank' })
  assert.equal(check.orientation, 'dette')
  assert.equal(check.ok, true)
})

test('la correction renvoyée au modèle dit la bonne arithmétique sur une carte', () => {
  const check = checkBalance([{ txn_date: '2026-09-02', amount: -200 }], 1000, 900, { kind: 'card' })
  assert.equal(check.orientation, 'dette')
  const msg = buildBalanceCorrection(check)
  assert.match(msg, /DETTE/)
  assert.match(msg, /MOINS/)
})

test('le nom du fichier donne la date d’arrêté du relevé', () => {
  assert.equal(dateHintFromName('CARTCRED_CREDCARD_4807_20260816.pdf'), '2026-08-16')
  assert.equal(dateHintFromName('releve-2026-07-15.pdf'), '2026-07-15')
  assert.equal(dateHintFromName('Desj CAD 2026-09.csv'), '2026-09-01')
  assert.equal(dateHintFromName('releve.pdf'), null)
})

test('une année inventée est dénoncée, jamais corrigée en douce', () => {
  // Vécu : un relevé d’août 2026 lu comme juillet 2023.
  const rows = [{ txn_date: '2023-07-17' }, { txn_date: '2023-08-06' }]
  assert.match(yearDriftAgainstHint('2026-08-16', rows), /Dates suspectes/)
  assert.equal(yearDriftAgainstHint('2026-08-16', [{ txn_date: '2026-07-17' }]), null)
  assert.equal(yearDriftAgainstHint(null, rows), null)
})

test('le solde d’ouverture déduit déclenche une passe corrective tardive', async () => {
  // Sur un relevé de carte, l'ouverture ne vient pas du document mais du relevé
  // précédent : l'écart n'existe qu'APRÈS l'extraction, donc la boucle interne
  // n'avait rien à contrôler. La passe tardive est le seul recours.
  const { refineWithBalance } = await import('./bankStatementImport.js')
  let seen = null
  const fake = async (messages) => { seen = messages; return EXTRACT }
  const check = checkBalance([{ txn_date: '2026-09-02', amount: -45.2 }], 1000, 1055.5, { kind: 'bank' })
  const out = await refineWithBalance([{ text: 'relevé' }], EXTRACT, check, { call: fake })
  assert.equal(out, EXTRACT)
  // Système + document + réponse précédente + correction chiffrée.
  assert.equal(seen.length, 4)
  assert.match(seen[3].content, /100\.70/)
})

// ── Relevés Desjardins : plusieurs comptes sur un folio ─────────────────────

// Folio d'août 2026 : le compte à opérations (EOP) PUIS la marge (MC 2), que
// le modèle avait recopiée à la suite — écart de −49 468,77.
const EOP = [
  { txn_date: '2026-08-03', amount: -531.23, balance: 274.07 },
  { txn_date: '2026-08-11', amount: -25000, balance: -24725.93 },
  { txn_date: '2026-08-11', amount: 25000, balance: 274.07 },
  { txn_date: '2026-08-17', amount: -25000, balance: -24725.93 },
  { txn_date: '2026-08-17', amount: 25000, balance: 274.07 },
  { txn_date: '2026-08-31', amount: -42, balance: 232.07 },
]
const MC2 = [
  { txn_date: '2026-08-03', amount: 531.23, balance: 98000 },
  { txn_date: '2026-08-11', amount: -25000, balance: 123000 },
  { txn_date: '2026-08-17', amount: -25000, balance: 148000 },
]

test('les lignes d’une autre section du folio sont écartées par la colonne Solde', () => {
  assert.equal(checkBalance([...EOP, ...MC2], 805.3, 232.07).ok, false)
  const out = isolateAccountChain([...EOP, ...MC2], 805.3, 232.07)
  assert.equal(out.dropped, 3)
  assert.deepEqual(out.rows, EOP)
  assert.equal(checkBalance(out.rows, 805.3, 232.07).ok, true)
  // Section étrangère AVANT le compte : même verdict.
  assert.deepEqual(isolateAccountChain([...MC2, ...EOP], 805.3, 232.07).rows, EOP)
})

test('sans chaîne unique qui balance, on ne retire rien', () => {
  // Déjà juste : rien à isoler.
  assert.equal(isolateAccountChain(EOP, 805.3, 232.07), null)
  // Une ligne sautée casse la chaîne : l'écart doit rester visible.
  assert.equal(isolateAccountChain([EOP[0], ...EOP.slice(2)], 805.3, 232.07), null)
  // Soldes absents : pas de preuve.
  assert.equal(isolateAccountChain([...EOP, { ...MC2[0], balance: null }], 805.3, 232.07), null)
  assert.equal(isolateAccountChain([...EOP, ...MC2], null, 232.07), null)
})

test('un relevé sans mouvement balance s’il ouvre et ferme au même solde', () => {
  assert.equal(checkBalance([], 0, 0).ok, true)
  assert.equal(checkBalance([], 0, 0, { kind: 'card' }).ok, true)
  assert.equal(checkBalance([], 10, 0).ok, false)
})

test('un relevé qui contredit son compte n’est pas vérifié', () => {
  const usd = { name: 'Desjardins USD', currency: 'USD', kind: 'bank' }
  // Le dossier USD contenait le relevé d'un compte en CAD, à zéro.
  assert.match(accountMismatch(usd, { currency: 'CAD', rowCount: 0, closing: 0 }), /en CAD/)
  // Même devise, mais « aucun mouvement » alors que le compte est à 35,34 $.
  const known = { txn_date: '2026-08-31', balance: 35.34 }
  assert.ok(accountMismatch(usd, { currency: 'USD', rowCount: 0, closing: 0, knownBalance: known }).startsWith(ACCOUNT_MISMATCH))
  assert.equal(accountMismatch(usd, { currency: 'USD', rowCount: 0, closing: 35.34, knownBalance: known }), null)
  // Carte : la dette peut être signée des deux côtés.
  const visa = { name: 'VISA Desjardins CAD', currency: 'CAD', kind: 'card' }
  assert.equal(accountMismatch(visa, { currency: 'CAD', rowCount: 0, closing: 147, knownBalance: { txn_date: '2026-08-01', balance: -147 } }), null)
  assert.equal(accountMismatch(visa, { currency: 'CAD', rowCount: 0, closing: 0, knownBalance: { txn_date: '2026-07-24', balance: 0 } }), null)
  // Des lignes au relevé : l'arithmétique suffit, pas de comparaison au solde connu.
  assert.equal(accountMismatch(usd, { currency: 'USD', rowCount: 3, closing: 0, knownBalance: known }), null)
  assert.equal(accountMismatch(null, { currency: 'CAD' }), null)
})

test('le compte visé est dit au modèle, et une section étrangère ne relance pas la lecture', async () => {
  let calls = 0
  let seen = null
  const read = {
    institution: 'Desjardins', currency: 'CAD', kind: 'bank', opening_balance: 805.3, closing_balance: 232.07,
    rows: [...EOP, ...MC2].map((r) => ({ txn_date: r.txn_date, description: 'x', debit: r.amount < 0 ? -r.amount : null, credit: r.amount > 0 ? r.amount : null, balance: r.balance })),
  }
  const fake = async (messages) => { calls++; seen = messages; return read }
  const account = { name: 'Desjardins CAD', currency: 'CAD', kind: 'bank', statement_hints: null }
  const out = await extractStatement([{ text: 'folio' }], { call: fake, accountHint: account })
  assert.equal(calls, 1)
  assert.equal(out.check.ok, true)
  assert.ok(seen[1].content.some((c) => c.type === 'text' && c.text === accountHintText(account)))
  assert.match(accountHintText(account), /« Desjardins CAD » \(compte bancaire, CAD\)/)
})

test('detectAccount : un solde qui enchaîne avec un seul compte suffit', () => {
  const det = detectAccount({}, [], ACCOUNTS, new Map(), 'transactions.csv', new Map([['a1', 1]]))
  assert.equal(det.account_id, 'a1')
  assert.equal(det.confidence, 1)
  assert.ok(det.evidence.some((e) => e.label === 'Solde'))
})

test('detectAccount : deux comptes qui enchaînent → rien de pré-sélectionné par le solde seul', () => {
  const det = detectAccount({}, [], ACCOUNTS, new Map(), '', new Map([['a1', 1], ['a2', 1]]))
  assert.notEqual(det.confidence, 1)
})

test('export BNC anglais : la date de transaction, pas la date d’inscription au relevé', () => {
  const table = [
    ['5258 81** **** 4807'],
    ['Transaction date', 'Card number', 'Date carried to statement', 'Reference', 'Status', 'Description', 'Amount'],
    ['2026-09-25', '525881******4815', '2026-10-01', 'U618161134', 'Authorized', 'PREMIER FARNELL        MISSISSAUGA   ON  CAN ON', '-1273.64'],
  ]
  const { rows } = parseStatementTable(table)
  assert.equal(rows[0].txn_date, '2026-09-25')
  assert.equal(rows[0].bank_state, 'autorise')
  const fr = parseStatementTable([
    ['Date de la transaction', 'Numéro de carte', 'Date associée au relevé', 'Référence', 'Statut', 'Description', 'Montant'],
    ['2026-09-23', 'x', '2026-09-24', 'U1', 'Autorisée', 'PREMIER FARNELL', '-298.02'],
  ])
  assert.equal(fr.rows[0].txn_date, '2026-09-23')
  const postedOnly = parseStatementTable([['Posting date', 'Description', 'Amount'], ['2026-09-24', 'X', '-1']])
  assert.equal(postedOnly.rows[0].txn_date, '2026-09-24')
})
