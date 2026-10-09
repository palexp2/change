// pm2 start standalone/one-pager/ecosystem.config.cjs && pm2 save
// Un processus par one-pager : dupliquer l'entrée (nom, PUBLIC_FILE_ID, PORT).
module.exports = {
  apps: [
    {
      name: 'farmer-partnership',
      script: __dirname + '/server.mjs',
      cwd: __dirname,
      env: {
        // « 40-hour-farmer-partnership.html » dans /public-files
        PUBLIC_FILE_ID: 'bore85u7GEANFYqS7',
        PORT: '3010',
      },
      max_memory_restart: '200M',
    },
  ],
}
