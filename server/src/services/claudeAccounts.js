// ─── Comptes Claude de la file de travaux ─────────────────────────────────────
// Orisha a plusieurs licences Claude Code. Chaque exécution de l'agent part sur le
// compte dont le plafond est le PLUS LOIN d'être atteint (demande de Guillaume,
// 2026-10-01) — les deux comptes s'usent donc à peu près au même rythme, et la file
// ne s'arrête que quand TOUS sont à sec.
//
// • Compte principal : ~/.claude + ~/.claude.json (ce qu'utilise `claude` sans rien).
// • Comptes supplémentaires : un dossier par compte sous ~/.claude-accounts/<nom>/,
//   passé à Claude Code par CLAUDE_CONFIG_DIR. Seuls .credentials.json et .claude.json
//   y sont propres ; réglages, hooks, skills, mémoire et sessions sont des liens vers
//   ~/.claude (voir server/scripts/claude-account-setup.sh) — une conversation reprise
//   sur l'autre compte retrouve donc sa session.
//   Ajouter un compte : claude-account-setup.sh <nom>, puis
//   CLAUDE_CONFIG_DIR=~/.claude-accounts/<nom> claude auth login.
// • Dès qu'au moins un compte dédié est connecté, le principal sort de la file
//   (demande de Charles, 2026-10-09) : ~/.claude suit qui s'est connecté dans le
//   terminal ; les comptes dédiés, eux, ne bougent jamais.
import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'

const HOME = process.env.HOME || '/home/ec2-user'
export const PRIMARY_ACCOUNT_ID = 'principal'
const ROOT = resolve(HOME, '.claude-accounts')

const LIST_TTL_MS = 30_000
let _list = null // { at, accounts }

/** Comptes de la file : les dossiers dédiés connectés ; à défaut, le principal. */
export function listAccounts() {
  if (_list && Date.now() - _list.at < LIST_TTL_MS) return _list.accounts
  const accounts = []
  let names = []
  try { names = readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() } catch {}
  for (const name of names) {
    const dir = resolve(ROOT, name)
    // Dossier préparé mais jamais connecté : ignoré tant qu'aucun jeton n'y est écrit.
    if (!existsSync(resolve(dir, '.credentials.json'))) continue
    accounts.push({ id: name, configDir: dir, globalConfig: resolve(dir, '.claude.json'), env: { CLAUDE_CONFIG_DIR: dir } })
  }
  if (!accounts.length) {
    accounts.push({
      id: PRIMARY_ACCOUNT_ID,
      configDir: resolve(HOME, '.claude'),
      globalConfig: resolve(HOME, '.claude.json'),
      env: {},
    })
  }
  _list = { at: Date.now(), accounts }
  return accounts
}

export function getAccount(id) {
  return listAccounts().find(a => a.id === id) || listAccounts()[0]
}

// ─── Comptes à sec ────────────────────────────────────────────────────────────
// Une exécution qui se heurte au plafond marque SON compte jusqu'à la
// réinitialisation : les suivantes partent sur l'autre, sans attendre.
const _limited = new Map() // id → resetAt (ms)

export function markAccountLimited(id, resetAt) {
  _limited.set(id, resetAt)
}

export function accountLimitedUntil(id, now = Date.now()) {
  const at = _limited.get(id)
  if (!at) return null
  if (at <= now) { _limited.delete(id); return null }
  return at
}

/** Au moins un compte (autre que `exceptId`) peut encore travailler. */
export function hasAvailableAccount({ exceptId = null, now = Date.now() } = {}) {
  return listAccounts().some(a => a.id !== exceptId && !accountLimitedUntil(a.id, now))
}

/**
 * Marge d'un compte par rapport aux seuils du garde-fou : le plus petit
 * (reste − seuil) sur la fenêtre de 5 h et la semaine. null = aucun chiffre lisible.
 */
export function accountMargin(usage, floors = { session: 0, week: 0 }) {
  let worst = null
  for (const [b, floor] of [[usage?.session, floors.session], [usage?.week, floors.week]]) {
    const pct = b?.utilizationPct
    if (!Number.isFinite(pct)) continue
    const m = Math.max(0, Math.min(100, 100 - pct)) - (Number(floor) || 0)
    if (worst == null || m < worst) worst = m
  }
  return worst
}

/**
 * Compte à utiliser : celui qui a le plus de marge, parmi ceux qui ne sont pas à sec.
 * `usageById` = { id → lecture des quotas }. Un compte sans chiffre lisible passe
 * après un compte mesuré ; à égalité, le principal. `floors` : seuils communs, ou
 * fonction id → seuils de ce compte (chaque compte a les siens).
 */
export function pickAccount(usageById = {}, floors, now = Date.now()) {
  const all = listAccounts()
  const open = all.filter(a => !accountLimitedUntil(a.id, now))
  const pool = open.length ? open : all
  let best = null
  let bestScore = -Infinity
  for (const a of pool) {
    const m = accountMargin(usageById[a.id], typeof floors === 'function' ? floors(a.id) : floors)
    const score = m == null ? -1000 : m
    if (score > bestScore) { best = a; bestScore = score }
  }
  return best || all[0]
}
