# `client/web/` — racine de document nginx pour le frontend

nginx sert désormais `client/dist` lui-même (avant, tout `/erp/` passait par
`proxy_pass` vers Express : index.html, le CSS et le bundle JS attendaient
derrière la boucle d'événements de Node — mesuré le 2026-09-04, 4,78 s pour un
index.html de 1,6 ko).

Servir un préfixe d'URL (`/erp/`) avec un dossier qui ne s'appelle pas `erp`
oblige à `alias`, et `alias` + `try_files` est un piège nginx connu. D'où ce
dossier : un seul lien symbolique, `web/erp → ../dist`, pour que le chemin
d'URL corresponde au chemin disque et que nginx s'en tienne à `root` +
`try_files`, la combinaison sans surprise.

Le lien pointe sur `dist`, pas sur un build daté : la bascule atomique de
`deploy.sh` (build dans `.dist-build` puis renommage) est donc visible sans
retoucher nginx.
