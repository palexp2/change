const ROWS=[
 {id:1,d:'2026-10-09',v:'Hydro-Québec',c:'Électricité',m:-212.40,s:'grn'},
 {id:2,d:'2026-10-10',v:'Bell',c:'Téléphone',m:-98.88,s:'grn'},
 {id:3,d:'2026-10-13',v:'Frais Banque Nationale',c:'Frais bancaires',m:-34.59,s:'grn'},
 {id:4,d:'2026-10-13',v:'Virement Interac',c:'',m:10000,s:'red'},
 {id:5,d:'2026-10-13',v:'Orisha',c:'',m:15000,s:'red'},
];
const FIX={
 4:{what:'Virement depuis Desjardins CAD',qb:'Virement QB · 10 000,00'},
 5:{what:'Dépôt · Paiement émis Desjardins CAD',qb:'Dépôt QB · 15 000,00'},
};
const fmt=n=>(n<0?'−':'+')+Math.abs(n).toLocaleString('fr-CA',{minimumFractionDigits:2});
const S={};
const gapOf=s=>24965.41-s.rows.filter(r=>FIX[r.id]&&r.s==='grn').reduce((a,r)=>a+r.m,0);
const money=n=>Math.abs(n).toLocaleString('fr-CA',{minimumFractionDigits:2});
function rowcard(r,k){return `<div class="rowcard" onmouseenter="hv('${k}',${r.id})" onmouseleave="hv('${k}',0)"><span>${r.d.slice(5)}</span><b>${r.v}</b><b class="n">${fmt(r.m)}</b><span></span><span class="w">Pas dans QuickBooks</span><span class="w"></span></div>`}
function body(k){const s=S[k],todo=s.rows.filter(r=>FIX[r.id]&&r.s!=='grn');
 let h=`<div class="sys"><b>✓</b> Hydro-Québec, Bell, Frais BN rapprochées</div>`;
 if(k==='k1'){
  s.rows.filter(r=>FIX[r.id]).forEach(r=>{const done=r.s==='grn';
   h+=`<div class="msg"><span class="av">C</span><div class="bub ${done?'':'warn'}">${rowcard(r,k)}${done?`Fait : ${FIX[r.id].what}. <span class="ok">✓</span><span class="undo" onclick="undo('${k}',${r.id})">Annuler</span>`:`Je l'inscris comme <b>${FIX[r.id].what}</b>.<div class="acts"><button class="btn sm go" onclick="doFix('${k}',[${r.id}])">Faire</button><button class="btn sm">Non</button></div>`}</div></div>`});
 }
 if(k==='k2'){
  s.rows.filter(r=>FIX[r.id]).forEach(r=>{const done=r.s==='grn';
   h+=`<div class="msg"><span class="av">C</span><div class="bub ${done?'':'warn'}">${rowcard(r,k)}${done?`Fait. <span class="ok">✓</span><span class="undo" onclick="undo('${k}',${r.id})">Annuler</span>`:`Proposition affichée sur la ligne.<div class="acts"><button class="btn sm go" onclick="doFix('${k}',[${r.id}])">Valider</button><button class="btn sm">Modifier</button></div>`}</div></div>`});
 }
 if(k==='k3'){
  const all=s.rows.filter(r=>FIX[r.id]);
  h+=`<div class="msg"><span class="av">C</span><div class="bub ${todo.length?'warn':''}">${todo.length?'2 corrections ferment l\'écart :':'Tout est fait.'}<div class="fix">${all.map(r=>`<div class="row ${r.s==='grn'?'done':''}" onmouseenter="hv('${k}',${r.id})" onmouseleave="hv('${k}',0)">${r.s==='grn'?'<span class="ok">✓</span>':`<input type="checkbox" checked data-id="${r.id}">`}<span><b>${r.v}</b> ${fmt(r.m)}<div class="k">→ ${FIX[r.id].what}</div></span><span></span></div>`).join('')}</div>
  <div class="ba">Écart <s>${money(24965.41)}</s> → <b>${money(todo.length?0:gapOf(s))}</b></div>
  ${todo.length?`<div class="acts"><button class="btn sm go" onclick="doAll('${k}')">Tout faire (${todo.length})</button></div>`:`<span class="undo" onclick="undoAll('${k}')">Tout annuler</span>`}</div></div>`;
 }
 s.feed.forEach(f=>{h+=f.t==='me'?`<div class="me">${f.x}</div>`:`<div class="msg"><span class="av">C</span><div class="bub">${f.x}</div></div>`});
 return h}
const inp=k=>`<form class="inp" onsubmit="say('${k}',this.q.value);this.q.value='';return false"><input name="q" placeholder="Répondre à Claude"/><button class="btn go">↑</button></form>`;
function render(k){const s=S[k],el=s.el,t=el.querySelector('[data-tbl]');
 const todo=s.rows.filter(r=>FIX[r.id]&&r.s!=='grn');
 const focus=s.open?(s.hover||(todo[0]&&todo[0].id)||0):0;
 t.className=focus?'dim':'';
 let h='<tr><th>Date</th><th>Fournisseur</th><th>Catégorie ou correspondance</th><th class="r">Montant</th><th></th></tr>';
 s.rows.forEach(r=>{const pend=FIX[r.id]&&r.s!=='grn';
  const cat=r.s==='grn'&&FIX[r.id]?FIX[r.id].what:(pend&&k==='k2'?`<span class="ghost">${FIX[r.id].what}</span>`:r.c||'<span class="l2">À catégoriser</span>');
  const act=r.s==='grn'?'<span class="mark ok">✓ Rapprochée</span>':(k==='k2'?`<button class="btn sm go" onclick="doFix('${k}',[${r.id}])">Valider</button>`:'<span class="mark bad">À traiter</span>');
  h+=`<tr data-id="${r.id}" class="${r.s} ${r.fl?'flash':''} ${focus===r.id?'focus':''}"><td>${r.d}</td><td><b>${r.v}</b></td><td class="cat">${cat}</td><td class="r n ${r.m>0?'ok':''}">${fmt(r.m)}</td><td class="r">${act}</td></tr>`;r.fl=0});
 t.innerHTML=h;
 const ui=el.querySelector('[data-ui]');
 ui.innerHTML=`<div class="pop chat" style="display:${s.open?'flex':'none'}"><div class="hd"><span class="av">C</span>Claude<span class="live">BNC CAD</span><span style="cursor:pointer;color:var(--ink3);margin-left:10px" onclick="tog('${k}')">✕</span></div><div class="feed">${body(k)}</div>${inp(k)}</div><div class="fab" onclick="tog('${k}')">C${todo.length?`<span class="dot">${todo.length}</span>`:''}</div>`;
 const f=ui.querySelector('.feed');if(f)f.scrollTop=f.scrollHeight;
 const g=todo.length?24965.41-s.rows.filter(r=>FIX[r.id]&&r.s==='grn').reduce((a,r)=>a+r.m,0):0;
 el.querySelector('[data-gap]').textContent=money(g);el.querySelector('[data-gap]').className='n '+(Math.abs(g)<.005?'ok':'bad');
 el.querySelector('[data-qb]').textContent=money(27130.21-g);
}
function hv(k,id){S[k].hover=id;const t=S[k].el.querySelector('[data-tbl]');t.querySelectorAll('tr').forEach(tr=>tr.classList.toggle('focus',+tr.dataset.id===(id||((S[k].rows.find(r=>FIX[r.id]&&r.s!=='grn')||{}).id))));t.className=S[k].open?'dim':''}
function toast(k,x){const el=S[k].el;let e=el.querySelector('.toast');if(!e){e=document.createElement('div');e.className='toast';el.appendChild(e)}e.innerHTML=x;clearTimeout(e._t);e._t=setTimeout(()=>e.remove(),2200)}
function doFix(k,ids){ids.forEach(id=>{const r=S[k].rows.find(x=>x.id===id);r.s='grn';r.fl=1});S[k].hover=0;render(k);toast(k,'<b>✓</b> Inscrit dans QuickBooks · rapprochée')}
function doAll(k){const ids=[...S[k].el.querySelectorAll('.fix input:checked')].map(i=>+i.dataset.id);doFix(k,ids)}
function undo(k,id){const r=S[k].rows.find(x=>x.id===id);r.s='red';render(k)}
function undoAll(k){S[k].rows.forEach(r=>{if(FIX[r.id])r.s='red'});render(k)}
function say(k,q){if(!q.trim())return;S[k].feed.push({t:'me',x:q});render(k);setTimeout(()=>{S[k].feed.push({t:'c',x:'D\'accord, je l\'inscris comme virement depuis Desjardins USD à la place.'});render(k)},500)}
function tog(k){S[k].open=!S[k].open;render(k)}
document.querySelectorAll('[data-k]').forEach(el=>{const k=el.dataset.k;S[k]={el,rows:ROWS.map(r=>({...r})),feed:[],open:true,hover:0};render(k)});
