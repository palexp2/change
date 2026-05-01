import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login, isLoading } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    try {
      await login(email, password)
      navigate('/dashboard')
    } catch {
      setError('Courriel ou mot de passe invalide.')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-brand-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-white font-bold text-2xl">O</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Orisha ERP</h1>
          <p className="text-slate-400 mt-1">Système de gestion intégré</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-6">Connexion</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Courriel</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="input"
                placeholder="votre@courriel.com"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="label">Mot de passe</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input"
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="btn-primary w-full justify-center py-2.5 mt-2"
            >
              {isLoading ? 'Connexion...' : 'Se connecter'}
            </button>
          </form>

          <p className="text-center text-xs text-slate-400 mt-6">
            Première utilisation?{' '}
            <Link to="/setup" className="text-brand-600 hover:underline">
              Configurer l'application
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
