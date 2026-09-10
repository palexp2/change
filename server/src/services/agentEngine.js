// CLI commands for Claude Code and Codex. Scheduling lives in taskRunner.js.

import { fileURLToPath } from 'node:url'

export const CLAUDE_BIN = '/home/ec2-user/.local/bin/claude'
export const CODEX_BIN = process.env.CODEX_BIN || '/home/ec2-user/.npm-global/bin/codex'
const CODEX_ADAPTER = fileURLToPath(new URL('../../scripts/codex-exec.mjs', import.meta.url))
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

// Ce qu'une exécution Codex doit pouvoir atteindre EN PLUS de l'arbre de travail.
// Le bac à sable `workspace-write` n'autorise que le repo : sans ces deux réglages,
// une tâche écrivait bien son code mais échouait sur toute la finition — « accès aux
// sockets PM2 interdit » (pas de `pm2 restart erp-server`), « l'API locale est
// inaccessible » (réseau coupé, donc ni 127.0.0.1:3004 ni npm). Claude, lui, tourne
// sans bac à sable : Codex partait avec un handicap que rien ne justifiait.
const CODEX_WRITABLE_ROOTS = ['/home/ec2-user/.pm2', '/home/ec2-user/.npm', '/tmp']

export function codexArgs({ effort = 'high', readOnly = false, resumeSessionId = null, json = true } = {}) {
  const args = ['exec', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${readOnly ? 'read-only' : 'workspace-write'}"`,
    '-c', `model_reasoning_effort="${['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'high'}"`]
  // Une question (lecture seule) n'a besoin ni du réseau ni de PM2 : on ne lui ouvre rien.
  if (!readOnly) {
    args.push('-c', 'sandbox_workspace_write.network_access=true',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(CODEX_WRITABLE_ROOTS)}`)
  }
  if (resumeSessionId) args.push('resume', resumeSessionId)
  if (json) args.push('--json')
  args.push('-')
  return args
}

// ─── Ligne de commande d'une exécution (voie détachée) ────────────────────────
export function execCommand({
  promptFile, logFile, codeFile, pidFile, taskId,
  model = null, effort = null, tools = '', resumeSessionId = null, settingsFile = null,
}) {
  const head = `printf '%s\\n%s\\n' "__SHELL_PID__" "${taskId}" > "${pidFile}"; `
  const tail = ` < "${promptFile}" > "${logFile}" 2>&1; echo $? > "${codeFile}"`
  if (model === 'codex') {
    const args = [process.execPath, CODEX_ADAPTER, effort || 'high', tools.includes('Edit') ? 'write' : 'read', resumeSessionId || '']
    return head + args.map(quote).join(' ') + tail
  }
  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '')
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : ''
  const settingsFlag = settingsFile ? ` --settings "${settingsFile}"` : ''
  return head + `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag}` +
    `${settingsFlag} --allowedTools "${tools}"` + tail
}

/** Appel court SANS outils (proposition instantanée, compte-rendu, suggestions). */
export function toollessSpec({ model, effort }) {
  if (model === 'codex') return { bin: CODEX_BIN, args: codexArgs({ effort, readOnly: true, json: false }) }
  return { bin: CLAUDE_BIN, args: ['-p', '--model', model, '--effort', effort, '--tools', ''] }
}

/** Appel court en lecture seule AVEC flux (réponse de conversation). */
export function streamSpec({ allowedTools }) {
  return { bin: CLAUDE_BIN, args: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', allowedTools] }
}
