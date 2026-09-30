// CLI commands for Claude Code. Scheduling lives in taskRunner.js.

export const CLAUDE_BIN = '/home/ec2-user/.local/bin/claude'

// Alias figés sur une version précise : « opus » = Opus 5.5, même quand le CLI
// fera pointer son alias sur un Opus plus récent.
const CLI_MODEL_IDS = { opus: 'claude-opus-5-5' }
const cliModel = m => CLI_MODEL_IDS[m] || m

// ─── Ligne de commande d'une exécution (voie détachée) ────────────────────────
export function execCommand({
  promptFile, logFile, codeFile, pidFile, taskId,
  model = null, effort = null, tools = '', resumeSessionId = null, settingsFile = null,
}) {
  const head = `printf '%s\\n%s\\n' "__SHELL_PID__" "${taskId}" > "${pidFile}"; `
  const tail = ` < "${promptFile}" > "${logFile}" 2>&1; echo $? > "${codeFile}"`
  const modelFlags = (model ? ` --model "${cliModel(model)}"` : '') + (effort ? ` --effort "${effort}"` : '')
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : ''
  const settingsFlag = settingsFile ? ` --settings "${settingsFile}"` : ''
  return head + `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag}` +
    `${settingsFlag} --allowedTools "${tools}"` + tail
}

/** Appel court SANS outils (proposition instantanée, compte-rendu, suggestions). */
export function toollessSpec({ model, effort }) {
  return { bin: CLAUDE_BIN, args: ['-p', '--model', cliModel(model), '--effort', effort, '--tools', ''] }
}

/** Appel court en lecture seule AVEC flux (réponse de conversation). */
export function streamSpec({ allowedTools }) {
  return { bin: CLAUDE_BIN, args: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', allowedTools] }
}
