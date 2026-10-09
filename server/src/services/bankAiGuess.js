/**
 * Le dernier recours du rapprochement : déduire la nature d'une ligne du relevé
 * quand aucune mémoire (ERP, QuickBooks, règle, profil) n'en dit rien.
 *
 * Demande de Charles (2026-10-06) : « si tu trouves rien dans le passé, raisonne
 * toi-même : c'est quoi la nature de la transaction et dans quel compte on
 * devrait la comptabiliser — il y en a que c'est assez évident ».
 *
 * L'IA reçoit le libellé, le montant, le compte du relevé, le plan comptable
 * QuickBooks et, pour chaque compte, des libellés réels qu'on y a déjà passés.
 * Elle ne choisit qu'un compte de la liste (sinon rien). La déduction est
 * gardée par libellé (`bank_ai_guesses`) et ne fait que PRÉ-REMPLIR : la
 * publication reste un geste humain, avec la source « déduit » sous le champ.
 */
import db from '../db/database.js'
import { labelKey, isWrapperKey } from './bankLabelMemory.js'
import { accountExamples } from './bankQbHabit.js'
import { txnFacts } from './bankTxnFacts.js'

const GEMINI_MODEL = 'gemini-3.5-flash'
const OPENAI_MODEL = 'gpt-4o-mini'
const MIN_CONFIDENCE = 0.55

const txnLabel = (t) => (t?.details || '').trim() || (t?.description || '').trim() || ''

// Le plan comptable, relu au plus toutes les heures.
let chart = null
async function chartOfAccounts(fetchAccounts) {
  if (chart && Date.now() - chart.at < 3600_000) return chart.list
  const run = fetchAccounts || (async () => {
    const { qbGet } = await import('../connectors/quickbooks.js')
    const q = 'SELECT Id, Name, AcctNum, AccountType, FullyQualifiedName, CurrencyRef FROM Account WHERE Active = true MAXRESULTS 1000'
    return (await qbGet(`/query?query=${encodeURIComponent(q)}`))?.QueryResponse?.Account || []
  })
  const list = (await run()).map((a) => ({
    id: String(a.Id), num: a.AcctNum || null, name: a.FullyQualifiedName || a.Name,
    type: a.AccountType, currency: a.CurrencyRef?.value || null,
  }))
  chart = { at: Date.now(), list }
  return list
}

/** La clé de mémoire : le libellé et le sens ; un libellé muet garde sa ligne. PUR. */
export function guessKey(txn) {
  const key = labelKey(txn)
  const sign = txn.amount < 0 ? '-' : '+'
  if (!key || isWrapperKey(key)) return `txn:${txn.id}`
  return `${txn.account_id}|${key}|${sign}`
}

/** La question posée à l'IA. PUR. */
export function buildPrompt(txn, account, accounts, examples) {
  const facts = txnFacts(txn)
  const out = txn.amount < 0
  const lines = accounts
    .filter((a) => a.id !== String(account?.qb_account_id || ''))
    .map((a) => {
      const ex = examples.get(a.id)
      return `${a.id} | ${a.num ? `${a.num} ` : ''}${a.name} | ${a.type}${a.currency && a.currency !== 'CAD' ? ` | ${a.currency}` : ''}${ex ? ` | déjà utilisé pour : ${ex.join(' ; ')}` : ''}`
    })
  return [
    'Tu es le comptable d\'Orisha, une PME québécoise (IoT et automatisation pour serres : conception, fabrication, vente directe).',
    'Une ligne de relevé bancaire n\'a aucun historique. Déduis sa nature et le compte QuickBooks où la comptabiliser.',
    '',
    `Libellé : ${txnLabel(txn)}`,
    `Montant : ${Math.abs(txn.amount).toFixed(2)} ${account?.currency || 'CAD'} — ${out ? 'SORTIE d\'argent (dépense, paiement, virement sortant)' : 'ENTRÉE d\'argent (dépôt, remboursement, virement entrant)'}`,
    `Date : ${txn.txn_date}`,
    `Compte du relevé : ${account?.name || ''} (${account?.kind === 'card' ? 'carte de crédit' : 'compte bancaire'}, ${account?.currency || 'CAD'})`,
    txn.bank_category ? `Catégorie donnée par la banque : ${txn.bank_category}` : null,
    txn.txn_type ? `Type au relevé : ${txn.txn_type}` : null,
    facts.foreign ? `Montant d'origine : ${Math.abs(facts.foreign.amount)} ${facts.foreign.currency}` : null,
    '',
    'Plan comptable (id | numéro et nom | type | exemples réels) :',
    ...lines,
    '',
    'Règles :',
    '- account_id DOIT être un id de la liste ci-dessus, sinon null.',
    '- Un virement vers un autre compte bancaire, une carte de crédit ou une marge : choisis ce compte (type Bank, Credit Card ou passif).',
    '- Un logiciel ou abonnement en ligne, des frais bancaires, des intérêts, du carburant, des repas, des taxes : choisis le compte de dépense qui correspond, en t\'inspirant des exemples réels.',
    '- vendor : le nom propre du marchand ou de l\'organisme, lisible (ex. « Google », « Hydro-Québec »), sans ville ni numéros ; null si le libellé ne nomme personne.',
    '- memo : 2 à 5 mots, la nature (ex. « Abonnement logiciel », « Frais bancaires »).',
    '- confidence entre 0 et 1 : honnête. Sous 0.5 si tu devines.',
    '',
    'Réponds en JSON seulement : {"nature": "...", "vendor": "..."|null, "account_id": "..."|null, "memo": "...", "confidence": 0.0, "reason": "une phrase"}',
  ].filter((l) => l !== null).join('\n')
}

/** Lit la réponse et ne garde qu'un compte qui existe. PUR. */
export function parseGuess(text, accounts) {
  let j
  try { j = JSON.parse(String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const acct = accounts.find((a) => a.id === String(j.account_id || ''))
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0))
  const clean = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
  return {
    nature: clean(j.nature, 80),
    vendor: clean(j.vendor, 80),
    account_id: acct?.id || null,
    account_type: acct?.type || null,
    memo: clean(j.memo, 60),
    confidence,
    reason: clean(j.reason, 200),
  }
}

export async function ask(prompt, fetchImpl = fetch) {
  const key = process.env.GEMINI_API_KEY
  if (key) {
    try {
      const resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) throw new Error(`Gemini ${resp.status}`)
      const data = await resp.json()
      return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')
    } catch (e) {
      if (!process.env.OPENAI_API_KEY) throw e
    }
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Aucune clé IA configurée')
  const resp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}`)
  return (await resp.json())?.choices?.[0]?.message?.content
}

const inflight = new Map()

/**
 * La déduction pour une ligne : gardée, ou demandée à l'IA. `null` quand l'IA
 * doute (sous MIN_CONFIDENCE) ou ne trouve aucun compte de la liste.
 */
export async function aiGuessFor(txn, account, { fetchImpl = fetch, fetchAccounts = null, fresh = false } = {}) {
  if (!txn || !txnLabel(txn)) return null
  const key = guessKey(txn)
  if (!fresh) {
    const row = db.prepare('SELECT guess FROM bank_ai_guesses WHERE key = ?').get(key)
    if (row) return usable(JSON.parse(row.guess || 'null'))
  }
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => {
    const accounts = await chartOfAccounts(fetchAccounts)
    const examples = new Map(accountExamples({ sign: txn.amount < 0 ? '-' : '+' }).map((e) => [e.acct, e.labels]))
    const guess = parseGuess(await ask(buildPrompt(txn, account, accounts, examples), fetchImpl), accounts)
    db.prepare(`INSERT INTO bank_ai_guesses (key, guess) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET guess = excluded.guess, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(key, JSON.stringify(guess))
    return usable(guess)
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

const usable = (g) => (g && g.account_id && g.confidence >= MIN_CONFIDENCE ? g : null)

/** La source affichée sous un champ rempli par déduction. PUR. */
export const guessSource = (g) => `déduit : ${g.nature || 'nature du libellé'}`
