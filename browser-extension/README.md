# Pont de session Orisha (module de navigateur)

Bell et DigiKey posent une case « Je ne suis pas un robot » sur leur écran de
connexion : aucun collecteur automatique ne la franchira. Mais ce captcha ne
garde que la **connexion**. Une fois la session ouverte dans un vrai navigateur,
l'ERP peut s'en servir pendant des jours.

Ce module fait le transport : il lit les témoins des portails ouverts dans ce
navigateur (y compris les `httpOnly`, que l'export manuel ratait), les envoie à
l'ERP, puis lance la collecte de tous les portails d'un coup.

## Installation (une fois)

Fonctionne dans **Edge comme dans Chrome** — c'est le même moteur et la même
interface d'extension.

1. Télécharger le module depuis l'ERP : Collecte de factures → « Module de
   navigateur », puis **décompresser** le fichier obtenu.
2. `edge://extensions` (ou `chrome://extensions`) → activer **« Mode
   développeur »** (interrupteur dans la colonne de gauche sur Edge).
3. Le bouton apparaît alors en haut : **« Charger l'extension décompressée »**
   sur Edge, « Charger l'extension non empaquetée » sur Chrome. Ce n'est PAS
   « Empaqueter l'extension ». Choisir le dossier décompressé.
4. Ouvrir les réglages du module : saisir `https://customer.orisha.io` et coller
   le jeton (ERP → onglet Collecte → bouton « Jeton »). Cliquer sur
   « Enregistrer » et autoriser l'accès au site si Chrome ou Edge le demande.

## Mise à jour d'une installation manuelle

Télécharger à nouveau « Module de navigateur » depuis l'ERP, décompresser
l'archive et remplacer les fichiers du dossier déjà chargé. Dans
`chrome://extensions` ou `edge://extensions`, cliquer sur le bouton de
rechargement de la carte Orisha. Vérifier la version 1.9.1 et accepter
l'accès au site ERP si le navigateur le demande. Les réglages restent
enregistrés lorsque le même dossier est utilisé.

## Usage

Rien à faire : **dès qu'on se connecte à un portail suivi, sa session part vers
l'ERP toute seule** quelques secondes plus tard, puis elle est renvoyée chaque
heure et à chaque ouverture du navigateur. Et à chaque session reçue, si une
sortie d'argent attend encore sa facture chez ce fournisseur, **l'ERP part la
chercher immédiatement** — sans aucun clic.

⚠️ **Laisser le portail ouvert dans un onglet.** MonBell garde son jeton de
connexion dans la page, pas dans un témoin : le module ne peut le lire que si
l'onglet est encore là au moment de l'envoi.

Le bouton sert à forcer une tournée complète, tout de suite, même sans facture
attendue : icône du module → « Envoyer mes sessions et collecter ».

L'envoi automatique se coupe dans les réglages du module.

Le module dit portail par portail ce qui est parti, et l'ERP enchaîne les
tournées l'une après l'autre. Quand une session meurt, l'ERP le signale et il
suffit de se reconnecter au portail puis de recliquer.

## Envoyer un document à l'extracteur

Facture ouverte dans un onglet (PDF, image ou page web) : icône du module →
**« Envoyer ce document à l'extracteur »**, ou clic droit → « Envoyer à
l'extracteur Orisha », ou **Alt+Maj+E**. Elle apparaît dans les reçus, en
lecture. Une page web est imprimée en PDF en entier (bandeau « débogage » une
seconde, normal). Pour un PDF local (`file://`), activer « Autoriser l'accès
aux URL de fichier » sur la carte du module.
