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
<header><h1 id="home">🧠 Mémoire</h1><form id="sf"><input id="sq" type="search" placeholder="Rechercher dans tous les projets…"><button class="p">Chercher</button></form><button id="nfichiers">Fichiers</button><button id="ngroupes">Groupes</button><button id="ntaches">Tâches</button><button id="ncles">Clés</button><small>${escHtml(email)}</small></header>
<div id="banner" style="display:none;padding:10px 16px;font-weight:600"></div>
<div class="wrap"><aside><button class="p" id="newp" style="width:100%">+ Nouveau projet</button><div id="plist"></div></aside><main id="main"></main></div>
<div id="toast"></div>
<script>
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STATUTS=["actif","en pause","termine","archive"],TYPES=["note","decision","fait","idee","resume","tache","evenement"],MAX=${MAX_BYTES};
const fmt=(n)=>n<1024?n+" o":n<1048576?Math.round(n/1024)+" Ko":(n/1048576).toFixed(1)+" Mo";
const day=(s)=>(s||"").slice(0,10);
let state={projets:[],sans:[],groupes:[],cur:null};
const gpath=(id)=>(state.groupes.find((g)=>g.id===id)||{}).chemin||"?";
function toast(m,ko){const t=$("#toast");t.textContent=m;t.style.background=ko?"var(--ko)":"";t.style.display="block";clearTimeout(t._h);t._h=setTimeout(()=>t.style.display="none",ko?5000:2200)}
async function api(method,path,body){const o={method,headers:{}};if(body instanceof FormData)o.body=body;else if(body!==undefined){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
const r=await fetch("/admin/api/"+path,o);let j;try{j=await r.json()}catch(_){j={ok:false,erreur:"Réponse inattendue ("+r.status+"). Session expirée ? Recharge la page."}}
if(!r.ok||j.ok===false){toast(j.erreur||"Erreur",true);throw new Error(j.erreur)}return j}
const opts=(list,cur)=>list.map((v)=>'<option'+(v===cur?" selected":"")+">"+esc(v)+"</option>").join("");
const projOpts=(cur)=>'<option value="">— aucun projet —</option>'+state.projets.map((p)=>'<option value="'+p.id+'"'+(p.id===cur?" selected":"")+">"+esc(p.name)+" ("+esc(gpath(p.group_id))+")</option>").join("");
const groupOpts=(cur,empty)=>(empty?'<option value="">'+esc(empty)+"</option>":"")+state.groupes.map((g)=>'<option value="'+g.id+'"'+(g.id===cur?" selected":"")+">"+esc(g.chemin)+"</option>").join("");

async function loadProjets(){const [g,j,tc]=await Promise.all([api("GET","groupes"),api("GET","projets"),api("GET","taches-config")]);state.tconf=tc;state.groupes=g.groupes;state.maxDepth=g.profondeur_max;state.projets=j.projets;state.sans=j.sans_projet;renderList()}
function renderList(){const act=state.projets.filter((p)=>p.status!=="archive"),arc=state.projets.filter((p)=>p.status==="archive");
const li=(p,lab)=>'<li data-k="p:'+p.id+'" class="'+(state.cur==="p:"+p.id?"sel ":"")+(p.status==="archive"?"arch":"")+'"><span>'+esc(lab||p.name)+'</span><span class="n">'+p.n_souvenirs+(p.n_fichiers?" · "+p.n_fichiers+" 📎":"")+"</span></li>";
let h="";for(const g of state.groupes){const ps=act.filter((p)=>p.group_id===g.id),o=state.sans.find((x)=>x.group_id===g.id);
h+='<h3 style="padding-left:'+(g.niveau-1)*12+'px" title="'+esc(g.chemin)+'">'+esc(g.nom)+'</h3><ul style="margin-left:'+(g.niveau-1)*12+'px">'+ps.map((p)=>li(p)).join("")+
(o?'<li data-k="o:'+g.id+'" class="'+(state.cur==="o:"+g.id?"sel":"")+'"><span><i>Sans projet</i></span><span class="n">'+o.n_souvenirs+(o.n_fichiers?" · "+o.n_fichiers+" 📎":"")+"</span></li>":"")+
(!ps.length&&!o?'<li class="empty">Vide</li>':"")+"</ul>"}
if(arc.length)h+="<h3>Archivés</h3><ul>"+arc.map((p)=>li(p,p.name+" — "+gpath(p.group_id))).join("")+"</ul>";$("#plist").innerHTML=h;
$$("#plist li[data-k]").forEach((l)=>l.onclick=()=>{const [t,id]=l.dataset.k.split(":");t==="p"?openProjet(Number(id)):openOrphans(Number(id))})}

function taskFields(t){t=t||{};const c=state.tconf||{niveaux:[],types:[]},dl=c.niveaux.find((l)=>l.is_default),dt=c.types.find((x)=>x.is_default);
const sel=(n,list,cur)=>'<select name="'+n+'">'+list.map((x)=>"<option"+(x.name===cur?" selected":"")+">"+esc(x.name)+"</option>").join("")+"</select>";
return '<fieldset data-task style="border:1px solid var(--bd);border-radius:8px;margin-top:10px;padding:4px 12px 10px"><legend class="meta">Tâche</legend><div class="row"><div><label>Date</label><input name="t_date" type="date" value="'+esc(t.date||"")+'"></div><div><label>Heure (facultative)</label><input name="t_heure" type="time" value="'+esc(t.heure||"")+'"></div><div><label>Criticité</label>'+sel("t_crit",c.niveaux,t.criticite||(dl&&dl.name))+"</div></div>"+
'<div class="row"><div><label>Type</label>'+sel("t_type",c.types,t.type||(dt&&dt.name))+'</div><div><label>Statut</label><select name="t_statut">'+Object.keys(TSTAT).map((k)=>'<option value="'+k+'"'+((t.statut||"a_faire")===k?" selected":"")+">"+TSTAT[k]+"</option>").join("")+'</select></div><div><label>Récurrence (ex. 1 mois)</label><input name="t_rec" value="'+esc(t.recurrence||"")+'"></div></div></fieldset>'}
function memForm(m,pid,gid){m=m||{};return '<label>Titre</label><input name="titre" value="'+esc(m.title)+'" required><label>Contenu</label><textarea name="contenu" class="big" required>'+esc(m.content)+'</textarea>'+
'<div class="row"><div><label>Tags (séparés par des virgules)</label><input name="tags" value="'+esc((m.tags||[]).join(", "))+'"></div><div><label>Type</label><select name="type">'+opts(TYPES,m.kind||"note")+'</select></div></div>'+
'<div class="row"><div><label>Projet</label><select name="projet_id">'+projOpts(pid)+'</select></div><div><label>Groupe (si aucun projet)</label><select name="groupe_id">'+groupOpts(gid)+"</select></div></div>"+taskFields(m.tache)}
const memData=(f)=>{const o={titre:f.titre.value,contenu:f.contenu.value,type:f.type.value,projet_id:f.projet_id.value?Number(f.projet_id.value):null,groupe_id:Number(f.groupe_id.value),tags:f.tags.value.split(",").map((s)=>s.trim()).filter(Boolean)};
if(o.type==="tache")o.tache={echeance:f.t_date.value?f.t_date.value+(f.t_heure.value?" "+f.t_heure.value:""):"",criticite:f.t_crit.value,type:f.t_type.value,statut:f.t_statut.value,recurrence:f.t_rec.value};return o};
// Les champs de tâche ne s'affichent que pour le type « tache ».
function bindTaskToggle(root){$$("form",root).concat(root.tagName==="FORM"?[root]:[]).forEach((f)=>{if(!f.type||!f.type.options)return;const fs=$("[data-task]",f);if(!fs)return;const upd=()=>fs.style.display=f.type.value==="tache"?"":"none";f.type.addEventListener("change",upd);upd()})}

const TSTAT={a_faire:"à faire",silencieux:"silencieuse",fait:"faite",annule:"annulée"};
const frDate=(d)=>d?d.slice(8,10)+"/"+d.slice(5,7)+"/"+d.slice(0,4):"";
function taskMeta(t){return '<div class="meta">⏰ '+(t.date?esc(frDate(t.date)+(t.heure?" "+t.heure:"")):"sans échéance")+" · "+esc(t.criticite)+" · "+esc(t.type)+" · "+esc(TSTAT[t.statut]||t.statut)+(t.recurrence?" · ↻ "+esc(t.recurrence):"")+(t.synchro?" · 📅 Google":"")+"</div>"}
function memItem(s){return '<div class="item" data-mid="'+s.id+'"><div class="t">'+esc(s.title)+'</div><div class="meta">#'+s.id+" · "+esc(s.kind)+" · modifié "+day(s.updated_at)+(s.source?" · "+esc(s.source):"")+"</div>"+(s.tache?taskMeta(s.tache):"")+
(s.tags.length?"<div>"+s.tags.map((t)=>'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+"</span>").join("")+"</div>":"")+
"<pre>"+esc(s.content)+'</pre><div class="acts"><button data-a="edit">Modifier</button><button data-a="del" class="d">Supprimer</button></div></div>'}

function fileItem(f){return '<div class="item" data-fid="'+esc(f.id)+'"><div class="row"><div><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'?voir" target="_blank" rel="noopener">'+esc(f.filename)+'</a> <a href="/admin/fichiers/'+encodeURIComponent(f.id)+'" title="Télécharger">⬇</a> <span class="meta">'+fmt(f.size)+" · "+day(f.created_at)+(f.memory_id?" · souvenir #"+f.memory_id:"")+" · id "+esc(f.id)+"</span>"+
(f.description?'<div class="meta">'+esc(f.description)+"</div>":"")+'</div></div><div class="acts"><button data-a="fedit">Modifier</button><button data-a="fdel" class="d">Supprimer</button></div></div>'}

const openProjet=(pid)=>openView("p:"+pid,"projets/"+pid);
const openOrphans=(gid)=>openView("o:"+gid,"projets/0?groupe="+gid);
async function openView(key,path){state.cur=key;renderList();const j=await api("GET",path);const p=j.projet,gid=j.groupe_id,reload=()=>openView(key,path);
let h='<section class="card">';
if(p){h+='<h2>'+esc(p.name)+' <span class="meta">'+esc(gpath(p.group_id))+'</span></h2><form id="pf"><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(p.name)+'" required></div><div><label>Statut</label><select name="statut">'+opts(STATUTS,p.status)+'</select></div><div><label>Groupe</label><select name="groupe_id">'+groupOpts(p.group_id)+'</select></div></div>'+
'<label>Description (résumé vivant du projet, lu en premier par Claude)</label><textarea name="description" class="big">'+esc(p.description)+'</textarea>'+
'<div class="acts"><button class="p">Enregistrer</button><button type="button" id="pdel" class="d">Supprimer le projet</button></div><div class="meta" style="margin-top:6px">Créé '+day(p.created_at)+" · dernière activité "+day(p.updated_at)+"</div></form>"}
else h+='<h2>Sans projet <span class="meta">'+esc(gpath(gid))+'</span></h2><p class="meta">Souvenirs et fichiers de ce groupe rattachés à aucun projet.</p>';
h+='</section><section class="card"><details><summary>+ Ajouter un souvenir (texte)</summary><form id="mf">'+memForm(null,p?p.id:null,gid)+'<div class="acts"><button class="p">Ajouter</button></div></form></details>'+
'<details><summary>+ Joindre des fichiers</summary><form id="ff"><label>Fichier(s) — '+(MAX/1048576)+' Mo max chacun</label><input type="file" name="fichier" multiple required><label>Description</label><input name="description" placeholder="Facultatif"><div class="acts"><button class="p">Envoyer</button></div><progress max="100" value="0"></progress></form></details></section>'+
'<section class="card"><h3 style="margin-top:0">Souvenirs ('+j.souvenirs.length+')</h3><div id="mems">'+(j.souvenirs.map(memItem).join("")||'<p class="empty">Aucun souvenir.</p>')+"</div>"+
"<h3>Fichiers ("+j.fichiers.length+')</h3><div id="files">'+(j.fichiers.map(fileItem).join("")||'<p class="empty">Aucun fichier.</p>')+"</div></section>";
$("#main").innerHTML=h;bindTaskToggle($("#main"));const mems=Object.fromEntries(j.souvenirs.map((s)=>[s.id,s])),files=Object.fromEntries(j.fichiers.map((f)=>[f.id,f]));
if(p){$("#pf").onsubmit=async(e)=>{e.preventDefault();const f=e.target,ng=Number(f.groupe_id.value);
if(ng!==p.group_id&&!confirm("Déplacer « "+p.name+" » vers "+gpath(ng)+" ?\\nSes souvenirs et fichiers suivent. Les clés qui n'ont pas accès à ce groupe ne le verront plus."))return;
await api("PATCH","projets/"+p.id,{nom:f.nom.value,statut:f.statut.value,description:f.description.value,groupe_id:ng});toast("Projet enregistré");await loadProjets();reload()};
$("#pdel").onclick=async()=>{if(!confirm("Supprimer le projet « "+p.name+" » ?\\nSes souvenirs et fichiers sont conservés, sans projet, dans le même groupe."))return;await api("DELETE","projets/"+p.id);toast("Projet supprimé");await loadProjets();openOrphans(p.group_id)}}
$("#mf").onsubmit=async(e)=>{e.preventDefault();await api("POST","souvenirs",memData(e.target));toast("Souvenir ajouté");await loadProjets();reload()};
$("#ff").onsubmit=(e)=>{e.preventDefault();const f=e.target,fd=new FormData();const list=[...f.fichier.files];
for(const x of list)if(x.size>MAX)return toast("« "+x.name+" » dépasse "+(MAX/1048576)+" Mo",true);
list.forEach((x)=>fd.append("fichier",x));fd.append("description",f.description.value);if(p)fd.append("projet_id",p.id);else fd.append("groupe_id",gid);
const pg=$("progress",f),bt=$("button",f);pg.style.display="block";bt.disabled=true;const x=new XMLHttpRequest();x.open("POST","/admin/api/fichiers");
x.upload.onprogress=(ev)=>ev.lengthComputable&&(pg.value=ev.loaded/ev.total*100);
x.onload=async()=>{bt.disabled=false;let r;try{r=JSON.parse(x.responseText)}catch(_){r={ok:false,erreur:"Réponse inattendue ("+x.status+")"}}
if(!r.ok)return toast(r.erreur,true);toast(r.fichiers.length+" fichier(s) envoyé(s)");await loadProjets();reload()};
x.onerror=()=>{bt.disabled=false;toast("Erreur réseau",true)};x.send(fd)};
bindItems(mems,files,reload)}

function bindItems(mems,files,reload){
$$("#main [data-mid]").forEach((el)=>{const s=mems[el.dataset.mid];if(!s)return;
$('[data-a="edit"]',el)&&($('[data-a="edit"]',el).onclick=()=>{el.innerHTML='<form>'+memForm(s,s.project_id,s.group_id)+'<div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
bindTaskToggle(el);$("form",el).onsubmit=async(e)=>{e.preventDefault();await api("PATCH","souvenirs/"+s.id,memData(e.target));toast("Souvenir modifié");await loadProjets();reload()};$('[data-a="cancel"]',el).onclick=reload});
$('[data-a="del"]',el)&&($('[data-a="del"]',el).onclick=async()=>{if(!confirm("Supprimer définitivement « "+s.title+" » ?"))return;await api("DELETE","souvenirs/"+s.id);toast("Souvenir supprimé");await loadProjets();reload()})});
$$("#main [data-fid]").forEach((el)=>{const f=files[el.dataset.fid];if(!f)return;
$('[data-a="fedit"]',el).onclick=()=>{el.innerHTML='<form><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(f.filename)+'"></div><div><label>Projet</label><select name="projet_id">'+projOpts(f.project_id)+'</select></div><div><label>Groupe (si aucun projet)</label><select name="groupe_id">'+groupOpts(f.group_id)+'</select></div></div><label>Description</label><input name="description" value="'+esc(f.description)+'"><div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
$("form",el).onsubmit=async(e)=>{e.preventDefault();const t=e.target;await api("PATCH","fichiers/"+encodeURIComponent(f.id),{nom:t.nom.value,description:t.description.value,projet_id:t.projet_id.value?Number(t.projet_id.value):null,groupe_id:Number(t.groupe_id.value)});toast("Fichier modifié");await loadProjets();reload()};$('[data-a="cancel"]',el).onclick=reload};
$('[data-a="fdel"]',el).onclick=async()=>{if(!confirm("Supprimer définitivement « "+f.filename+" » ?"))return;await api("DELETE","fichiers/"+encodeURIComponent(f.id));toast("Fichier supprimé");await loadProjets();reload()}});
$$("#main .tag").forEach((t)=>t.onclick=()=>search("",t.dataset.tag))}

const hl=(s)=>esc(s).replace(/\\u0001/g,"<mark>").replace(/\\u0002/g,"</mark>");
async function search(q,tag){state.cur=null;renderList();const qs=new URLSearchParams();if(q)qs.set("q",q);if(tag)qs.set("tag",tag);
const j=await api("GET","recherche?"+qs);
let h='<section class="card"><h2>Recherche : '+esc(q||"")+(tag?' <span class="tag">'+esc(tag)+"</span>":"")+"</h2>";
if(j.projets.length)h+="<h3>Projets ("+j.projets.length+")</h3>"+j.projets.map((p)=>'<div class="item"><a href="#" data-p="'+p.id+'" class="t">'+esc(p.name)+'</a> <span class="meta">'+esc(p.status)+" · "+esc(gpath(p.group_id))+"</span>"+(p.description?'<div class="meta">'+esc(p.description.slice(0,200))+"</div>":"")+"</div>").join("");
h+="<h3>Souvenirs ("+j.souvenirs.length+")</h3>"+(j.souvenirs.map((s)=>'<div class="item"><div class="t">'+esc(s.title)+'</div><div class="meta">#'+s.id+" · "+esc(s.kind)+" · "+day(s.updated_at)+" · "+esc(gpath(s.group_id))+" · "+(s.project_id?'<a href="#" data-p="'+s.project_id+'">'+esc(s.projet)+"</a>":'<a href="#" data-o="'+s.group_id+'">sans projet</a>')+"</div>"+
(s.tags.length?"<div>"+s.tags.map((t)=>'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+"</span>").join("")+"</div>":"")+"<pre>"+hl(s.extrait)+"</pre></div>").join("")||'<p class="empty">Aucun souvenir.</p>');
if(j.fichiers.length)h+="<h3>Fichiers ("+j.fichiers.length+")</h3>"+j.fichiers.map((f)=>'<div class="item"><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'">'+esc(f.filename)+'</a> <span class="meta">'+fmt(f.size)+" · "+esc(gpath(f.group_id))+" · "+(f.project_id?'<a href="#" data-p="'+f.project_id+'">'+esc(f.projet)+"</a>":'<a href="#" data-o="'+f.group_id+'">sans projet</a>')+"</span>"+(f.description?'<div class="meta">'+esc(f.description)+"</div>":"")+"</div>").join("");
$("#main").innerHTML=h+"</section>";$$("#main [data-p]").forEach((a)=>a.onclick=(e)=>{e.preventDefault();openProjet(Number(a.dataset.p))});$$("#main [data-o]").forEach((a)=>a.onclick=(e)=>{e.preventDefault();openOrphans(Number(a.dataset.o))});$$("#main .tag[data-tag]").forEach((t)=>t.onclick=()=>search("",t.dataset.tag))}

// --- ménage des fichiers
const KINDS={image:"Images",pdf:"PDF",doc:"Documents bureautiques",texte:"Texte et code",media:"Audio et vidéo",autre:"Autres"};
function kind(f){const m=f.mime||"",n=(f.filename||"").toLowerCase();if(m.startsWith("image/"))return"image";if(m==="application/pdf")return"pdf";
if(/word|excel|powerpoint|opendocument|officedocument|msword|rtf/.test(m)||/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/.test(n))return"doc";
if(m.startsWith("text/")||/json|xml|javascript/.test(m))return"texte";if(m.startsWith("audio/")||m.startsWith("video/"))return"media";return"autre"}
let fstate={tri:"taille",ordre:"desc",q:"",groupe:"",projet:"",type:"",sel:new Set()};
async function fichiersPage(){state.cur=null;renderList();const j=await api("GET","fichiers");const all=j.fichiers;fstate.sel=new Set([...fstate.sel].filter((id)=>all.some((f)=>f.id===id)));
const sub=(gid)=>{const out=new Set([gid]);let grew=true;while(grew){grew=false;for(const g of state.groupes)if(out.has(g.parent_id)&&!out.has(g.id)){out.add(g.id);grew=true}}return out};
const total=all.reduce((n,f)=>n+f.size,0),inD1=all.filter((f)=>f.storage!=="r2");
$("#main").innerHTML='<section class="card"><h2>Fichiers</h2><p class="meta">'+all.length+" fichier(s), "+fmt(total)+" au total"+(inD1.length?" · <b>"+inD1.length+" encore dans D1</b> ("+fmt(inD1.reduce((n,f)=>n+f.size,0))+") : lance le workflow « Migrer les fichiers vers R2 »":" · tous dans R2")+"</p>"+
'<div class="row"><div><label>Recherche (nom, description)</label><input id="fq" type="search" value="'+esc(fstate.q)+'"></div><div><label>Groupe</label><select id="fg">'+groupOpts(fstate.groupe?Number(fstate.groupe):null,"Tous les groupes")+'</select></div></div>'+
'<div class="row"><div><label>Projet</label><select id="fp"><option value="">Tous les projets</option><option value="0"'+(fstate.projet==="0"?" selected":"")+'>— sans projet —</option>'+state.projets.map((p)=>'<option value="'+p.id+'"'+(String(p.id)===fstate.projet?" selected":"")+">"+esc(p.name)+"</option>").join("")+'</select></div><div><label>Type</label><select id="ft"><option value="">Tous les types</option>'+Object.entries(KINDS).map(([k,v])=>'<option value="'+k+'"'+(fstate.type===k?" selected":"")+">"+v+"</option>").join("")+'</select></div><div><label>Tri</label><select id="fs">'+[["taille","Taille"],["date","Date"],["nom","Nom"]].map(([k,v])=>'<option value="'+k+'"'+(fstate.tri===k?" selected":"")+">"+v+"</option>").join("")+'</select></div><div><label>Ordre</label><select id="fo"><option value="desc"'+(fstate.ordre==="desc"?" selected":"")+'>Décroissant</option><option value="asc"'+(fstate.ordre==="asc"?" selected":"")+">Croissant</option></select></div></div>"+
'<div class="acts" style="margin-top:12px;align-items:center"><button id="fdelsel" class="d">Supprimer la sélection</button><span class="meta" id="fsum"></span></div></section><section class="card" id="flist"></section>';
const render=()=>{const q=fstate.q.trim().toLowerCase(),gs=fstate.groupe?sub(Number(fstate.groupe)):null;
let list=all.filter((f)=>(!q||(f.filename+" "+(f.description||"")).toLowerCase().includes(q))&&(!gs||gs.has(f.group_id))&&(fstate.projet===""||(fstate.projet==="0"?!f.project_id:String(f.project_id)===fstate.projet))&&(!fstate.type||kind(f)===fstate.type));
const cmp={taille:(a,b)=>a.size-b.size,date:(a,b)=>a.created_at.localeCompare(b.created_at),nom:(a,b)=>a.filename.localeCompare(b.filename,"fr")}[fstate.tri];
list.sort((a,b)=>fstate.ordre==="asc"?cmp(a,b):cmp(b,a));
const shown=list.reduce((n,f)=>n+f.size,0),selected=all.filter((f)=>fstate.sel.has(f.id));
$("#fsum").textContent=list.length+" affiché(s) ("+fmt(shown)+") · "+selected.length+" sélectionné(s) ("+fmt(selected.reduce((n,f)=>n+f.size,0))+")";
$("#fdelsel").disabled=!selected.length;
$("#flist").innerHTML=list.length?'<table style="width:100%;border-collapse:collapse"><tr><th><input type="checkbox" id="fall" title="Tout sélectionner"'+(list.every((f)=>fstate.sel.has(f.id))?" checked":"")+'></th><th align="left">Nom</th><th align="right">Taille</th><th align="left">Type</th><th align="left">Rangement</th><th align="left">Ajouté</th><th></th></tr>'+
list.map((f)=>'<tr data-fid="'+esc(f.id)+'" style="border-top:1px solid var(--bd)"><td><input type="checkbox" data-sel'+(fstate.sel.has(f.id)?" checked":"")+'></td><td style="padding:6px 4px"><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'?voir" target="_blank" rel="noopener">'+esc(f.filename)+"</a>"+(f.description?'<div class="meta">'+esc(f.description.slice(0,120))+(f.description.length>120?"…":"")+"</div>":"")+'</td><td align="right" style="white-space:nowrap"><b>'+fmt(f.size)+'</b></td><td class="meta">'+KINDS[kind(f)]+(f.storage!=="r2"?" · D1":"")+'</td><td class="meta">'+esc(gpath(f.group_id))+(f.projet?" › "+esc(f.projet):"")+(f.memory_id?" · souvenir #"+f.memory_id:"")+'</td><td class="meta" style="white-space:nowrap">'+day(f.created_at)+'</td><td style="white-space:nowrap"><a href="/admin/fichiers/'+encodeURIComponent(f.id)+'" title="Télécharger">⬇</a> <button data-a="del" class="d" style="padding:2px 8px">Supprimer</button></td></tr>').join("")+"</table>":'<p class="empty">Aucun fichier ne correspond.</p>';
$$("#flist [data-sel]").forEach((c)=>c.onchange=()=>{const id=c.closest("tr").dataset.fid;c.checked?fstate.sel.add(id):fstate.sel.delete(id);render()});
$("#fall")&&($("#fall").onchange=(e)=>{list.forEach((f)=>e.target.checked?fstate.sel.add(f.id):fstate.sel.delete(f.id));render()});
$$('#flist [data-a="del"]').forEach((b)=>b.onclick=async()=>{const f=all.find((x)=>x.id===b.closest("tr").dataset.fid);if(!confirm("Supprimer définitivement « "+f.filename+" » ("+fmt(f.size)+") ?"))return;await api("DELETE","fichiers/"+encodeURIComponent(f.id));fstate.sel.delete(f.id);toast("Fichier supprimé ("+fmt(f.size)+" libérés)");await loadProjets();fichiersPage()})};
$("#fq").oninput=(e)=>{fstate.q=e.target.value;render()};
$("#fg").onchange=(e)=>{fstate.groupe=e.target.value;render()};$("#fp").onchange=(e)=>{fstate.projet=e.target.value;render()};$("#ft").onchange=(e)=>{fstate.type=e.target.value;render()};
$("#fs").onchange=(e)=>{fstate.tri=e.target.value;render()};$("#fo").onchange=(e)=>{fstate.ordre=e.target.value;render()};
$("#fdelsel").onclick=async()=>{const ids=[...fstate.sel],size=all.filter((f)=>fstate.sel.has(f.id)).reduce((n,f)=>n+f.size,0);if(!ids.length)return;
if(!confirm("Supprimer définitivement "+ids.length+" fichier(s) ("+fmt(size)+") ?\\nIrréversible."))return;const r=await api("POST","fichiers/supprimer",{ids});fstate.sel.clear();toast(r.supprimes+" fichier(s) supprimé(s), "+fmt(r.octets)+" libérés");await loadProjets();fichiersPage()};
render()}

// --- groupes
function groupesPage(){state.cur=null;renderList();const G=state.groupes;
const parents=(self)=>'<option value="">— racine —</option>'+G.filter((g)=>g.niveau<state.maxDepth&&(!self||!(g.chemin===self.chemin||g.chemin.startsWith(self.chemin+" › ")))).map((g)=>'<option value="'+g.id+'"'+(self&&self.parent_id===g.id?" selected":"")+">"+esc(g.chemin)+"</option>").join("");
let h='<section class="card"><h2>Groupes</h2><p class="meta">Arbre de '+state.maxDepth+' niveaux maximum. Chaque projet appartient à un groupe ; les clés d\\'accès donnent des droits par groupe, hérités par les sous-groupes.</p>'+
G.map((g)=>'<div class="item" data-gid="'+g.id+'" style="margin-left:'+(g.niveau-1)*20+'px"><div class="t">'+esc(g.nom)+' <span class="meta">'+esc(g.chemin)+'</span></div><div class="meta">'+g.n_projets+" projet(s) · "+g.n_souvenirs+" souvenir(s) · "+g.n_fichiers+" fichier(s)"+(g.n_enfants?" · "+g.n_enfants+" sous-groupe(s)":"")+"</div>"+(g.description?'<div class="meta">'+esc(g.description)+"</div>":"")+
'<div class="acts"><button data-a="gedit">Modifier</button><button data-a="gdel" class="d">Supprimer</button></div></div>').join("")+
'</section><section class="card"><h3 style="margin-top:0">Nouveau groupe</h3><form id="gf"><div class="row"><div><label>Nom</label><input name="nom" required></div><div><label>Sous</label><select name="parent_id">'+parents(null)+'</select></div></div><label>Description</label><input name="description" placeholder="Facultatif"><div class="acts"><button class="p">Créer</button></div></form></section>';
$("#main").innerHTML=h;
$("#gf").onsubmit=async(e)=>{e.preventDefault();const f=e.target;await api("POST","groupes",{nom:f.nom.value,parent_id:f.parent_id.value?Number(f.parent_id.value):null,description:f.description.value});toast("Groupe créé");await loadProjets();groupesPage()};
$$("#main [data-gid]").forEach((el)=>{const g=G.find((x)=>x.id===Number(el.dataset.gid));
$('[data-a="gedit"]',el).onclick=()=>{el.innerHTML='<form><div class="row"><div><label>Nom</label><input name="nom" value="'+esc(g.nom)+'" required></div><div><label>Sous</label><select name="parent_id">'+parents(g)+'</select></div></div><label>Description</label><input name="description" value="'+esc(g.description)+'"><div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';
$("form",el).onsubmit=async(e)=>{e.preventDefault();const f=e.target;await api("PATCH","groupes/"+g.id,{nom:f.nom.value,parent_id:f.parent_id.value?Number(f.parent_id.value):null,description:f.description.value});toast("Groupe modifié");await loadProjets();groupesPage()};$('[data-a="cancel"]',el).onclick=groupesPage};
$('[data-a="gdel"]',el).onclick=async()=>{if(!confirm("Supprimer le groupe « "+g.chemin+" » ?"))return;await api("DELETE","groupes/"+g.id);toast("Groupe supprimé");await loadProjets();groupesPage()}})}

// --- clés d'accès
const RIGHTS={rw:"lecture-écriture",ro:"lecture seule",none:"aucun accès"};
function effective(rules){const out={};for(const g of state.groupes){let r="none";const chain=[];for(let x=g;x;x=state.groupes.find((y)=>y.id===x.parent_id))chain.push(x.id);for(const id of chain)if(rules[id]){r=rules[id];break}out[g.id]=r}return out}
function rulesEditor(rules){return '<table style="width:100%;border-collapse:collapse"><tr><th align="left">Groupe</th><th align="left">Règle</th><th align="left">Droit effectif</th></tr>'+
state.groupes.map((g)=>'<tr><td style="padding:4px 0 4px '+(g.niveau-1)*16+'px">'+esc(g.nom)+'</td><td><select data-rule="'+g.id+'"><option value="">'+(g.parent_id?"hérité":"— (aucun accès)")+"</option>"+["rw","ro","none"].map((r)=>'<option value="'+r+'"'+(rules[g.id]===r?" selected":"")+">"+RIGHTS[r]+"</option>").join("")+'</select></td><td class="meta" data-eff="'+g.id+'"></td></tr>').join("")+"</table>"}
function bindRules(root){const upd=()=>{const r=readRules(root),e=effective(r);$$("[data-eff]",root).forEach((td)=>td.textContent=RIGHTS[e[td.dataset.eff]])};$$("[data-rule]",root).forEach((s)=>s.onchange=upd);upd()}
const readRules=(root)=>Object.fromEntries($$("[data-rule]",root).filter((s)=>s.value).map((s)=>[s.dataset.rule,s.value]));
function keyForm(k){k=k||{regles:{}};return '<label>Nom (ex. « Claude perso »)</label><input name="nom" value="'+esc(k.name||"")+'" required><label>Groupe par défaut (souvenirs sans projet ; doit être en lecture-écriture)</label><select name="defaut">'+groupOpts(k.default_group_id)+'</select><label style="display:flex;gap:8px;align-items:center;color:var(--txt)"><input type="checkbox" name="rappels" style="width:auto"'+(k.show_reminders===0?"":" checked")+'> Affiche les rappels de tâches en début de conversation</label><label>Droits</label>'+rulesEditor(k.regles)}
async function clesPage(created){state.cur=null;renderList();const j=await api("GET","cles");
let h=created?'<section class="card" style="border-color:var(--acc)"><h2>Clé créée</h2><p>Copie cette URL dans le connecteur du compte Claude concerné. <b>Elle ne sera plus jamais affichée.</b></p><input readonly value="'+esc(created.url)+'" onclick="this.select()"></section>':"";
h+='<section class="card"><h2>Clés d\\'accès</h2><p class="meta">Une clé par compte Claude. L\\'URL du connecteur est <code>'+esc(location.origin)+'/&lt;clé&gt;/mcp</code>. Clé maîtresse (MEMORY_SECRET, accès à tout) : <b>'+(j.cle_maitresse_active?"active":"désactivée")+"</b>"+(j.cle_maitresse_active?" — mets MASTER_KEY_ENABLED à « false » une fois tes comptes passés sur leurs propres clés.":"")+"</p>"+
(j.cles.map((k)=>{const e=effective(k.regles),vis=state.groupes.filter((g)=>e[g.id]!=="none").map((g)=>esc(g.chemin)+(e[g.id]==="ro"?" (lecture)":""));
return '<div class="item" data-kid="'+k.id+'"'+(k.revoked_at?' style="opacity:.55"':"")+'><div class="t">'+esc(k.name)+(k.revoked_at?" — révoquée le "+day(k.revoked_at):"")+'</div><div class="meta">Défaut : '+esc(gpath(k.default_group_id))+" · créée "+day(k.created_at)+" · dernière utilisation "+(k.last_used_at?day(k.last_used_at):"jamais")+(k.show_reminders===0?" · sans rappels":"")+'</div><div class="meta">Accès : '+(vis.join(", ")||"aucun")+"</div>"+
(k.revoked_at?"":'<div class="acts"><button data-a="kedit">Modifier</button><button data-a="kdel" class="d">Révoquer</button></div>')+"</div>"}).join("")||'<p class="empty">Aucune clé.</p>')+
'</section><section class="card"><h3 style="margin-top:0">Nouvelle clé</h3><form id="kf">'+keyForm(null)+'<div class="acts"><button class="p">Créer la clé</button></div></form></section>';
$("#main").innerHTML=h;bindRules($("#kf"));
$("#kf").onsubmit=async(e)=>{e.preventDefault();const f=e.target;const r=await api("POST","cles",{nom:f.nom.value,groupe_defaut_id:Number(f.defaut.value),rappels:f.rappels.checked,regles:readRules(f)});toast("Clé créée");clesPage(r)};
$$("#main [data-kid]").forEach((el)=>{const k=j.cles.find((x)=>x.id===Number(el.dataset.kid));if(k.revoked_at)return;
$('[data-a="kedit"]',el).onclick=()=>{el.innerHTML='<form>'+keyForm(k)+'<div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="cancel">Annuler</button></div></form>';const f=$("form",el);bindRules(f);
f.onsubmit=async(e)=>{e.preventDefault();await api("PATCH","cles/"+k.id,{nom:f.nom.value,groupe_defaut_id:Number(f.defaut.value),rappels:f.rappels.checked,regles:readRules(f)});toast("Clé modifiée");clesPage()};$('[data-a="cancel"]',el).onclick=()=>clesPage()};
$('[data-a="kdel"]',el).onclick=async()=>{if(!confirm("Révoquer la clé « "+k.name+" » ?\\nLe connecteur qui l'utilise cessera immédiatement de fonctionner."))return;await api("DELETE","cles/"+k.id);toast("Clé révoquée");clesPage()}})}

// --- tâches : types, niveaux de criticité, réglages
const ALERT_LAB={aucune:"Aucune",notification:"Notification",alarme:"Alarme"};
function confRow(kind,x,j){const lv=kind==="niveaux";x=x||{};
const f=(n,lab,v,t,extra)=>'<div><label>'+lab+'</label><input name="'+n+'" type="'+(t||"text")+'" value="'+esc(v??"")+'"'+(extra||"")+"></div>";
return '<form class="item" data-kind="'+kind+'" data-id="'+(x.id||"")+'"><div class="row">'+f("nom","Nom",x.name)+f("position","Ordre",x.position??0,"number",' min="0" style="max-width:90px"')+
(lv?f("marqueur","Marqueur",x.marker,"text",' maxlength="4" style="max-width:90px"')+f("horizon_jours","Visible (jours avant)",x.horizon_days??0,"number",' min="0"'):
'<div><label>Synchro</label><select name="synchro"><option value="">Aucune</option><option value="google"'+(x.sync==="google"?" selected":"")+">Google Agenda</option></select></div>")+"</div>"+
(lv?'<div class="row"><div><label>Alerte</label><select name="alerte">'+j.alertes.map((a)=>'<option value="'+a+'"'+((x.alert||"aucune")===a?" selected":"")+">"+ALERT_LAB[a]+"</option>").join("")+"</select></div>"+f("plage_debut","Plage : début",x.alert_from||"07:00","time")+f("plage_fin","Plage : fin (24:00 = minuit)",x.alert_to||"24:00","text",' placeholder="HH:MM"')+f("relance_minutes","Relance (min, 0 = jamais)",x.repeat_minutes??0,"number",' min="0"')+"</div>":"")+
'<label style="display:flex;gap:8px;align-items:center;color:var(--txt)"><input type="checkbox" name="par_defaut" style="width:auto"'+(x.is_default?" checked":"")+"> Par défaut</label>"+
'<div class="acts"><button class="p">'+(x.id?"Enregistrer":"Ajouter")+"</button>"+(x.id?'<button type="button" class="d" data-a="del">Supprimer</button><span class="meta">'+x.n_taches+" tâche(s)</span>":"")+"</div></form>"}
const confData=(f)=>{const o={nom:f.nom.value,position:Number(f.position.value),par_defaut:f.par_defaut.checked};
if(f.dataset.kind==="niveaux")Object.assign(o,{marqueur:f.marqueur.value,horizon_jours:Number(f.horizon_jours.value),alerte:f.alerte.value,plage_debut:f.plage_debut.value,plage_fin:f.plage_fin.value,relance_minutes:Number(f.relance_minutes.value)});else o.synchro=f.synchro.value;return o};
async function tachesPage(){state.cur=null;renderList();const j=await api("GET","taches-config");
const sec=(kind,title,list,help)=>'<section class="card"><h2>'+title+'</h2><p class="meta">'+help+"</p>"+list.map((x)=>confRow(kind,x,j)).join("")+"<h3>Ajouter</h3>"+confRow(kind,null,j)+"</section>";
$("#main").innerHTML=sec("niveaux","Niveaux de criticité",j.niveaux,"Ordre 1 = le plus critique. « Visible » : combien de jours avant l'échéance la tâche apparaît dans les rappels de début de conversation. Alerte : notification ou alarme ntfy, envoyée seulement dans la plage horaire (sinon au début de la suivante), puis relancée toutes les N minutes tant qu'elle n'est ni « Vu » ni faite (0 = jamais).")+
sec("types-taches","Types de tâche",j.types,"Le type décide de la synchronisation (Google Agenda pour les rendez-vous).")+
'<section class="card"><h2>Réglages</h2><form id="regf"><label>Rappels affichés au maximum en début de conversation</label><input name="rappels_max" type="number" min="1" max="50" value="'+esc(j.reglages.rappels_max)+'" style="max-width:120px">'+
'<label>Heure des alertes pour les tâches sans heure</label><input name="alerte_matin" type="time" value="'+esc(j.reglages.alerte_matin)+'" style="max-width:140px">'+
'<label>Choix du bouton « Repousser » : une ligne « Libellé=règle ». Règles : +1h, +30m (à partir de maintenant), 18:00 (prochaine fois qu\\'il est 18 h), +1j, +7j 08:00 (dans N jours)</label><textarea name="reports">'+esc(j.reglages.reports)+'</textarea>'+
'<div class="acts"><button class="p">Enregistrer</button></div></form></section>';
$("#main").insertAdjacentHTML("beforeend",'<section class="card" id="gsec"><h2>Google Agenda</h2><div class="empty">Chargement…</div></section>');googleSection(j);
$("#regf").onsubmit=async(e)=>{e.preventDefault();const f=e.target;await api("PATCH","reglages",{rappels_max:Number(f.rappels_max.value),alerte_matin:f.alerte_matin.value,reports:f.reports.value});toast("Réglages enregistrés")};
$$("#main form[data-kind]").forEach((f)=>{const kind=f.dataset.kind,id=f.dataset.id;
f.onsubmit=async(e)=>{e.preventDefault();await api(id?"PATCH":"POST",kind+(id?"/"+id:""),confData(f));toast(id?"Enregistré":"Ajouté");tachesPage()};
const del=$('[data-a="del"]',f);if(del)del.onclick=async()=>{const list=kind==="niveaux"?j.niveaux:j.types,x=list.find((y)=>y.id===Number(id)),others=list.filter((y)=>y.id!==x.id);
if(!others.length){toast("Il en faut au moins un.",true);return}let vers="";
if(x.n_taches||x.is_default){const c=prompt((x.n_taches?x.n_taches+" tâche(s) utilisent « "+x.name+" ». ":"")+"Vers quoi basculer ? Tape le nom :\\n"+others.map((y)=>"- "+y.name).join("\\n"));if(c===null)return;
const t=others.find((y)=>y.name.toLowerCase()===c.trim().toLowerCase());if(!t){toast("Nom inconnu.",true);return}vers="?vers="+t.id}
else if(!confirm("Supprimer « "+x.name+" » ?"))return;
const r=await api("DELETE",kind+"/"+id+vers);toast("Supprimé"+(r.basculees?" ("+r.basculees+" tâche(s) basculée(s))":""));tachesPage()}})}

// --- Google Agenda : connexion, agenda dédié, rangement des RDV créés dans Google
async function googleSection(conf){const g=await api("GET","google"),el=$("#gsec");
if(!g.configure){el.innerHTML="<h2>Google Agenda</h2><p class='meta'>Non configuré : ajoute la variable GOOGLE_CLIENT_ID et le secret GOOGLE_CLIENT_SECRET sur le Worker.</p>";return}
if(!g.connecte){el.innerHTML="<h2>Google Agenda</h2><p>Les tâches de type à synchro « Google Agenda » (rendez-vous) seront synchronisées dans les deux sens, toutes les 15 minutes.</p>"+(g.erreur?'<p style="color:var(--ko)">'+esc(g.erreur)+"</p>":"")+'<div class="acts"><a href="/admin/google/connect"><button class="p">Connecter Google</button></a></div>';return}
let ag=[];try{ag=(await api("GET","google/agendas")).agendas}catch(_){}
const lv=conf.niveaux;
el.innerHTML="<h2>Google Agenda</h2><p class='meta'>Connecté. Dernière synchro : "+(g.derniere_synchro?esc(g.derniere_synchro.slice(0,16).replace("T"," "))+" UTC":"jamais")+"</p>"+(g.erreur?'<p style="color:var(--ko)">'+esc(g.erreur)+"</p>":"")+
'<form id="gf"><label>Agenda dédié</label><select name="agenda"><option value="">— choisir —</option>'+ag.map((a)=>'<option value="'+esc(a.id)+'"'+(a.id===g.agenda_id?" selected":"")+">"+esc(a.nom)+(a.principal?" (principal)":"")+"</option>").join("")+(g.agenda_id&&!ag.some((a)=>a.id===g.agenda_id)?'<option value="'+esc(g.agenda_id)+'" selected>'+esc(g.agenda_nom||g.agenda_id)+"</option>":"")+"</select>"+
'<p class="meta">RDV créés directement dans Google :</p><div class="row"><div><label>Groupe</label><select name="groupe_id">'+groupOpts(g.groupe_id,"— groupe par défaut —")+'</select></div><div><label>Projet</label><select name="projet_id">'+projOpts(g.projet_id)+'</select></div><div><label>Criticité</label><select name="niveau_id"><option value="">— par défaut —</option>'+lv.map((l)=>'<option value="'+l.id+'"'+(l.id===g.niveau_id?" selected":"")+">"+esc(l.name)+"</option>").join("")+"</select></div></div>"+
'<label>Durée des RDV envoyés à Google (minutes)</label><input name="duree" type="number" min="5" max="1440" value="'+esc(g.duree_minutes)+'" style="max-width:120px">'+
'<div class="acts"><button class="p">Enregistrer</button><button type="button" data-a="gsync">Synchroniser maintenant</button><button type="button" class="d" data-a="gdisc">Déconnecter</button></div></form>';
const f=$("#gf");f.onsubmit=async(e)=>{e.preventDefault();const o=f.agenda.selectedOptions[0];
if(g.agenda_id&&f.agenda.value!==g.agenda_id&&!confirm("Changer d'agenda ? Les rendez-vous ouverts y seront recréés ; l'ancien agenda n'est pas vidé."))return;
await api("PATCH","google",{agenda_id:f.agenda.value,agenda_nom:o?o.textContent:"",groupe_id:f.groupe_id.value?Number(f.groupe_id.value):null,projet_id:f.projet_id.value?Number(f.projet_id.value):null,niveau_id:f.niveau_id.value?Number(f.niveau_id.value):null,duree_minutes:Number(f.duree.value)});toast("Enregistré");googleSection(conf)};
$('[data-a="gsync"]',f).onclick=async()=>{const r=await api("POST","google/synchro");toast("Synchro : "+r.pulled+" reçu(s), "+r.pushed+" envoyé(s)");googleSection(conf)};
$('[data-a="gdisc"]',f).onclick=async()=>{if(!confirm("Déconnecter Google ? La synchro s'arrête ; rien n'est supprimé."))return;await api("DELETE","google");toast("Déconnecté");googleSection(conf)}}

// --- consommation (garde-fous) et sauvegardes
const nf=(n)=>Number(n).toLocaleString("fr-FR",{maximumFractionDigits:2});
const PER={day:"aujourd'hui",month:"ce mois-ci"};
function banner(c){const b=$("#banner");let m="",bg="";
if(c.bloque.length){m="⛔ Quota atteint ("+c.metriques.filter((r)=>c.bloque.includes(r.metric)).map((r)=>r.label).join(", ")+") : les écritures et le connecteur sont bloqués jusqu'à la remise à zéro.";bg="var(--ko)"}
else if(c.metriques.some((r)=>r.ratio>=0.8)){m="⚠️ Consommation au-delà de 80 % d'un seuil : "+c.metriques.filter((r)=>r.ratio>=0.8).map((r)=>r.label+" "+Math.round(r.ratio*100)+" %").join(", ");bg="#b26a00"}
else if(!c.configure)m="⚠️ Garde-fous inactifs : configure CF_ACCOUNT_ID et CF_API_TOKEN sur le Worker.",bg="#b26a00";
else if(c.erreur)m="⚠️ Consommation non vérifiée"+(c.verifie_le?" depuis "+c.verifie_le.slice(11,16)+" UTC":"")+" : "+c.erreur,bg="#b26a00";
b.textContent=m;b.style.display=m?"block":"none";b.style.background=bg;b.style.color="#fff"}
function consoHtml(c){return '<section class="card"><h2>Consommation</h2><p class="meta">'+(c.configure?(c.verifie_le?"Vérifiée le "+c.verifie_le.slice(0,16).replace("T"," ")+" UTC (rafraîchie toutes les 5 min).":"Pas encore vérifiée."):"API Analytics non configurée : seule la taille de la base est suivie.")+" Seuils réglables par variables d'environnement.</p>"+
'<table style="width:100%;border-collapse:collapse"><tr><th align="left">Métrique</th><th align="right">Consommé</th><th align="right">Seuil</th><th align="right">Limite gratuite</th><th align="right">%</th></tr>'+
c.metriques.map((r)=>'<tr style="'+(r.ratio>=1?"color:var(--ko);font-weight:600":r.ratio>=0.8?"color:#b26a00;font-weight:600":"")+'"><td>'+esc(r.label)+(r.period?' <span class="meta">('+PER[r.period]+")</span>":"")+'</td><td align="right">'+nf(r.value)+esc(r.unit)+'</td><td align="right">'+nf(r.limit)+esc(r.unit)+'</td><td align="right" class="meta">'+nf(r.real)+esc(r.unit)+'</td><td align="right">'+Math.round(r.ratio*100)+" %</td></tr>").join("")+"</table>"+
"<h3>Sauvegardes</h3>"+(c.sauvegardes===null?'<p class="meta">Bucket R2 non lié, ou consultation suspendue (quota atteint).</p>':c.sauvegardes.length?c.sauvegardes.map((s)=>'<div class="item"><a href="/admin/sauvegardes/'+encodeURIComponent(s.nom)+'">'+esc(s.nom)+'</a> <span class="meta">'+fmt(s.taille)+" · "+esc(s.date.slice(0,16).replace("T"," "))+" UTC</span></div>").join(""):'<p class="empty">Aucune sauvegarde pour l\\'instant.</p>')+"</section>"}
async function home(){state.cur=null;renderList();const [t,c]=await Promise.all([api("GET","tags"),api("GET","conso")]);banner(c);
$("#main").innerHTML='<section class="card"><h2>Bienvenue</h2><p>Choisis un projet à gauche, ou cherche dans toute la mémoire.</p><h3>Tags</h3><div>'+(t.tags.map((x)=>'<span class="tag" data-tag="'+esc(x.name)+'">'+esc(x.name)+" ("+x.n+")</span>").join("")||'<span class="empty">Aucun tag.</span>')+"</div></section>"+consoHtml(c);
$$("#main .tag").forEach((x)=>x.onclick=()=>search("",x.dataset.tag))}

$("#sf").onsubmit=(e)=>{e.preventDefault();const q=$("#sq").value.trim();if(q)search(q)};
$("#home").onclick=home;$("#nfichiers").onclick=()=>fichiersPage();$("#ngroupes").onclick=groupesPage;$("#ncles").onclick=()=>clesPage();$("#ntaches").onclick=tachesPage;
$("#newp").onclick=()=>{state.cur=null;renderList();$("#main").innerHTML='<section class="card"><h2>Nouveau projet</h2><form id="np"><label>Nom</label><input name="nom" required><div class="row"><div><label>Groupe</label><select name="groupe_id" required>'+groupOpts(null,"— choisir —")+'</select></div><div><label>Statut</label><select name="statut">'+opts(STATUTS,"actif")+'</select></div></div><label>Description</label><textarea name="description" class="big"></textarea><div class="acts"><button class="p">Créer</button></div></form></section>';
$("#np").onsubmit=async(e)=>{e.preventDefault();const f=e.target;const r=await api("POST","projets",{nom:f.nom.value,groupe_id:Number(f.groupe_id.value),statut:f.statut.value,description:f.description.value});toast("Projet créé");await loadProjets();openProjet(r.id)}};
const gq=new URLSearchParams(location.search).get("google");
loadProjets().then(()=>{if(gq!==null){history.replaceState(null,"","/admin");toast(gq==="ok"?"Google connecté : choisis l'agenda dédié.":gq,gq!=="ok");tachesPage()}else home()}).catch(()=>{});
</script></body></html>`;
}
