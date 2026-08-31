// URL publique de l'app (liens dans les emails, callbacks OAuth, messages
// Slack…). Une seule source de vérité — le littéral était recopié dans une
// vingtaine de fichiers. Trailing slash retiré pour pouvoir concaténer
// `${APP_URL}/erp/...` sans double barre.
export const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
