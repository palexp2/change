/**
 * Script adapter for field-rule automations.
 *
 * action_config shape:
 *   {
 *     script: '...',                 // required — JS body run in the sandbox
 *     allow_trigger_write: true,     // optional, default false — lift the
 *                                    // anti-cycle guard that forbids writing a
 *                                    // column used as a rule trigger
 *   }
 *
 * The triggering row is exposed to the script as `row`; DB writes go through
 * the sandboxed `update(table, id, patch)` (table allowlist + depth-bounded
 * cascade). See scriptSandbox.js for the full contract.
 */
import { runScriptSandboxed } from '../scriptSandbox.js'

export async function runScriptAction({ rule, row }) {
  const ac = rule.action_config || {}
  const script = ac.script
  if (!script || !String(script).trim()) {
    throw new Error('action_config.script manquant ou vide')
  }
  await runScriptSandboxed(script, {
    row,
    trigger: { rule_id: rule.id, table: rule.trigger_config?.erp_table },
    enableWrite: true,
    allowTriggerWrite: ac.allow_trigger_write === true,
  })
}
