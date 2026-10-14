// Bulle « Claude » du rapprochement (Charles, 2026-10-13, maquette B2 « projecteur »).
//
// Ce que le passage de vérification trouve d'anormal sur un compte devient un
// message de Claude, attaché à SA ligne du relevé (la page l'éclaire quand la
// bulle est ouverte). Une anomalie qui disparaît d'un passage suivant se ferme
// seule ; « Ignorer » la ferme pour de bon (elle ne revient plus). Les lignes
// passées au vert automatiquement laissent une petite trace dans le même fil.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { emit } from './realtime.js'
import { shiftDate } from '../utils/datetime.js'

// Anomalies remontées : écart de montant, doublon, ligne comptabilisée
// introuvable, écriture QB sans ligne de relevé. « À comptabiliser » n'en est
// pas une : c'est le travail normal de la page.
const KIND_LABEL = {
  ecart_compte: 'Écart banque ↔ QuickBooks',
  ecart_montant: 'Montant différent dans QuickBooks',
  doublon_releve: 'Doublon probable',
  comptabilisee_introuvable: 'Introuvable dans QuickBooks',
  qb_sans_releve: 'Dans QuickBooks, pas au relevé',
}

const money = (n) => Number(n || 0).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function claudeChanged(accountId) {
  emit([`bank_claude:${accountId}`], { type: 'bank_claude:changed', payload: { account_id: accountId }, ts: Date.now() })
}

function insertMessage(m) {
  const id = newRecordId()
  db.prepare(`
    INSERT INTO bank_claude_messages (id, account_id, txn_id, role, kind, finding_key, body, card, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, m.account_id, m.txn_id || null, m.role, m.kind || null, m.finding_key || null,
    m.body || '', m.card ? JSON.stringify(m.card) : null, m.user_id || null)
  return id
}

/** Les constats d'un passage → messages. `from`/`to` = fenêtre réellement examinée. */
export function syncFindings(account, { anomalies = [], gaps = [], balance = null, from, to }) {
  // Pas d'historique ancien dans la bulle : le mois précédent et le courant.
  const today = new Date().toISOString().slice(0, 10)
  const since = shiftDate(today.slice(0, 8) + '01', -1).slice(0, 8) + '01'
  const wanted = new Map()
  for (const g of gaps) {
    if (g.method === 'conversion' || Math.abs(Number(g.delta) || 0) < 0.01) continue
    wanted.set(`ecart_montant|${account.id}|${g.txn_id}`, {
      kind: 'ecart_montant', txn_id: g.txn_id, date: g.date, amount: g.amount, label: g.label,
      body: `Écart de ${money(Math.abs(g.delta))} $ avec QuickBooks${g.qb_name ? ` (${g.qb_name})` : ''}.`,
      qb: g.qb_date ? `QB ${g.qb_date}` : null,
    })
  }
  for (const a of anomalies) {
    if (!KIND_LABEL[a.kind]) continue
    wanted.set(a.key, {
      kind: a.kind, txn_id: a.txn_id || null, date: a.date, amount: a.amount, label: a.label,
      body: a.explanation || KIND_LABEL[a.kind],
    })
  }
  for (const [k, f] of wanted) if (!f.date || f.date < since) wanted.delete(k)
  // Le solde du compte ne colle pas à QuickBooks : UN message par écart (la clé
  // porte le montant — un nouvel écart ferme l'ancien message).
  const diff = balance && !balance.error && balance.difference != null ? Number(balance.difference) : null
  const balanceKnown = diff != null
  if (balanceKnown && Math.abs(diff) >= 0.005) {
    wanted.set(`ecart_compte|${account.id}|${diff.toFixed(2)}`, {
      kind: 'ecart_compte', txn_id: null, date: balance.statement_date, amount: diff, label: 'Solde du compte',
      body: `Banque ${money(balance.statement)}, QuickBooks ${money(balance.qb_as_of)} au ${balance.statement_date}.`,
    })
  }

  const open = db.prepare(`
    SELECT id, finding_key, card FROM bank_claude_messages
    WHERE account_id=? AND role='claude' AND finding_key IS NOT NULL AND resolved_at IS NULL
  `).all(account.id)
  const openKeys = new Set(open.map((m) => m.finding_key))
  const ignored = db.prepare(`SELECT 1 FROM bank_claude_messages WHERE finding_key=? AND resolution='ignore' LIMIT 1`)
  let changed = 0
  db.transaction(() => {
    for (const [key, f] of wanted) {
      if (openKeys.has(key) || ignored.get(key)) continue
      insertMessage({
        account_id: account.id, txn_id: f.txn_id, role: 'claude', kind: f.kind, finding_key: key,
        body: f.body,
        card: { date: f.date, label: f.label, amount: f.amount, account: account.name, title: KIND_LABEL[f.kind], qb: f.qb || null },
      })
      changed++
    }
    // Fermeture : seulement ce que CE passage a pu revoir (fenêtre examinée).
    const close = db.prepare(`UPDATE bank_claude_messages SET resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution='auto' WHERE id=?`)
    for (const m of open) {
      if (wanted.has(m.finding_key)) continue
      if (m.finding_key.startsWith('ecart_compte|')) { if (!balanceKnown) continue; close.run(m.id); changed++; continue }
      const d = (() => { try { return JSON.parse(m.card || '{}').date } catch { return null } })()
      if (d && from && to && (d < from || d > to)) continue
      close.run(m.id)
      changed++
    }
  })()
  if (changed) claudeChanged(account.id)
  return changed
}

/** Trace « ✓ … rapprochées » quand l'automate passe des lignes au vert. */
export function noteGreen(ids) {
  if (!ids?.length) return
  const rows = db.prepare(`
    SELECT id, account_id, COALESCE(NULLIF(description,''), details) AS label FROM bank_transactions
    WHERE id IN (${ids.map(() => '?').join(',')})
  `).all(...ids)
  const byAcct = new Map()
  for (const r of rows) {
    if (!byAcct.has(r.account_id)) byAcct.set(r.account_id, [])
    byAcct.get(r.account_id).push(r)
  }
  for (const [accountId, list] of byAcct) {
    const names = list.slice(0, 3).map((r) => String(r.label || '').slice(0, 28).trim()).join(', ')
    const more = list.length > 3 ? ` +${list.length - 3}` : ''
    insertMessage({ account_id: accountId, role: 'sys', kind: 'green', body: `${names}${more}`, card: { n: list.length } })
    claudeChanged(accountId)
  }
}

export function listMessages(accountId, { limit = 60 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM bank_claude_messages WHERE account_id=?
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(accountId, limit).reverse()
  const open = db.prepare(`
    SELECT COUNT(*) AS n FROM bank_claude_messages
    WHERE account_id=? AND role='claude' AND finding_key IS NOT NULL AND resolved_at IS NULL
  `).get(accountId).n
  return {
    open,
    messages: rows.map((r) => ({ ...r, card: r.card ? JSON.parse(r.card) : null })),
  }
}

/** Compteur par compte (pastille de la bulle, tous comptes). */
export function openCounts() {
  return db.prepare(`
    SELECT account_id, COUNT(*) AS n FROM bank_claude_messages
    WHERE role='claude' AND finding_key IS NOT NULL AND resolved_at IS NULL GROUP BY account_id
  `).all()
}

export function dismissMessage(id) {
  const m = db.prepare('SELECT account_id FROM bank_claude_messages WHERE id=?').get(id)
  if (!m) return null
  db.prepare(`UPDATE bank_claude_messages SET resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution='ignore' WHERE id=?`).run(id)
  claudeChanged(m.account_id)
  return m.account_id
}

export function addUserMessage(accountId, body, userId, txnId = null) {
  const id = insertMessage({ account_id: accountId, role: 'user', body, user_id: userId, txn_id: txnId })
  claudeChanged(accountId)
  return id
}

export function addClaudeReply(accountId, body, txnId = null) {
  const id = insertMessage({ account_id: accountId, role: 'claude', kind: 'reply', body, txn_id: txnId })
  claudeChanged(accountId)
  return id
}

// ── Répondre à Claude ────────────────────────────────────────────────────────
// Claude répond depuis le contexte que Boréal lui donne (compte, écart, lignes
// signalées, fil). Il n'a aucun outil : il explique et dit quoi faire ; les
// gestes restent à l'écran (« Voir » ouvre la ligne).
const pending = new Set()

function contextFor(accountId, txnId) {
  const acct = db.prepare('SELECT id, name, currency, kind FROM bank_accounts WHERE id=?').get(accountId)
  const open = db.prepare(`
    SELECT kind, body, card FROM bank_claude_messages
    WHERE account_id=? AND role='claude' AND finding_key IS NOT NULL AND resolved_at IS NULL
    ORDER BY created_at DESC LIMIT 15
  `).all(accountId)
  const thread = db.prepare(`
    SELECT role, body FROM bank_claude_messages WHERE account_id=? AND role IN ('user','claude')
    ORDER BY created_at DESC, rowid DESC LIMIT 12
  `).all(accountId).reverse()
  const txn = txnId ? db.prepare(`
    SELECT txn_date, description, details, amount, status, qb_txn_type, qb_txn_id, qb_match_delta, matched_type
    FROM bank_transactions WHERE id=?
  `).get(txnId) : null
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND txn_date >= date('now','-60 day') GROUP BY status
  `).all(accountId)
  // Les lignes pas encore dans QuickBooks : c'est souvent elles qui font l'écart.
  const todo = db.prepare(`
    SELECT txn_date, COALESCE(NULLIF(description,''), details) AS label, amount, status FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status NOT IN ('rapproche','ignore','comptabilise')
      AND txn_date >= date('now','-60 day') ORDER BY txn_date DESC LIMIT 25
  `).all(accountId)
  return { acct, open, thread, txn, counts, todo }
}

export function buildReplyPrompt(ctx) {
  const lines = [
    "Tu es Claude, dans la bulle du rapprochement bancaire de Boréal (l'ERP d'Orisha). Charles, le comptable, te parle.",
    'Réponds en français, en 1 à 3 phrases courtes, sans jargon technique ni nom de fichier. Pas de markdown lourd.',
    "Tu n'as aucun outil : tu ne peux rien modifier. Si un geste est nécessaire, dis lequel faire dans Boréal ou QuickBooks.",
    'Les couleurs : rouge = à traiter, jaune = comptabilisée, vert = rapprochée.',
    '',
    `Compte : ${ctx.acct?.name} (${ctx.acct?.currency || 'CAD'}, ${ctx.acct?.kind === 'card' ? 'carte' : 'banque'}).`,
    `Lignes des 60 derniers jours par statut : ${ctx.counts.map((c) => `${c.status} ${c.n}`).join(', ') || 'aucune'}.`,
  ]
  if (ctx.open.length) {
    lines.push('', 'Anomalies ouvertes :')
    for (const o of ctx.open) {
      const c = o.card ? JSON.parse(o.card) : {}
      lines.push(`- ${c.date} · ${c.label} · ${c.amount} — ${c.title} : ${o.body}`)
    }
  }
  if (ctx.todo?.length) {
    lines.push('', 'Lignes du relevé pas encore dans QuickBooks (60 jours) — leur somme explique souvent un écart :')
    for (const t of ctx.todo) lines.push(`- ${t.txn_date} · ${t.label} · ${t.amount} · ${t.status}`)
  }
  if (ctx.txn) {
    lines.push('', `Ligne visée : ${ctx.txn.txn_date} · ${ctx.txn.description || ctx.txn.details} · ${ctx.txn.amount} · statut ${ctx.txn.status}` +
      (ctx.txn.qb_txn_id ? ` · liée à QuickBooks ${ctx.txn.qb_txn_type} ${ctx.txn.qb_txn_id}${ctx.txn.qb_match_delta ? ` (écart ${ctx.txn.qb_match_delta})` : ''}` : ' · pas liée à QuickBooks'))
  }
  lines.push('', 'Conversation :')
  for (const m of ctx.thread) lines.push(`${m.role === 'user' ? 'Charles' : 'Claude'} : ${m.body}`)
  lines.push('', 'Ta réponse :')
  return lines.join('\n')
}

export async function replyTo(accountId, txnId = null) {
  if (pending.has(accountId)) return
  pending.add(accountId)
  emit([`bank_claude:${accountId}`], { type: 'bank_claude:typing', payload: { account_id: accountId, typing: true }, ts: Date.now() })
  try {
    const { runToollessClaude } = await import('./taskRunner.js')
    const out = await runToollessClaude({ prompt: buildReplyPrompt(contextFor(accountId, txnId)), model: 'sonnet', effort: 'low', timeoutMs: 120_000 })
    addClaudeReply(accountId, out.code === 0 && out.text ? out.text : "Je n'ai pas pu répondre, réessaie dans un instant.", txnId)
  } catch (e) {
    addClaudeReply(accountId, "Je n'ai pas pu répondre, réessaie dans un instant.", txnId)
    console.error('bankClaude.replyTo:', e.message)
  } finally {
    pending.delete(accountId)
  }
}

// ── Corrections prêtes (maquette K3 « tout d'un coup », 2026-10-13) ──────────
// Pour chaque ligne rouge du compte, le geste en un clic que Boréal sait déjà
// faire : proposition du moteur, pièce appariée à publier, virement dont
// l'autre moitié est au relevé, règle « exclure ». Rien n'est exécuté ici :
// l'écran les coche, et « Tout faire » passe par les routes habituelles.
const QB_TYPE_FR = { expense: 'Dépense', purchase: 'Dépense', deposit: 'Dépôt', transfer: 'Virement', billpayment: 'Paiement de facture', bill: 'Facture', journalentry: 'Écriture de journal', payment: 'Paiement', check: 'Chèque', creditcardcredit: 'Crédit de carte', creditcardpayment: 'Paiement de carte' }

function proposalText(p) {
  const pl = (() => { try { return JSON.parse(p.payload || '{}') } catch { return {} } })()
  if (p.kind === 'qb_link') {
    const t = QB_TYPE_FR[pl.qb_txn_type] || 'Écriture'
    return `Lier à ${t} QuickBooks du ${pl.date || '?'}${pl.method === 'autre_compte' && pl.account_name ? ` (portée à ${pl.account_name})` : ''}`
  }
  if (['vendor_expense', 'qb_habit'].includes(p.kind)) return `Dépense ${pl.vendor || ''}`.trim()
  if (p.kind === 'doc_match' || p.kind === 'invoice_found') return 'Apparier à la pièce trouvée'
  if (p.kind === 'payment_clear') return 'Paiement émis passé à la banque'
  if (p.kind === 'paie_debit') return 'Débit de la paie'
  if (p.kind === 'debt_payment') return 'Remboursement de dette'
  if (p.kind === 'aga_repartition') return 'Répartition AGA'
  return 'Appliquer la proposition'
}

export async function readyFixes(accountId) {
  const rows = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND COALESCE(pending,0)=0
      AND status NOT IN ('rapproche','ignore','comptabilise')
      AND (qb_txn_id IS NULL OR qb_txn_id='') AND transfer_txn_id IS NULL
      AND txn_date >= date('now','-90 day')
    ORDER BY txn_date DESC LIMIT 40
  `).all(accountId)
  const { findTransferCandidates } = await import('./bankActions.js')
  const { matchedDocState } = await import('./bankMatchPublish.js')
  const { ruleForTxn } = await import('./bankRules/store.js')
  const prop = db.prepare(`SELECT * FROM bank_proposals WHERE bank_txn_id=? AND status='proposee' ORDER BY created_at LIMIT 1`)
  const fixes = []
  const manual = []
  for (const t of rows) {
    const base = { txn_id: t.id, date: t.txn_date, amount: t.amount, label: t.details || t.description || '' }
    const p = prop.get(t.id)
    if (p) {
      let pl = {}
      try { pl = JSON.parse(p.payload || '{}') } catch { pl = {} }
      // Une écriture déjà dans CE compte QB ne change pas son solde ; une
      // écriture publiée, oui.
      const moves = ['vendor_expense', 'qb_habit', 'aga_repartition'].includes(p.kind)
      fixes.push({ ...base, how: 'proposal', proposal_id: p.id, text: proposalText(p), moves, warn: pl.method === 'autre_compte' })
      continue
    }
    const doc = t.matched_id ? matchedDocState(t) : null
    if (doc && !doc.booked && !doc.blocked) { fixes.push({ ...base, how: 'publish_matched', text: `Publier ${doc.label}`, moves: true }); continue }
    const cands = findTransferCandidates(t).filter((c) => !c.fx && !c.qb_txn_id)
    // Sûr : même jour ou presque, ou seule contrepartie possible à 5 jours près.
    const tr = cands[0] && (cands[0].confidence >= 0.9 || (cands.length === 1 && cands[0].confidence >= 0.75)) ? cands[0] : null
    if (tr) {
      // L'autre moitié est peut-être déjà dans la liste (même compte) : un seul virement.
      if (!fixes.some((f) => f.counterpart_txn_id === t.id)) {
        fixes.push({ ...base, how: 'transfer', counterpart_txn_id: tr.id, text: `Virement ${t.amount < 0 ? 'vers' : 'depuis'} ${tr.account_name}`, moves: true })
      }
      continue
    }
    let rule = null
    try { rule = ruleForTxn(t) } catch { rule = null }
    if (rule?.action === 'exclure') { fixes.push({ ...base, how: 'exclude', text: `Exclure (règle ${rule.name})`, moves: false }); continue }
    manual.push(base)
  }
  return { fixes, manual }
}
