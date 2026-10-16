// Formulaire d'adresse de facturation de la page de paiement : pays (Canada ou
// É.-U.) et code postal seulement — assez pour les taxes automatiques de Stripe
// (Charles, 2026-10-15). Inliné dans la page par customer-pay.js.
// API : window.PayAddress.mount(root, { fr, initial, defaultCountry, onChange })
//   → { value(): {name, address}, edited(): bool, valid(): bool }
(function () {
  // Province d'un code postal canadien par sa 1re lettre (X = T.N.-O./Nunavut : ambigu).
  var CA_PROV = { A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC', K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK', T: 'AB', V: 'BC', Y: 'YT' }
  var FORMAT = { CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/, US: /^\d{5}(-\d{4})?$/ }
  var STYLE = '.pa{margin:14px 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}.pa label{display:block;font-size:14px;color:#30313d;margin:0 0 4px}' +
    '.pa input,.pa select{width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:11px 12px;border:1px solid #e6e6e6;border-radius:8px;background:#fff;color:#30313d;box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02);height:44px;margin:0;font-weight:400}' +
    '.pa input:focus,.pa select:focus{outline:0;border-color:#1a5c2a;box-shadow:0 0 0 3px rgba(26,92,42,.2)}'

  function el(tag, attrs, kids) {
    var e = document.createElement(tag)
    for (var k in attrs || {}) if (attrs[k] != null) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]) }
    ;(kids || []).forEach(function (c) { e.appendChild(c) })
    return e
  }
  function clean(s) { return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim() }

  function mount(root, opts) {
    var fr = opts.fr, init = opts.initial || {}, a0 = init.address || {}
    var T = fr
      ? { country: 'Pays', CA: 'Canada', US: 'États-Unis', postal: { CA: 'Code postal', US: 'Code ZIP' } }
      : { country: 'Country', CA: 'Canada', US: 'United States', postal: { CA: 'Postal code', US: 'ZIP code' } }
    document.head.appendChild(el('style', { text: STYLE }))

    var c0 = a0.country === 'US' || a0.country === 'CA' ? a0.country : (opts.defaultCountry === 'US' ? 'US' : 'CA')
    var country = el('select', { autocomplete: 'country' }, ['CA', 'US'].map(function (c) { return el('option', { value: c, text: T[c] }) }))
    country.value = c0
    var postalLabel = el('label')
    var postal = el('input', { autocomplete: 'postal-code', value: a0.country === c0 ? (a0.postal_code || '') : '' })
    root.className = 'pa'
    root.appendChild(el('div', {}, [el('label', { text: T.country }), country]))
    root.appendChild(el('div', {}, [postalLabel, postal]))
    function label() { postalLabel.textContent = T.postal[country.value] }
    label()

    var api = {
      value: function () {
        var c = country.value, p = clean(postal.value)
        if (c === 'CA' && /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(p)) p = p.slice(0, 3) + ' ' + p.slice(3)
        return { name: init.name || null, address: { country: c, postal_code: p, state: c === 'CA' ? (CA_PROV[p[0]] || null) : null } }
      },
      // Adresse différente de celle pré-remplie (ou pas d'adresse au départ).
      edited: function () {
        var a = api.value().address
        return !a0.country || a.country !== a0.country || a.postal_code.replace(/\s/g, '') !== clean(a0.postal_code).replace(/\s/g, '')
      },
      valid: function () {
        var a = api.value().address
        return FORMAT[a.country].test(a.postal_code)
      },
    }
    var ct = null
    function changed() { clearTimeout(ct); ct = setTimeout(function () { opts.onChange && opts.onChange(api) }, 400) }
    country.addEventListener('change', function () { label(); changed() })
    postal.addEventListener('input', changed)
    return api
  }

  window.PayAddress = { mount: mount }
})()
