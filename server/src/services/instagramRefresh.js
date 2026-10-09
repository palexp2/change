// Tournée complète juste après une reconnexion (Instagram ou ManyChat).
//
// La session copiée d'un navigateur ne survit pas longtemps côté serveur : on
// profite des minutes où elle marche pour tout faire d'un coup — lire les
// conversations, les commentaires, ranger, écrire les messages — puis annoncer
// la semaine à Philippe. Chaque étape journalise elle-même son passage dans sa
// propre automatisation ; une étape qui échoue n'empêche pas les suivantes.

let running = null

const PROFILE_PASS_GAP_MS = 20 * 60 * 1000
const MAX_PROFILE_PASSES = 6
const sleep = ms => new Promise(r => setTimeout(r, ms))

let profileRun = 0

async function readRemainingProfiles({ trigger, first }) {
  const me = ++profileRun // une reconnexion plus récente reprend la main
  const { getSessionStatus } = await import('./sessionHealth.js')
  let last = first
  for (let pass = 1; pass <= MAX_PROFILE_PASSES && me === profileRun; pass++) {
    const read = last?.profiles?.read || 0
    const stopped = last?.profiles?.stopped
    // Rien lu sans raison = plus rien à lire. Connexion morte = inutile d'insister.
    if (!read && !stopped) return
    if (getSessionStatus('instagram')?.status === 'expired') return
    await sleep(PROFILE_PASS_GAP_MS)
    if (me !== profileRun || getSessionStatus('instagram')?.status === 'expired') return
    const { runSegmentation } = await import('./instagramSegments.js')
    last = await runSegmentation({ force: true, trigger: `${trigger} · profils ${pass + 1}` }).catch(e => ({ error: e.message }))
    // Une fiche qui change de pile doit avoir un message à jour.
    try { await (await import('./instagramDrafts.js')).runDraftWriting({ force: true, trigger }) } catch { /* le prochain passage s'en chargera */ }
  }
}

// `scraped` : la lecture des commentaires vient d'être faite ailleurs (par le
// navigateur) — on ne la refait pas depuis le serveur, on prend son résultat.
export function refreshAfterReconnect({ trigger = 'reconnexion', sendDigest = false, scraped = null } = {}) {
  if (running) return running
  running = (async () => {
    const steps = []
    const step = async (name, fn) => {
      try { steps.push({ name, result: await fn() }) }
      catch (e) { steps.push({ name, error: e.message }); console.error(`instagram refresh ${name}:`, e.message) }
    }
    // Une session tout juste collée efface le verdict « expirée » de la veille.
    if (sendDigest) {
      const { probeInstagram } = await import('./sessionHealth.js')
      await probeInstagram().catch(() => null)
    }
    const { probeManychat } = await import('./manychat.js')
    const mc = await probeManychat().catch(() => null)
    if (mc?.status === 'ok') {
      await step('manychat', async () => (await import('./manychatSync.js')).runManychatSync({ force: true, trigger }))
    }
    if (scraped) steps.push({ name: 'commentaires', result: scraped })
    else await step('commentaires', async () => (await import('./instagramCommentScrape.js')).runCommentScrape({ force: true, trigger }))
    const scrape = steps.find(s => s.name === 'commentaires')
    const scrapeOk = !scrape?.error && !scrape?.result?.error && !scrape?.result?.skipped
    await step('tri', async () => (await import('./instagramSegments.js')).runSegmentation({ force: true, trigger }))
    await step('messages', async () => (await import('./instagramDrafts.js')).runDraftWriting({ force: true, trigger }))
    // La liste ne part qu'après une reconnexion Instagram dont la lecture a
    // réussi : jamais une liste incomplète (décision de Charles, 2026-09-26).
    if (sendDigest && scrapeOk) {
      await step('liste à Philippe', async () => (await import('./instagramProspects.js')).runWeeklyProspectDigest({ weekly: true, trigger }))
    }
    // Les profils se lisent par paquets de 25 : on relance un paquet toutes les
    // 20 minutes tant que la connexion tient et qu'il en reste. Plus serré,
    // Instagram bloque toute la connexion (22 sept. : plus d'une heure).
    // En arrière-plan : une nouvelle reconnexion ne doit pas attendre la fin.
    readRemainingProfiles({ trigger, first: steps.find(x => x.name === 'tri')?.result })
      .catch(e => console.error('instagram refresh profils:', e.message))
    return steps
  })().finally(() => { running = null })
  return running
}
