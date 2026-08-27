# Faire tourner Claude sur un abonnement (pas sur des crédits API) — brief d'implémentation

> Document destiné à un autre assistant IA chargé de reproduire, dans une autre application,
> le mécanisme de « file de travaux » de l'ERP Orisha. Il décrit **pourquoi** ça ne consomme
> pas de crédits API, **à quelles conditions**, et **comment** c'est construit.

---

## 1. Le point central

Claude est accessible de deux façons, facturées différemment :

| Voie | Auth | Facturation |
|---|---|---|
| **API Anthropic** (`https://api.anthropic.com/v1/messages`, SDK `@anthropic-ai/sdk`) | `ANTHROPIC_API_KEY` | au jeton, crédits API prépayés |
| **CLI Claude Code en mode headless** (`claude -p ...`) | session OAuth d'un compte Claude (Pro/Max/Team), stockée dans `~/.claude/.credentials.json` | **incluse dans l'abonnement** — quotas glissants, pas de facture au jeton |

L'ERP n'utilise **que la seconde**. Il n'y a aucune clé API Anthropic dans son `.env`, et aucune
ligne de code n'appelle `/v1/messages`. Chaque « tâche » de la file de travaux est un
**sous-processus** `claude -p` lancé par le serveur Node, exactement comme si un humain tapait
la commande dans un terminal.

C'est pour ça que la réponse « il faut des crédits API » est vraie **pour une intégration API**,
et fausse pour cette architecture-ci.

## 2. Conditions à respecter — sinon ça bascule en facturation API

1. **Le CLI doit être installé sur une machine que tu contrôles** (VM, VPS, serveur dédié,
   conteneur persistant). Pas de serverless (Vercel/Lambda/Cloud Run éphémère) : il faut un
   système de fichiers et des processus qui survivent.
2. **Un humain doit s'être connecté une fois** sur cette machine (`claude` puis `/login`, ou
   `claude setup-token`). Ça écrit `~/.claude/.credentials.json`. Le token se rafraîchit seul
   ensuite.
3. **`ANTHROPIC_API_KEY` ne doit PAS être présent dans l'environnement du processus** qui
   spawne le CLI. Si la variable existe, le CLI l'utilise en priorité → tu paies au jeton sans
   t'en rendre compte. À vérifier explicitement.
4. **`HOME` doit être posé** sur l'env du spawn (`HOME: '/home/<user>'`). Un service systemd/pm2
   avec un `HOME` vide ou différent ne trouvera pas les credentials → échec d'auth.

### Limite structurelle à énoncer clairement au client

C'est **un compte, un abonnement, une machine**. Les quotas (fenêtre 5 h, plafond hebdomadaire
global, plafond hebdomadaire par modèle) sont ceux de ce compte unique et sont partagés par
toutes les exécutions. Concrètement :

- ✅ Parfait pour une app **interne / single-tenant** : un agent qui travaille pour l'équipe.
- ❌ Inadapté à un **SaaS multi-clients** : tu ne peux pas faire tourner l'IA de 500 utilisateurs
  sur un forfait individuel. Pour ça, c'est l'API (ou chaque client apporte son propre
  abonnement et se connecte sur son propre environnement).
- La concurrence est faible par nature. L'ERP n'exécute **qu'une tâche en écriture à la fois**
  (un slot global), plus quelques lectures seules en parallèle.

## 3. Architecture du runner (ce qu'il faut reproduire)

### 3.1 La commande de base

```bash
claude -p \
  --output-format stream-json --verbose \
  --model "sonnet" --effort "high" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
  < prompt.txt > run.log 2>&1
echo $? > run.code
```

- `-p` = mode headless (print) : lit le prompt, travaille, sort.
- Le prompt passe par **stdin depuis un fichier**, pas par argv (pas de limite de taille, pas
  d'échappement shell à gérer).
- `--output-format stream-json --verbose` : chaque événement est une ligne JSON (NDJSON). C'est
  ce qui permet de streamer la progression vers l'UI en direct.
- `--allowedTools` : liste blanche d'outils. Une tâche « question » ne reçoit que
  `Read,Glob,Grep` → elle ne peut physiquement rien modifier.
- La sortie va dans un **fichier**, jamais dans un pipe vers le parent (voir §3.3).

### 3.2 Détachement du processus — le piège n°1

Le serveur applicatif redémarre (déploiement, `pm2 restart`). Si l'exécution Claude est un enfant
direct du serveur, elle meurt avec lui. Pire : l'agent qui modifie le serveur et le redémarre
lui-même se décapite au moment de valider son travail.

Solution : couper la lignée avec `setsid --fork`.

```js
const cmd =
  `printf '%s\\n' "$$" > "${pidFile}"; ` +
  `"${CLAUDE_BIN}" -p --output-format stream-json --verbose ${flags} ` +
  `--allowedTools "${tools}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`

const proc = spawn('setsid', ['--fork', 'bash', '-c', cmd], {
  cwd: WORKDIR,
  env: { ...cleanEnv, HOME: '/home/ec2-user' },
  detached: true,
  stdio: 'ignore',   // personne ne lit sa sortie → un restart ne peut pas le tuer par SIGPIPE
})
proc.unref()
```

Points non négociables :

- `setsid --fork` → le wrapper est réadopté par init (ppid 1) et devient invisible au
  `treekill` du gestionnaire de process.
- **Le pid retourné par `spawn()` est inutile** (c'est celui de setsid, éphémère). C'est le
  wrapper bash qui écrit **son** pid (`$$`) dans un fichier, dès sa première ligne.
- `stdio: 'ignore'` : si personne ne lit le stdout de l'enfant et que le parent meurt, aucun
  SIGPIPE ne peut le tuer.
- Nettoyer l'env hérité : `const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...cleanEnv } = process.env`.
  Ces variables, présentes si le serveur a lui-même été lancé depuis Claude Code, perturbent le
  CLI imbriqué.

### 3.3 Trois artefacts durables par exécution

| Fichier | Contenu |
|---|---|
| `.run-<id>.prompt` | le prompt (entrée stdin) |
| `.run-<id>.log` | le flux NDJSON |
| `.run-<id>.code` | le code de sortie, écrit **après** la fin |

Le serveur ne « tient » rien en mémoire. Il **poll** ces fichiers. Un redémarrage du serveur en
plein milieu ne perd donc aucun résultat : au retour, le `.code` est là.

### 3.4 Boucle de surveillance (toutes les 2 s)

```js
const poll = setInterval(() => {
  drainLog()                                   // lit le delta depuis `offset`, découpe en lignes, pousse à l'UI
  if (existsSync(CODE)) return finalize()      // signal primaire : terminé
  if (Date.now() - startedAt > TIMEOUT_MS) {   // délai dépassé → tuer TOUT le groupe
    process.kill(-pid, 'SIGKILL'); return finalize({ killedTimeout: true })
  }
  const pid = readPidFile()                    // process disparu sans code → crash
  if (pid && !isProcessAlive(pid) && Date.now() - startedAt > 6000) return finalize()
}, 2000)
```

`drainLog()` garde un `offset` d'octets + un buffer de ligne partielle : on relit uniquement le
nouveau, et on ne parse jamais une ligne JSON tronquée.

Le timeout tue **le groupe** (`kill(-pid)`), pas juste le wrapper — sinon Claude et ses
sous-processus survivent orphelins.

### 3.5 Extraction du résultat depuis le NDJSON

```js
// Le récit complet : concaténer les blocs texte des événements `assistant`
if (evt.type === 'assistant') for (const b of evt.message.content) if (b.type === 'text') text += b.text

// L'identifiant de session (pour --resume) : n'importe quel événement porte `session_id`
if (evt.session_id) return evt.session_id

// Le message FINAL : l'événement `result`. Important — sur une longue exécution,
// le dernier tour peut n'exister QUE là, pas dans les événements `assistant`.
```

Statut final : `code === 0` → **terminé** ; tout le reste (code ≠ 0, ou aucun code) → **bloqué**.

Astuce d'UX employée dans l'ERP : le prompt exige une section finale à marqueur fixe
(`RÉSUMÉ UTILISATEUR :`). Le serveur la découpe du rapport technique pour l'afficher en clair sur
la carte. Et si le modèle a oublié la section, un second appel court (sans outils) la génère
a posteriori.

## 4. Gestion des quotas d'abonnement

C'est la vraie différence avec l'API : au plafond, **on n'échoue pas, on attend**.

### 4.1 Détection dans le flux

Le stream-json contient des lignes `rate_limit_info` :

```js
const info = JSON.parse(line).rate_limit_info
if (info.status === 'allowed' || info.status === 'allowed_warning') hit = null  // dernier état gagne
else hit = { resetAt: Number(info.resetsAt) * 1000 }
```

Le **dernier** état connu gagne : un refus suivi d'un retour à `allowed` (fenêtre réinitialisée
en cours de route) ne doit pas mettre l'ordonnanceur en pause. Filet secondaire : une regex sur
le texte de sortie (« limit reached … resets at 3pm »).

Quand un quota est touché :
1. la tâche **retourne en file** (elle n'a pas échoué — elle n'a pas pu travailler) ;
2. **aucun compte-rendu n'est écrit** (sinon la carte ment) ;
3. l'ordonnanceur se met en pause jusqu'à `resetAt`, ou **bascule sur un modèle de repli**.

### 4.2 Chaîne de repli entre modèles

Le plafond hebdomadaire est *par modèle* pour le haut de gamme. On garde donc :
`modèle souhaité → modèle de repli`, et on note sur la tâche le modèle **réellement** utilisé
(`run_model`), distinct du souhaité. Un garde-fou limite le nombre de replis par tâche pour
qu'une fausse détection ne relance pas la tâche indéfiniment.

### 4.3 Lire les jauges réelles

Endpoint que le CLI utilise pour son propre `/usage` :

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken lu dans ~/.claude/.credentials.json>
```

Renvoie un tableau `limits[]` avec trois familles :
- `session` — fenêtre 5 h **glissante** (s'ancre au premier message, pas un créneau fixe) ;
- `weekly_all` — total 7 jours, tous modèles ;
- `weekly_scoped` — plafond hebdo d'**un** modèle (peut bloquer le haut de gamme alors que les
  deux autres jauges sont au vert).

Il n'y a **aucune limite journalière**. Mettre le résultat en cache ~60 s. C'est cette lecture qui
alimente la barre de quotas de l'UI.

## 5. Ordonnanceur et file

- Une **file persistée en JSON** (écriture atomique : écrire `.tmp` puis `rename`), pas en base —
  simple, inspectable, et survit à tout.
- **Un seul slot global** pour les exécutions en écriture (`busy` + `currentTaskId`). Les tâches
  en lecture seule tournent hors slot, avec un plafond de parallélisme.
- Chaque changement d'état est diffusé à l'UI (WebSocket) : `approved → in_progress → done/blocked`.
- `kick()` est rappelé après chaque fin de tâche pour démarrer la suivante.

### Reprise de contexte

`--resume "<session_id>"` fait continuer la session Claude précédente au lieu de repartir à zéro.
L'ERP l'utilise pour l'option « même contexte » d'un item de file. **Prévoir le repli** : une
session purgée fait échouer le démarrage → relancer l'item avec un contexte neuf.

### Steering en cours d'exécution

Pour parler à une tâche déjà lancée : un fichier « boîte de réception » (`.run-<id>.inbox`, une
ligne JSON par message) + des hooks `PostToolUse`/`Stop` branchés sur **cette** exécution via
`--settings <fichier.json>`. Le hook lit l'inbox et livre le message à Claude, comme un message
tapé en direct. À la fin, un message jamais consommé est reporté sur la tâche pour relancer avec
ce complément.

## 6. Checklist d'implémentation

- [ ] Machine persistante avec le CLI installé et `claude` connecté par un humain.
- [ ] Vérifier au démarrage que `ANTHROPIC_API_KEY` est **absent** de l'env du spawn.
- [ ] Poser `HOME` explicitement dans l'env du spawn.
- [ ] Spawn via `setsid --fork bash -c`, `detached: true`, `stdio: 'ignore'`.
- [ ] Le wrapper écrit son `$$` dans un fichier pid ; ignorer le pid de `spawn()`.
- [ ] Prompt par fichier → stdin ; log NDJSON et code de sortie vers fichiers.
- [ ] Poll 2 s : drain incrémental du log, fin sur fichier `.code`, timeout dur avec `kill(-pid)`.
- [ ] Extraire `assistant`/`result`/`session_id` du NDJSON.
- [ ] Détecter `rate_limit_info` → remettre en file + pause/repli, jamais un faux échec.
- [ ] Un slot d'écriture à la fois ; liste blanche d'outils restreinte pour le lecture-seule.
- [ ] Nettoyer les artefacts en fin d'exécution.

## 7. Fichiers de référence dans l'ERP Orisha

| Fichier | Rôle |
|---|---|
| `server/src/services/taskRunner.js` | tout le runner : spawn, monitoring, extraction, quotas (1545 l.) |
| `server/src/services/agentModel.js` | chaîne de repli entre modèles, mémoire des plafonds atteints |
| `server/src/services/claudeUsage.js` | lecture des jauges d'abonnement (`/api/oauth/usage`) |
| `server/src/services/promptQueue.js` | file de travaux : enchaînement des items, recap Slack |
| `server/src/routes/travaux.js` | API HTTP de la page /travaux |
| `server/scripts/agent-steer-hooks.json` | hooks de steering en cours d'exécution |
