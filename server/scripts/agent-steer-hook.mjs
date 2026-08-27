#!/usr/bin/env node
// Hook Claude Code (PostToolUse + Stop) des exécutions détachées de l'agent :
// livre à Claude les messages que l'utilisateur envoie PENDANT la tâche depuis la
// carte /travaux (steering, comme dans l'interface de Claude Code).
//
// Fonctionnement : la route POST /travaux/prompts/:id/message dépose le message
// dans un fichier « inbox » (.agent-exec-<taskId>.inbox, racine du repo, ignoré
// par git). Ce hook, déclenché après CHAQUE outil (PostToolUse) et au moment de
// terminer (Stop), réclame l'inbox de façon atomique (rename) et ressort le
// message en `{"decision":"block","reason":…}` — Claude Code réinjecte la raison
// dans la conversation, donc Claude prend le message en compte et continue.
//
// Silencieux (exit 0 sans sortie) dans tous les autres cas : pas de tâche agent
// (ERP_AGENT_TASK_ID absent — sessions interactives), pas d'inbox, inbox vide,
// ou déjà réclamée par un déclenchement concurrent.
import { readFileSync, renameSync, unlinkSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const taskId = process.env.ERP_AGENT_TASK_ID || ''
// Id = UUID de la tâche : tout autre contenu (vide, chemin…) est ignoré — le hook
// tourne aussi dans les sessions Claude interactives sur ce repo via --settings,
// il ne doit JAMAIS y faire quoi que ce soit.
if (!/^[A-Za-z0-9-]{6,64}$/.test(taskId)) process.exit(0)

// Racine du repo (le script vit dans server/scripts/) — même dossier que les
// autres artefacts d'exécution .agent-exec-<id>.{log,code,prompt}.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INBOX = resolve(ROOT, `.agent-exec-${taskId}.inbox`)
if (!existsSync(INBOX)) process.exit(0)

// L'événement (Stop vs PostToolUse) adapte la consigne. stdin peut être vide ou
// illisible — on dégrade sans bruit.
let event = ''
try { event = JSON.parse(readFileSync(0, 'utf8'))?.hook_event_name || '' } catch {}

// Réclamation atomique : rename puis lecture. Deux déclenchements concurrents
// (PostToolUse et Stop) ne livreront jamais le même message deux fois — le
// second rename échoue et sort en silence.
const claimed = `${INBOX}.claimed-${process.pid}`
let raw = ''
try {
  renameSync(INBOX, claimed)
  raw = readFileSync(claimed, 'utf8')
  unlinkSync(claimed)
} catch { process.exit(0) }

// Une ligne JSON { text, at } par message (plusieurs si l'utilisateur a écrit
// plusieurs fois entre deux outils). Ligne illisible = texte brut, on livre quand même.
const texts = raw.split('\n').filter(l => l.trim()).map(l => {
  try { return String(JSON.parse(l).text || '').trim() } catch { return l.trim() }
}).filter(Boolean)
if (!texts.length) process.exit(0)

const body = texts.length === 1 ? texts[0] : texts.map(t => `— ${t}`).join('\n')
const reason = [
  '📨 MESSAGE DE L\'UTILISATEUR reçu en plein milieu de la tâche (envoyé depuis la carte /travaux) :\n\n',
  body,
  '\n\nCe n\'est PAS une erreur d\'outil. ',
  event === 'Stop'
    ? 'Prends ce message en compte AVANT de terminer, puis termine normalement (avec les sections finales demandées par ta consigne, ex. RÉSUMÉ UTILISATEUR).'
    : 'Prends ce message en compte dès maintenant et poursuis la tâche en l\'intégrant.',
].join('')

process.stdout.write(JSON.stringify({ decision: 'block', reason }))
