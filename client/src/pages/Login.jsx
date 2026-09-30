import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import { AuthShell } from '../components/AuthShell.jsx'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login, isLoading } = useAuth()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    try {
      await login(email, password)
      // App choisit l'accueil une fois l'utilisateur connecté (capture sur téléphone).
    } catch {
      setError('Courriel ou mot de passe invalide.')
    }
  }

  return (
    <AuthShell title="Connexion">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Courriel</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="input"
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

        <Link to="/forgot-password" className="block text-center text-sm text-slate-500 hover:text-slate-700">
          Mot de passe ou identifiant oublié ?
        </Link>
      </form>
    </AuthShell>
  )
}
