import { useState, useEffect } from 'react'
import { CheckCircle, Link2, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { useConfirm } from './ConfirmProvider.jsx'

// Bloc « Mon compte QuickBooks » : connexion OAuth QuickBooks personnelle de
// l'utilisateur courant. Une fois connecté, les écritures qu'il publie depuis l'ERP
// sont attribuées à SON compte QuickBooks dans l'« Historique de vérification »
// (au lieu du compte principal par défaut).
//
// Réutilisé à deux endroits : la page /settings (accessible à tous) et l'onglet
// admin Connecteurs. La connexion se rattache toujours à l'utilisateur ERP courant.
export default function QuickBooksAccountCard() {
  const [status, setStatus] = useState(null)
  const confirm = useConfirm()

  const load = async () => {
    try { setStatus(await api.connectors.qbMyConnection()) } catch { setStatus({ connected: false }) }
  }
  useEffect(() => { load() }, [])

  const connect = () => {
    const token = localStorage.getItem('erp_token')
    window.location.href = `/erp/api/connectors/quickbooks/connect?scope=me&token=${token}`
  }

  const disconnect = async () => {
    const ok = await confirm({
      title: 'Déconnecter mon compte QuickBooks',
      message: `Déconnecter votre compte QuickBooks personnel ?\n\n` +
        `• Vos prochaines publications seront de nouveau attribuées au compte principal.\n` +
        `• Vous pourrez vous reconnecter à tout moment.`,
      confirmLabel: 'Déconnecter',
    })
    if (!ok) return
    await api.connectors.qbDisconnectMine()
    load()
  }

  if (!status) return null

  if (status.connected) {
    return (
      <div className="flex items-center justify-between p-2 bg-green-50 rounded-lg">
        <div className="flex items-center gap-2">
          <CheckCircle size={14} className="text-green-500" />
          <span className="text-xs text-slate-700">
            Connecté — vos publications sont signées à votre nom dans QuickBooks
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={connect} className="btn-secondary btn-sm text-xs" title="Réautoriser (si le token a expiré)">
            <Link2 size={12} /> Reconnecter
          </button>
          <button onClick={disconnect} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter mon compte">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
      <span className="text-xs text-slate-500">
        Non connecté — vos publications apparaissent sous le compte principal.
      </span>
      <button onClick={connect} className="btn-secondary btn-sm text-xs">
        <Link2 size={12} /> Connecter mon compte
      </button>
    </div>
  )
}
