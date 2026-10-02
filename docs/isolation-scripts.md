# Exécution isolée des scripts Boréal

Implémentation du 17 septembre 2026. Remplace l’exécution des scripts dans le processus Express. Concerne les scripts d’automatisation manuels/planifiés, les actions de règles de champ et les webhooks en mode script. Les automatisations système écrites dans le code serveur et les agents de développement ne sont pas des scripts de ce moteur et ne passent pas dans cette file.

## Limites par défaut

| Contrôle | Valeur |
|---|---:|
| Mémoire du processus isolé et de ses descendants | 128 Mio, swap interdit |
| Tas V8 | 64 Mio, en complément de la limite système |
| Temps total depuis le lancement, appels métier compris | 10 secondes |
| Exécutions simultanées | 1 |
| File FIFO | 50 demandes en attente |
| Attente maximale dans la file | 60 secondes |
| CPU du groupe | Un cœur au maximum |
| Nombre de tâches du groupe, threads compris | 16 |
| Espace temporaire privé | 8 Mio, inclus dans la mémoire du groupe |
| Taille du code / données d’entrée | 64 Kio / 1 Mio |
| Journal / réponse finale | 64 Kio chacun |
| Appels métier par exécution | 100 au maximum |
| Lecture SQL | 1 000 lignes, résultat inférieur à 1 Mio |

Un courtier SQL temporaire tourne séparément, avec **64 Mio d’espace d’adressage** au maximum et une limite de calcul SQL d’une seconde, doublée d’un arrêt externe après 1,5 seconde. Il ne bloque donc pas la boucle événementielle d’Express. Une exécution peut utiliser ce courtier en plus de ses 128 Mio ; ce n’est pas une limite de 128 Mio pour l’ensemble de Boréal. Les tailles des échanges et de la file bornent aussi la mémoire conservée par le serveur.

La file est **en mémoire** : elle ne survit pas au redémarrage. Une demande refusée, expirée ou interrompue produit une erreur ; elle n’est pas relancée automatiquement. Les écritures ou envois déjà accomplis avant un arrêt ne sont pas annulés : l’exécution complète d’un script n’est pas une transaction.

## Frontière de sécurité

Chaque exécution crée un service utilisateur systemd transitoire et un environnement Bubblewrap avec espaces de noms Linux distincts : montages, utilisateurs, processus, réseau et IPC. Seuls le binaire Node, les bibliothèques système nécessaires et le petit worker sont montés en lecture seule. Le répertoire de Boréal, SQLite, les fichiers `.env`, les uploads, le répertoire personnel et le bus systemd ne sont pas montés. L’environnement est vidé ; le réseau du serveur n’est pas accessible. Les privilèges supplémentaires et les core dumps sont interdits.

`node:vm` reste utilisé **uniquement pour fournir l’API JavaScript**, à l’intérieur du processus isolé. Il n’est pas considéré comme une protection. Les tests sortent volontairement de son contexte et vérifient que la frontière Linux reste en place.

Le serveur impose le délai et systemd applique aussi `RuntimeMaxSec` indépendamment : la disparition du parent ne laisse pas un script tourner indéfiniment. `MemoryMax` couvre aussi les Buffer natifs et les descendants, contrairement à la seule taille du tas V8. L’arrêt vise tout le groupe de processus.

Les messages du worker sont traités comme non fiables : protocole et tailles validés, aucune autorisation ni limite fournie par le worker n’est acceptée. Il n’existe **aucun repli vers une exécution non isolée** si Bubblewrap, systemd ou les contrôles du noyau sont indisponibles.

## Fonctions accessibles aux scripts

- `log`, `console.log`, `row`, `trigger`, `params`, `request`, `respond` conservent leur rôle.
- `query(sql, params)` reste synchrone du point de vue du script, mais passe par un courtier séparé. Un authorizer SQLite contrôle réellement les tables et les opérations, y compris les sous-requêtes. Les tables d’utilisateurs, de secrets et RH sont exclues. Seules les tables métier listées dans `READABLE_TABLES` sont accessibles ; les vues et fonctions SQL propres au processus Node ne sont pas implicitement disponibles.
- `update(table, id, patch)` passe aussi par le courtier. La liste autorisée, les colonnes, l’immuabilité de l’identifiant et la garde contre les cycles sont validées hors du script. Le mode lecture seule ne peut pas être contourné en forgeant un message.
- `fetch` n’autorise que les origines HTTPS explicitement configurées dans `SCRIPT_FETCH_ORIGINS`, séparées par des virgules (`https://*.domaine` = tous ses sous-domaines). **Aucune par défaut.** Résolution DNS contrôlée, adresses IPv4 privées/réservées et IPv6 refusées, adresse publique épinglée à la connexion, aucun suivi de redirection, réponse bornée. Les accès réseau directs depuis le processus isolé restent bloqués.
- `sendEmail` n’autorise que les adresses exactes de `SCRIPT_EMAIL_RECIPIENTS`, séparées par des virgules (`https://*.domaine` = tous ses sous-domaines). **Aucune par défaut.** Aucun compte fournisseur ou jeton n’est transmis au script. Un envoi déjà accepté par le fournisseur ne peut pas être rappelé lors d’un timeout.

La base inspectée avant ce changement ne contenait aucun script personnalisé non vide. Les fonctions `query` et `update` conservent leur syntaxe synchrone pour les futurs scripts et les tests existants.

## Configuration et exploitation

Variables serveur, validées au démarrage :

| Variable | Défaut | Valeurs autorisées |
|---|---:|---:|
| `SCRIPT_MEMORY_MB` | 128 | 96–512 |
| `SCRIPT_TIMEOUT_MS` | 10000 | 100–30000 |
| `SCRIPT_CONCURRENCY` | 1 | 1–4 |
| `SCRIPT_QUEUE_SIZE` | 50 | 0–100 |
| `SCRIPT_QUEUE_TIMEOUT_MS` | 60000 | 100–300000 |

L’option interne `timeoutMs` peut réduire le délai d’un appel, jamais dépasser le plafond configuré. La file et la concurrence sont locales à l’unique processus ERP ; un passage à plusieurs instances nécessitera une coordination partagée.

La page **Automations** affiche le nombre de scripts en cours/en attente et les plafonds. `GET /erp/api/automations/runtime/status`, réservé aux administrateurs, expose les mêmes valeurs et les compteurs d’exécution. Les erreurs remontent aux journaux habituels des automatisations.

Prérequis Linux : cgroups v2 avec contrôle mémoire délégué au gestionnaire systemd utilisateur, Bubblewrap avec espaces de noms utilisateur activés, `systemd-run`, `systemctl`, `prlimit`, Python 3 avec SQLite et Node sous `/usr`. Sur ce serveur Amazon Linux, Bubblewrap a été installé depuis le dépôt de la distribution ; le maintien du gestionnaire utilisateur après déconnexion (`Linger=yes`) était déjà actif.

Pour une nouvelle installation Amazon Linux : installer `bubblewrap`, activer si nécessaire `loginctl enable-linger <utilisateur-du-service>`, puis exécuter les tests d’intégration ci-dessous. Ne jamais désactiver les protections pour contourner une erreur de démarrage.

## Validation

Depuis `server/` :

```sh
node --import ./src/test-helpers/testEnv.js --test src/services/scriptRuntime.test.js src/services/scriptSandbox.test.js
```

Les tests utilisent des bases temporaires et exécutent réellement les processus isolés. Ils vérifient FIFO/saturation/expiration/annulation, conservation du contexte de l’appelant, compatibilité SQL et webhook, refus des secrets SQL, refus des fichiers et du réseau hôte même après sortie du contexte JavaScript, arrêt des boucles synchrones/asynchrones et des promesses bloquées, arrêt d’une allocation Buffer de 256 Mio, puis reprise de la file. Aucun appel métier externe n’est envoyé.

**64 tests de régression réussis**, en incluant les contrôles de sécurité, le temps réel, les gardes de scripts, les routes paiements/reçus et les webhooks QuickBooks. Compilation frontend et ESLint ciblé réussis.

Après cette suite, les 12 tests dédiés au nouveau moteur ont été rejoués avec deux vérifications supplémentaires : falsification du protocole sans obtention de droits d’écriture, et libération immédiate d’une place après une exécution. Tous passent.

Activation effectuée : build frontend publié, serveur redémarré, essai sans effet métier renvoyant `isolation-active`. Vérification du point de suivi en service : **401 anonyme**, **200 administrateur**, file vide et plafonds attendus. Health HTTPS : **200**. Aucun service de script résiduel après les tests.

Référence de la politique de montage : [documentation Bubblewrap](https://github.com/containers/bubblewrap#sandboxing). Le niveau d’isolation dépend des options de lancement ; elles sont centralisées dans `server/src/services/scriptRuntime/process.js` et ne sont pas modifiables par le script.
