import { Component } from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'

// ErrorBoundary global — capture toute erreur de rendu dans l'arbre React et
// affiche un fallback exploitable au lieu de l'écran blanc total (le défaut
// React : une exception non rattrapée pendant le render démonte toute l'app).
//
// L'app étant l'outil d'opérations quotidien, un crash sur une page (null ref,
// state corrompu, données inattendues d'un sync realtime) ne doit pas bloquer
// l'utilisateur sans recours ni diagnostic. Le fallback offre :
//   - « Réessayer » : remonte l'arbre en place (utile si l'erreur était
//     transitoire — ex. donnée pas encore arrivée).
//   - « Tableau de bord » : navigation dure vers /dashboard (reload complet,
//     repart d'un état propre quand la page courante est définitivement cassée).
//
// Les error boundaries DOIVENT être des composants classe : seuls
// getDerivedStateFromError / componentDidCatch capturent les erreurs de rendu
// des enfants (pas de hook équivalent).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Trace en console pour le diagnostic (la stack React n'est pas visible
    // autrement une fois le fallback affiché).
    console.error('[ErrorBoundary] render crash:', error, info?.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  handleHome = () => {
    // Navigation dure (pas react-router) : on est dans un état de crash, le
    // routeur lui-même peut être compromis. basename = /erp (voir main.jsx).
    window.location.assign('/erp/dashboard')
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        data-testid="error-boundary-fallback"
        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
      >
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={26} className="text-red-600" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            Une erreur est survenue
          </h2>
          <p className="text-sm text-slate-600 mb-6">
            Cette page a rencontré un problème inattendu. Tu peux réessayer ou
            revenir au tableau de bord. Si le problème persiste, signale-le.
          </p>

          {error?.message && (
            <pre className="text-left text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-6 overflow-auto max-h-32 whitespace-pre-wrap break-words">
              {String(error.message)}
            </pre>
          )}

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
            >
              <RefreshCw size={16} />
              Réessayer
            </button>
            <button
              onClick={this.handleHome}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              <Home size={16} />
              Tableau de bord
            </button>
          </div>
        </div>
      </div>
    )
  }
}
