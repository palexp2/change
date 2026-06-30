/**
 * Slack Incoming Webhook adapter for field-rule automations.
 *
 * action_config shape:
 *   { webhookEnv: 'SLACK_WEBHOOK_HARDWARE', text: '...' }
 *   or { webhookUrl: 'https://hooks.slack.com/...', text: '...' }
 *
 * Templates in `text` are rendered upstream (fieldRuleEngine.renderActionConfig).
 */
/**
 * Stable recipient key for the anti-spam guard (fieldRuleEngine.makeRateGuard).
 * A Slack rule targets a single webhook (channel), so the key is the env var name
 * when configured via webhookEnv (avoids logging the secret URL), otherwise the
 * URL itself. Returns null when nothing is configured.
 */
export function resolveSlackTarget({ rule }) {
  const ac = rule.action_config || {}
  if (ac.webhookEnv) return `env:${ac.webhookEnv}`
  return ac.webhookUrl || null
}

export async function sendSlack({ rule, rendered }) {
  const ac = rule.action_config || {}
  const webhookUrl = ac.webhookEnv
    ? process.env[ac.webhookEnv] || null
    : (ac.webhookUrl || null)
  if (!webhookUrl) {
    throw new Error(
      ac.webhookEnv
        ? `Variable d'environnement manquante: ${ac.webhookEnv}`
        : 'webhookEnv ou webhookUrl requis'
    )
  }
  const text = rendered.text
  if (!text || !String(text).trim()) {
    throw new Error('Template `text` manquant ou vide')
  }
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Slack HTTP ${resp.status}${body ? ': ' + body.slice(0, 160) : ''}`)
  }
}
