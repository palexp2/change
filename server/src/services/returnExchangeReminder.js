// Rappel « retours avec échange immédiat » — import de l'automatisation
// Airtable #4 (Phase 2 du plan). Relance CHAQUE JOUR d'exécution tant que le
// retour n'est pas facturé, fidèle à l'original (pas un envoi one-shot comme
// sys_installation_followup — décision arrêtée avec l'utilisateur).
//
// ⚠️ Écart assumé : l'automatisation Airtable filtre sur un champ « Date de
// retour » par item, absent de la sync ERP actuelle (aucune colonne
// équivalente trouvée — voir Phase 2 du plan). On approxime avec
// `return_items.received_at IS NULL` (l'item n'a pas encore été reçu par
// Orisha), le proxy le plus proche disponible.

import { getPostmarkClient } from './postmarkConfig.js'

export const IMMEDIATE_REASON = 'Retour de garantie avec échange immédiat'
const MIN_RETURN_DATE = '2025-06-04'
const RETURN_WINDOW_DAYS = 21

// Pure DB query — retourne les dossiers de retour à relancer aujourd'hui.
export function selectEligibleReturns(db) {
  return db.prepare(`
    SELECT r.id AS return_id, r.created_at, r.company_id,
           ct.id AS contact_id, ct.email AS contact_email, ct.first_name AS contact_first_name,
           ct.langue AS contact_langue
    FROM returns r
    JOIN contacts ct ON ct.id = r.contact
    WHERE r.billed_at IS NULL
      AND r.created_at >= ?
      AND ct.email IS NOT NULL AND ct.email LIKE '%@%'
      AND EXISTS (
        SELECT 1 FROM return_items ri
        WHERE ri.return_id = r.id
          AND ri.return_reason = ?
          AND ri.received_at IS NULL
      )
    ORDER BY r.created_at ASC
  `).all(MIN_RETURN_DATE, IMMEDIATE_REASON)
}

function selectOutstandingItems(db, returnId) {
  return db.prepare(`
    SELECT ri.*, COALESCE(pr.name_fr, psn.name_fr) AS product_name_fr,
           COALESCE(pr.name_en, psn.name_en) AS product_name_en
    FROM return_items ri
    LEFT JOIN serial_numbers sn ON ri.serial_id = sn.id
    LEFT JOIN products psn ON sn.product_id = psn.id
    LEFT JOIN products pr ON ri.product_id = pr.id
    WHERE ri.return_id = ? AND ri.return_reason = ? AND ri.received_at IS NULL
  `).all(returnId, IMMEDIATE_REASON)
}

function isFrench(langue) {
  return langue === 'French'
}

function formatDateLocale(iso, langue) {
  try {
    return new Date(iso).toLocaleDateString(isFrench(langue) ? 'fr-CA' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  } catch { return iso }
}

function buildItemsTableHtml(items, langue) {
  const nameTitle = isFrench(langue) ? 'Produit' : 'Item Name'
  const priceTitle = isFrench(langue) ? 'Prix' : 'Price'
  let total = 0
  const rows = items.map(it => {
    const price = parseFloat(it.prix_de_l_item) || 0
    total += price
    const name = isFrench(langue) ? (it.poduit_a_recevoir_fr_for_email_display || it.product_name_fr) : (it.poduit_a_recevoir_en_for_email_display || it.product_name_en)
    return `<tr>
      <td align="left" style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">${name || ''}</td>
      <td align="right" style="padding:10px;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">$${price.toFixed(2)}</td>
    </tr>`
  }).join('')
  return `<table width="100%" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:20px;">
    <thead><tr>
      <th align="left" style="padding:10px;border-bottom:1px solid #eee;font-size:14px;color:#555;font-weight:bold;">${nameTitle}</th>
      <th align="right" style="padding:10px;border-bottom:1px solid #eee;font-size:14px;color:#555;font-weight:bold;">${priceTitle}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td align="right" style="padding:10px;font-size:16px;color:#333;font-weight:bold;">Total:</td>
      <td align="right" style="padding:10px;font-size:16px;color:#333;font-weight:bold;">$${total.toFixed(2)}</td>
    </tr></tfoot>
  </table>`
}

function buildReminderHtml({ langue, firstName, createdAt, itemsHtml, overdue }) {
  const fr = isFrench(langue)
  const maxReturnDate = new Date(createdAt)
  maxReturnDate.setDate(maxReturnDate.getDate() + RETURN_WINDOW_DAYS)

  const overdueHtml = overdue
    ? `<p style="margin:0 0 20px 0;font-size:16px;color:red;font-weight:bold;">${fr ? 'La période de retour de 21 jours est dépassée. Le montant sera prélevé sur votre carte de crédit.' : 'The 21-day return period has passed. The amount will be charged to your credit card.'}</p>`
    : `<p style="margin:0 0 20px 0;font-size:16px;color:green;font-weight:bold;">${fr ? "Rien n'est dû pour le moment." : 'Nothing is due at the moment.'}</p>`

  const reminder = fr
    ? `<p style="margin:0 0 20px 0;font-size:16px;color:#333;">Ceci est un rappel concernant les articles en cours de retour dans le cadre d'un échange d'équipement sous garantie.</p>
       <p style="margin:0 0 20px 0;font-size:16px;color:#333;">Veuillez noter que vous disposez de 21 jours à partir de la date de demande d'échange pour retourner ces articles. À défaut de retour dans ce délai, le montant indiqué ci-dessous vous sera facturé.</p>
       <p style="margin:0 0 20px 0;font-size:16px;color:#333;"><strong>Date de demande d'échange: </strong>${formatDateLocale(createdAt, langue)}</p>
       <p style="margin:0 0 20px 0;font-size:16px;color:#333;"><strong>Date limite de retour: </strong>${formatDateLocale(maxReturnDate.toISOString(), langue)}</p>`
    : `<p style="margin:0 0 20px 0;font-size:16px;color:#333;">This is a reminder regarding items in the process of being returned as part of a warranty exchange.</p>
       <p style="margin:0 0 20px 0;font-size:16px;color:#333;">Please note that you have 21 days from the exchange request date to return these items. If they are not returned within this period, you will be charged the amount listed below.</p>
       <p style="margin:0 0 20px 0;font-size:16px;color:#333;"><strong>Exchange request date: </strong>${formatDateLocale(createdAt, langue)}</p>
       <p style="margin:0 0 20px 0;font-size:16px;color:#333;"><strong>Return deadline: </strong>${formatDateLocale(maxReturnDate.toISOString(), langue)}</p>`

  const help = fr ? "Besoin d'aide ? Appelez-nous: 1-888-267-4742" : 'Need help ? Give us a call: 1-888-267-4742'
  const greeting = fr ? 'Bonjour' : 'Dear'

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Return reminder</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial, sans-serif;">
<table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#f4f4f4;"><tr><td align="center">
<table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:4px;overflow:hidden;">
<tr><td align="center" style="padding:20px;background-color:#ffffff;"><img src="https://orisha.us-east-1.linodeobjects.com/logo.png" alt="Logo Orisha" style="max-width:150px;display:block;"></td></tr>
<tr><td style="background-color:#22b14c;height:5px;line-height:5px;font-size:0;"></td></tr>
<tr><td style="padding:20px;">
<p style="margin:0 0 10px 0;font-size:16px;color:#333;">${greeting} ${firstName || ''},</p><br>
${reminder}<br>
${itemsHtml}<br>
${overdueHtml}
</td></tr>
<tr><td style="padding:20px;text-align:center;"><p style="margin:0;font-size:16px;color:#333;">${help}</p></td></tr>
<tr><td align="center" style="padding:20px;background-color:#f4f4f4;font-size:12px;color:#777;">Automatisation Orisha Inc. 1535 ch. Ste-Foy Bureau 220 Québec, QC G1S 2P1</td></tr>
</table></td></tr></table>
</body></html>`
}

export async function sendReturnExchangeReminders(db, { fromAddress = process.env.POSTMARK_FROM, postmarkToken = process.env.POSTMARK_API_KEY, dryRun = false, sendFn = null, nowIso } = {}) {
  const now = nowIso || new Date().toISOString()
  const eligible = selectEligibleReturns(db)
  const results = { total: eligible.length, sent: 0, errors: 0, skipped: 0, details: [] }
  if (!eligible.length) return results

  const send = sendFn || (async (emailData) => getPostmarkClient(postmarkToken).sendEmail(emailData))

  for (const row of eligible) {
    try {
      const items = selectOutstandingItems(db, row.return_id)
      if (!items.length) { results.skipped++; continue }
      const overdue = (new Date(now) - new Date(row.created_at)) / (1000 * 60 * 60 * 24) > RETURN_WINDOW_DAYS
      const itemsHtml = buildItemsTableHtml(items, row.contact_langue)
      const html = buildReminderHtml({ langue: row.contact_langue, firstName: row.contact_first_name, createdAt: row.created_at, itemsHtml, overdue })
      const subject = isFrench(row.contact_langue) ? 'Rappel important - Échange d\'équipement sous garantie' : 'Important Reminder: Warranty Exchange Return'

      if (dryRun) {
        results.skipped++
        results.details.push({ action: 'dry-run', return_id: row.return_id, to: row.contact_email, overdue })
        continue
      }

      await send({
        From: fromAddress,
        To: row.contact_email,
        Bcc: 'support@orisha.io',
        Subject: subject,
        HtmlBody: html,
      })
      results.sent++
      results.details.push({ action: 'sent', return_id: row.return_id, to: row.contact_email, overdue })
    } catch (e) {
      results.errors++
      results.details.push({ action: 'error', return_id: row.return_id, error: e.message })
    }
  }
  return results
}
