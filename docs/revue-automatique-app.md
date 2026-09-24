# Revue automatique de l’app

La revue est intégrée à l’automation existante `sys_work_suggestions`. Si cette
automation est active, elle passe chaque jour à **11 h UTC**, avant les suggestions
de chantiers et d’intégrations. Son interrupteur dans Automatisations permet de
couper l’ensemble. « Exécuter » lance un passage immédiat ; le bouton de génération
des chantiers dans Travaux lance aussi la revue. « Simuler » ne sollicite pas le
modèle et conserve le diagnostic du contexte métier existant.

Les résultats apparaissent dans **Travaux → Suggestions → Chantiers**, domaine
technique. Chaque résultat précise la priorité, le fichier, la ligne, le scénario,
la correction proposée et sa vérification. Accepter la suggestion la transmet à
la file de travail existante ; la revue ne crée jamais elle-même de correction.

La revue utilise Codex indépendamment du modèle global des travaux. Le modèle
provient de la configuration locale Codex (GPT-6 Astra lors de cette mise en place).
L’onglet simplifié filtre la provenance `app_review` ; son bouton d’analyse ne
lance que ce moteur. Les anciennes suggestions restent dans la vue complète.

Chaque passage fournit à Codex jusqu’à sept extraits de sources
suivies par Git, dans une limite de 60 000 caractères. La sélection tourne selon
le jour UTC. Les configurations, tests, migrations, fichiers non suivis et liens
symboliques sont exclus. Les données métier et fichiers `.env` ne sont pas lus
par ce collecteur. Le dépôt doit conserver sa règle de ne pas contenir de secrets
dans les sources.

Au maximum trois propositions sont publiées. La ligne citée doit exister dans
l’extrait fourni et être encore identique à la fin de l’analyse. Une empreinte
du fichier et de la preuve évite de republier le même constat, même rejeté.
Les passages concurrents sont regroupés. Un échec de la revue est journalisé et
n’empêche pas les moteurs de suggestions existants de poursuivre.

Il s’agit d’une **revue statique partielle quotidienne**, pas d’une surveillance
temps réel ni d’une certification de l’app. Aucune navigation navigateur ni
exécution de tests n’est effectuée par le collecteur. Une référence valide ne
prouve pas que le diagnostic du modèle est correct : le brief de correction
demande explicitement de confirmer le problème dans son contexte complet.

Validation locale :

```sh
cd server
node --import ./src/test-helpers/testEnv.js --test src/services/appReview.test.js src/services/workSuggestions.test.js
```

## Critères d’analyse

Le champ « Critères d’analyse » de Travaux enregistre automatiquement un texte
partagé (4 000 caractères maximum). Il définit les priorités et exclusions pour
les prochaines revues manuelles et quotidiennes. Un champ vide rétablit la
recherche de bugs et de problèmes de fiabilité. Le bouton d’analyse attend la
sauvegarde ; une erreur conserve la saisie et empêche le lancement. Une analyse
déjà en cours conserve les critères qu’elle a reçus au départ. Les critères
personnalisés sont recopiés dans les propositions pour garder leur contexte.

La revue reste limitée aux extraits fournis : demander un critère de performance
ou d’ergonomie n’ajoute pas une navigation navigateur ou une mesure de vitesse.
