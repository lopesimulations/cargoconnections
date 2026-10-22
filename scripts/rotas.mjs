// Verificação noturna das rotas com ADS-B aberto (roda no GitHub Actions à meia-noite de Brasília).
// Tira algumas fotos dos cargueiros no ar (adsb.lol / airplanes.live), descobre a rota de cada
// indicativo (adsb.lol routeset, adsbdb ou hexdb, que às vezes traz também as escalas) e compara com a base do index.html.
// Acumula o resultado com o verificacao.json já publicado, para a confirmação crescer noite a noite.
// Uso: node scripts/rotas.mjs index.html verificacao.json [verificação anterior: arquivo local ou url ...]
import fs from "node:fs";

const [, , htmlPath, outPath, ...prevSrc] = process.argv;
const html = fs.readFileSync(htmlPath, "utf8");

// constantes do próprio site: mesmos modelos, companhias e códigos que o mapa ao vivo usa
const lit = name => {
  const i = html.indexOf(`const ${name}=`);
  if (i < 0) throw new Error(`não achei ${name}`);
  let t = html.slice(i + name.length + 7, html.indexOf("\n", i)).trim();
  if (t.endsWith(";")) t = t.slice(0, -1);
  return new Function(`return (${t})`)();
};
const LV_TYPES = lit("LV_TYPES"), LV_OPS = lit("LV_OPS"), LV_CARGO = lit("LV_CARGO"), LV_MIX = lit("LV_MIX"), ICAO = lit("ICAO");
const D = (() => {
  const i = html.indexOf("const __D=") + 10, line = html.slice(i, html.indexOf("\n", i));
  return JSON.parse(line.slice(0, line.lastIndexOf("}") + 1));
})();
const AP = D.aeroportos?.lista || {};
const IATA = Object.fromEntries(Object.entries(ICAO).map(([k, v]) => [v, k]));
const HUBS = new Set(Object.values(D.meta?.hubs || {}).flat());
const opKey = s => String(s || "").toLowerCase().replace(/airlines?|cargo|air lines|international|express|aviation|\(.*?\)/g, "").replace(/[^a-z0-9]/g, "").slice(0, 6);
const isCargo = fl => { const p = fl.slice(0, 3), n = fl.slice(3); return LV_CARGO.has(p) || !!(LV_MIX[p] && LV_MIX[p].test(n)); };

// base: rotas por companhia
const base = new Map();
for (const [k, v] of Object.entries(D)) {
  if (!k.startsWith("rotas-")) continue;
  for (const r of v.rotas || []) {
    if (!r.o || !r.d || r.o === "---" || r.d === "---") continue;
    const ok = opKey(r.op);
    if (!base.has(ok)) base.set(ok, []);
    base.get(ok).push(r);
  }
}

const UA = { "user-agent": "cargoconnections-verificacao (+https://lopesimulations.github.io/skyconnections/)" };
async function getJ(url, opt = {}) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: ac.signal });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function snapshot() {
  const out = new Map(), fontes = new Set();
  for (const t of LV_TYPES) {
    for (const [src, u] of [["adsb.lol", `https://api.adsb.lol/v2/type/${t}`], ["airplanes.live", `https://api.airplanes.live/v2/type/${t}`]]) {
      try {
        const j = await getJ(u);
        for (const a of j.ac || j.aircraft || []) {
          const fl = (a.flight || "").trim();
          if (a.lat == null || a.lon == null || a.alt_baro === "ground" || !isCargo(fl)) continue;
          if (!out.has(fl)) out.set(fl, { fl, lat: +a.lat, lon: +a.lon });
        }
        fontes.add(src);
        break;
      } catch (e) { /* tenta a outra fonte */ }
    }
    await sleep(1200); // airplanes.live pede no máximo 1 consulta por segundo
  }
  return { avioes: [...out.values()], fontes };
}

// a posição do avião precisa estar a até 600 km do grande círculo origem–destino (descarta rotas velhas do indicativo)
const vec = (lat, lon) => { const p = lat * Math.PI / 180, l = lon * Math.PI / 180; return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]; };
function fits(a, c) {
  const A = AP[c[0]], B = AP[c[c.length - 1]];
  if (!A || !B) return false;
  const u = vec(A.lat, A.lon), v = vec(B.lat, B.lon), q = vec(a.lat, a.lon);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], nl = Math.hypot(...n);
  if (nl < 1e-6) return true;
  return Math.abs(Math.asin(Math.max(-1, Math.min(1, (q[0] * n[0] + q[1] * n[1] + q[2] * n[2]) / nl)))) * 6371 < 600;
}

async function routes(avioes) {
  const res = new Map();
  for (let i = 0; i < avioes.length; i += 100) {
    const part = avioes.slice(i, i + 100);
    try {
      const j = await getJ("https://api.adsb.lol/api/0/routeset", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ planes: part.map(a => ({ callsign: a.fl, lat: a.lat, lng: a.lon })) }),
      });
      for (const it of Array.isArray(j) ? j : []) {
        if (it.plausible === false) continue;
        let c = (it._airport_codes_iata || "").split("-").filter(x => /^[A-Z0-9]{3}$/.test(x));
        if (c.length < 2) c = (it.airport_codes || "").split("-").filter(x => /^[A-Z]{4}$/.test(x)).map(x => IATA[x] || x);
        const a = part.find(x => x.fl === (it.callsign || "").trim());
        if (a && c.length >= 2 && fits(a, c)) res.set(a.fl, c);
      }
    } catch (e) { console.error("routeset:", e.message); }
    await sleep(1000);
  }
  // quem ficou sem rota: adsbdb (origem e destino) e hexdb (às vezes com escalas), 4 por vez
  const todo = avioes.filter(a => !res.has(a.fl));
  const one = async a => {
    try {
      const j = await getJ(`https://hexdb.io/api/v1/route/icao/${encodeURIComponent(a.fl)}`);
      const c = String(j.route || "").split("-").map(x => IATA[x] || x);
      if (c.length >= 2 && fits(a, c)) { res.set(a.fl, c); return; }
    } catch (e) { /* sem rota no hexdb */ }
    try {
      const fr = (await getJ(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(a.fl)}`)).response?.flightroute;
      const c = [fr?.origin?.iata_code, fr?.destination?.iata_code].filter(Boolean);
      if (c.length === 2 && fits(a, c)) res.set(a.fl, c);
    } catch (e) { /* sem rota no adsbdb */ }
  };
  for (let i = 0; i < todo.length; i += 4) { await Promise.all(todo.slice(i, i + 4).map(one)); await sleep(300); }
  return res;
}

// compara um caminho observado (ex.: ICN-ANC-MIA) com as rotas da base dessa companhia
function compare(fl, path, day, V, N) {
  const op = LV_OPS[fl.slice(0, 3)];
  if (!op) return;
  const rows = base.get(opKey(op)) || [];
  const covered = new Set();
  for (const r of rows) {
    const i = path.indexOf(r.o), j = path.lastIndexOf(r.d);
    if (i < 0 || j <= i) continue;
    const k = `${r.o}|${r.d}|${r.op}`, via = path.slice(i + 1, j);
    const v = V[k] || (V[k] = { n: 0 });
    v.u = day; v.n++; v.cs = fl; v.via = via;
    // histórico: dias (UTC) em que a rota foi vista voando, guardados por 60 dias
    v.d = v.d || []; if (!v.d.includes(day)) v.d.push(day);
    for (let x = i; x < j; x++) covered.add(path[x] + "|" + path[x + 1]);
  }
  for (let x = 0; x + 1 < path.length; x++) {
    const a = path[x], b = path[x + 1];
    if (covered.has(a + "|" + b) || !(HUBS.has(a) || HUBS.has(b))) continue;
    const k = `${op}|${a}|${b}`, n = N[k] || (N[k] = { p: day, n: 0 });
    n.u = day; n.n++; n.cs = fl;
  }
}

// verificação anterior: o primeiro que existir (arquivo guardado no repositório ou o publicado no site)
const prev = await (async () => {
  for (const src of prevSrc) {
    try { return /^https?:/.test(src) ? await getJ(`${src}?t=${Date.now()}`) : JSON.parse(fs.readFileSync(src, "utf8")); } catch { /* tenta o próximo */ }
  }
  return null;
})();
const V = prev?.vistas || {}, N = prev?.novas || {};
const day = new Date().toISOString().slice(0, 10);
let total = 0, comRota = 0;
const fontes = new Set(["adsb.lol routeset"]);
const FOTOS = +process.env.FOTOS || 3;
for (let s = 0; s < FOTOS; s++) { // três fotos com 10 min de intervalo pegam mais voos
  if (s) await sleep(10 * 60e3);
  const snap = await snapshot();
  snap.fontes.forEach(f => fontes.add(f));
  const rt = await routes(snap.avioes);
  total += snap.avioes.length; comRota += rt.size;
  for (const [fl, path] of rt) compare(fl, path, day, V, N);
  console.log(`foto ${s + 1}: ${snap.avioes.length} cargueiros no ar, ${rt.size} com rota`);
}
// novidades: some quando a rota entra na base ou fica 45 dias sem aparecer
const lim = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
const lim60 = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
for (const v of Object.values(V)) { v.d = (v.d || [v.u]).filter(x => x >= lim60).sort(); }
for (const k of Object.keys(N)) {
  const [op, a, b] = k.split("|");
  if (N[k].u < lim || (base.get(opKey(op)) || []).some(r => r.o === a && r.d === b)) delete N[k];
}
fs.writeFileSync(outPath, JSON.stringify({
  atualizado_em: new Date().toISOString(),
  fonte: [...fontes].join(" + "),
  ultima_noite: { cargueiros: total, com_rota: comRota },
  vistas: V,
  novas: N,
}));
console.log(`${Object.keys(V).length} rotas da base já confirmadas no ADS-B, ${Object.keys(N).length} ligações fora da base`);
