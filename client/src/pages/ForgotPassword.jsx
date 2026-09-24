import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { AuthShell } from '../components/AuthShell.jsx'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.auth.forgotPassword(email)
      setSent(true)
    } catch {
      setSent(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Mot de passe oublié">
      {sent ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Si un compte existe, un courriel avec votre identifiant et un lien de réinitialisation vient de partir.
          </p>
          <Link to="/login" className="btn-primary w-full justify-center py-2.5">Retour</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Courriel</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="input" required autoFocus />
          </div>
          <button type="submit" disabled={busy} className="btn-primary w-full justify-center py-2.5">
            {busy ? 'Envoi...' : 'Envoyer le lien'}
          </button>
          <Link to="/login" className="block text-center text-sm text-slate-500 hover:text-slate-700">Retour</Link>
        </form>
      )}
    </AuthShell>
  )
}
