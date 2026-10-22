// Verificação das rotas de passageiros com ADS-B aberto (Pax Connections), à parte da verificação de carga.
// Tira uma foto dos jatos de passageiros no ar (adsb.lol / airplanes.live), descobre a rota de cada indicativo
// (adsb.lol routeset) e, quando a companhia do indicativo (código ICAO, ex.: TAM3456) opera aquela rota no pax.json,
// marca a rota como vista e guarda o modelo da aeronave. Acumula com a verificação anterior.
// Uso: node scripts/rotas-pax.mjs pax.json verificacao-pax.json [verificação anterior: arquivo local ou url ...]
import fs from "node:fs";

const [, , paxPath, outPath, ...prevSrc] = process.argv;
const P = JSON.parse(fs.readFileSync(paxPath, "utf8"));
const AP = P.aeroportos, IATA = Object.fromEntries(Object.entries(P.icao || {}).map(([k, v]) => [v, k]));

// modelos de passageiros mais comuns (códigos ICAO de tipo)
const TYPES = ["A19N", "A20N", "A21N", "A318", "A319", "A320", "A321", "BCS1", "BCS3", "A332", "A333", "A338", "A339", "A343", "A346",
  "A359", "A35K", "A388", "B736", "B737", "B738", "B739", "B37M", "B38M", "B39M", "B3XM", "B752", "B753", "B763", "B764", "B772",
  "B77L", "B773", "B77W", "B788", "B789", "B78X", "B744", "B748", "E170", "E175", "E75L", "E75S", "E190", "E195", "E290", "E295",
  "CRJ2", "CRJ7", "CRJ9", "CRJX", "AT72", "AT75", "AT76", "AT45", "AT46", "C208", "DH8D", "SU95", "C919", "AJ27", "E145", "B712", "MD88", "MD90"];

// rotas da base por par de aeroportos (sem sentido) e companhias por código ICAO
const byPair = new Map(), byCode = new Map();
P.opc.forEach((c, i) => { for (const x of String(c || "").split(" ").filter(Boolean)) { if (!byCode.has(x)) byCode.set(x, new Set()); byCode.get(x).add(i); } });
for (const r of P.rotas) { const k = [r[0], r[1]].sort().join("|"); if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(r); }

const UA = { "user-agent": "paxconnections-verificacao (+https://lopesimulations.github.io/cargoconnections/?passageiros)" };
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
  const out = new Map(), fontes = new Set(), porTipo = {}, falhas = [];
  for (const t of TYPES) {
    let j = null;
    // o adsb.lol limita consultas seguidas: tenta de novo com espera crescente antes de passar à outra fonte
    for (let k = 0; k < 4 && !j; k++) {
      try { j = await getJ(`https://api.adsb.lol/v2/type/${t}`); fontes.add("adsb.lol"); }
      catch (e) { await sleep(4000 * (k + 1)); }
    }
    if (!j) try { j = await getJ(`https://api.airplanes.live/v2/type/${t}`); fontes.add("airplanes.live"); } catch (e) { falhas.push(t); }
    let n = 0;
    for (const a of j?.ac || j?.aircraft || []) {
      const fl = (a.flight || "").trim();
      if (a.lat == null || a.lon == null || a.alt_baro === "ground" || !/^[A-Z]{3}\d/.test(fl) || !byCode.has(fl.slice(0, 3))) continue;
      if (!out.has(fl)) { out.set(fl, { fl, lat: +a.lat, lon: +a.lon, t: a.t || t }); n++; }
    }
    porTipo[t] = n;
    await sleep(1500);
  }
  console.log("aviões por modelo:", Object.entries(porTipo).filter(x => x[1]).map(x => x.join(":")).join(" "));
  if (falhas.length) console.warn("modelos sem resposta:", falhas.join(" "));
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
    } catch (e) { if (!/JSON/.test(e.message)) console.error("routeset:", e.message); }
    await sleep(1000);
  }
  // reserva: adsbdb, um indicativo por consulta (4 por vez), limitado para não abusar do serviço
  // revezando entre os modelos, para a amostra não ficar só com os primeiros tipos da lista
  const porTipo = new Map();
  for (const a of avioes) if (!res.has(a.fl)) { if (!porTipo.has(a.t)) porTipo.set(a.t, []); porTipo.get(a.t).push(a); }
  const fila = [...porTipo.values()], todo = [], max = +process.env.RESERVA || 400;
  for (let i = 0; todo.length < max && fila.some(l => l.length > i); i++) for (const l of fila) if (l[i] && todo.length < max) todo.push(l[i]);
  const one = async a => {
    try {
      const fr = (await getJ(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(a.fl)}`)).response?.flightroute;
      const c = [fr?.origin?.iata_code, fr?.destination?.iata_code].filter(Boolean);
      if (c.length === 2 && fits(a, c)) res.set(a.fl, c);
    } catch (e) { /* sem rota no adsbdb */ }
  };
  for (let i = 0; i < todo.length; i += 4) { await Promise.all(todo.slice(i, i + 4).map(one)); await sleep(300); }
  return res;
}

// verificação anterior: o primeiro que existir (arquivo local ou o publicado no site)
const prev = await (async () => {
  for (const src of prevSrc) {
    try { return /^https?:/.test(src) ? await getJ(`${src}?t=${Date.now()}`) : JSON.parse(fs.readFileSync(src, "utf8")); } catch { /* tenta o próximo */ }
  }
  return null;
})();
const V = prev?.vistas || {};
// frota vista no ar por companhia (código ICAO -> modelo -> fotos em que apareceu): base da aeronave provável
// nas rotas ainda não vistas; cada modelo guarda o último dia visto e some depois de 90 dias sem aparecer
const F = prev?.frota || {};
const day = new Date().toISOString().slice(0, 10);
const snap = await snapshot();
const rt = await routes(snap.avioes);
for (const a of snap.avioes) {
  const f = F[a.fl.slice(0, 3)] || (F[a.fl.slice(0, 3)] = {}), x = f[a.t] || (f[a.t] = [0, day]);
  x[0]++; x[1] = day;
}
const lim90 = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
for (const [c, f] of Object.entries(F)) { for (const t of Object.keys(f)) if (f[t][1] < lim90) delete f[t]; if (!Object.keys(f).length) delete F[c]; }
let casadas = 0;
for (const [fl, path] of rt) {
  const ops = byCode.get(fl.slice(0, 3)), t = snap.avioes.find(a => a.fl === fl).t;
  let ok = false;
  // qualquer par do caminho (ex.: GRU-LFW-ADD casa GRU-LFW, LFW-ADD e GRU-ADD "via LFW"), como na verificação de carga
  for (let x = 0; x + 1 < path.length; x++) for (let y = x + 1; y < path.length; y++) {
    for (const r of byPair.get([path[x], path[y]].sort().join("|")) || []) {
      if (!ops.has(r[2])) continue;
      // chave no sentido em que a rota está no pax.json: origem|destino|companhia; escalas no mesmo sentido
      const k = `${r[0]}|${r[1]}|${P.ops[r[2]]}`, v = V[k] || (V[k] = { n: 0, t: {} }), via = path.slice(x + 1, y);
      v.u = day; v.n++; v.cs = fl; v.t[t] = (v.t[t] || 0) + 1; v.via = r[0] === path[x] ? via : via.reverse();
      v.d = v.d || []; if (!v.d.includes(day)) v.d.push(day);
      ok = true;
    }
  }
  if (ok) casadas++;
}
// histórico: dias (UTC) em que a rota foi vista voando, guardados por 60 dias
const lim60 = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
for (const [k, v] of Object.entries(V)) { v.d = (v.d || [v.u]).filter(x => x >= lim60).sort(); if (!v.d.length) delete V[k]; }
fs.writeFileSync(outPath, JSON.stringify({
  atualizado_em: new Date().toISOString(),
  fonte: [...snap.fontes, "adsb.lol routeset"].join(" + "),
  ultima_foto: { avioes: snap.avioes.length, com_rota: rt.size, na_base: casadas },
  vistas: V,
  frota: F,
}));
console.log(`${snap.avioes.length} jatos de passageiros no ar, ${rt.size} com rota, ${casadas} casados com a base · ${Object.keys(V).length} rotas já vistas`);
