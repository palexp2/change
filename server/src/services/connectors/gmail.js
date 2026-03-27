export default {
  name: 'gmail',
  async pull(tenantId, config, credentials, lastSyncAt) {
    // TODO: implement with Gmail API
    return []
  },
  async push(tenantId, config, credentials, interaction) {
    // TODO: send email via Gmail API
  },
  async handleWebhook(tenantId, payload) {
    // TODO: parse Gmail push notifications
    return []
  },
  async testConnection(config, credentials) {
    return { success: true, message: 'Connexion OK (skeleton)' }
  },
}
