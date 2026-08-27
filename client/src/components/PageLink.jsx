// Lien « Voir la page » vers la section modifiée par une tâche terminée de
// l'agent — partagé entre /agent (cartes de suggestion) et /travaux (file de
// prompts), les deux affichant des tâches issues du même moteur d'exécution.
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { architectureManifest } from '../lib/architectureManifest.js'

// Le contexte d'une tâche combine la route d'où vient le signalement et,
// optionnellement, le descriptif de l'élément ciblé (voir FeedbackFab). On sépare
// les deux : le badge et la navigation n'utilisent que la partie « page », le
// descriptif brut de l'élément (balise HTML) reste disponible au survol.
// Un seul élément (« élément ciblé… ») ou plusieurs (« éléments ciblés (3)… ») :
// dans les deux cas la partie « page » s'arrête au séparateur.
const CONTEXT_ELEMENT_SEP = / — éléments? cibl[ée]s? par l'utilisateur/
function contextPage(context) {
  if (!context) return ''
  const i = context.search(CONTEXT_ELEMENT_SEP)
  return i === -1 ? context : context.slice(0, i)
}

// Une demande « toute l'application » n'a pas de page cible : son contexte est une
// mention globale (voir FeedbackFab, préfixe ci-dessous), pas une route. Dans ce
// cas on n'affiche ni badge de page ni lien « Voir la page » — la demande ne
// concerne pas la page d'où elle a été émise.
const APP_WIDE_CONTEXT_PREFIX = 'Demande concernant l\'ensemble de l\'application'
function isAppWideContext(context) {
  return typeof context === 'string' && context.startsWith(APP_WIDE_CONTEXT_PREFIX)
}

// Table composant de page → route, construite depuis le manifeste d'architecture
// (généré au build). On ignore les routes paramétrées (`/serials/:id`) : sans id
// concret on ne peut pas construire un lien valide.
const COMPONENT_TO_ROUTE = (() => {
  const map = {}
  const consider = (items) => {
    for (const it of items || []) {
      if (it?.component && it?.to && !it.to.includes(':') && !(it.component in map)) {
        map[it.component] = it.to
      }
    }
  }
  for (const g of architectureManifest.groups || []) consider(g.items)
  consider(architectureManifest.flat)
  consider(architectureManifest.offMenu)
  return map
})()

// Repli quand la tâche n'a pas de contexte de signalement (suggestions venues de
// /travaux ou de l'agent autonome, pas d'un clic FeedbackFab sur une page) : on
// cherche dans le rapport de l'agent les fichiers de page modifiés et on les
// résout vers leur route. On n'affiche le lien que si une seule page distincte
// est concernée — sinon la section ciblée est ambiguë.
function derivePageFromAgentResult(agentResult) {
  if (!agentResult) return null
  const components = new Set()
  for (const m of agentResult.matchAll(/client\/src\/pages\/(\w+)\.jsx/g)) components.add(m[1])
  const routes = new Set()
  for (const c of components) {
    const route = COMPONENT_TO_ROUTE[c]
    if (route) routes.add(route)
  }
  return routes.size === 1 ? [...routes][0] : null
}

// Le contexte d'une tâche = la route d'où vient le signalement ; une fois le
// correctif implanté, on offre la navigation directe vers la page modifiée — en
// priorité celle du signalement, sinon celle déduite du rapport d'implémentation.
export function PageLink({ task }) {
  if (!task) return null
  let page = null
  if (!isAppWideContext(task.context)) {
    const ctxPage = contextPage(task.context)
    if (ctxPage.startsWith('/')) page = ctxPage
  }
  if (!page) page = derivePageFromAgentResult(task.agent_result)
  if (!page) return null
  return (
    <Link
      to={page}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      data-testid="card-page-link"
      title={`Voir la page ${page}`}
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-medium transition-colors"
    >
      <ArrowUpRight size={10} /> Voir la page
    </Link>
  )
}

export { isAppWideContext, contextPage }
