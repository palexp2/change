import { Logo } from './Logo.jsx'

/**
 * Cadre commun des écrans hors session (connexion, mot de passe oublié,
 * réinitialisation). `theme-light` : écrans conçus sombres, ils gardent leur
 * rendu en mode nuit.
 */
export function AuthShell({ title, children }) {
  return (
    <div className="theme-light min-h-screen bg-gradient-to-br from-slate-900 to-brand-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Logo size={56} className="mx-auto mb-3 text-brand-400 drop-shadow-lg" />
          <p className="text-white text-2xl font-semibold tracking-tight">Boréal</p>
          <p className="text-slate-400 text-xs uppercase tracking-[0.2em] mt-1">Orisha</p>
          <p className="text-slate-400 text-sm mt-1">Système de gestion intégré</p>
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-6">{title}</h2>
          {children}
        </div>
      </div>
    </div>
  )
}
