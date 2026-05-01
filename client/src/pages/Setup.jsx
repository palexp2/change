import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api.js'

export default function Setup() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    company_name: '',
    admin_name: '',
    email: '',
    password: '',
    confirm_password: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  function handleChange(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirm_password) {
      return setError('Les mots de passe ne correspondent pas.')
    }
    if (form.password.length < 8) {
      return setError('Le mot de passe doit contenir au moins 8 caractères.')
    }
    setLoading(true)
    try {
      await api.auth.setup({
        company_name: form.company_name,
        admin_name: form.admin_name,
        email: form.email,
        password: form.password,
      })
      setSuccess(true)
      setTimeout(() => navigate('/login'), 2000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-brand-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-white font-bold text-2xl">O</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Orisha ERP</h1>
          <p className="text-slate-400 mt-1">Configuration initiale</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-6">Créer votre compte administrateur</h2>

          {success ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-slate-700 font-medium">Configuration réussie!</p>
              <p className="text-slate-500 text-sm mt-1">Redirection vers la connexion...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Nom de l'entreprise</label>
                <input
                  name="company_name"
                  value={form.company_name}
                  onChange={handleChange}
                  className="input"
                  placeholder="Orisha Technologies"
                  required
                />
              </div>
              <div>
                <label className="label">Votre nom</label>
                <input
                  name="admin_name"
                  value={form.admin_name}
                  onChange={handleChange}
                  className="input"
                  placeholder="Jean Tremblay"
                  required
                />
              </div>
              <div>
                <label className="label">Courriel</label>
                <input
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  className="input"
                  placeholder="admin@orisha.io"
                  required
                />
              </div>
              <div>
                <label className="label">Mot de passe</label>
                <input
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={handleChange}
                  className="input"
                  placeholder="Minimum 8 caractères"
                  required
                />
              </div>
              <div>
                <label className="label">Confirmer le mot de passe</label>
                <input
                  name="confirm_password"
                  type="password"
                  value={form.confirm_password}
                  onChange={handleChange}
                  className="input"
                  placeholder="Répéter le mot de passe"
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
                disabled={loading}
                className="btn-primary w-full justify-center py-2.5"
              >
                {loading ? 'Configuration en cours...' : 'Créer le compte'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
