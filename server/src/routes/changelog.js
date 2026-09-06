// Journal des nouveautés — état de la garde « toute modification est documentée ».
//
// La page /changelog affiche cet état : tant que du code applicatif a changé
// sans nouvelle entrée, la page le signale et le déploiement est bloqué
// (voir deploy.sh + services/changelogGuard.js).
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getChangelogStatus } from '../services/changelogGuard.js'
import { getChangelogRequesters } from '../services/changelogRequesters.js'

const router = Router()

// « Demandé par » de la page /changelog : { "<date>|<titre>": { name, source } }.
router.get('/requesters', requireAuth, (req, res) => {
  res.json(getChangelogRequesters())
})

router.get('/status', requireAuth, (req, res) => {
  const st = getChangelogStatus()
  res.json({
    ok: st.ok,
    skipped: st.skipped,
    reason: st.reason,
    base: st.base ? st.base.slice(0, 10) : null,
    changedCount: st.codeChanged.length,
    // Aperçu seulement : la page liste quelques fichiers, pas les 200.
    changedFiles: st.codeChanged.slice(0, 20),
    commits: st.commits.slice(0, 20),
    newEntries: st.newEntries.map((e) => ({ date: e.date, title: e.title })),
    invalidCount: st.invalidEntries.length,
    latestEntryDate: st.latestEntry?.date || null,
  })
})

export default router
