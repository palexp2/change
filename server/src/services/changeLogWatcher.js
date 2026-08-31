// changeLogWatcher — fabrique du squelette commun des watchers change_log.
//
// Plusieurs services taillent le même polling sur change_log (journal exhaustif
// des mutations, alimenté par triggers SQLite — voir db/changeLog.js) : curseur
// `lastSeenId` démarré à la pointe, garde anti-réentrance, fast-forward du
// curseur quand le watcher est désactivé (pour ne pas rejouer le backlog à la
// réactivation), setInterval unref'é. Cette fabrique factorise ce squelette ;
// la logique métier (que faire des lignes) reste dans chaque service via
// `onRows` — ou `onPoll` pour les watchers dont le tail lui-même est custom.
//
// Aucune préparation de statement au chargement du module : tout est paresseux
// (le harnais de tests importe les modules avant d'ouvrir la DB).

import db from '../db/database.js'

/**
 * @param {object} opts
 * @param {string}   opts.name        Préfixe des logs (`[name] …`).
 * @param {number}   opts.intervalMs  Période du poll.
 * @param {string|string[]} [opts.tables]  Filtre table_name du tail (requis avec onRows).
 * @param {string}   [opts.changeType='upsert']  Filtre change_type du tail.
 * @param {number}   [opts.batchSize=500]        LIMIT du tail.
 * @param {string|string[]} [opts.maxIdTables]   Filtre optionnel du MAX(id) —
 *                   variante addressCheck (curseur borné à la table surveillée).
 * @param {Function} [opts.isEnabled]  () => état truthy | falsy. Falsy → le
 *                   curseur est avancé à MAX(id) et le poll est sauté (les
 *                   écritures pendant la pause ne sont PAS rejouées). L'état
 *                   truthy est repassé à onRows/onPoll (`enabledState`) pour
 *                   éviter de le recalculer.
 * @param {Function} [opts.onRows]   async (rows, { advance, enabledState }) —
 *                   corps métier. Appeler advance(row.id) AVANT de traiter
 *                   chaque ligne (une ligne en erreur est sautée, pas rejouée).
 * @param {Function} [opts.onPoll]   async ({ enabledState }) — remplace la
 *                   requête + onRows quand le tail est trop spécifique ; ne
 *                   garde de la fabrique que timer/garde/fast-forward/curseur.
 * @param {Function|string} [opts.startLog]  Message loggé au démarrage (après
 *                   le préfixe) ; fonction évaluée au moment du start.
 * @param {string}   [opts.errorLabel='poll']  Libellé du log d'erreur.
 */
export function createChangeLogWatcher({
  name,
  intervalMs,
  tables = null,
  changeType = 'upsert',
  batchSize = 500,
  maxIdTables = null,
  isEnabled = null,
  onRows = null,
  onPoll = null,
  startLog = null,
  errorLabel = 'poll',
}) {
  const tableList = tables == null ? null : (Array.isArray(tables) ? tables : [tables])
  const maxIdList = maxIdTables == null ? null : (Array.isArray(maxIdTables) ? maxIdTables : [maxIdTables])

  let lastSeenId = 0
  let timer = null
  let running = false

  let _maxStmt = null
  function maxChangeLogId() {
    if (!_maxStmt) {
      _maxStmt = maxIdList
        ? db.prepare(`SELECT MAX(id) AS m FROM change_log WHERE table_name IN (${maxIdList.map(() => '?').join(',')})`)
        : db.prepare('SELECT MAX(id) AS m FROM change_log')
    }
    return (maxIdList ? _maxStmt.get(...maxIdList) : _maxStmt.get())?.m || 0
  }

  let _tailStmt = null
  function fetchRows() {
    _tailStmt ??= db.prepare(`
      SELECT id, table_name, record_id FROM change_log
      WHERE id > ? AND change_type = ? AND table_name IN (${tableList.map(() => '?').join(',')})
      ORDER BY id ASC LIMIT ?
    `)
    return _tailStmt.all(lastSeenId, changeType, ...tableList, batchSize)
  }

  const advance = (id) => { lastSeenId = id }

  // Une passe. Exposée pour les tests (déterministe, sans minuterie).
  async function pollOnce() {
    if (running) return 0
    running = true
    try {
      let enabledState = true
      if (isEnabled) {
        enabledState = isEnabled()
        if (!enabledState) {
          // Désactivé : on avance le curseur pour ne pas rejouer tout le
          // backlog à la réactivation.
          lastSeenId = Math.max(lastSeenId, maxChangeLogId())
          return 0
        }
      }
      if (onPoll) return (await onPoll({ enabledState })) ?? 0
      return (await onRows(fetchRows(), { advance, enabledState })) ?? 0
    } catch (e) {
      console.error(`[${name}] ${errorLabel} error:`, e.message)
      return 0
    } finally {
      running = false
    }
  }

  function start() {
    if (timer) return
    // Démarre à la pointe : on ne réagit qu'aux changements postérieurs au boot.
    lastSeenId = maxChangeLogId()
    timer = setInterval(() => { pollOnce() }, intervalMs)
    if (timer.unref) timer.unref()
    const msg = typeof startLog === 'function' ? startLog() : (startLog || `started (poll ${intervalMs}ms)`)
    console.log(`[${name}] ${msg}`)
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return {
    start,
    stop,
    pollOnce,
    maxChangeLogId,
    getLastSeenId: () => lastSeenId,
    setLastSeenId: (n) => { lastSeenId = n },
  }
}
