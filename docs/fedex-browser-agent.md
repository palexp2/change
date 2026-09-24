# Pilote FedEx par agent navigateur

FedEx utilise par défaut `fedexAgent.js`. Les autres fournisseurs conservent leurs collecteurs. `FEDEX_BROWSER_AGENT=0` restaure le collecteur historique au prochain lancement (ne pas changer les identifiants ni les sessions).

Le navigateur Playwright et la session chiffrée existants sont réutilisés. À chaque étape, le modèle reçoit le texte des pages, les contrôles visibles et leurs références temporaires. Il choisit une action JSON ; le serveur exécute uniquement les actions de consultation prévues. Aucun shell, MCP ou code généré n'est confié au modèle. Les mots de passe et codes sont saisis côté serveur, sans les inclure dans les observations.

Le moteur utilise le CLI Claude déjà installé et authentifié sur le serveur, modèle Sonnet. Aucun nouveau service ou clé n'est nécessaire. Chaque décision dispose de 60 secondes, la tournée de 50 étapes et 12 minutes ; la saisie humaine du code utilise l'attente OTP existante. Une authentification refusée n'est pas retentée automatiquement.

L'agent liste les factures avant téléchargement. L'ERP garde la sélection par transaction bancaire, la déduplication et l'ingestion. En mode ciblé, la recherche couvre les archives ; en mode fenêtre, les dates sont limitées au nombre de jours du compte. Les métadonnées proviennent uniquement de lignes observées. Le PDF téléchargé doit être un PDF lisible par `pdftotext`, mentionner FedEx et confirmer le numéro de facture demandé. Les relevés d’activité payés par carte sont reconnus par leur en-tête « Activity Number » et leur préfixe A (A2-746-26580 correspond au numéro 2-746-26580 affiché au portail). Un document scanné sans texte est refusé pour ce pilote.

Les étapes sont visibles dans le journal habituel de Collecte. Les captures sont prises à la fin du relevé et en cas de blocage. Pour lancer : Collecte → compte FedEx → lancer la collecte. En cas de session refusée ou de captcha, renvoyer une session depuis le module de navigateur. On peut désactiver le compte avec le contrôle existant.

Vérification :

```sh
node --test server/src/services/scrapers/fedexAgent.test.js server/src/services/scrapers/fedex.test.js
```

Les tests utilisent de vraies pages Chromium servies par interception locale et des décisions simulées : pagination, variations de libellés, intégrité des métadonnées, secret, restrictions de navigation, budget et refus du mauvais PDF. Ils n'appellent ni FedEx ni le modèle. L'essai réel reste nécessaire pour vérifier leurs interactions.

## Essai réel du 21 septembre 2026

Session existante réutilisée, consentement cookies traité par l'agent, navigation vers « View all invoices », 34 documents relevés, ouverture de 2-746-26580 puis « Show invoice (PDF) ». PDF de 585 095 octets récupéré et vérifié : relevé d'activité A2-746-26580, 7 septembre 2026, total 323,81 CAD. Essai de navigation et de téléchargement uniquement : aucun import ni rapprochement bancaire exécuté pendant ce test.

Validation locale : 11 tests réussis, lint des fichiers concernés sans erreur, build client réussi. Le pilote reste borné et peut demander une nouvelle session ; ce résultat ne garantit pas les prochaines collectes si le portail change.
