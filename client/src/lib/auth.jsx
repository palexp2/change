import { rolesOf } from '../../../shared/roles.mjs'
import { useState, useEffect, useRef, createContext, useContext } from 'react'
import api from './api.js'

const TOKEN_KEY = 'erp_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function removeToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export function getUser() {
  const token = getToken()
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      removeToken()
      return null
    }
    return payload
  } catch {
    return null
  }
}

// Auth Context
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getUser())
  const [isLoading, setIsLoading] = useState(!!getToken())
  const accessRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      if (!getToken()) return
      try {
        const account = await api.auth.me()
        if (!cancelled && account) {
          const access = JSON.stringify([account.id, rolesOf(account), account.employee_id])
          // Remount pages and discard in-memory HR data when grants change.
          if (accessRef.current && accessRef.current !== access) {
            window.location.reload()
            return
          }
          accessRef.current = access
          setUser(account)
        }
      } catch (error) {
        if (!cancelled && (error.status === 401 || error.status === 403)) setUser(null)
      } finally { if (!cancelled) setIsLoading(false) }
    }
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    const timer = setInterval(refresh, 30000)
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); clearInterval(timer) }
  }, [])

  async function login(email, password) {
    setIsLoading(true)
    try {
      const data = await api.auth.login(email, password)
      setToken(data.token)
      setUser(data.user)
      return data
    } finally {
      setIsLoading(false)
    }
  }

  function logout() {
    removeToken()
    setUser(null)
    window.location.href = '/erp/login'
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, isLoading, setUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
