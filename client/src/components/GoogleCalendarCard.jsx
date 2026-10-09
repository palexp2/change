import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarCheck, CalendarPlus } from 'lucide-react'
import api from '../lib/api.js'

// Google Agenda de l'utilisateur, pour la prise de rendez-vous (Marketing →
// Rendez-vous) : ses occupations bloquent les créneaux et chaque réservation
// y crée un événement. Même compte Google que la boîte Gmail ; le bouton
// relance le consentement en y ajoutant l'agenda.
export default function GoogleCalendarCard() {
  const [status, setStatus] = useState(null)
  useEffect(() => { api.connectors.gmailMyMailbox().then(setStatus).catch(() => setStatus({})) }, [])
  if (!status) return null

  const connect = () => {
    const token = localStorage.getItem('erp_token')
    window.location.href = `/erp/api/connectors/google/connect?scope=me&calendar=1&token=${token}`
  }

  return (
    <div className={`flex items-center justify-between p-2 rounded-lg ${status.calendar ? 'bg-green-50' : 'bg-slate-50'}`} data-testid="google-calendar-card">
      <span className="flex items-center gap-2 text-xs text-slate-700">
        {status.calendar ? <CalendarCheck size={14} className="text-green-500" /> : <CalendarPlus size={14} className="text-slate-400" />}
        Google Agenda
        <Link to="/rendez-vous" className="text-slate-400 hover:text-slate-700">— Rendez-vous</Link>
      </span>
      {!status.calendar && (
        <button onClick={connect} className="btn-secondary btn-sm text-xs" data-testid="google-calendar-connect">
          Brancher
        </button>
      )}
    </div>
  )
}
