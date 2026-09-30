// Relais de redémarrage — voir scripts/restart.sh. Arrêté hors redémarrage.
// nginx le sert en « backup » (port 3007) quand erp-server (3004) ne répond pas.
module.exports = {
  apps: [{
    name: 'erp-standby',
    script: 'src/index.js',
    cwd: __dirname,
    env: { ERP_ROLE: 'standby', PORT: '3007', DRAIN_MAX_MS: '10000' },
    kill_timeout: 12000,
    autorestart: true,
    watch: false,
  }],
}
