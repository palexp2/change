import { useState, createContext, useContext } from 'react'
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
  const [isLoading, setIsLoading] = useState(false)

  async function login(email, password) {
    setIsLoading(true)
    try {
      const data = await api.auth.login(email, password)
      setToken(data.token)
      setUser(getUser())
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
