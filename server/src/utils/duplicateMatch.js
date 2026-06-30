// Détection de doublons à la création/édition d'entreprises et de contacts.
//
// L'ERP est single-tenant mais alimenté par plusieurs sources (Airtable,
// HubSpot, saisie manuelle) : sans garde-fou, les doublons d'entreprises et
// de contacts s'accumulent vite et faussent les rollups. On normalise
// nom / courriel / téléphone puis on remonte les correspondances pour
// avertir l'utilisateur — la détection est *non bloquante* (l'utilisateur
// peut toujours créer le record s'il sait que ce n'en est pas un).

export function normalizeName(s) {
  return (s ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeEmail(s) {
  return (s ?? '').toString().trim().toLowerCase();
}

// Garde uniquement les chiffres, puis les 10 derniers (ignore l'indicatif
// pays « 1 » nord-américain). Retourne '' si trop court pour être fiable.
export function normalizePhone(s) {
  const digits = (s ?? '').toString().replace(/\D/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-10);
}

const COMPANY_COLS = 'id, name, email, phone, city, province, lifecycle_phase';

export function findCompanyDuplicates(db, { name, email, phone, excludeId } = {}) {
  const nName = normalizeName(name);
  const nEmail = normalizeEmail(email);
  const nPhone = normalizePhone(phone);
  if (!nName && !nEmail && !nPhone) return [];

  const byId = new Map();
  const add = (row, reason) => {
    if (excludeId && row.id === excludeId) return;
    const e = byId.get(row.id) || { ...row, reasons: [] };
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    byId.set(row.id, e);
  };

  if (nName) {
    db.prepare(
      `SELECT ${COMPANY_COLS} FROM companies
       WHERE deleted_at IS NULL AND lower(trim(name)) = ?`
    ).all(nName).forEach(r => add(r, 'name'));
  }
  if (nEmail) {
    db.prepare(
      `SELECT ${COMPANY_COLS} FROM companies
       WHERE deleted_at IS NULL AND email IS NOT NULL AND lower(trim(email)) = ?`
    ).all(nEmail).forEach(r => add(r, 'email'));
  }
  if (nPhone) {
    // Le téléphone est stocké formaté (parenthèses, tirets, espaces) — on
    // normalise en JS plutôt que dans SQL.
    db.prepare(
      `SELECT ${COMPANY_COLS} FROM companies
       WHERE deleted_at IS NULL AND phone IS NOT NULL AND phone != ''`
    ).all().forEach(r => { if (normalizePhone(r.phone) === nPhone) add(r, 'phone'); });
  }

  return [...byId.values()].slice(0, 10);
}

const CONTACT_COLS = 'id, first_name, last_name, email, phone, mobile, company_id';

export function findContactDuplicates(db, { first_name, last_name, email, phone, mobile, excludeId } = {}) {
  const nFirst = normalizeName(first_name);
  const nLast = normalizeName(last_name);
  const nEmail = normalizeEmail(email);
  const phones = [normalizePhone(phone), normalizePhone(mobile)].filter(Boolean);
  if (!(nFirst && nLast) && !nEmail && !phones.length) return [];

  const byId = new Map();
  const add = (row, reason) => {
    if (excludeId && row.id === excludeId) return;
    const e = byId.get(row.id) || { ...row, reasons: [] };
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    byId.set(row.id, e);
  };

  if (nFirst && nLast) {
    db.prepare(
      `SELECT ${CONTACT_COLS} FROM contacts
       WHERE deleted_at IS NULL
         AND lower(trim(first_name)) = ? AND lower(trim(last_name)) = ?`
    ).all(nFirst, nLast).forEach(r => add(r, 'name'));
  }
  if (nEmail) {
    db.prepare(
      `SELECT ${CONTACT_COLS} FROM contacts
       WHERE deleted_at IS NULL AND email IS NOT NULL AND lower(trim(email)) = ?`
    ).all(nEmail).forEach(r => add(r, 'email'));
  }
  if (phones.length) {
    db.prepare(
      `SELECT ${CONTACT_COLS} FROM contacts
       WHERE deleted_at IS NULL
         AND ((phone IS NOT NULL AND phone != '') OR (mobile IS NOT NULL AND mobile != ''))`
    ).all().forEach(r => {
      const rp = [normalizePhone(r.phone), normalizePhone(r.mobile)].filter(Boolean);
      if (rp.some(p => phones.includes(p))) add(r, 'phone');
    });
  }

  return [...byId.values()].slice(0, 10);
}
