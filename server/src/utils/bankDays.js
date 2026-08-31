// Jours d'ouverture des banques, côté serveur.
//
// Le calendrier (fériés fédéraux + Fête nationale, règle du report au lundi,
// Pâques) vit dans `client/src/lib/bankDays.js` : c'est lui qui date les
// paiements dans la cédule affichée à l'utilisateur. Le dupliquer ici
// garantirait qu'un jour les deux calendriers divergent — et une alerte qui
// annonce une date de paiement différente de celle affichée à l'écran est pire
// que pas d'alerte du tout. Le module est du JS pur sans dépendance : on le
// réexporte tel quel.
//
// Si le serveur devait un jour être déployé sans le dossier `client/`, c'est
// ICI (et nulle part ailleurs) qu'il faudrait vendorer le fichier.
export {
  todayIso, shiftDays, weekdayOf, isWeekend, easterSunday, bankHolidays,
  holidayName, isBankDay, bankDayOnOrBefore, payDateForDue,
} from '../../../client/src/lib/bankDays.js'
