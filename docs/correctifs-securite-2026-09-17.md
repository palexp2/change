# Correctifs de sécurité appliqués — 17 septembre 2026

Les correctifs prioritaires de l’audit ont été appliqués et activés : compilation frontend réussie, serveur `erp-server` redémarré, migration `077-encrypt-oauth-tokens` exécutée. Les modifications préexistantes du workspace ont été conservées ; aucun commit créé.

## Protections actives

- **Sessions HTTP et WebSocket :** utilisateur existant et actif obligatoire, rôle courant relu en base, validité de 12 heures, révocation au changement de mot de passe. Les anciens JWT sont refusés : reconnexion nécessaire. Les WebSockets recontrôlent la session avant émission et au heartbeat.
- **Automatisations et agents :** accès administrateur obligatoire aux routes automatisations, agents, travaux et exécution des boutons d’automatisation ; pages correspondantes protégées côté client.
- **Fichiers :** authentification obligatoire sur les enregistrements, bons de livraison et images Airtable. Le montage statique général des pièces jointes est supprimé au profit des routes de téléchargement. Les aperçus partagés et vignettes Airtable chargent les fichiers avec Authorization puis une URL blob locale.
- **RH :** retrait des tables RH du snapshot et du delta pour les non-RH, contrôle des canaux temps réel, des historiques génériques et des champs/fichiers personnalisés RH. Les anciens snapshots IndexedDB sont supprimés lors de la montée de version ; les snapshots RH ne sont plus persistés sur disque côté navigateur. La portée du cache est vérifiée avec le serveur avant réhydratation.
- **OAuth :** state aléatoire à usage unique, durée de dix minutes, liaison au navigateur par cookie HttpOnly/SameSite, contrôle de la session et des droits au retour. Vérificateur PKCE conservé côté serveur. Les parcours OAuth commencés avant le redémarrage doivent être relancés.
- **Connecteurs :** administration des comptes partagés réservée aux administrateurs ; liste autorisée de clés sur la route générique, validation des valeurs et masquage des mots de passe dans la réponse de configuration.
- **Secrets :** chiffrement des access/refresh tokens Google, Airtable, Amazon et QuickBooks à l’écriture et au renouvellement. Migration des valeurs existantes, ainsi que des secrets Stripe, HubSpot et du jeton de webhook QuickBooks. Refus d’utiliser le secret JWT faible de repli et refus de stocker silencieusement en clair en cas d’échec de chiffrement. Permissions de l’ancienne sauvegarde `.env` ramenées à 0600.
- **Connexion :** limitation des tentatives par IP et par compte, en mémoire et bornée. Le JWT en query string n’est plus accepté pour les méthodes autres que GET/HEAD.
- **Dépendances serveur :** mises à jour de `ws`, `multer`, `form-data`, `axios`, `qs`, `body-parser` et de leur résolution transitive compatible. Audit npm serveur : **14 → 8 alertes** (1 critique, 6 élevées, 1 modérée restantes).

## Vérifications

- **54 tests réussis**, incluant les nouveaux tests de sécurité, le temps réel, la couverture d’authentification, les gardes des scripts, les webhooks QuickBooks et les routes paiements/reçus.
- Tests exécutés avec `--import ./src/test-helpers/testEnv.js` et bases temporaires. Deux anciens tests de sandbox dépendaient du schéma de production : ils utilisent désormais le harnais isolé.
- ESLint ciblé serveur/client, vérifications syntaxiques et `git diff --check` réussis.
- `npm run build` réussi ; sortie servie dans `client/dist`.
- Après activation, contrôles HEAD locaux et HTTPS : health **200** ; enregistrements, bons de livraison, images Airtable et bootstrap anonymes **401**.
- Migration présente dans le registre ; **0 jeton OAuth en clair** dans les colonnes des quatre fournisseurs vérifiés. Aucune valeur de secret affichée.
- Sauvegarde cohérente SQLite avant migration dans `server/data/security-backups/`, répertoire 0700, fichier 0600. Cette sauvegarde contient l’état antérieur au chiffrement et doit rester protégée puis être supprimée selon la politique de rétention.

## Limites et suites nécessaires

1. **Mise à jour : l’isolation Linux, les limites mémoire/temps et la file sont désormais livrées ; voir [Exécution isolée des scripts](isolation-scripts.md).** État au premier lot : restriction des auteurs, pas isolation complète. `node:vm` reste impropre à exécuter du code hostile. Les administrateurs de confiance conservent cette capacité ; un processus/conteneur séparé avec droits et réseau limités reste à construire. Les scripts existants et données externes qu’ils consomment n’ont pas tous été revus.
2. **JWT dans les URL : retrait partiel.** Les aperçus partagés utilisent désormais Authorization, mais certains lecteurs audio, flux et autres téléchargements conservent `?token=`. Le remplacement général par des tickets courts et le traitement des anciens journaux nginx restent à faire.
3. **Dépendances restantes :** `tar`/chaîne `bcrypt`, `sharp`, `uuid`, `xlsx`, `brace-expansion`, `js-yaml`. Le frontend conserve les alertes de l’audit initial. Les migrations majeures et le remplacement de SheetJS demandent une validation dédiée ; aucun `audit fix --force` n’a été appliqué.
4. **Périmètre du chiffrement :** cette livraison couvre les fournisseurs et secrets explicitement listés ci-dessus. Elle ne garantit pas le chiffrement de toutes les configurations historiques, notamment des autres connecteurs, ni des anciennes sauvegardes.
5. Les limites de login et états OAuth sont locaux au processus ; une architecture multi-instance nécessitera un stockage partagé. La MFA, une CSP adaptée et la revue exhaustive des droits sur les recherches, relations et champs calculés restent des travaux distincts.

La livraison réduit les risques prioritaires ; elle ne constitue pas une déclaration de sécurité exhaustive de l’application.
