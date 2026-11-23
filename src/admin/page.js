import { MAX_BYTES } from "../config.js";

// ------------------------------------------------------------------ page d'administration
export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function adminPage(email) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Mémoire — administration</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--txt:#1d1d1b;--mut:#6b6b66;--acc:#c96442;--bd:#e3e2dd;--ko:#c62828;--ok:#2e7d32}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1a;--card:#262624;--txt:#eceae4;--mut:#9b9a94;--bd:#3a3936}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt)}
header{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--bd)}
header h1{font-size:1.05rem;margin:0;white-space:nowrap;cursor:pointer}header form{flex:1;display:flex;gap:8px}header small{color:var(--mut);white-space:nowrap}
.wrap{display:grid;grid-template-columns:260px 1fr;gap:16px;max-width:1200px;margin:0 auto;padding:16px}
@media(max-width:760px){.wrap{grid-template-columns:1fr}header small{display:none}}
aside,section.card,.item{background:var(--card);border:1px solid var(--bd);border-radius:12px}
aside{padding:8px;align-self:start}aside ul{list-style:none;margin:0;padding:0}
aside li{padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
aside li:hover{background:var(--bg)}aside li.sel{background:var(--acc);color:#fff}aside li.sel .n{color:#fff}aside li.arch{opacity:.55}
.n{color:var(--mut);font-size:.8rem;white-space:nowrap}aside h3{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:10px 10px 4px}
section.card{padding:16px;margin-bottom:16px}h2{font-size:1.15rem;margin:0 0 12px}h3{font-size:1rem;margin:20px 0 8px}
label{display:block;font-size:.82rem;color:var(--mut);margin:10px 0 4px}
input,select,textarea{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--txt)}
textarea{min-height:90px;resize:vertical}textarea.big{min-height:160px}
button{font:inherit;padding:8px 14px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--txt);cursor:pointer;white-space:nowrap}
button.p{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}button.d{color:var(--ko)}button:disabled{opacity:.5}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>*{flex:1}.row>button{flex:0}
.item{padding:12px 14px;margin:8px 0}.item .t{font-weight:600}.meta{color:var(--mut);font-size:.8rem}
.item pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:8px 0 0}
.tag{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:99px;background:var(--bg);border:1px solid var(--bd);margin:2px 4px 0 0;cursor:pointer}
.acts{display:flex;gap:6px;margin-top:8px}.acts button{padding:4px 10px;font-size:.85rem}
a{color:var(--acc)}mark{background:#f6d365;color:#1d1d1b;border-radius:3px;padding:0 2px}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;background:var(--txt);color:var(--bg);display:none;z-index:9}
.empty{color:var(--mut);font-style:italic}progress{width:100%;margin-top:8px;display:none}
details summary{cursor:pointer;color:var(--acc);font-weight:600;margin:4px 0}
</style></head><body>
<header><h1 id="home">🧠 Mémoire</h1><form id="sf"><input id="sq" type="search" placeholder="Rechercher dans tous les projets…"><button class="p">Chercher</button></form><small>${escHtml(email)}</small></header>
<div class="wrap"><aside><button class="p" id="newp" style="width:100%">+ Nouveau projet</button><div id="plist"></div></aside><main id="main"></main></div>
<div id="toast"></div>
<script>
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STATUTS=["actif","en pause","termine","archive"],TYPES=["note","decision","fait","idee","resume","tache","evenement"],MAX=${MAX_BYTES};
const fmt=(n)=>n<1024?n+" o":n<1048576?Math.round(n/1024)+" Ko":(n/1048576).toFixed(1)+" Mo";
const day=(s)=>(s||"").slice(0,10);
let state={projets:[],cur:null};
function toast(m,ko){const t=$("#toast");t.textContent=m;t.style.background=ko?"var(--ko)":"";t.style.display="block";clearTimeout(t._h);t._h=setTimeout(()=>t.style.display="none",ko?5000:2200)}
async function api(method,path,body){const o={method,headers:{}};if(body instanceof FormData)o.body=body;else if(body!==undefined){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
const r=await fetch("/admin/api/"+path,o);let j;try{j=await r.json()}catch(_){j={ok:false,erreur:"Réponse inattendue ("+r.status+"). Session expirée ? Recharge la page."}}
if(!r.ok||j.ok===false){toast(j.erreur||"Erreur",true);throw new Error(j.erreur)}return j}
const opts=(list,cur)=>list.map((v)=>'<option'+(v===cur?" selected":"")+">"+esc(v)+"</option>").join("");
const projOpts=(cur)=>'<option value="">— aucun projet —</option>'+state.projets.map((p)=>'<option value="'+p.id+'"'+(p.id===cur?" selected":"")+">"+esc(p.name)+"</option>").join("");

async function loadProjets(){const j=await api("GET","projets");state.projets=j.projets;state.sans=j.sans_projet;renderList()}
function renderList(){const act=state.projets.filter((p)=>p.status!=="archive"),arc=state.projets.filter((p)=>p.status==="archive");
const li=(p)=>'<li data-id="'+p.id+'" class="'+(state.cur===p.id?"sel ":"")+(p.status==="archive"?"arch":"")+'"><span>'+esc(p.name)+'</span><span class="n">'+p.n_souvenirs+(p.n_fichiers?" · "+p.n_fichiers+" 📎":"")+"</span></li>";
let h="<h3>Projets</h3><ul>"+(act.map(li).join("")||'<li class="empty">Aucun</li>')+'</ul><h3>Autres</h3><ul><li data-id="0" class="'+(state.cur===0?"sel":"")+'"><span>Sans projet</span><span class="n">'+(state.sans?.n_souvenirs||0)+(state.sans?.n_fichiers?" · "+state.sans.n_fichiers+" 📎":"")+"</span></li></ul>";
if(arc.length)h+="<h3>Archivés</h3><ul>"+arc.map(li).join("")+"</ul>";$("#plist").innerHTML=h;
$$("#plist li[data-id]").forEach((l)=>l.onclick=()=>openProjet(Number(l.dataset.id)))}

function memForm(m,pid){m=m||{};return '<label>Titre</label><input name="titre" value="'+esc(m.title)+'" required><label>Contenu</label><textarea name="contenu" class="big" required>'+esc(m.content)+'</textarea>'+
'<div class="row"><div><label>Tags (séparés par des virgules)</label><input name="tags" value="'+esc((m.tags||[]).join(", "))+'"></div><div><label>Type</label><select name="type">'+opts(TYPES,m.kind||"note")+'</select></div><div><label>Projet</label><select name="projet_id">'+projOpts(pid)+"</select></div></div>"}
const memData=(f)=>({titre:f.titre.value,contenu:f.contenu.value,type:f.type.value,projet_id:f.projet_id.value?Number(f.projet_id.value):null,tags:f.tags.value.split(",").map((s)=>s.trim()).filter(Boolean)});

function memItem(s,pid){return '<div class="item" data-mid="'+s.id+'"><div class="t">'+esc(s.title)+'</div><div class="meta">#'+s.id+" · "+esc(s.kind)+" · modifié "+day(s.updated_at)+(s.source?" · "+esc(s.source):"")+"</div>"+
(s.tags.length?"<div>"+s.tags.map((t)=>'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+"</span>").join("")+"</div>":"")+
"<pre>"+esc(s.content)+'</pre><div class="acts"><button data-a="edit">Modifier</button><button data-a="del" class="d">Supprimer</button></div></div>'}

function fileItem(f){return '<div class="item" data-fid="'+esc(f.id)+'"><div class="row"><div><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'">'+esc(f.filename)+'</a> <span class="meta">'+fmt(f.size)+" · "+day(f.created_at)+(f.memory_id?" · souvenir #"+f.memory_id:"")+" · id "+esc(f.id)+"</span>"+
(f.description?'<div class="meta">'+esc(f.description)+"</div>":"")+'</div></div><div class="acts"><button data-a="fedit">Modifier</button><button data-a="fdel" class="d">Supprimer</button></div></div>'}

async function openProjet(pid){state.cur=pid;renderList();const j=await api("GET","projets/"+pid);const p=j.projet;
let h='<section class="card">';
if(p){h+='<h2>'+esc(p.name)+'</h2><form id="pf"><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(p.name)+'" required></div><div><label>Statut</label><select name="statut">'+opts(STATUTS,p.status)+'</select></div></div>'+
'<label>Description (résumé vivant du projet, lu en premier par Claude)</label><textarea name="description" class="big">'+esc(p.description)+'</textarea>'+
'<div class="acts"><button class="p">Enregistrer</button><button type="button" id="pdel" class="d">Supprimer le projet</button></div><div class="meta" style="margin-top:6px">Créé '+day(p.created_at)+" · dernière activité "+day(p.updated_at)+"</div></form>"}
else h+='<h2>Sans projet</h2><p class="meta">Souvenirs et fichiers rattachés à aucun projet.</p>';
h+='</section><section class="card"><details><summary>+ Ajouter un souvenir (texte)</summary><form id="mf">'+memForm(null,p?p.id:null)+'<div class="acts"><button class="p">Ajouter</button></div></form></details>'+
'<details><summary>+ Joindre des fichiers</summary><form id="ff"><label>Fichier(s) — '+(MAX/1048576)+' Mo max chacun</label><input type="file" name="fichier" multiple required><label>Description</label><input name="description" placeholder="Facultatif"><div class="acts"><button class="p">Envoyer</button></div><progress max="100" value="0"></progress></form></details></section>'+
'<section class="card"><h3 style="margin-top:0">Souvenirs ('+j.souvenirs.length+')</h3><div id="mems">'+(j.souvenirs.map((s)=>memItem(s,p?p.id:null)).join("")||'<p class="empty">Aucun souvenir.</p>')+"</div>"+
"<h3>Fichiers ("+j.fichiers.length+')</h3><div id="files">'+(j.fichiers.map(fileItem).join("")||'<p class="empty">Aucun fichier.</p>')+"</div></section>";
$("#main").innerHTML=h;const mems=Object.fromEntries(j.souvenirs.map((s)=>[s.id,s])),files=Object.fromEntries(j.fichiers.map((f)=>[f.id,f]));
if(p){$("#pf").onsubmit=async(e)=>{e.preventDefault();const f=e.target;await api("PATCH","projets/"+p.id,{nom:f.nom.value,statut:f.statut.value,description:f.description.value});toast("Projet enregistré");await loadProjets();openProjet(p.id)};
$("#pdel").onclick=async()=>{if(!confirm("Supprimer le projet « "+p.name+" » ?\\nSes souvenirs et fichiers sont conservés, sans projet."))return;await api("DELETE","projets/"+p.id);toast("Projet supprimé");await loadProjets();openProjet(0)}}
$("#mf").onsubmit=async(e)=>{e.preventDefault();await api("POST","souvenirs",memData(e.target));toast("Souvenir ajouté");await loadProjets();openProjet(pid)};
$("#ff").onsubmit=(e)=>{e.preventDefault();const f=e.target,fd=new FormData();const list=[...f.fichier.files];
for(const x of list)if(x.size>MAX)return toast("« "+x.name+" » dépasse "+(MAX/1048576)+" Mo",true);
list.forEach((x)=>fd.append("fichier",x));fd.append("description",f.description.value);if(pid)fd.append("projet_id",pid);
const pg=$("progress",f),bt=$("button",f);pg.style.display="block";bt.disabled=true;const x=new XMLHttpRequest();x.open("POST","/admin/api/fichiers");
x.upload.onprogress=(ev)=>ev.lengthComputable&&(pg.value=ev.loaded/ev.total*100);
x.onload=async()=>{bt.disabled=false;let r;try{r=JSON.parse(x.responseText)}catch(_){r={ok:false,erreur:"Réponse inattendue ("+x.status+")"}}
if(!r.ok)return toast(r.erreur,true);toast(r.fichiers.length+" fichier(s) envoyé(s)");await loadProjets();openProjet(pid)};
x.onerror=()=>{bt.disabled=false;toast("Erreur réseau",true)};x.send(fd)};
bindItems(mems,files,()=>openProjet(pid))}

function bindItems(mems,files,reload){
$$("#main [data-mid]").forEach((el)=>{const s=mems[el.dataset.mid];if(!s)return;
$('[data-a="edit"]',el)&&($('[data-a="edit"]',el).onclick=()=>{el.innerHTML='<form>'+memForm(s,s.project_id!==undefined?s.project_id:state.cur||null)+'<div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
$("form",el).onsubmit=async(e)=>{e.preventDefault();await api("PATCH","souvenirs/"+s.id,memData(e.target));toast("Souvenir modifié");await loadProjets();reload()};$('[data-a="cancel"]',el).onclick=reload});
$('[data-a="del"]',el)&&($('[data-a="del"]',el).onclick=async()=>{if(!confirm("Supprimer définitivement « "+s.title+" » ?"))return;await api("DELETE","souvenirs/"+s.id);toast("Souvenir supprimé");await loadProjets();reload()})});
$$("#main [data-fid]").forEach((el)=>{const f=files[el.dataset.fid];if(!f)return;
$('[data-a="fedit"]',el).onclick=()=>{el.innerHTML='<form><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(f.filename)+'"></div><div><label>Projet</label><select name="projet_id">'+projOpts(f.project_id!==undefined?f.project_id:state.cur||null)+'</select></div></div><label>Description</label><input name="description" value="'+esc(f.description)+'"><div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
$("form",el).onsubmit=async(e)=>{e.preventDefault();const t=e.target;await api("PATCH","fichiers/"+encodeURIComponent(f.id),{nom:t.nom.value,description:t.description.value,projet_id:t.projet_id.value?Number(t.projet_id.value):null});toast("Fichier modifié");await loadProjets();reload()};$('[data-a="cancel"]',el).onclick=reload};
$('[data-a="fdel"]',el).onclick=async()=>{if(!confirm("Supprimer définitivement « "+f.filename+" » ?"))return;await api("DELETE","fichiers/"+encodeURIComponent(f.id));toast("Fichier supprimé");await loadProjets();reload()}});
$$("#main .tag").forEach((t)=>t.onclick=()=>search("",t.dataset.tag))}

const hl=(s)=>esc(s).replace(/\\u0001/g,"<mark>").replace(/\\u0002/g,"</mark>");
async function search(q,tag){state.cur=null;renderList();const qs=new URLSearchParams();if(q)qs.set("q",q);if(tag)qs.set("tag",tag);
const j=await api("GET","recherche?"+qs);
let h='<section class="card"><h2>Recherche : '+esc(q||"")+(tag?' <span class="tag">'+esc(tag)+"</span>":"")+"</h2>";
if(j.projets.length)h+="<h3>Projets ("+j.projets.length+")</h3>"+j.projets.map((p)=>'<div class="item"><a href="#" data-p="'+p.id+'" class="t">'+esc(p.name)+'</a> <span class="meta">'+esc(p.status)+"</span>"+(p.description?'<div class="meta">'+esc(p.description.slice(0,200))+"</div>":"")+"</div>").join("");
h+="<h3>Souvenirs ("+j.souvenirs.length+")</h3>"+(j.souvenirs.map((s)=>'<div class="item"><div class="t">'+esc(s.title)+'</div><div class="meta">#'+s.id+" · "+esc(s.kind)+" · "+day(s.updated_at)+" · "+(s.project_id?'<a href="#" data-p="'+s.project_id+'">'+esc(s.projet)+"</a>":"sans projet")+"</div>"+
(s.tags.length?"<div>"+s.tags.map((t)=>'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+"</span>").join("")+"</div>":"")+"<pre>"+hl(s.extrait)+"</pre></div>").join("")||'<p class="empty">Aucun souvenir.</p>');
if(j.fichiers.length)h+="<h3>Fichiers ("+j.fichiers.length+")</h3>"+j.fichiers.map((f)=>'<div class="item"><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'">'+esc(f.filename)+'</a> <span class="meta">'+fmt(f.size)+" · "+(f.project_id?'<a href="#" data-p="'+f.project_id+'">'+esc(f.projet)+"</a>":"sans projet")+"</span>"+(f.description?'<div class="meta">'+esc(f.description)+"</div>":"")+"</div>").join("");
$("#main").innerHTML=h+"</section>";$$("#main [data-p]").forEach((a)=>a.onclick=(e)=>{e.preventDefault();openProjet(Number(a.dataset.p))});$$("#main .tag[data-tag]").forEach((t)=>t.onclick=()=>search("",t.dataset.tag))}

async function home(){state.cur=null;renderList();const t=await api("GET","tags");
$("#main").innerHTML='<section class="card"><h2>Bienvenue</h2><p>Choisis un projet à gauche, ou cherche dans toute la mémoire.</p><h3>Tags</h3><div>'+(t.tags.map((x)=>'<span class="tag" data-tag="'+esc(x.name)+'">'+esc(x.name)+" ("+x.n+")</span>").join("")||'<span class="empty">Aucun tag.</span>')+"</div></section>";
$$("#main .tag").forEach((x)=>x.onclick=()=>search("",x.dataset.tag))}

$("#sf").onsubmit=(e)=>{e.preventDefault();const q=$("#sq").value.trim();if(q)search(q)};
$("#home").onclick=home;
$("#newp").onclick=()=>{state.cur=null;renderList();$("#main").innerHTML='<section class="card"><h2>Nouveau projet</h2><form id="np"><label>Nom</label><input name="nom" required><label>Statut</label><select name="statut">'+opts(STATUTS,"actif")+'</select><label>Description</label><textarea name="description" class="big"></textarea><div class="acts"><button class="p">Créer</button></div></form></section>';
$("#np").onsubmit=async(e)=>{e.preventDefault();const f=e.target;const r=await api("POST","projets",{nom:f.nom.value,statut:f.statut.value,description:f.description.value});toast("Projet créé");await loadProjets();openProjet(r.id)}};
loadProjets().then(home).catch(()=>{});
</script></body></html>`;
}
