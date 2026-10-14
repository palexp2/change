// Serveur de paiement — voir src/payServer.js. Toujours en marche ; nginx le
// sert en premier sur /erp/pay et /erp/api/public/pages, Boréal en secours.
module.exports = {
  apps: [{
    name: 'erp-pay',
    script: 'src/payServer.js',
    cwd: __dirname,
    env: { PAY_PORT: '3008' },
    kill_timeout: 5000,
    autorestart: true,
    watch: false,
  }],
}
