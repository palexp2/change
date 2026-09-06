// Titre d'un envoi — un seul numéro, partout.
//
// Le numéro d'un envoi est son « # d'envoi » (colonne `d_envoi`, ENV-1687),
// celui que montre la colonne du même nom dans le tableau des envois. Les
// titres de panneaux le construisaient au choix sur le numéro de COMMANDE ou
// sur le numéro de SUIVI : le panneau annonçait alors « Envoi 1047 » pour
// l'envoi ENV-1687, et les deux envois d'une même commande portaient le même
// titre.
//
// Repli quand `d_envoi` est vide : le numéro est calculé par Airtable, un envoi
// jamais synchronisé n'en a pas (voir services/airtableWriteback.js). On montre
// alors un fragment d'id, jamais un numéro qui appartient à un autre record.
export function shipmentTitle(row) {
  if (!row) return 'Envoi'
  if (row.d_envoi) return String(row.d_envoi)
  return `Envoi #${String(row.id).slice(0, 6)}`
}

// Sous-titre par défaut : entreprise + commande d'origine. Le numéro de
// commande quitte le titre mais reste sous les yeux de l'utilisateur.
export function shipmentSubtitle(row) {
  return [
    row?.company_name,
    row?.order_number ? `Commande #${row.order_number}` : null,
  ].filter(Boolean).join(' · ')
}
