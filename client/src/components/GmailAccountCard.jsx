import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle, Link2, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDateTime } from '../lib/formatDate.js'

// Bloc « Ma boîte Gmail » : chaque utilisateur branche SA propre adresse (celle
// de son compte ERP — le serveur refuse toute autre boîte). Une fois connectée,
// ses courriels alimentent le fil d'interactions et l'ingestion de factures.
//
// Le retour d'OAuth arrive sur /parametres/gmail?success=google (ou ?error=…) :
// c'est ici qu'on le lit et qu'on nettoie l'URL.
const ERRORS = {
  google_denied: 'Connexion annulée.',
  google_wrong_account: 'Mauvais compte Google — choisissez la même adresse que votre compte ERP.',
  google_no_email: 'Votre compte ERP n’a pas d’adresse courriel.',
  google_failed: 'La connexion a échoué.',
}

export default function GmailAccountCard() {
  const [status, setStatus] = useState(null)
  const [params, setParams] = useSearchParams()
  const confirm = useConfirm()
  const { addToast } = useToast()

  const load = async () => {
    try { setStatus(await api.connectors.gmailMyMailbox()) } catch { setStatus({ connected: false }) }
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    const ok = params.get('success')
    const err = params.get('error')
    if (!ok && !err) return
    if (ok === 'google') addToast({ message: 'Boîte Gmail connectée', type: 'success' })
    else if (err) addToast({ message: ERRORS[err] || 'La connexion a échoué.', type: 'error' })
    params.delete('success'); params.delete('error')
    setParams(params, { replace: true })
    load()
  }, [params])

  const connect = () => {
    const token = localStorage.getItem('erp_token')
    window.location.href = `/erp/api/connectors/google/connect?scope=me&token=${token}`
  }

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Déconnecter ma boîte Gmail',
      message: 'Vos courriels cesseront d’être synchronisés. Vous pourrez reconnecter à tout moment.',
      confirmLabel: 'Déconnecter',
    })
    if (!ok) return
    await api.connectors.gmailDisconnectMine()
    load()
  }

  if (!status) return null

  if (status.connected) {
    return (
      <div className="flex items-center justify-between p-2 bg-green-50 rounded-lg">
        <div className="flex items-center gap-2 min-w-0">
          <CheckCircle size={14} className="text-green-500 flex-shrink-0" />
          <span className="text-xs text-slate-700 truncate">
            {status.email}
            {status.lastSyncedAt && (
              <span className="text-slate-400"> — sync {fmtDateTime(status.lastSyncedAt)}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={connect} className="btn-secondary btn-sm text-xs" title="Réautoriser">
            <Link2 size={12} /> Reconnecter
          </button>
          <button onClick={disconnect} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
      <span className="text-xs text-slate-500 truncate">
        {status.email ? `${status.email} — non connectée` : 'Non connectée'}
      </span>
      <button onClick={connect} className="btn-secondary btn-sm text-xs">
        <Link2 size={12} /> Connecter ma boîte
      </button>
    </div>
  )
}
