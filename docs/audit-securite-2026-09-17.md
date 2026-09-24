# Audit de sécurité Boréal — 17 septembre 2026

## Conclusion et périmètre

Risque global **élevé, avec une faille critique d’exécution de code**. Priorité : isoler les scripts, révoquer correctement les sessions, fermer les accès anonymes aux fichiers privés et filtrer les données RH du bootstrap.

Audit du code présent dans le workspace (y compris les modifications non commitées), des dépendances npm serveur/client et de la configuration nginx locale. Tests isolés avec dépendances simulées ; trois requêtes HEAD anonymes vers le serveur local, sans téléchargement des contenus. Aucune modification du fonctionnement de l’application, aucun envoi de message, aucun appel métier externe. Les audits npm interrogent le registre. Aucun secret n’est reproduit ici.

Ce rapport n’est pas un pentest exhaustif : absence de vérification de l’infrastructure cloud, des sauvegardes distantes, de l’historique complet Git et des contrôles éventuels en amont du nginx. Le code sur disque peut différer du processus déployé. Les preuves dynamiques isolées sont distinguées des constats statiques.

## Constats

### S01 — Critique : sortie du contexte d’exécution des automatisations

**Sources :** `server/src/services/scriptSandbox.js:97`, `:176` ; `server/src/routes/automations.js:849`, `:951`, `:1243`.

Tout utilisateur authentifié peut créer puis lancer un script. Le contexte `node:vm` expose des fonctions du contexte hôte, dont `log`. Le script `log(log.constructor('return process.version')())` accède au véritable processus Node et affiche sa version. Reproduit à partir du module réel, en remplaçant uniquement les imports DB et email par des doubles inertes. Aucun secret lu.

**Impact :** le contexte ne constitue pas une frontière de sécurité ; un compte ordinaire compromis peut accéder aux capacités du processus serveur. Même sans évasion, `query()` autorise des SELECT sur toutes les tables et `fetch()` n’impose aucune restriction de destination.

**Correction :** restreindre immédiatement création, modification et exécution aux administrateurs de confiance ; exécuter ensuite les scripts dans un processus/conteneur réellement isolé, sans secrets ni accès disque de l’application, avec API de données limitée, filtrage réseau et quotas. Le contrôle de rôle seul ne rend pas `vm` sûr. La [documentation officielle Node](https://nodejs.org/api/vm.html#vm-executing-javascript) précise que ce module n’est pas un mécanisme de sécurité.

### S02 — Élevée : désactivation et suppression d’un compte ne révoquent pas ses jetons

**Sources :** `server/src/middleware/auth.js:9`, `:29` ; `server/src/routes/auth.js:19` ; `server/src/services/realtime.js`.

Les JWT expirent après dix ans. Le middleware relit le rôle mais jamais `active`. Si l’utilisateur a été supprimé, il réutilise le rôle du JWT ; une erreur SQL produit le même repli. Le changement de mot de passe n’invalide pas les jetons déjà émis. Le WebSocket vérifie la signature sans vérifier l’existence ou l’activité du compte.

**Preuve isolée :** `requireAdmin` accorde l’accès avec un ancien JWT administrateur lorsque le double DB retourne un compte désactivé, puis lorsqu’il ne retourne aucun compte.

**Correction :** refuser tout utilisateur absent/inactif et toute erreur de contrôle ; utiliser une version de session ou une date de révocation, une durée courte et un renouvellement contrôlé. Appliquer la même politique aux WebSockets et fermer les connexions révoquées.

### S03 — Élevée : enregistrements audio et documents privés accessibles anonymement

**Source :** `server/src/index.js:257` — montages `express.static` de `/api/recordings`, `/api/bons-livraison`, `/api/attachments` avant les routeurs authentifiés.

**Preuve sur le processus local :** HEAD sans Authorization sur un fichier existant de chaque catégorie → **200**, respectivement `audio/mp4`, `application/pdf`, `image/png`. Aucun corps téléchargé. La configuration nginx transmet `/erp/api/` sans authentification supplémentaire.

**Impact :** toute personne connaissant le chemin peut consulter le fichier ; un nom UUID rend la découverte moins facile mais n’apporte ni contrôle d’accès ni révocation. Pas de preuve d’indexation ou de découverte exhaustive des noms.

**Correction :** supprimer les montages publics des catégories privées ; servir les fichiers via authentification et autorisation sur l’enregistrement. Pour le partage externe volontaire, liens dédiés, révocables et à expiration.

### S04 — Élevée : le bootstrap contourne les restrictions RH

**Sources :** `server/src/routes/bootstrap.js:88` et route `/delta` ; `server/src/db/changeLog.js:45` ; `server/src/db/recordRegistry.js:71` ; `server/src/routes/paies.js:99`.

Les routes employés exigent RH/admin et la liste des paies filtre les non-RH. Pourtant le bootstrap, accessible avec `requireAuth`, exporte les tables `employees`, `vacations`, `paies`, `timesheets` sans exclusion de colonnes ni filtre selon l’utilisateur. Les spécifications sont obtenues globalement, sans contexte utilisateur. Le mécanisme de delta ne rétablit pas ces restrictions.

**Impact :** accès aux données RH présentes dans ces tables malgré les contrôles des routes métier. Le registre employés inclut notamment informations bancaires, coordonnées privées et évaluations. Constat statique ; aucune extraction des données RH réelles effectuée.

**Correction :** centraliser les autorisations de lignes/colonnes et les appliquer au snapshot, delta, routes génériques et événements temps réel. Purger les caches clients antérieurement trop larges. Vérifier avec des utilisateurs admin, RH et ordinaires.

### S05 — Élevée : état OAuth falsifiable et non lié à une session

**Sources :** `server/src/routes/connectors.js:310`, `:333`, `:399`, `:408`, `:2612`, `:2627`.

Le `state` est du JSON encodé en base64url, sans signature, nonce serveur à usage unique ou liaison au navigateur initiateur. Le callback QuickBooks public accepte `accountKey` fourni par ce state, alors que la connexion principale est réservée aux administrateurs sur la route de départ. Le callback Google accepte également des attentes d’identité modifiables ; Airtable transporte son vérificateur PKCE dans le state.

**Impact :** substitution de compte/connecteur et contournement des restrictions imposées au départ du parcours. L’exploitation exige un code OAuth valide obtenu pour l’application ; ce n’est pas une génération arbitraire de jetons fournisseur. Aucun parcours réel de liaison n’a été exécuté.

**Correction :** nonce aléatoire stocké côté serveur, expirant et consommé une seule fois, lié à l’utilisateur, à sa session, au fournisseur et au compte cible. Garder le vérificateur PKCE côté serveur ; revalider les droits au callback.

### S06 — Élevée : administration des connecteurs accessible à tout compte

**Source :** `server/src/routes/connectors.js:481`, `:489`.

`DELETE /api/connectors/accounts/:id` exige uniquement `requireAuth` et ne vérifie aucune propriété du compte. `PUT /api/connectors/config/:connector` accepte des clés arbitraires avec le même contrôle. Les restrictions appliquées à certaines routes spécialisées ne couvrent donc pas ces routes génériques.

**Impact :** déconnexion des intégrations et modification de leur configuration par un utilisateur ordinaire. Constat statique ; aucune modification exécutée.

**Correction :** accès administrateur pour les intégrations partagées, vérification de propriété pour les comptes personnels, liste explicite des connecteurs et clés modifiables.

### S07 — Élevée : secrets OAuth enregistrés en clair et repli dangereux du chiffrement

**Sources :** `server/src/routes/connectors.js:354`, `:420`, `:489` ; `server/src/connectors/google.js:123` ; `server/src/utils/encryption.js:9`, `:28` ; `server/src/config/secrets.js:31`.

Les callbacks Google/Airtable écrivent directement les access/refresh tokens dans SQLite. La route générique de configuration écrit aussi les valeurs directement, contournant le stockage chiffré disponible ailleurs. `encryptCredentials` retourne le texte d’origine si le chiffrement échoue. Son ancienne clé de repli n’est pas une clé hexadécimale valide : test avec clé absente et valeur fictive → stockage en clair. Le chargeur JWT conserve aussi une valeur de repli connue quand la configuration manque.

**Nuance :** le fichier `.env` actuel contient un secret JWT d’au moins 32 caractères différent du défaut connu et une clé de chiffrement hexadécimale valide de 64 caractères. Les replis dangereux sont donc des risques conditionnels, pas la preuve que ces défauts sont actifs. Le stockage OAuth direct reste présent dans le code indépendamment de la clé.

**Correction :** chiffrer tous les chemins de stockage, migrer les valeurs existantes, refuser le démarrage/écriture en cas de clé invalide et éliminer les replis. Une sauvegarde `.env.bak-20260527-171309` a des permissions 0644 : restreindre les copies et vérifier leur nécessité. Aucun secret exposé confirmé à distance.

### S08 — Moyenne : jetons de dix ans transmis dans les URL

**Sources :** `server/src/middleware/auth.js:21` ; `client/src/lib/api.js:1464`, `:1720` ; `/etc/nginx/nginx.conf:18`.

Les aperçus utilisent `?token=`. Le journal nginx inclut `$request`, donc la configuration journalise aussi la query string des requêtes concernées. Des identifiants durables peuvent ainsi être conservés dans les journaux et l’historique. Les tokens sont également en localStorage, ce qui accroît l’impact d’une éventuelle XSS ; aucune XSS démontrée ici.

**Correction :** authentification par cookie HttpOnly sécurisé avec protection CSRF, ou ticket de téléchargement court et limité à une ressource ; masquer les paramètres sensibles dans les logs et révoquer les jetons qui y ont circulé.

### S09 — Moyenne : aucune limitation des tentatives de connexion identifiée

**Source :** `server/src/routes/auth.js:24` et configurations Express/nginx examinées.

Aucune limitation des tentatives entrantes de login n’a été trouvée dans les couches inspectées. Les rate guards existants concernent surtout les services externes et les envois d’automatisation. Un contrôle cloud éventuel reste à vérifier. Aucun test de force brute ou de charge réalisé.

**Correction :** quotas par compte et IP, temporisation progressive, supervision des échecs et MFA pour les comptes privilégiés.

### S10 — Dépendances : alertes à qualifier et corriger

Résultat de `npm audit --json --ignore-scripts`, sans installation ni correction automatique :

| Arbre | Critiques | Élevées | Modérées | Faibles | Total |
|---|---:|---:|---:|---:|---:|
| Serveur | 1 | 10 | 2 | 1 | 14 |
| Client | 0 | 6 | 5 | 2 | 13 |

Ce sont des entrées npm, incluant les dépendances transitives et de développement, pas 27 exploitations indépendantes démontrées en production. `tar` est l’entrée critique, via la chaîne de `bcrypt` : distinguer installation et exécution de l’application. Parmi les dépendances directes signalées : `multer`, `ws`, `form-data`, `sharp`, `xlsx`, `vite`, `postcss`, `react-router-dom`, `uuid`, `bcrypt`.

Prioriser les parseurs et uploads serveur accessibles, puis la chaîne de build. `xlsx` est signalé sans correctif disponible via npm audit ; remplacement ou distribution corrigée à qualifier. Plusieurs suggestions npm impliquent des versions majeures : ne pas lancer aveuglément `npm audit fix --force`. Valider les advisories applicables, les versions effectivement déployées et les tests métier après chaque lot. Les détails bruts de ce relevé sont dans `/tmp/boreal-audit-server.json` et `/tmp/boreal-audit-client.json` (fichiers temporaires).

## Vérifications et limites des tests existants

- Évasion du contexte : reproduite sur le code réel avec DB/email neutralisés, simple lecture de `process.version`.
- Utilisateur désactivé/supprimé : accès administrateur reproduit avec JWT de test et DB simulée.
- Chiffrement sans clé : retour en clair confirmé avec une valeur fictive.
- Fichiers privés : trois HEAD anonymes, trois réponses 200 sur le serveur local.
- `node --test server/src/routes/_auth-audit.test.js` : **2 tests réussis**. Ce test vérifie la présence syntaxique de middleware, pas l’efficacité des rôles, la révocation, les exports transversaux ou les montages statiques de `index.js`.
- Aucun scan agressif, aucune lecture de contenu de fichier privé, aucune modification de donnée métier.

## Ordre de correction proposé

1. **Immédiat :** restreindre les scripts et connecteurs, filtrer les données RH, protéger les fichiers privés, bloquer les comptes absents/inactifs.
2. **Ensuite :** révocation des sessions HTTP/WS, correction OAuth, retrait des JWT des URL et examen des journaux existants sans divulgation de secrets.
3. **Durablement :** isolation réelle des scripts, chiffrement complet et migration, limitation du login, mises à jour npm qualifiées.
4. **Validation :** tests d’autorisation par rôle incluant snapshot/delta/WS/fichiers, tests de révocation et OAuth ; vérification des protections sur le chemin public après déploiement.

Autre durcissement à planifier : CSP actuellement désactivée dans Express ; les pages statiques servies directement par nginx ne bénéficient pas automatiquement des en-têtes Helmet. Ce point n’est pas présenté comme une XSS avérée.
