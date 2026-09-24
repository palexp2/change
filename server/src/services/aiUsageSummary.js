// Jauges IA de la barre de gauche : un résumé minimal (nom, % consommé, remise à
// zéro) des quotas déjà lus pour /travaux — mêmes fenêtres, mêmes libellés. Aucun
// jeton, aucun courriel, aucun appel au fournisseur : seulement les caches existants.
//
// Un compte n'a de ligne que s'il répond : aucune fenêtre lisible → absent.
// Une fenêtre dont la remise à zéro est passée est périmée → écartée (on ne sait plus).

const live = (pct, resetsAt, now) => Number.isFinite(pct)
  && !(resetsAt && Date.parse(resetsAt) <= now)

const win = (key, label, b) => ({
  key, label, pct: Math.round(b.utilizationPct), resetsAt: b.resetsAt || null, severity: b.severity || null,
})

export function summarizeAiUsage({ claude, codex }, now = Date.now()) {
  const accounts = []
  if (claude?.subscriptionAvailable) {
    const windows = [
      ['session', 'Fenêtre 5 h', claude.session],
      ['week', 'Semaine', claude.week],
      ['scoped', `Semaine ${claude.weekScoped?.label || 'modèle'}`, claude.weekScoped],
    ].filter(([, , b]) => live(b?.utilizationPct, b?.resetsAt, now))
      .map(([key, label, b]) => win(key, label, b))
    if (windows.length) accounts.push({ key: 'claude', name: 'Claude', windows })
  }
  if (codex?.available) {
    const windows = (codex.windows || [])
      .filter(w => live(w.utilizationPct, w.resetsAt, now))
      .map(w => win(w.key, w.label, w))
    if (windows.length) accounts.push({ key: 'codex', name: 'Codex', windows })
  }
  return { accounts }
}
