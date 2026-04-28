import { recomputeAllProjectsValeurCad } from '../services/projectValeur.js'

const start = Date.now()
const res = await recomputeAllProjectsValeurCad({
  onProgress: (done, total) => console.log(`  ${done}/${total}`),
})
console.log(`✅ valeur_cad_calc backfill: ${res.done}/${res.total} projets (${res.failed} erreurs) en ${((Date.now()-start)/1000).toFixed(1)}s`)
process.exit(0)
