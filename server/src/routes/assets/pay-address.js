// Formulaire d'adresse de facturation de la page de paiement (remplace le bloc
// d'adresse Stripe : pays recherchable, Canada et É.-U. en tête, autocomplétion
// Google ; Charles, 2026-10-13). Inliné dans la page par customer-pay.js.
// API : window.PayAddress.mount(root, { fr, endpoint, initial, onChange })
//   → { value(): {name, address}, valid(): bool }
(function () {
  var CODES = 'CA US AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')
  var REGIONS = {
    CA: 'AB BC MB NB NL NS NT NU ON PE QC SK YT',
    US: 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR',
  }
  var REGION_NAMES = {
    CA: { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' },
    CA_fr: { BC: 'Colombie-Britannique', NB: 'Nouveau-Brunswick', NL: 'Terre-Neuve-et-Labrador', NS: 'Nouvelle-Écosse', NT: 'Territoires du Nord-Ouest', PE: 'Île-du-Prince-Édouard', QC: 'Québec' },
  }
  var STYLE = '.pa{margin:14px 0}.pa label{display:block;font-size:14px;color:#30313d;margin:10px 0 4px}' +
    '.pa input,.pa select,.pa .pa-cc{width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:11px 12px;border:1px solid #e6e6e6;border-radius:8px;background:#fff;color:#30313d;box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02);height:44px;margin:0;font-weight:400}' +
    '.pa .pa-cc:hover{background:#fff}.pa .pa-pop input{height:40px}' +
    '.pa input:focus,.pa select:focus,.pa .pa-cc:focus{outline:0;border-color:#1a5c2a;box-shadow:0 0 0 3px rgba(26,92,42,.2)}' +
    '.pa .pa-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}@media(max-width:480px){.pa .pa-row{grid-template-columns:1fr}}' +
    '.pa .pa-w{position:relative}.pa .pa-cc{text-align:left;cursor:pointer}.pa .pa-cc:after{content:"";position:absolute;right:14px;top:50%;margin-top:-3px;border:5px solid transparent;border-top-color:#6b7280}' +
    '.pa ul{position:absolute;z-index:20;left:0;right:0;top:100%;margin:4px 0 0;padding:4px 0;list-style:none;background:#fff;border:1px solid #e6e6e6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:260px;overflow:auto}' +
    '.pa li{padding:9px 12px;cursor:pointer;font-size:14px}.pa li.on{background:#eef6f0}.pa li.sep{border-bottom:1px solid #f1f5f9}' +
    '.pa .pa-pop{position:absolute;z-index:20;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #e6e6e6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12)}' +
    '.pa .pa-pop input{border:0;border-bottom:1px solid #f1f5f9;border-radius:8px 8px 0 0;box-shadow:none}.pa .pa-pop ul{position:static;border:0;box-shadow:none;margin:0}'

  function el(tag, attrs, kids) {
    var e = document.createElement(tag)
    for (var k in attrs || {}) if (attrs[k] != null) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]) }
    ;(kids || []).forEach(function (c) { e.appendChild(c) })
    return e
  }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() }

  // Liste déroulante navigable au clavier ; items = [{ value, label, sep? }].
  function listbox(ul, pick) {
    var items = [], on = -1
    function paint() { Array.prototype.forEach.call(ul.children, function (li, i) { li.className = (i === on ? 'on' : '') + (items[i].sep ? ' sep' : '') }) }
    return {
      set: function (list) {
        items = list; on = list.length ? 0 : -1; ul.innerHTML = ''
        list.forEach(function (it, i) {
          var li = el('li', { text: it.label, role: 'option' })
          li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(items[i]) })
          ul.appendChild(li)
        })
        ul.hidden = !list.length; paint()
      },
      key: function (e) {
        if (ul.hidden || !items.length) return false
        if (e.key === 'ArrowDown') on = Math.min(items.length - 1, on + 1)
        else if (e.key === 'ArrowUp') on = Math.max(0, on - 1)
        else if (e.key === 'Enter') { if (on >= 0) pick(items[on]); e.preventDefault(); return true }
        else if (e.key === 'Escape') { ul.hidden = true; return true }
        else return false
        e.preventDefault(); paint(); if (ul.children[on]) ul.children[on].scrollIntoView({ block: 'nearest' }); return true
      },
      hide: function () { ul.hidden = true },
    }
  }

  function mount(root, opts) {
    var fr = opts.fr, init = opts.initial || {}, a0 = init.address || {}
    var T = fr
      ? { name: 'Nom complet', country: 'Pays', search: 'Rechercher un pays', line1: 'Adresse', line2: 'App., bureau (facultatif)', city: 'Ville', state: { CA: 'Province', US: 'État', x: 'Région' }, postal: { CA: 'Code postal', US: 'Code ZIP', x: 'Code postal' }, pick: 'Choisir' }
      : { name: 'Full name', country: 'Country', search: 'Search countries', line1: 'Address', line2: 'Apt, suite (optional)', city: 'City', state: { CA: 'Province', US: 'State', x: 'Region' }, postal: { CA: 'Postal code', US: 'ZIP code', x: 'Postal code' }, pick: 'Select' }
    var dn = null
    try { dn = new Intl.DisplayNames([fr ? 'fr-CA' : 'en-CA'], { type: 'region' }) } catch (e) {}
    var cname = function (c) { try { return (dn && dn.of(c)) || c } catch (e) { return c } }
    // Recherche aussi dans l'autre langue (« États-Unis » sur la page anglaise) et « USA ».
    var dn2 = null
    try { dn2 = new Intl.DisplayNames([fr ? 'en-CA' : 'fr-CA'], { type: 'region' }) } catch (e) {}
    var alias = function (c) { var o = ''; try { o = (dn2 && dn2.of(c)) || '' } catch (e) {} return norm(o + (c === 'US' ? ' usa' : '')) }
    var countries = CODES.map(function (c, i) { return { value: c, label: cname(c), alt: alias(c), sep: i === 1 } })
    var rest = countries.slice(2).sort(function (a, b) { return a.label.localeCompare(b.label, fr ? 'fr' : 'en') })
    countries = countries.slice(0, 2).concat(rest)

    document.head.appendChild(el('style', { text: STYLE }))
    var country = /^[A-Z]{2}$/.test(a0.country || '') ? a0.country : (opts.defaultCountry || 'CA')

    var name = el('input', { autocomplete: 'name', value: init.name || '' })
    var cc = el('button', { type: 'button', class: 'pa-cc', 'aria-haspopup': 'listbox' })
    var csearch = el('input', { placeholder: T.search, autocomplete: 'off' })
    var cul = el('ul', { role: 'listbox' })
    var cpop = el('div', { class: 'pa-pop', hidden: '' }, [csearch, cul])
    var line1 = el('input', { autocomplete: 'address-line1', value: a0.line1 || '' })
    var aul = el('ul', { role: 'listbox', hidden: '' })
    var line2 = el('input', { autocomplete: 'address-line2', value: a0.line2 || '' })
    var city = el('input', { autocomplete: 'address-level2', value: a0.city || '' })
    var stateWrap = el('div'), stateLabel = el('label'), postalLabel = el('label')
    var postal = el('input', { autocomplete: 'postal-code', value: a0.postal_code || '' })
    var state = null

    root.className = 'pa'
    // Pays en dernier : la suggestion d'adresse le remplit (Charles, 2026-10-13).
    ;[el('label', { text: T.name }), name,
      el('label', { text: T.line1 }), el('div', { class: 'pa-w' }, [line1, aul]),
      el('label', { text: T.line2 }), line2,
      el('div', { class: 'pa-row' }, [el('div', {}, [el('label', { text: T.city }), city]), stateWrap, el('div', {}, [postalLabel, postal])]),
      el('label', { text: T.country }), el('div', { class: 'pa-w' }, [cc, cpop]),
    ].forEach(function (n) { root.appendChild(n) })

    function renderState(val) {
      stateWrap.innerHTML = ''
      var k = REGIONS[country] ? country : 'x'
      stateLabel.textContent = T.state[k]; postalLabel.textContent = T.postal[k]
      if (REGIONS[country]) {
        state = el('select', { autocomplete: 'address-level1' })
        state.appendChild(el('option', { value: '', text: T.pick }))
        REGIONS[country].split(' ').map(function (c) {
          var n = (fr && country === 'CA' && REGION_NAMES.CA_fr[c]) || (REGION_NAMES[country] && REGION_NAMES[country][c]) || c
          return { c: c, n: n }
        }).sort(function (a, b) { return a.n.localeCompare(b.n) }).forEach(function (o) { state.appendChild(el('option', { value: o.c, text: o.n })) })
        state.value = val && REGIONS[country].split(' ').indexOf(val) >= 0 ? val : ''
      } else {
        state = el('input', { autocomplete: 'address-level1', value: val || '' })
      }
      state.addEventListener('change', changed); state.addEventListener('input', changed)
      stateWrap.appendChild(stateLabel); stateWrap.appendChild(state)
    }
    function setCountry(c, keepState) {
      var prev = country
      country = c; cc.textContent = cname(c)
      if (prev !== c || !state) renderState(keepState)
    }

    // Pays : bouton → popover avec recherche.
    var clb = listbox(cul, function (it) { setCountry(it.value); closeCountry(); changed() })
    function filterCountries() {
      var q = norm(csearch.value)
      clb.set(q ? countries.filter(function (c) { return norm(c.label).indexOf(q) >= 0 || c.alt.indexOf(q) >= 0 || c.value.toLowerCase() === q }).map(function (c) { return { value: c.value, label: c.label } }) : countries)
      cul.hidden = false
    }
    function openCountry() { cpop.hidden = false; csearch.value = ''; filterCountries(); csearch.focus() }
    function closeCountry() { cpop.hidden = true; cc.focus() }
    cc.addEventListener('click', function () { cpop.hidden ? openCountry() : closeCountry() })
    csearch.addEventListener('input', filterCountries)
    csearch.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCountry(); else clb.key(e) })
    csearch.addEventListener('blur', function () { setTimeout(function () { cpop.hidden = true }, 120) })

    // Adresse : suggestions Google, session groupant frappe + détail.
    var sess = '', timer = null, seq = 0
    var alb = listbox(aul, function (it) {
      alb.hide()
      fetch(opts.endpoint + '/' + encodeURIComponent(it.value) + '?s=' + sess).then(function (r) { return r.json() }).then(function (d) {
        sess = ''
        var c = d.components || {}
        if (/^[A-Z]{2}$/.test(c.country || '')) setCountry(c.country, c.province)
        line1.value = c.line1 || it.label.split(',')[0]
        city.value = c.city || ''
        if (state) state.value = c.province || ''
        postal.value = c.postal_code || ''
        changed(); line2.focus()
      }).catch(function () {})
    })
    line1.addEventListener('input', function () {
      clearTimeout(timer)
      var q = line1.value.trim()
      if (q.length < 3) { alb.hide(); changed(); return }
      if (!sess) sess = Math.random().toString(36).slice(2) + Date.now().toString(36)
      var my = ++seq
      timer = setTimeout(function () {
        fetch(opts.endpoint + '?q=' + encodeURIComponent(q) + '&c=' + (REGIONS[country] ? 'CA|US' : country) + '&s=' + sess).then(function (r) { return r.json() }).then(function (d) {
          if (my !== seq || document.activeElement !== line1) return
          alb.set((d.predictions || []).map(function (p) { return { value: p.place_id, label: p.description } }))
        }).catch(function () {})
      }, 220)
      changed()
    })
    line1.addEventListener('keydown', function (e) { alb.key(e) })
    line1.addEventListener('blur', function () { setTimeout(alb.hide, 120) })
    ;[name, line2, city, postal].forEach(function (i) { i.addEventListener('input', changed) })

    var api = {
      value: function () {
        return { name: name.value.trim(), address: { country: country, line1: line1.value.trim(), line2: line2.value.trim() || null, city: city.value.trim(), state: (state && state.value.trim()) || null, postal_code: postal.value.trim() } }
      },
      // Adresse différente de celle pré-remplie (ou pas d'adresse au départ).
      edited: function () {
        var a = api.value().address, k = ['country', 'line1', 'city', 'state', 'postal_code']
        return !a0.country || k.some(function (f) { return norm(a[f]).replace(/\s/g, '') !== norm(a0[f]).replace(/\s/g, '') })
      },
      valid: function () {
        var v = api.value(), a = v.address
        return !!(v.name && a.country && a.line1 && a.city && a.postal_code && (!REGIONS[a.country] || a.state))
      },
    }
    var ct = null
    function changed() { clearTimeout(ct); ct = setTimeout(function () { opts.onChange && opts.onChange(api) }, 400) }
    setCountry(country, a0.state || '')
    return api
  }

  window.PayAddress = { mount: mount }
})()
