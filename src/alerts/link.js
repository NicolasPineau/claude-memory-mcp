import { TASK_SELECT, applyTaskUpdate, getSetting, parisNow, parseReports, reportTarget, shortDate, shortTime } from "../db/tasks.js";
import { escHtml } from "../admin/page.js";
import { verifyTaskLink } from "./ntfy.js";

// ------------------------------------------------------------------ liens des notifications : /t/<jeton>[/<action>]
// GET /t/<jeton> : page mobile (repousser, modifier). POST /t/<jeton>/fait | vu | repousser | modifier.
// Le jeton signé (une tâche, 7 jours) tient lieu d'authentification : pas de Cloudflare Access, ouverture en un clic.
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const text = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...HEADERS } });

export async function handleTaskLink(request, env, parts) {
  const db = env.DB;
  const id = await verifyTaskLink(env, parts[1]);
  if (!id) return text("Lien invalide ou expiré.", 404);
  const t = await db.prepare(`${TASK_SELECT} WHERE t.memory_id = ?`).bind(id).first();
  if (!t) return text("Tâche introuvable.", 404);
  const action = parts[2];

  if (!action) {
    if (request.method !== "GET") return text("Méthode non autorisée.", 405);
    return new Response(await taskPage(db, t), { headers: { "Content-Type": "text/html; charset=utf-8", ...HEADERS } });
  }
  if (request.method !== "POST") return text("Méthode non autorisée.", 405);
  let body = {};
  if (action === "repousser" || action === "modifier") {
    try { body = await request.json(); } catch { return text("Requête invalide.", 400); }
  }

  let a;
  if (action === "fait") a = { statut: "fait" };
  else if (action === "vu") a = { vu: true };
  else if (action === "repousser") {
    const reports = parseReports(await getSetting(db, "reports"));
    const choice = reports.list?.[Number(body.choix)];
    if (!choice) return text("Choix de report inconnu.", 400);
    const d = reportTarget(choice.rule, t);
    a = { echeance: d.time ? `${d.date} ${d.time}` : d.date, ...(t.status === "a_faire" ? {} : { statut: "a_faire" }) };
  } else if (action === "modifier") {
    a = {};
    for (const k of ["titre", "detail", "echeance", "criticite"]) if (body[k] != null) a[k] = String(body[k]);
    if (a.titre != null && !a.titre.trim()) return text("Le titre ne peut pas être vide.", 400);
  } else return text("Action inconnue.", 404);

  const r = await applyTaskUpdate(db, t, a);
  if (r.error) return text(r.error.replace(/^Erreur : /, ""), 400);
  const today = parisNow().date;
  if (action === "fait") return text(r.next ? `Fait. Prochaine le ${shortDate(r.next.due, today)}.` : "Fait.");
  if (action === "vu") return text("Vu : plus de relance.");
  if (action === "repousser") return text(`Repoussée au ${shortDate(a.echeance.slice(0, 10), today)}${a.echeance.length > 10 ? " " + shortTime(a.echeance.slice(11)) : ""}.`);
  return text("Enregistré.");
}

async function taskPage(db, t) {
  const today = parisNow().date;
  const reports = parseReports(await getSetting(db, "reports")).list || [];
  const levels = (await db.prepare("SELECT name FROM task_levels ORDER BY position, id").all()).results.map((l) => l.name);
  const due = t.due_date ? (t.due_date < today && t.status === "a_faire" ? "En retard : " : "Échéance : ") + (t.due_date === today ? "aujourd'hui" : shortDate(t.due_date, today)) + (t.due_time ? " " + shortTime(t.due_time) : "") : "Sans échéance";
  const status = { a_faire: "", silencieux: " · silencieuse", fait: " · faite", annule: " · annulée" }[t.status];
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(t.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--txt:#1d1d1b;--mut:#6b6b66;--acc:#c96442;--bd:#e3e2dd;--ko:#c62828}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1a;--card:#262624;--txt:#eceae4;--mut:#9b9a94;--bd:#3a3936}}
*{box-sizing:border-box}body{margin:0;padding:16px;font:16px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt)}
section{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin:0 auto 14px;max-width:520px}
h1{font-size:1.2rem;margin:0 0 4px}h2{font-size:1rem;margin:0 0 10px}.meta{color:var(--mut);font-size:.9rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
button{font:inherit;padding:12px;border:1px solid var(--bd);border-radius:10px;background:var(--card);color:var(--txt);width:100%}
button.p{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
label{display:block;font-size:.85rem;color:var(--mut);margin:10px 0 4px}
input,select,textarea{width:100%;font:inherit;padding:10px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--txt)}
textarea{min-height:90px}#msg{position:fixed;left:16px;right:16px;bottom:16px;padding:12px;border-radius:10px;background:var(--txt);color:var(--bg);text-align:center;display:none}
</style></head><body>
<section><h1>${escHtml((t.marker ? t.marker + " " : "") + t.title)}</h1><div class="meta">${escHtml(due + " · " + t.level + status)}</div>
<div class="grid" style="margin-top:12px"><button class="p" data-act="fait">Fait</button><button data-act="vu">Vu</button></div></section>
<section id="repousser"><h2>Repousser</h2><div class="grid">${reports.map((r, i) => `<button data-rep="${i}">${escHtml(r.label)}</button>`).join("")}</div></section>
<section><h2>Modifier</h2><form id="f">
<label>Intitulé</label><input name="titre" value="${escHtml(t.title)}" required>
<label>Détail</label><textarea name="detail">${escHtml(t.content === t.title ? "" : t.content)}</textarea>
<div class="grid"><div><label>Date</label><input name="date" type="date" value="${escHtml(t.due_date || "")}"></div><div><label>Heure</label><input name="heure" type="time" value="${escHtml(t.due_time || "")}"></div></div>
<label>Criticité</label><select name="criticite">${levels.map((l) => `<option${l === t.level ? " selected" : ""}>${escHtml(l)}</option>`).join("")}</select>
<div style="margin-top:14px"><button class="p">Enregistrer</button></div></form></section>
<div id="msg"></div>
<script>
const base=location.pathname.replace(/\\/$/,"");
function show(m){const e=document.getElementById("msg");e.textContent=m;e.style.display="block";clearTimeout(e._h);e._h=setTimeout(()=>e.style.display="none",4000)}
async function post(act,body){const r=await fetch(base+"/"+act,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});show(await r.text());if(r.ok)setTimeout(()=>location.reload(),1200)}
document.querySelectorAll("[data-act]").forEach((b)=>b.onclick=()=>post(b.dataset.act));
document.querySelectorAll("[data-rep]").forEach((b)=>b.onclick=()=>post("repousser",{choix:Number(b.dataset.rep)}));
document.getElementById("f").onsubmit=(e)=>{e.preventDefault();const f=e.target;post("modifier",{titre:f.titre.value,detail:f.detail.value,echeance:f.date.value?(f.date.value+(f.heure.value?" "+f.heure.value:"")):"",criticite:f.criticite.value})};
</script></body></html>`;
}
