// Bloc « Nom + J'accepte + Payer » des pages hébergées (Fichiers publics).
// Injecté par l'ERP dans toute page HTML qui contient un élément
// `data-orisha-accept` ; il s'affiche dans cet élément. Les prix sont lus par
// le serveur dans la page enregistrée, jamais envoyés d'ici.
(function () {
  var host = document.querySelector('[data-orisha-accept]')
  if (!host) return
  var m = location.pathname.match(/\/erp\/p\/([a-f0-9]{32})/)
  if (!m) return
  var token = m[1]
  var params = new URLSearchParams(location.search)
  // Id du contact mis par le modèle de courriel ([Contact ID]) : client reconnu.
  var contact = params.get('contact') || ''
  var api = '/erp/api/public/pages/' + token

  var T = {
    fr: { name: 'Nom complet', agree: 'J’ai lu et j’accepte ces conditions.', sign: 'Accepter', signed: 'Accepté', pay: 'Payer', locale: 'fr-CA' },
    en: { name: 'Full name', agree: 'I have read and accept these terms.', sign: 'Accept', signed: 'Accepted', pay: 'Pay', locale: 'en-CA' },
  }

  var css = document.createElement('style')
  css.textContent = '.oa{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border-top:1px solid #e2e8f0;margin-top:28px;padding-top:24px;color:#1f2937}'
    + '.oa label{display:block;font-size:13px;color:#475569;margin-bottom:4px}'
    + '.oa input[type=text]{width:100%;max-width:360px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:9px 12px;font-size:14px}'
    + '.oa .row{margin-bottom:14px}.oa .chk{display:flex;gap:8px;align-items:flex-start;font-size:14px;color:#334155}'
    + '.oa button{background:#1a5c2a;color:#fff;border:0;border-radius:999px;padding:10px 28px;font-size:14px;font-weight:600;cursor:pointer}'
    + '.oa button:hover{background:#25b14e}.oa button:disabled{opacity:.5;cursor:default}'
    + '.oa .ok{color:#15803d;font-weight:600;margin-bottom:4px}.oa .muted{color:#64748b;font-size:13px}.oa .err{color:#b91c1c;font-size:13px;margin-top:8px}'
  document.head.appendChild(css)

  var root = document.createElement('div')
  root.className = 'oa'
  host.appendChild(root)
  var state = null
  var lang = 'fr'

  function call(path, body) {
    return fetch(api + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j }) })
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag)
    for (var k in attrs || {}) e.setAttribute(k, attrs[k])
    if (text) e.textContent = text
    return e
  }
  function error(msg) { var e = el('div', { 'class': 'err' }, msg); root.appendChild(e) }

  // Variantes « client existant » / « nouveau client » écrites dans la page.
  function variant(existing) {
    document.querySelectorAll('[data-orisha-if]').forEach(function (e) {
      e.hidden = e.getAttribute('data-orisha-if') !== (existing ? 'existing' : 'new')
    })
  }

  function render() {
    var t = T[lang] || T.fr
    root.innerHTML = ''
    if (state.accepted) {
      root.appendChild(el('div', { 'class': 'ok' }, '✓ ' + t.signed))
      root.appendChild(el('div', { 'class': 'muted' }, state.accepted.name + ' — ' + new Date(state.accepted.at).toLocaleString(t.locale)))
      if (state.has_payment) {
        var pay = el('button', { type: 'button', style: 'margin-top:18px' }, t.pay)
        pay.onclick = function () {
          pay.disabled = true
          call('/pay', { acceptance_id: state.accepted.id })
            .then(function (r) { location.href = r.url })
            .catch(function (e) { pay.disabled = false; error(e.message) })
        }
        root.appendChild(pay)
      }
      return
    }
    var nameRow = el('div', { 'class': 'row' })
    nameRow.appendChild(el('label', {}, t.name))
    var name = el('input', { type: 'text', autocomplete: 'name' })
    nameRow.appendChild(name)
    var chkRow = el('label', { 'class': 'row chk' })
    var agree = el('input', { type: 'checkbox' })
    chkRow.appendChild(agree)
    chkRow.appendChild(el('span', {}, t.agree))
    var btn = el('button', { type: 'button', disabled: 'disabled' }, t.sign)
    function sync() { btn.disabled = !(name.value.trim() && agree.checked) }
    name.oninput = sync
    agree.onchange = sync
    btn.onclick = function () {
      btn.disabled = true
      call('/accept', { name: name.value.trim(), agree: true, contact: contact || undefined })
        .then(function (r) { state = r; render() })
        .catch(function (e) { sync(); error(e.message) })
    }
    root.appendChild(nameRow)
    root.appendChild(chkRow)
    root.appendChild(btn)
  }

  call(contact ? '?contact=' + encodeURIComponent(contact) : '')
    .then(function (r) { state = r; lang = r.language === 'en' ? 'en' : 'fr'; variant(r.existing); render() })
    .catch(function () { /* page sans bloc : rien à afficher */ })
})()
