import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import * as postmark from 'postmark'

const router = Router()
router.use(requireAuth)

// ── Winback candidate detection ──────────────────────────────────────────────

function detectWinbackCandidates(tenantId) {
  // Find companies with canceled subscriptions > 6 months ago
  const canceled = db.prepare(`
    SELECT
      s.id as sub_id,
      s.company_id,
      s.amount_monthly,
      s.currency,
      s.start_date,
      s.cancel_date,
      s.notes as sub_notes,
      c.name as company_name,
      c.email as company_email,
      c.phone as company_phone,
      c.address, c.city, c.province, c.country,
      c.notes as company_notes,
      c.lifecycle_phase
    FROM subscriptions s
    JOIN companies c ON c.id = s.company_id AND c.tenant_id = s.tenant_id
    WHERE s.tenant_id = ?
      AND s.status = 'canceled'
      AND COALESCE(s.cancel_date, s.start_date) < date('now', '-180 days')
    ORDER BY s.cancel_date DESC
    LIMIT 10
  `).all(tenantId)

  return canceled.map(sub => {
    // Contacts de l'entreprise
    const contacts = db.prepare(`
      SELECT first_name, last_name, email, phone, mobile, language
      FROM contacts
      WHERE company_id = ? AND tenant_id = ?
      ORDER BY created_at ASC
      LIMIT 5
    `).all(sub.company_id, tenantId)

    // Historique des commandes
    const orderHistory = db.prepare(`
      SELECT COUNT(*) as total_orders,
             MAX(created_at) as last_order,
             SUM(cout_total) as total_spent
      FROM orders
      WHERE company_id = ? AND tenant_id = ?
    `).get(sub.company_id, tenantId)

    // Dernières interactions (appels, emails, notes, réunions) — ancien système
    const interactionsOld = db.prepare(`
      SELECT i.type, i.direction, i.timestamp,
             e.subject as email_subject, e.body_text as email_body,
             m.title as meeting_title, m.notes as meeting_notes,
             ca.transcript_formatted as call_transcript,
             COALESCE(ct.first_name || ' ' || ct.last_name, NULL) as contact_name
      FROM interactions i
      LEFT JOIN emails e ON e.interaction_id = i.id
      LEFT JOIN meetings m ON m.interaction_id = i.id
      LEFT JOIN calls ca ON ca.interaction_id = i.id
      LEFT JOIN contacts ct ON ct.id = i.contact_id
      WHERE i.company_id = ? AND i.tenant_id = ?
      ORDER BY i.timestamp DESC
      LIMIT 6
    `).all(sub.company_id, tenantId)

    // Interactions nouveau système (base_interactions)
    const interactionsNew = db.prepare(`
      SELECT bi.type, bi.direction, bi.created_at as timestamp,
             bi.subject as email_subject, bi.body as body_text,
             bi.duration_seconds
      FROM base_interactions bi
      JOIN base_interaction_links bil ON bil.interaction_id = bi.id
      WHERE bil.record_id = ? AND bi.tenant_id = ?
        AND bi.deleted_at IS NULL
      ORDER BY bi.created_at DESC
      LIMIT 6
    `).all(sub.company_id, tenantId)

    const interactions = [...interactionsOld, ...interactionsNew]
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      .slice(0, 8)

    // Factures/billets ouverts
    const openBills = db.prepare(`
      SELECT COUNT(*) as count, SUM(total_cad) as total
      FROM factures_fournisseurs
      WHERE vendor_id = ? AND tenant_id = ? AND status NOT IN ('Payée','paid')
    `).get(sub.company_id, tenantId)

    return {
      sub_id: sub.sub_id,
      company_id: sub.company_id,
      company_name: sub.company_name,
      company_email: sub.company_email,
      company_phone: sub.company_phone,
      address: [sub.address, sub.city, sub.province, sub.country].filter(Boolean).join(', '),
      company_notes: sub.company_notes,
      lifecycle_phase: sub.lifecycle_phase,
      subscription: {
        amount_monthly: sub.amount_monthly,
        currency: sub.currency,
        start_date: sub.start_date,
        cancel_date: sub.cancel_date,
        notes: sub.sub_notes,
      },
      contacts: contacts.map(ct => ({
        name: `${ct.first_name} ${ct.last_name}`,
        email: ct.email,
        phone: ct.phone || ct.mobile,
        language: ct.language,
      })),
      order_history: {
        total_orders: orderHistory?.total_orders || 0,
        last_order: orderHistory?.last_order || null,
        total_spent: orderHistory?.total_spent || 0,
      },
      recent_interactions: interactions.map(it => {
        let summary = `[${it.type}${it.direction ? '/' + it.direction : ''}] ${it.timestamp?.slice(0, 10) || ''}`
        if (it.contact_name) summary += ` (${it.contact_name})`
        if (it.email_subject) summary += ` — ${it.email_subject}`
        if (it.body_text && !it.email_subject) summary += ` — ${it.body_text.slice(0, 120)}`
        if (it.meeting_title) summary += ` — ${it.meeting_title}`
        if (it.meeting_notes) summary += ` — ${it.meeting_notes.slice(0, 120)}`
        if (it.call_transcript) summary += ` — Résumé appel: ${it.call_transcript.slice(0, 200)}`
        return summary
      }),
      open_bills: openBills?.count > 0 ? openBills : null,
    }
  })
}

// ── OpenAI winback email generation ─────────────────────────────────────────

async function generateWinbackEmails(candidates, tenantId) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')
  if (!candidates.length) return []

  const today = new Date().toISOString().slice(0, 10)

  const prompt = `Tu es un directeur des ventes d'une entreprise québécoise qui relance d'anciens clients abonnés. Date d'aujourd'hui: ${today}.

Pour chaque client ci-dessous, rédige un courriel de réengagement personnalisé et chaleureux.
Le courriel doit:
- Mentionner ce à quoi ils étaient abonnés et depuis combien de temps c'était
- Référencer des éléments spécifiques de leur historique (interactions passées, commandes, projets)
- Être chaleureux, professionnel et personnalisé — jamais générique
- Proposer une valeur concrète pour les inciter à reprendre la relation
- Être en français sauf si la langue principale du contact est English
- Avoir un ton humain, pas corporatif

Retourne UNIQUEMENT un tableau JSON valide, sans texte avant ou après.

Structure de chaque élément:
{
  "candidate_index": <index dans le tableau>,
  "priority": "high" | "medium" | "low",
  "title": "<titre court ex: 'Relance – Ferme Tremblay'>",
  "description": "<1-2 phrases sur pourquoi ce client est une bonne opportunité de réengagement>",
  "email_to": "<email principal du contact ou de la compagnie>",
  "email_subject": "<sujet accrocheur et personnalisé>",
  "email_body": "<corps complet du courriel. Utilise \\n pour les sauts de ligne. Commence par Bonjour [prénom] ou équivalent. Signe de façon professionnelle.>"
}

Règles de priorité:
- high: abonnement récent (< 1 an avant annulation), montant mensuel élevé, interactions fréquentes
- medium: abonnement modéré ou quelques interactions
- low: peu d'historique ou abonnement très ancien

Clients à relancer:
${JSON.stringify(candidates, null, 2)}`

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 6000,
      temperature: 0.5,
      response_format: { type: 'json_object' },
    }),
  })

  if (!resp.ok) throw new Error(`OpenAI error: ${await resp.text()}`)
  const result = await resp.json()
  const raw = result.choices[0].message.content

  let parsed
  try {
    const obj = JSON.parse(raw)
    parsed = Array.isArray(obj) ? obj : (obj.winbacks || obj.opportunities || obj.results || Object.values(obj)[0] || [])
  } catch {
    throw new Error('Réponse OpenAI invalide')
  }

  return parsed.map(item => {
    const candidate = candidates[item.candidate_index]
    if (!candidate) return null

    // Choisir le meilleur email disponible
    const primaryContact = candidate.contacts.find(ct => ct.email)
    const emailTo = item.email_to || primaryContact?.email || candidate.company_email || null

    return {
      id: randomUUID(),
      tenant_id: tenantId,
      type: 'winback_client',
      priority: item.priority || 'medium',
      title: item.title,
      description: item.description,
      entity_type: 'company',
      entity_id: candidate.company_id,
      entity_name: candidate.company_name,
      action_type: 'email',
      email_to: emailTo,
      email_subject: item.email_subject || null,
      email_body: item.email_body || null,
    }
  }).filter(Boolean)
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/opportunities — liste les opportunités actives
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM opportunities
    WHERE tenant_id=? AND status='active'
    ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      scanned_at DESC
  `).all(req.user.tenant_id)
  const lastScan = db.prepare(
    "SELECT MAX(scanned_at) as t FROM opportunities WHERE tenant_id=?"
  ).get(req.user.tenant_id)
  res.json({ data: rows, last_scan: lastScan?.t || null })
})

// POST /api/opportunities/scan — détecte les désabonnés et génère les courriels de relance
router.post('/scan', async (req, res) => {
  const tid = req.user.tenant_id
  try {
    const candidates = detectWinbackCandidates(tid)
    if (!candidates.length) {
      return res.json({ inserted: 0, total_candidates: 0, message: 'Aucun abonné désabonné depuis plus de 6 mois trouvé' })
    }

    const opportunities = await generateWinbackEmails(candidates, tid)

    // Effacer les anciennes opportunités actives avant d'insérer les nouvelles
    db.prepare("DELETE FROM opportunities WHERE tenant_id=? AND status='active'").run(tid)

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO opportunities
        (id, tenant_id, type, priority, title, description, entity_type, entity_id, entity_name,
         action_type, email_to, email_subject, email_body, status, scanned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',datetime('now'))
    `)

    let inserted = 0
    for (const opp of opportunities) {
      stmt.run(
        opp.id, tid, opp.type, opp.priority, opp.title, opp.description,
        opp.entity_type, opp.entity_id, opp.entity_name,
        opp.action_type, opp.email_to, opp.email_subject, opp.email_body
      )
      inserted++
    }

    res.json({ inserted, total_candidates: candidates.length })
  } catch (e) {
    console.error('Opportunities scan error:', e)
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/opportunities/:id — changer le statut (dismissed / done)
router.patch('/:id', (req, res) => {
  const { status, email_to, email_subject, email_body } = req.body
  const existing = db.prepare(
    'SELECT id FROM opportunities WHERE id=? AND tenant_id=?'
  ).get(req.params.id, req.user.tenant_id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const fields = ["updated_at=datetime('now')"]
  const params = []
  if (status) { fields.push('status=?'); params.push(status) }
  if (email_to !== undefined) { fields.push('email_to=?'); params.push(email_to) }
  if (email_subject !== undefined) { fields.push('email_subject=?'); params.push(email_subject) }
  if (email_body !== undefined) { fields.push('email_body=?'); params.push(email_body) }

  db.prepare(`UPDATE opportunities SET ${fields.join(',')} WHERE id=?`)
    .run(...params, req.params.id)
  res.json(db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id))
})

// POST /api/opportunities/:id/send — envoyer l'email via Postmark (requiert approbation explicite de l'utilisateur)
router.post('/:id/send', async (req, res) => {
  const tid = req.user.tenant_id
  const opp = db.prepare(
    'SELECT * FROM opportunities WHERE id=? AND tenant_id=?'
  ).get(req.params.id, tid)
  if (!opp) return res.status(404).json({ error: 'Not found' })
  if (!opp.email_to) return res.status(400).json({ error: 'Aucun destinataire' })
  if (!opp.email_body) return res.status(400).json({ error: 'Corps du courriel manquant' })

  const pmKey = process.env.POSTMARK_API_KEY
  const pmFrom = process.env.POSTMARK_FROM
  if (!pmKey || !pmFrom) return res.status(500).json({ error: 'Postmark non configuré' })

  try {
    const client = new postmark.ServerClient(pmKey)
    const bodyHtml = opp.email_body.replace(/\n/g, '<br>')
    await client.sendEmail({
      From: pmFrom,
      To: opp.email_to,
      Subject: opp.email_subject || opp.title,
      HtmlBody: `<div style="font-family:sans-serif;max-width:600px">${bodyHtml}</div>`,
      TextBody: opp.email_body,
    })

    db.prepare("UPDATE opportunities SET status='done', updated_at=datetime('now') WHERE id=?")
      .run(opp.id)

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
