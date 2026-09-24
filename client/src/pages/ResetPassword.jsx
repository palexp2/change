import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../lib/api.js'
import { setToken } from '../lib/auth.jsx'
import { AuthShell } from '../components/AuthShell.jsx'

export default function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const [state, setState] = useState('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.auth.checkReset(token)
      .then(r => { if (alive) setState(r.valid ? 'ok' : 'invalid') })
      .catch(() => { if (alive) setState('invalid') })
    return () => { alive = false }
  }, [token])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password !== confirm) return setError('Les deux mots de passe diffèrent.')
    setBusy(true)
    try {
      const data = await api.auth.resetPassword(token, password)
      setToken(data.token)
      window.location.href = '/erp/dashboard'
    } catch (err) {
      setError(err.message || 'Lien invalide ou expiré.')
      setBusy(false)
    }
  }

  if (state === 'checking') return <AuthShell title="Nouveau mot de passe"><p className="text-sm text-slate-500">…</p></AuthShell>

  if (state === 'invalid') {
    return (
      <AuthShell title="Lien expiré">
        <Link to="/forgot-password" className="btn-primary w-full justify-center py-2.5">Demander un nouveau lien</Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Nouveau mot de passe">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Mot de passe</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="input" required minLength={8} autoFocus />
        </div>
        <div>
          <label className="label">Confirmation</label>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} className="input" required minLength={8} />
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}
        <button type="submit" disabled={busy} className="btn-primary w-full justify-center py-2.5">
          {busy ? '…' : 'Enregistrer'}
        </button>
      </form>
    </AuthShell>
  )
}
