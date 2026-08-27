// Moyens de paiement émis — source de vérité unique de « quoi saisir pour quel
// moyen ». Extraite de /paiements-emis parce que la cédule (« À payer ») en a
// besoin elle aussi : c'est le moyen qui nomme la référence à saisir (n° de
// chèque, n° de confirmation Interac, code de paiement…).
//
//   transfer     — mouvement entre deux de NOS comptes : « De » → « Vers », pas
//                  de bénéficiaire externe, sens déduit des deux comptes.
//   recipient    — bénéficiaire réel (courriel Interac, « à l'ordre de »), souvent
//                  différent du fournisseur facturé. Ne se saisit plus à la
//                  création : seulement dans le détail d'une ligne, au besoin.
//   invoice      — le paiement règle une facture fournisseur identifiable.
//   sens         — laisse choisir entrée/sortie (mouvements inhabituels).
import {
  Send, ArrowLeftRight, CreditCard, ScrollText, KeyRound, MoreHorizontal,
} from 'lucide-react'

export const METHOD_SPECS = {
  interac: {
    label: 'Virement Interac',
    icon: Send,
    hint: "L'argent part d'un compte vers un courriel ou un téléphone. Le débit apparaît souvent 1 à 3 jours plus tard.",
    accountLabel: "Compte d'où part le virement",
    accountLabelIn: 'Compte qui reçoit le virement',
    accountKind: 'bank',
    payeeLabel: 'Bénéficiaire du virement',
    payeeLabelIn: 'Expéditeur du virement',
    payeePlaceholder: "Les Jardins d'Inverness",
    recipientLabel: 'Courriel ou téléphone du bénéficiaire',
    refLabel: 'N° de confirmation de la banque',
    refShort: 'N° confirmation',
    refPlaceholder: 'ex. CA4RTG7X',
    dateLabel: "Date d'envoi du virement",
    invoice: true,
    // Un Interac peut aussi ENTRER (renflouement depuis un autre de nos comptes,
    // remboursement d'un partenaire) — d'où le choix du sens.
    sens: true,
  },
  transfert: {
    label: 'Transfert entre comptes',
    icon: ArrowLeftRight,
    hint: "Argent déplacé entre deux de nos comptes (renflouement du BNC, Épargne → Chèque). Rien ne quitte l'entreprise.",
    transfer: true,
    fromLabel: "Compte d'où part l'argent",
    toLabel: "Compte qui reçoit l'argent",
    fromKind: 'bank',
    toKind: 'bank',
    refLabel: 'N° de confirmation (facultatif)',
    refShort: 'N° confirmation',
    dateLabel: 'Date du transfert',
    invoice: false,
  },
  cheque: {
    label: 'Chèque',
    icon: ScrollText,
    hint: 'Chèque émis. Il peut être encaissé bien après la date inscrite — il reste projeté jusque-là.',
    accountLabel: 'Compte sur lequel le chèque est tiré',
    accountKind: 'bank',
    payeeLabel: "À l'ordre de",
    payeePlaceholder: 'Nom inscrit sur le chèque',
    refLabel: 'N° du chèque',
    refShort: 'N° chèque',
    refPlaceholder: 'ex. 1042',
    dateLabel: 'Date inscrite sur le chèque',
    invoice: true,
  },
  carte: {
    label: 'Paiement de carte de crédit',
    icon: CreditCard,
    hint: "Remboursement du solde d'une carte depuis un compte bancaire (site de l'émetteur ou virement).",
    transfer: true,
    fromLabel: 'Compte qui paie',
    toLabel: 'Carte payée',
    fromKind: 'bank',
    toKind: 'card',
    refLabel: 'N° de confirmation (facultatif)',
    refShort: 'N° confirmation',
    dateLabel: 'Date du paiement',
    invoice: false,
  },
  code_paiement: {
    label: 'Code de paiement',
    icon: KeyRound,
    hint: 'Paiement fait au guichet ou en ligne avec un code fourni par le bénéficiaire (Revenu Québec, ARC…).',
    accountLabel: 'Compte débité',
    accountKind: 'bank',
    payeeLabel: 'Bénéficiaire',
    payeePlaceholder: 'Revenu Québec',
    refLabel: 'Code de paiement / n° de confirmation',
    refShort: 'Code / n°',
    dateLabel: 'Date du paiement',
    invoice: true,
  },
  autre: {
    label: 'Paiement',
    icon: MoreHorizontal,
    hint: 'Prélèvement préautorisé, paiement de facture en ligne, mouvement inhabituel. Le sens est à préciser.',
    accountLabel: 'Compte débité',
    accountLabelIn: 'Compte crédité',
    accountKind: 'any',
    payeeLabel: 'Fournisseur / libellé',
    payeeLabelIn: "Provenance de l'argent",
    payeePlaceholder: 'Nom qui apparaîtra au relevé',
    refLabel: 'Référence (facultatif)',
    refShort: 'Référence',
    dateLabel: 'Date du mouvement',
    invoice: true,
    sens: true,
  },
}

export const METHOD_ORDER = ['interac', 'transfert', 'cheque', 'carte', 'code_paiement', 'autre']

export const spec = m => METHOD_SPECS[m] || METHOD_SPECS.autre
