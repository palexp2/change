// Les 6 templates HubSpot exacts pour l'email « instructions de retour au
// client » (recherche "return" dans la bibliothèque HubSpot). Texte brut
// simple — pas de HTML riche, pas de logo — fidèle à la source, fautes
// d'origine comprises (ex. « vôtre » dans le template #6). Voir Phase 2 du
// plan pour le détail de la sélection.
//
// Sélection sur 3 axes :
//  - pays du client  : CA → Purolator (FR ou EN selon la langue), US → UPS (EN seulement)
//  - type de retour  : immédiat (garantie, échange immédiat — rappel 21 jours)
//                      vs différé/aucun échange (pas de rappel)
//  - EN-CAN reste volontairement SANS personnalisation ("Hello there,") —
//    fidèle à HubSpot, confirmé avec l'utilisateur, pas une erreur à corriger.

function nl2p(text) {
  return text.trim().split('\n\n').map(p => `<p style="margin:0 0 16px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('')
}

const TEMPLATES = {
  // #1 — US, EN, immédiat (UPS)
  us_en_immediate: {
    subject: 'How to ship back your Orisha equipment',
    body: (firstName) => nl2p(`Hi ${firstName},

Here is the process for sending back your Orisha equipment:
If you are not sure what you need to return to our office, I have attached a reminder to this email.

Please note that you have 21 days to return the equipment starting today.
Otherwise, we will charge you the full price.

<strong>RETURN PROCEDURE UPS</strong>
How to return an item:
1. Put the equipment inside a box.
2. Label the box containing the return item with the prepaid UPS shipping label attached to this email.
3. Secure the customs documents (all copies) on top of the box (documents are attached to this email)
4. Return your item using one of the two options:
   - Bring the package to your nearest UPS drop-off location
   - Schedule a pickup with UPS on ups.com/pickup or call 1-800-742-5877

We thank you for your collaboration.`),
  },
  // #2 — CAN, FR, immédiat (Purolator)
  ca_fr_immediate: {
    subject: 'Comment renvoyer votre équipement défectueux',
    body: (firstName) => nl2p(`Bonjour ${firstName},

Voici la procédure à suivre pour retourner votre équipement Orisha:

Veuillez noter que vous disposez de 21 jours pour le retourner.
Dans le cas contraire, nous vous facturerons le prix total.

- Placez l'équipement dans une boîte.
- Étiquetez la boîte contenant l'article retourné avec l'étiquette d'expédition prépayée Purolator, jointe à ce courriel.
- Retournez votre article de l'une des deux manières suivantes :
  - Apportez le colis au point de dépôt Purolator le plus proche OU
  - Planifiez un ramassage via le chat sur https://www.purolator.com/fr ou appelez le 1 888 SHIP-123 (1 888 744-7123).

Nous vous remercions de votre collaboration.`),
  },
  // #3 — CAN, EN, immédiat (Purolator) — sans personnalisation
  ca_en_immediate: {
    subject: 'How to ship back your defective equipment',
    body: () => nl2p(`Hello there,
Here is the process for sending back your Orisha equipment:

If you are not sure what you need to return to our office, I have attached a reminder to this email.

Please note that you have 21 days to return the equipment.
Otherwise, we will charge you the full price.

<strong>RETURN PROCEDURE PUROLATOR</strong>
How to return a defective item:
1. Put the equipment inside a box.
2. Label the box containing the return item with the prepaid Purolator shipping label attached to this email.
3. Return your item using one of the two options:
   - Bring the package to your nearest Purolator drop-off location
   - Schedule a pickup through their chat feature on https://www.purolator.com/en or call 1-888-SHIP-123 (1-888-744-7123)

We thank you for your collaboration.
1-888-267-4742
support@orisha.io`),
  },
  // #4 — US, EN, différé (UPS)
  us_en_deferred: {
    subject: 'How to ship back your Orisha equipment',
    body: (firstName) => nl2p(`Hi ${firstName},

Here is the process for sending back your Orisha equipment:

<strong>RETURN PROCEDURE UPS</strong>
How to return an item:
1. Put the equipment inside a box.
2. Label the box containing the return item with the prepaid UPS shipping label, attached to this email.
3. Secure the customs documents (all copies) on top of the box (documents are attached to this email)
4. Return your item using one of the two options:
   - Bring the package to your nearest UPS drop-off location
   - Schedule a pickup with UPS on ups.com/pickup or call 1-800-742-5877

We thank you for your collaboration.`),
  },
  // #5 — CAN, EN, différé (Purolator) — sans personnalisation
  ca_en_deferred: {
    subject: 'How to ship back your defective equipment',
    body: () => nl2p(`Hello there,
Here is the process for sending back your Orisha equipment:

<strong>RETURN PROCEDURE PUROLATOR</strong>
How to return a defective item:
1. Put the equipment inside a box.
2. Label the box containing the return item with the prepaid Purolator shipping label, attached to this email.
3. Return your item using one of the two options:
   - Bring the package to your nearest Purolator drop-off location
   - Schedule a pickup through their chat feature on https://www.purolator.com/en or call 1-888-SHIP-123 (1-888-744-7123)

We thank you for your collaboration.
1-888-267-4742
support@orisha.io`),
  },
  // #6 — CAN, FR, différé (Purolator) — objet resté en anglais dans HubSpot, reproduit tel quel
  ca_fr_deferred: {
    subject: 'How to ship back your defective equipment',
    body: (firstName) => nl2p(`Bonjour ${firstName},

Voici la procédure pour retourner l'équipement Orisha.

- Mettez l'article dans une boîte.
- Imprimez l'étiquette de retour jointe à ce courriel et collez-là sur la boîte.
- Retourner la boîte en utilisant l'une de ces deux méthodes:
  - Apportez la boîte au point de dépôt Purolator le plus proche
  - Planifiez un ramassage à vôtre ferme via la fonction de clavardage sur https://www.purolator.com/fr ou appelez au 1-888-SHIP-123 (1-888-744-7123)

Merci de vôtre collaboration,`),
  },
}

const IMMEDIATE_REASON = 'Retour de garantie avec échange immédiat'

// `country` = code ISO 2 lettres ('CA'|'US'|...), `lang` = valeur brute du
// single-select Airtable Contact.Langue ('French'|'English'), `returnReason`
// = return_items.return_reason du/des item(s) du retour.
export function selectReturnInstructionsTemplate({ country, lang, returnReason }) {
  const isImmediate = returnReason === IMMEDIATE_REASON
  const isUS = country === 'US'
  const isFrench = lang === 'French'

  let key
  if (isUS) key = isImmediate ? 'us_en_immediate' : 'us_en_deferred'
  else if (isFrench) key = isImmediate ? 'ca_fr_immediate' : 'ca_fr_deferred'
  else key = isImmediate ? 'ca_en_immediate' : 'ca_en_deferred'

  return { key, ...TEMPLATES[key] }
}

export function buildReturnInstructionsHtml(template, firstName) {
  const body = template.body(firstName || '')
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>${template.subject}</title></head>
  <body style="margin:0;padding:20px;background:#ffffff;font-family:Arial, sans-serif;color:#333333;font-size:15px;line-height:1.5;">
    ${body}
    <p style="margin:24px 0 0 0;color:#555555;">Automatisation Orisha Inc.<br>1-888-267-4742 · support@orisha.io</p>
  </body>
</html>`
}
