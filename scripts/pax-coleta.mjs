// Coleta de teste das rotas de passageiros: tabela "Airlines and destinations / Passenger" de cada hub
// na Wikipedia; códigos IATA e coordenadas dos destinos vêm do Wikidata.
// Uso: node coleta.mjs saida.json GRU MAO ATL ...
import fs from "node:fs";

const [out, ...HUBS] = process.argv.slice(2);
const UA = { "User-Agent": "cargoconnections-pax/0.1 (https://lopesimulations.github.io/skyconnections/; marinhomatheus289@gmail.com)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJ = async (url, opt = {}) => { for (let i = 0; ; i++) { try { const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(60000) }); if (r.status === 429) throw new Error("429"); if (!r.ok) throw new Error(r.status); return await r.json(); } catch (e) { if (i >= 3) throw e; await sleep(3000 * (i + 1)); } } };
const W = "https://en.wikipedia.org/w/api.php?format=json&formatversion=2&";
const dec = s => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, " ");

// 1) artigo da Wikipedia de cada hub, pelo código IATA (Wikidata P238)
const q = `SELECT ?iata ?art WHERE { VALUES ?iata { ${HUBS.map(h => `"${h}"`).join(" ")} } ?i wdt:P238 ?iata. ?art schema:about ?i; schema:isPartOf <https://en.wikipedia.org/>. ?i wdt:P31/wdt:P279* wd:Q1248784 }`;
const sp = await getJ("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q));
const art = {};
for (const b of sp.results.bindings) art[b.iata.value] = decodeURIComponent(b.art.value.split("/wiki/")[1]).replace(/_/g, " ");
console.log("artigos:", JSON.stringify(art));

// 2) tabela de passageiros de cada hub
const rows = [], titles = new Set();
for (const h of HUBS) {
  const t = art[h]; if (!t) { console.warn(h, "sem artigo"); continue; }
  const secs = (await getJ(W + "action=parse&prop=sections&redirects=1&page=" + encodeURIComponent(t))).parse.sections;
  const ad = secs.findIndex(s => /airlines and destinations/i.test(s.line));
  if (ad < 0) { console.warn(h, "sem seção de destinos"); continue; }
  // subseção "Passenger" (se não houver, a própria seção)
  let sec = secs.slice(ad + 1).find(s => +s.toclevel > +secs[ad].toclevel && /passenger/i.test(s.line));
  if (sec && secs.slice(ad + 1, secs.indexOf(sec)).some(s => +s.toclevel <= +secs[ad].toclevel)) sec = null;
  const html = (await getJ(W + "action=parse&prop=text&redirects=1&page=" + encodeURIComponent(t) + "&section=" + (sec || secs[ad]).index)).parse.text;
  let n = 0;
  for (const tr of html.split(/<tr[\s>]/).slice(1)) {
    const td = tr.split(/<td[\s>]/).slice(1);
    if (td.length < 2) continue;
    const al = (td[0].match(/title="([^"]+)"/) || [])[1];
    if (!al) continue;
    // destinos: links; o que vem depois de "Seasonal:" ou "Charter:" leva a marca
    let mode = "";
    for (const part of td[1].split(/(<b>[^<]*<\/b>|Seasonal(?: charter)?:|Charter:)/i)) {
      if (/seasonal charter/i.test(part)) { mode = "sc"; continue; }
      if (/seasonal/i.test(part)) { mode = "s"; continue; }
      if (/charter/i.test(part)) { mode = "c"; continue; }
      for (const m of part.matchAll(/<a href="\/wiki\/[^"]+" title="([^"]+)"/g)) {
        const dt = dec(m[1]); if (/^(Help|Wikipedia|Template):/.test(dt)) continue;
        rows.push({ o: h, al: dec(al), dt, m: mode }); titles.add(dt); n++;
      }
    }
  }
  console.log(h, t, "linhas:", n);
  await sleep(500);
}

// 3) título do destino -> IATA + coordenadas (Wikipedia pageprops -> Wikidata)
const qid = {}, info = {};
const T = [...titles];
for (let i = 0; i < T.length; i += 50) {
  const j = await getJ(W + "action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=" + encodeURIComponent(T.slice(i, i + 50).join("|")));
  const red = {}; for (const r of j.query.redirects || []) red[r.to] = (red[r.to] || []).concat(r.from);
  const norm = {}; for (const r of j.query.normalized || []) norm[r.to] = r.from;
  for (const p of j.query.pages || []) { const id = p.pageprops && p.pageprops.wikibase_item; if (!id) continue; for (const f of [p.title, ...(red[p.title] || [])]) { qid[f] = id; if (norm[f]) qid[norm[f]] = id; } }
  await sleep(200);
}
const ids = [...new Set(Object.values(qid))];
for (let i = 0; i < ids.length; i += 50) {
  const j = await getJ("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|labels&languages=en|pt&ids=" + ids.slice(i, i + 50).join("|"));
  for (const [id, e] of Object.entries(j.entities)) {
    const c = e.claims || {}, iata = c.P238 && c.P238[0].mainsnak.datavalue && c.P238[0].mainsnak.datavalue.value, co = c.P625 && c.P625[0].mainsnak.datavalue && c.P625[0].mainsnak.datavalue.value;
    if (iata) info[id] = { iata, lat: co ? +co.latitude.toFixed(4) : null, lon: co ? +co.longitude.toFixed(4) : null, n: (e.labels.pt || e.labels.en || {}).value || iata };
  }
  await sleep(200);
}
const res = [], miss = new Set();
for (const r of rows) { const i = info[qid[r.dt]]; if (!i) { miss.add(r.dt); continue; } if (i.iata === r.o) continue; res.push({ o: r.o, d: i.iata, op: r.al, s: r.m }); }
const ap = {}; for (const i of Object.values(info)) ap[i.iata] = { lat: i.lat, lon: i.lon, n: i.n };
fs.writeFileSync(out, JSON.stringify({ rotas: res, aeroportos: ap, sem_codigo: [...miss] }));
const pairs = new Set(res.map(r => r.o + "-" + r.d)), dests = new Set(res.map(r => r.d)), ops = new Set(res.map(r => r.op));
console.log(`linhas ${res.length} | ligações ${pairs.size} | destinos ${dests.size} | companhias ${ops.size} | sem código ${miss.size}`);
for (const h of HUBS) console.log(h, "ligações", new Set(res.filter(r => r.o === h).map(r => r.d)).size, "linhas", res.filter(r => r.o === h).length);
