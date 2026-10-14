const ROWS=[
 {id:1,d:'10 oct',v:'Amazon.ca',c:'Fournitures de bureau',m:-84.27,s:'grn'},
 {id:2,d:'10 oct',v:'Hydro-Québec',c:'Électricité',m:-212.40,s:'yel'},
 {id:3,d:'11 oct',v:'DigiKey',c:'Pièces électroniques',m:-1045.18,s:'grn'},
 {id:4,d:'11 oct',v:'Stripe',c:'Encaissement clients',m:3420.00,s:'grn'},
 {id:5,d:'12 oct',v:'Shopify',c:'Logiciels',m:-39.00,s:'red',bad:'QuickBooks : 36,00 $'},
 {id:6,d:'12 oct',v:'Bell',c:'Téléphone',m:-98.88,s:'yel'},
];
const fmt=n=>(n<0?'−':'+')+Math.abs(n).toLocaleString('fr-CA',{minimumFractionDigits:2});
const S={};
function ask(k){const r=S[k].rows.find(x=>x.id===5);
 const card=k==='b3'?'':`<div class="rowcard" onmouseenter="hv('${k}',1)" onmouseleave="hv('${k}',0)" onclick="jump('${k}')"><span>${r.d}</span><b>${k==='b1'?'<span class="tag">1</span>':''}${r.v}</b><b class="n">${fmt(r.m)}</b><span></span><span class="w">Visa CAD · ligne 5</span><span class="w bad">QB 36,00</span></div>`;
 return `${card}La TVQ manque dans QuickBooks ?`}
function feedHtml(k){const s=S[k];return s.feed.map(f=>f.t==='sys'?`<div class="sys">${f.x}</div>`:f.t==='me'?`<div class="me">${f.x}</div>`:`<div class="msg"><span class="av">C</span><div class="bub ${f.t==='warn'&&!s.solved?'warn':''}">${f.t==='warn'?ask(k):f.x}${f.t==='warn'&&!s.solved?`<div class="acts"><button class="btn sm go" onclick="fix('${k}')">Corriger à 39,00</button><button class="btn sm" onclick="say('${k}','Montre-moi la facture')">Voir</button></div>`:''}</div></div>`).join('')}
const inp=k=>`<form class="inp" onsubmit="say('${k}',this.q.value);this.q.value='';return false"><input name="q" placeholder="Répondre à Claude"/><button class="btn go">↑</button></form>`;
const chat=(k,x='')=>`<div class="hd"><span class="av">C</span>Claude<span class="live">Visa CAD</span><span style="cursor:pointer;color:var(--ink3);margin-left:10px" onclick="tog('${k}')">✕</span></div><div class="feed">${feedHtml(k)}</div>${inp(k)}`;
function render(k){const s=S[k],el=s.el,t=el.querySelector('[data-tbl]');
 const focus=!s.solved&&((k!=='b1'&&s.open)||s.hover);
 t.className=focus&&k==='b2'?'dim':'';
 let h='<tr><th>Date</th><th>Fournisseur</th><th>Catégorie</th><th class="r">Montant</th><th></th></tr>';
 s.rows.forEach(r=>{const tg=r.id===5&&!s.solved;
  const a=r.s==='yel'?`<button class="btn sm" onclick="book('${k}',${r.id})">Comptabiliser</button>`:r.s==='grn'?'<span class="mark ok">✓ Rapprochée</span>':'<span class="mark bad">! Écart</span>';
  h+=`<tr data-id="${r.id}" class="${r.s} ${r.fl?'flash':''} ${tg&&focus?'focus':''}"><td>${r.d}</td><td>${tg&&k==='b1'?'<span class="tag">1</span>':''}<b>${r.v}</b></td><td>${r.c}${r.bad&&tg?`<div class="l2 bad">${r.bad}</div>`:''}</td><td class="r n ${r.m>0?'ok':''}">${fmt(r.m)}</td><td class="r ${tg&&k==='b3'?'anch':''}">${a}${tg&&k==='b3'?`<span class="pin" onclick="tog('b3')">C</span>`:''}</td></tr>`;r.fl=0});
 t.innerHTML=h;
 const ui=el.querySelector('[data-ui]');
 if(k==='b3'){
  const tr=t.querySelector('tr[data-id="5"]');
  ui.innerHTML=s.open&&!s.solved?`<div class="anpop chat" style="height:240px">${chat(k)}</div>`:'';
  if(tr&&ui.firstChild){const top=tr.offsetTop+el.querySelector('.scroll').offsetTop+tr.offsetHeight+8;ui.firstChild.style.top=top+'px'}
 } else {
  ui.innerHTML=`<div class="pop chat" style="display:${s.open?'flex':'none'}">${chat(k)}</div><div class="fab" onclick="tog('${k}')">C${s.solved?'':'<span class="dot">1</span>'}</div>`;
 }
 const f=ui.querySelector('.feed');if(f)f.scrollTop=f.scrollHeight;
 el.querySelector('[data-gap]').textContent=s.solved?'0,00':'39,00';el.querySelector('[data-gap]').className='n '+(s.solved?'ok':'bad');el.querySelector('[data-qb]').textContent=s.solved?'12 480,22':'12 441,22';
}
function hv(k,on){if(k==='b2')return;S[k].hover=!!on;const tr=S[k].el.querySelector('tr[data-id="5"]');if(tr)tr.classList.toggle('focus',!!on)}
function jump(k){const tr=S[k].el.querySelector('tr[data-id="5"]');tr.scrollIntoView({behavior:'smooth',block:'center'});tr.classList.add('focus','flash');setTimeout(()=>{if(!S[k].hover&&k!=='b2')tr.classList.remove('focus')},1600)}
function toast(k,x){const el=S[k].el;let e=el.querySelector('.toast');if(!e){e=document.createElement('div');e.className='toast';el.appendChild(e)}e.innerHTML=x;clearTimeout(e._t);e._t=setTimeout(()=>e.remove(),2200)}
function book(k,id){const r=S[k].rows.find(x=>x.id===id);r.s='grn';r.fl=1;S[k].feed.push({t:'sys',x:`<b>✓</b> ${r.v} rapprochée`});render(k);toast(k,`<b>✓</b> ${r.v} rapprochée`)}
function fix(k){const s=S[k];s.solved=true;s.hover=false;const r=s.rows.find(x=>x.id===5);r.s='grn';r.fl=1;r.bad='';s.feed.push({t:'msg',x:'Corrigé dans QuickBooks. Écart <b class="ok">0,00</b> ✓'});render(k);toast(k,'<b>✓</b> Shopify rapprochée')}
function say(k,q){if(!q.trim())return;const s=S[k];s.feed.push({t:'me',x:q});render(k);setTimeout(()=>{if(!s.solved&&/tvq|corrige|oui/i.test(q))fix(k);else{s.feed.push({t:'msg',x:'Facture Shopify n° 4471 : 33,92 + TPS 1,70 + TVQ 3,38 = <b>39,00 $</b>.'});render(k)}},500)}
function tog(k){S[k].open=!S[k].open;render(k)}
document.querySelectorAll('[data-k]').forEach(el=>{const k=el.dataset.k;S[k]={el,rows:ROWS.map(r=>({...r})),feed:[{t:'sys',x:'<b>✓</b> Amazon.ca, DigiKey, Stripe rapprochées'},{t:'warn',id:5}],open:k!=='b1',solved:false,hover:false};render(k)});
