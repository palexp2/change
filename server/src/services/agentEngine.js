// ─── Moteur d'exécution de la file de travaux : Claude Code ───────────────────
//
// Un seul moteur. Un second CLI (Gemini) a été branché un temps pour continuer la
// file quand le quota Claude tombait sous le seuil du garde-fou (quotaGuard.js) ;
// l'option a été retirée : changer de modèle changeait la qualité du travail, et la
// file attend désormais simplement la réinitialisation du quota.
//
// Ce module ne porte QUE la ligne de commande du CLI (binaire, drapeaux) ; le reste
// de l'orchestration vit dans taskRunner.js.

export const CLAUDE_BIN = '/home/ec2-user/.local/bin/claude'

// ─── Ligne de commande d'une exécution (voie détachée) ────────────────────────
export function execCommand({
  promptFile, logFile, codeFile, pidFile, taskId,
  model = null, effort = null, tools = '', resumeSessionId = null, settingsFile = null,
}) {
  const head = `printf '%s\\n%s\\n' "__SHELL_PID__" "${taskId}" > "${pidFile}"; `
  const tail = ` < "${promptFile}" > "${logFile}" 2>&1; echo $? > "${codeFile}"`
  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '')
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : ''
  const settingsFlag = settingsFile ? ` --settings "${settingsFile}"` : ''
  return head + `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag}` +
    `${settingsFlag} --allowedTools "${tools}"` + tail
}

/** Appel court SANS outils (proposition instantanée, compte-rendu, suggestions). */
export function toollessSpec({ model, effort }) {
  return { bin: CLAUDE_BIN, args: ['-p', '--model', model, '--effort', effort, '--tools', ''] }
}

/** Appel court en lecture seule AVEC flux (réponse de conversation). */
export function streamSpec({ allowedTools }) {
  return { bin: CLAUDE_BIN, args: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', allowedTools] }
}
