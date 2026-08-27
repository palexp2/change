import { v4 as uuid } from 'uuid'
import { join } from 'path'
import db from '../../db/database.js'
import { decryptCredentials } from '../../utils/encryption.js'
import { logSync } from '../syncLog.js'
import { ingestReceiptBuffer } from '../receiptIngest.js'
import { launchContext, snapshot, chromiumAvailable } from './browser.js'
import { generateTotp } from './totp.js'
import { dueNeedsForAccount, refreshInvoiceNeeds, selectDocuments, markNeed, bumpAttempt } from './invoiceNeeds.js'
import { awaitExtraction, linkReceiptToTransaction } from './linkBank.js'
import amazon from './amazon.js'
import wix from './wix.js'
import bell from './bell.js'

// ── Collecteurs de portails fournisseurs ──────────────────────────────────────
// Un collecteur = un module qui sait, pour UN fournisseur, se connecter à son
// portail, lister les factures récentes et en produire un PDF. Tout le reste
// (session, 2FA, dédup, ingestion, journalisation, artefacts de diagnostic) est
// mutualisé ici : ajouter un fournisseur = écrire `login` + `collect`.

export const SCRAPERS = { amazon, wix, bell }
export const VENDOR_LABELS = Object.fromEntries(
  Object.entries(SCRAPERS).map(([k, v]) => [k, v.label])
)

// Domaine dont un import de session doit porter les cookies, par collecteur.
export const VENDOR_DOMAINS = { amazon: 'amazon.', wix: 'wix.com', bell: 'bell.ca' }

const artifactsRoot = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'scrapers')
const OTP_TIMEOUT_MS = Number(process.env.SCRAPER_OTP_TIMEOUT_MS || 10 * 60 * 1000)

// Une tournée par compte à la fois : deux passes simultanées se voleraient la
// session et se battraient sur la dédup.
const inFlight = new Map()

const nowIso = () => new Date().toISOString()
const sleep = ms => new Promise(r => setTimeout(r, ms))

function updateRun(runId, fields) {
  const keys = Object.keys(fields)
  if (!keys.length) return
  db.prepare(`UPDATE scraper_runs SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`)
    .run(...keys.map(k => fields[k]), runId)
}

// Une tournée vit dans le processus : un `pm2 restart` la fauche sans qu'elle
// puisse écrire sa fin, et elle resterait « en cours » pour toujours — l'UI
// afficherait un compte occupé qu'aucun bouton ne peut relancer. Au démarrage,
// tout run encore marqué en cours est donc clos comme annulé.
export function reapOrphanRuns() {
  const orphans = db.prepare(`
    UPDATE scraper_runs SET status='cancelled', finished_at=?,
      error='Tournée interrompue par un redémarrage du serveur'
    WHERE status IN ('running','needs_otp')
  `).run(nowIso())
  if (orphans.changes) console.log(`♻️ scrapers : ${orphans.changes} tournée(s) orpheline(s) close(s)`)
  db.prepare(`UPDATE scraper_accounts SET last_status='cancelled' WHERE last_status='running'`).run()
}

export function getAccount(id) {
  return db.prepare('SELECT * FROM scraper_accounts WHERE id=? AND deleted_at IS NULL').get(id)
}

/**
 * Lance une tournée pour un compte. Résout quand la tournée est terminée ;
 * l'appelant HTTP n'attend pas (POST /run répond dès la création du run).
 */
export function runScraper({ accountId, trigger = 'manual', userId = null }) {
  if (inFlight.has(accountId)) return inFlight.get(accountId)
  const p = execute({ accountId, trigger, userId }).finally(() => inFlight.delete(accountId))
  inFlight.set(accountId, p)
  return p
}

export function isRunning(accountId) {
  return inFlight.has(accountId)
}


// Une facture est en base pour un besoin : attendre son extraction, vérifier
// que le montant du PDF concorde vraiment, puis lier la transaction.
async function settleNeed({ hit, receiptId, log }) {
  const receipt = await awaitExtraction(receiptId)
  const out = linkReceiptToTransaction({ need: hit.need, receipt })
  if (out.ok) {
    markNeed(hit.need.id, {
      status: 'trouvee',
      sale_receipt_id: receiptId,
      note: out.exact ? null : `écart de ${out.delta.toFixed(2)} absorbé`,
    })
    log(`🔗 transaction du ${hit.need.txn_date} (${Math.abs(hit.need.amount).toFixed(2)}) liée à la facture`)
  } else {
    markNeed(hit.need.id, { status: out.reason, sale_receipt_id: receiptId, note: out.note })
    log(`⚠️ ${hit.need.txn_date} : ${out.note}`)
  }
}

async function execute({ accountId, trigger, userId }) {
  const account = getAccount(accountId)
  if (!account) throw new Error('Compte de collecte introuvable')
  const scraper = SCRAPERS[account.vendor]
  if (!scraper) throw new Error(`Aucun collecteur pour « ${account.vendor} »`)

  const runId = uuid()
  const t0 = Date.now()
  const dir = join(artifactsRoot, runId)
  const logLines = []
  const artifacts = []
  const module = `scraper:${account.vendor}`

  db.prepare(`
    INSERT INTO scraper_runs (id, account_id, vendor, trigger, status, created_by)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(runId, accountId, account.vendor, trigger, userId)

  const log = msg => {
    logLines.push(`${nowIso()} ${msg}`)
    console.log(`🔎 ${module}: ${msg}`)
    updateRun(runId, { log: JSON.stringify(logLines.slice(-200)) })
  }

  let browser, context
  let found = 0, imported = 0, skipped = 0

  try {
    if (!chromiumAvailable()) throw new Error('Chromium introuvable sur le serveur')
    if (!account.username || !account.password_enc) throw new Error('Identifiants manquants sur le compte')

    const storageState = account.storage_state_enc
      ? JSON.parse(decryptCredentials(account.storage_state_enc))
      : null
    if (storageState) log('session existante réutilisée')

    ;({ browser, context } = await launchContext({ storageState, downloadsDir: dir }))
    const page = await context.newPage()

    const ctx = {
      page,
      context,
      log,
      lookbackDays: account.lookback_days || 60,
      credentials: {
        username: account.username,
        password: decryptCredentials(account.password_enc),
        totpSecret: account.totp_secret_enc ? decryptCredentials(account.totp_secret_enc) : null,
      },
      totp: () => {
        const secret = account.totp_secret_enc ? decryptCredentials(account.totp_secret_enc) : null
        return secret ? generateTotp(secret) : null
      },
      snapshot: async name => {
        const file = await snapshot(page, dir, name)
        if (file) {
          artifacts.push(file)
          updateRun(runId, { artifacts: JSON.stringify(artifacts) })
        }
        return file
      },
      // Défi 2FA qu'aucun secret TOTP ne couvre (code par SMS/courriel) : la
      // tournée se met en attente et l'utilisateur saisit le code dans l'ERP.
      askOtp: async (prompt = 'Code de vérification') => {
        log(`⏸️ en attente d'un code — ${prompt}`)
        updateRun(runId, { status: 'needs_otp' })
        db.prepare(`UPDATE scraper_accounts SET otp_code=NULL, otp_requested_at=?, updated_at=? WHERE id=?`)
          .run(nowIso(), nowIso(), accountId)
        const deadline = Date.now() + OTP_TIMEOUT_MS
        while (Date.now() < deadline) {
          await sleep(3000)
          const row = db.prepare('SELECT otp_code FROM scraper_accounts WHERE id=?').get(accountId)
          if (row?.otp_code) {
            db.prepare(`UPDATE scraper_accounts SET otp_code=NULL, otp_submitted_at=? WHERE id=?`)
              .run(nowIso(), accountId)
            updateRun(runId, { status: 'running' })
            log('code reçu — reprise')
            return row.otp_code.trim()
          }
        }
        throw new Error("Aucun code de vérification saisi dans le délai — tournée abandonnée")
      },
      alreadySeen: externalId => !!db.prepare(
        'SELECT 1 FROM scraper_documents WHERE vendor=? AND external_id=?'
      ).get(account.vendor, String(externalId)),
      /**
       * Remet une facture au pipeline d'extraction.
       * @returns {{status:'imported'|'duplicate'|'empty', id:string|null}}
       */
      deliver: ({ externalId, buffer, filename, date = null, amount = null, currency = null, url = null }) => {
        found++
        const key = String(externalId)
        if (!buffer?.length) { skipped++; log(`⚠️ ${key} : fichier vide, ignoré`); return { status: 'empty', id: null } }
        const res = ingestReceiptBuffer({
          buffer,
          originalName: filename || `${account.vendor}-${key}.pdf`,
          ext: '.pdf',
          source: `scraper:${account.vendor}`,
          userId: account.created_by || userId,
        })
        db.prepare(`
          INSERT OR REPLACE INTO scraper_documents
            (id, account_id, vendor, external_id, doc_date, amount, currency, source_url,
             filename, content_sha256, sale_receipt_id, run_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(uuid(), accountId, account.vendor, key, date, amount, currency, url,
          filename || null, res.hash, res.id || null, runId, res.status)
        if (res.status === 'imported') { imported++; log(`✅ ${key} importée`) }
        else { skipped++; log(`↩️ ${key} déjà en base (même contenu)`) }
        // L'id est celui du reçu — nouveau, ou celui déjà en base sur doublon.
        // C'est lui qui permet de refermer un besoin sans rien réimporter.
        return { status: res.status, id: res.id || null }
      },
    }

    // ── Lister, choisir, télécharger ─────────────────────────────────────
    // Le collecteur ne fait que LISTER (métadonnées bon marché : numéro, date,
    // montant). C'est ici qu'on décide quoi télécharger — en mode ciblé, la
    // liste de travail vient du relevé bancaire, pas du portail.
    const docs = await scraper.list(ctx)
    const targeted = account.collect_mode !== 'fenetre'

    let selection = docs
    let needByDoc = new Map()
    if (targeted) {
      refreshInvoiceNeeds()
      const needs = dueNeedsForAccount(accountId)
      log(`${needs.length} transaction(s) attendent une facture`)
      if (needs.length === 0) {
        log('rien à chercher — aucune transaction non comptabilisée pour ce fournisseur')
        selection = []
      } else {
        const { picks, unmatched } = selectDocuments(needs, docs)
        for (const u of unmatched) {
          bumpAttempt(u.need.id)
          markNeed(u.need.id, { status: u.reason, note: u.note })
          log(`🔍 ${Math.abs(u.need.amount).toFixed(2)} du ${u.need.txn_date} : ${u.note}`)
        }
        selection = picks.map(p => p.doc)
        needByDoc = new Map(picks.map(p => [p.doc.externalId, { need: p.need, exact: p.exact, delta: p.delta }]))
        log(`${picks.length} concordance(s) : ${picks.filter(p => p.exact).length} exacte(s), ${picks.filter(p => !p.exact).length} dans la marge de 2 %`)
      }
    } else {
      log(`mode fenêtre : ${docs.length} document(s) disponible(s)`)
    }

    for (const doc of selection) {
      const hit = needByDoc.get(doc.externalId)
      if (hit) bumpAttempt(hit.need.id)

      // Déjà collecté lors d'une tournée précédente : le PDF est en base, on
      // n'a pas à le retélécharger. En mode ciblé on veut quand même refermer
      // le besoin, donc on récupère le reçu correspondant.
      if (ctx.alreadySeen(doc.externalId)) {
        const prior = db.prepare('SELECT sale_receipt_id FROM scraper_documents WHERE vendor=? AND external_id=?')
          .get(account.vendor, doc.externalId)
        if (hit && prior?.sale_receipt_id) {
          await settleNeed({ hit, receiptId: prior.sale_receipt_id, log })
        } else {
          log(`↩️ ${doc.externalId} déjà collectée`)
        }
        continue
      }

      let buffer
      try {
        buffer = await doc.fetch()
      } catch (e) {
        const msg = e.message.split('\n')[0]
        log(`⚠️ ${doc.externalId} : ${msg}`)
        if (hit) markNeed(hit.need.id, { status: 'introuvable', note: msg })
        continue
      }

      const res = ctx.deliver({
        externalId: doc.externalId,
        buffer,
        filename: doc.filename,
        date: doc.date,
        amount: doc.amount,
        currency: doc.currency,
        url: doc.url,
      })
      // `duplicate` = ce PDF est déjà en base (saisi à la main, ou reçu par
      // courriel). C'est le cas le plus fréquent au premier passage, et il
      // ferme le besoin aussi bien qu'un import.
      if (hit && res.id) await settleNeed({ hit, receiptId: res.id, log })
    }

    // Session rafraîchie : la prochaine tournée repart connectée.
    try {
      const state = await context.storageState()
      const { encryptCredentials } = await import('../../utils/encryption.js')
      db.prepare(`UPDATE scraper_accounts SET storage_state_enc=?, storage_state_at=?, updated_at=? WHERE id=?`)
        .run(encryptCredentials(JSON.stringify(state)), nowIso(), nowIso(), accountId)
    } catch (e) { log(`⚠️ session non sauvegardée : ${e.message}`) }

    const durationMs = Date.now() - t0
    updateRun(runId, {
      status: 'success', finished_at: nowIso(), duration_ms: durationMs,
      found, imported, skipped, log: JSON.stringify(logLines.slice(-200)),
      artifacts: JSON.stringify(artifacts),
    })
    db.prepare(`UPDATE scraper_accounts SET last_run_at=?, last_status='success', last_error=NULL, last_imported=?, updated_at=? WHERE id=?`)
      .run(nowIso(), imported, nowIso(), accountId)
    logSync(module, trigger, { status: 'success', modified: imported, durationMs })
    return { status: 'success', runId, found, imported, skipped }
  } catch (e) {
    const durationMs = Date.now() - t0
    logLines.push(`${nowIso()} ❌ ${e.message}`)
    updateRun(runId, {
      status: 'error', finished_at: nowIso(), duration_ms: durationMs,
      found, imported, skipped, error: e.message,
      log: JSON.stringify(logLines.slice(-200)), artifacts: JSON.stringify(artifacts),
    })
    db.prepare(`UPDATE scraper_accounts SET last_run_at=?, last_status='error', last_error=?, updated_at=? WHERE id=?`)
      .run(nowIso(), e.message, nowIso(), accountId)
    logSync(module, trigger, { status: 'error', error: e.message, durationMs })
    console.error(`❌ ${module}:`, e)
    return { status: 'error', runId, error: e.message, found, imported, skipped }
  } finally {
    try { await context?.close() } catch { /* contexte déjà fermé */ }
    try { await browser?.close() } catch { /* navigateur déjà fermé */ }
  }
}

/**
 * Tournée planifiée sur tous les comptes actifs. Séquentiel : un Chromium à la
 * fois sur un serveur qui fait déjà tourner l'API.
 */
export async function runAllScrapers(trigger = 'scheduled') {
  const accounts = db.prepare(
    'SELECT id, vendor FROM scraper_accounts WHERE deleted_at IS NULL AND enabled=1'
  ).all()
  const results = []
  for (const a of accounts) {
    try { results.push({ vendor: a.vendor, ...(await runScraper({ accountId: a.id, trigger })) }) }
    catch (e) { results.push({ vendor: a.vendor, status: 'error', error: e.message }) }
  }
  return results
}
