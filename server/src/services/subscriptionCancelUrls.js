// Répertoire des pages d'annulation / gestion d'abonnement par fournisseur.
//
// But : le bouton « Se désabonner » doit ouvrir DIRECTEMENT la bonne page, sans
// que l'utilisateur ait à la chercher. Le lien enregistré sur l'abonnement
// (`vendor_subscriptions.cancel_url`) reste prioritaire — ce répertoire ne sert
// qu'à amorcer les abonnements qui n'en ont pas encore.
//
// Contenu : uniquement des pages de facturation/abonnement STABLES et publiques
// des fournisseurs déjà au registre. Les URLs derrière un login répondent 401 /
// 403 / 404 à une requête anonyme — c'est normal, le chemin est le bon et
// l'utilisateur y arrive après connexion. Les fournisseurs dont la page n'est
// pas déterminable (portail par organisation, opérateur local sans espace
// client standard) sont volontairement ABSENTS : le bouton bascule alors sur
// une recherche pré-remplie, et le lien saisi une fois est mémorisé.
import db from '../db/database.js'
import { subscriptionVendorKey, vendorKeysMatch } from './vendorSubscriptions.js'
import { logSync } from './syncLog.js'

// clé fournisseur (subscriptionVendorKey) → page d'annulation.
export const CANCEL_URL_DIRECTORY = {
  adobe:                'https://account.adobe.com/plans',
  airtable:             'https://airtable.com/account/billing',
  amazonprime:          'https://www.amazon.ca/gp/primecentral',
  amazonwebservices:    'https://console.aws.amazon.com/billing/home',
  anthropic:            'https://claude.ai/settings/billing',
  apilayerdataproducts: 'https://apilayer.com/account',
  bytedance:            'https://www.capcut.com/my-subscription',
  celonismake:          'https://www.make.com/en/login',
  chatbase:             'https://www.chatbase.co/dashboard',
  dextsoftware:         'https://app.dext.com/',
  github:               'https://github.com/settings/billing',
  google:               'https://admin.google.com/ac/billing/subscriptions',
  googleplaycallrecorder: 'https://play.google.com/store/account/subscriptions',
  hemingwayeditor:      'https://www.hemingwayapp.com/account',
  hubspot:              'https://app.hubspot.com/l/billing-management',
  ionos:                'https://my.ionos.ca/',
  linodeakamai:         'https://cloud.linode.com/account/billing',
  lucidsoftware:        'https://lucid.app/users/settings',
  manychatcom:          'https://app.manychat.com/',
  openai:               'https://chatgpt.com/#settings/Subscription',
  openmeteo:            'https://open-meteo.com/en/pricing',
  postmark:             'https://account.postmarkapp.com/',
  quickbooks:           'https://qbo.intuit.com/app/billing',
  telnyx:               'https://portal.telnyx.com/#/app/billing',
  twilio:               'https://console.twilio.com/us1/billing',
  webflow:              'https://webflow.com/dashboard/account/billing',
  wix:                  'https://manage.wix.com/account/subscriptions',
  bell:                 'https://mybell.bell.ca/',
  bellmobilite:         'https://mybell.bell.ca/',
  circleso:             'https://app.circle.so/',
  monologueto:          'https://monologue.to/',
  simplexwireless:      'https://simplexwireless.com/',
  negotel:              'https://negotel.ca/',
  fastspring:           'https://app.pdf.co/account',
}

// Résolution tolérante aux variantes de nom (suffixe de devise, « Inc. »…),
// mêmes règles que le croisement des charges attendues.
export function lookupCancelUrl(vendor) {
  const key = subscriptionVendorKey(vendor)
  if (!key) return null
  if (CANCEL_URL_DIRECTORY[key]) return CANCEL_URL_DIRECTORY[key]
  for (const [k, url] of Object.entries(CANCEL_URL_DIRECTORY)) {
    if (vendorKeysMatch(key, k)) return url
  }
  return null
}

// Amorçage idempotent : ne remplit QUE les abonnements sans lien. N'écrase
// jamais une URL saisie par l'utilisateur (elle fait foi).
export function seedCancelUrls() {
  const rows = db.prepare(`
    SELECT id, vendor FROM vendor_subscriptions
    WHERE deleted_at IS NULL AND (cancel_url IS NULL OR TRIM(cancel_url) = '')
  `).all()
  const update = db.prepare('UPDATE vendor_subscriptions SET cancel_url = ? WHERE id = ?')
  let filled = 0
  const unresolved = []
  for (const r of rows) {
    const url = lookupCancelUrl(r.vendor)
    if (url) { update.run(url, r.id); filled++ } else { unresolved.push(r.vendor) }
  }
  if (filled || unresolved.length) {
    logSync('subscription_cancel_urls', 'startup', {
      status: 'success',
      modified: filled,
      error: unresolved.length ? `sans page connue : ${unresolved.join(', ')}` : null,
    })
  }
  return { filled, unresolved }
}
