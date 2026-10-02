// Jauges IA de la barre de gauche : un résumé minimal (nom, % consommé, remise à
// zéro) des quotas déjà lus pour /travaux — mêmes fenêtres, mêmes libellés. Aucun
// jeton, aucun courriel (le titulaire n'est donné que par son prénom), aucun appel au fournisseur : seulement les caches existants.
//
// Un compte n'a de ligne que s'il répond : aucune fenêtre lisible → absent.
// Une fenêtre dont la remise à zéro est passée est périmée → écartée (on ne sait plus).

const live = (pct, resetsAt, now) => Number.isFinite(pct)
  && !(resetsAt && Date.parse(resetsAt) <= now)

const win = (key, label, b) => ({
  key, label, pct: Math.round(b.utilizationPct), resetsAt: b.resetsAt || null, severity: b.severity || null,
})

// Titulaire du compte : prénom seul (pas de courriel envoyé au navigateur).
const firstName = (s) => (s || '').split(/[\s@]/)[0] || null

export function summarizeAiUsage({ claude }, now = Date.now()) {
  const accounts = []
  // Plusieurs licences Claude : une ligne par compte (`claude.accounts`), le premier
  // garde la clé historique « claude ».
  const list = claude?.accounts?.length ? claude.accounts : (claude ? [claude] : [])
  list.forEach((c, i) => {
    if (!c?.subscriptionAvailable) return
    const windows = [
      ['session', 'Fenêtre 5 h', c.session],
      ['week', 'Semaine', c.week],
    ].filter(([, , b]) => live(b?.utilizationPct, b?.resetsAt, now))
      .map(([key, label, b]) => win(key, label, b))
    if (windows.length) accounts.push({ key: i ? `claude-${c.id}` : 'claude', name: 'Claude', owner: firstName(c.account?.name || c.account?.email), windows })
  })
  return { accounts }
}
