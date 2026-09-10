// Codes-barres additionnels d'une pièce (`products.scan_codes`).
//
// Une pièce se scanne d'abord par son SKU. Mais beaucoup d'articles arrivent
// avec l'étiquette du fournisseur/fabricant collée dessus (UPC, EAN, ASIN
// Amazon…) et jamais d'étiquette Orisha : au prélèvement, le seul code
// scannable est celui du fournisseur. `scan_codes` stocke ces codes, séparés
// par des virgules, et le scan de commande les accepte au même titre que le
// SKU.
//
// Comparaison insensible à la casse et aux espaces de bordure : un lecteur
// code-barre peut renvoyer la casse d'origine ou un espace parasite.

const SEPARATOR = /[,;\n\r]+/;

export function parseScanCodes(raw) {
  return String(raw || '')
    .split(SEPARATOR)
    .map(s => s.trim())
    .filter(Boolean);
}

export function formatScanCodes(codes) {
  const seen = new Set();
  const out = [];
  for (const c of codes) {
    const code = String(c || '').trim();
    if (!code) continue;
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(code);
  }
  return out.length ? out.join(', ') : null;
}

// Normalise une valeur saisie à la main dans la fiche pièce (retire les
// doublons et les séparateurs vides). Renvoie null pour « aucun code ».
export function normalizeScanCodes(raw) {
  return formatScanCodes(parseScanCodes(raw));
}

export function matchesScanCode(raw, code) {
  const needle = String(code || '').trim().toLowerCase();
  if (!needle) return false;
  return parseScanCodes(raw).some(c => c.toLowerCase() === needle);
}

// Ajoute un code s'il manque. Renvoie la nouvelle valeur (chaîne ou null).
export function addScanCode(raw, code) {
  const codes = parseScanCodes(raw);
  if (!matchesScanCode(raw, code)) codes.push(String(code || '').trim());
  return formatScanCodes(codes);
}
