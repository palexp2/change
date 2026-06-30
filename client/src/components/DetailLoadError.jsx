// État d'erreur visible pour l'échec de chargement d'une fiche détail.
// api.js throw sur échec réseau/serveur et n'a pas de handler global ; sans ce
// composant, un load() qui catch laisse la fiche sur un spinner infini ou un
// faux « introuvable ». Utilisé par toutes les fiches détail (Order, Product,
// Company, Contact, Facture, SaleReceipt, Soumission, Retour, Envoi, Employee,
// Purchase, StripePayout, Project, Ticket, Serial…) — à wrapper dans <Layout>
// par l'appelant, comme « introuvable ». Pattern : un état loadError + un
// onRetry={load} ; le branchement de rendu `if (loadError && !record)` passe
// AVANT le « introuvable » pour distinguer échec réseau et record absent.
export function DetailLoadError({ message, onRetry, retrying = false }) {
  return (
    <div className="p-6 max-w-lg mx-auto">
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-5 text-sm text-rose-700">
        <div className="font-medium">Impossible de charger cette fiche.</div>
        {message && <div className="mt-1 text-rose-600 break-words">{message}</div>}
        <button
          onClick={onRetry}
          disabled={retrying}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-rose-300 bg-white px-3 py-1.5 font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-60"
        >
          {retrying && <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-rose-500" />}
          Réessayer
        </button>
      </div>
    </div>
  )
}
