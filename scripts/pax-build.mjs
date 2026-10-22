// Monta o pax.json do modo Passageiros a partir da coleta (tabelas "Airlines and destinations" da Wikipedia):
// rotas compactas [origem, destino, índice da companhia, marca], aeroportos, hubs por região e códigos ICAO.
// Uso: node scripts/pax-build.mjs <coleta.json> <pax.json>
import fs from "node:fs";

const [inp, out] = process.argv.slice(2);
const J = JSON.parse(fs.readFileSync(inp, "utf8"));
// 10 principais hubs de passageiros por região (+ Manaus na América do Sul e Honolulu na América do Norte)
const HUBS = {
  NAM: ["ATL", "DFW", "DEN", "ORD", "LAX", "JFK", "LAS", "MCO", "CLT", "MIA", "HNL"],
  CAM: ["MEX", "CUN", "GDL", "TIJ", "MTY", "PTY", "SJO", "SDQ", "PUJ", "SJU"],
  SAM: ["BOG", "GRU", "SCL", "LIM", "CGH", "BSB", "AEP", "GIG", "MDE", "CNF", "MAO"],
  EUR: ["LHR", "IST", "CDG", "AMS", "MAD", "FRA", "BCN", "FCO", "SAW", "MUC"],
  LES: ["SVO", "VKO", "DME", "LED", "AER", "WAW", "BUD", "PRG", "OTP", "KRK"],
  OM: ["DXB", "DOH", "JED", "RUH", "AUH", "TLV", "KWI", "MCT", "SHJ", "DMM"],
  AFR: ["CAI", "JNB", "CMN", "ADD", "CPT", "HRG", "NBO", "RAK", "LOS", "ALG"],
  LEA: ["HND", "CAN", "PVG", "SZX", "PEK", "ICN", "TFU", "PKX", "HKG", "NRT"],
  SEA: ["SIN", "BKK", "CGK", "MNL", "KUL", "SGN", "HAN", "DMK", "DPS", "HKT"],
  SAS: ["DEL", "BOM", "BLR", "HYD", "MAA", "CCU", "AMD", "COK", "DAC", "CMB"],
  OCE: ["SYD", "MEL", "BNE", "AKL", "PER", "ADL", "OOL", "CHC", "CNS", "WLG"],
};
const ap = {};
for (const [k, v] of Object.entries(J.aeroportos)) if (v.lat != null && v.lon != null) ap[k] = { lat: v.lat, lon: v.lon, n: v.n };
// a mesma companhia aparece com títulos diferentes (redirecionamentos da Wikipedia): usa o título final do artigo
const UA = { "User-Agent": "cargoconnections-pax/0.1 (https://lopesimulations.github.io/cargoconnections/)" };
const nomes = [...new Set(J.rotas.map(r => r.op))], canon = {};
for (let i = 0; i < nomes.length; i += 50) {
  const r = await fetch("https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=query&redirects=1&titles=" + encodeURIComponent(nomes.slice(i, i + 50).join("|")), { headers: UA });
  const q = (await r.json()).query || {}, norm = {};
  for (const n of q.normalized || []) norm[n.to] = n.from;
  for (const d of q.redirects || []) { canon[d.from] = d.to; if (norm[d.from]) canon[norm[d.from]] = d.to; }
}
for (const r of J.rotas) r.op = (canon[r.op] || r.op).replace(/ \((airline|company)\)$/i, "");
const ops = [], oi = new Map(), seen = new Set(), rotas = [];
for (const r of J.rotas) {
  if (!ap[r.o] || !ap[r.d] || r.o === r.d) continue;
  const k = [r.o, r.d].sort().join("|") + "|" + r.op; // malha não tem sentido: ida e volta viram uma linha só
  if (seen.has(k)) continue;
  seen.add(k);
  if (!oi.has(r.op)) { oi.set(r.op, ops.length); ops.push(r.op); }
  rotas.push(r.s ? [r.o, r.d, oi.get(r.op), r.s] : [r.o, r.d, oi.get(r.op)]);
}
// ICAO de cada aeroporto usado (Wikidata P239), para o METAR e o SimBrief
const used = [...new Set(rotas.flatMap(r => [r[0], r[1]]))], icao = {};
for (let i = 0; i < used.length; i += 250) {
  const q = `SELECT ?iata ?icao WHERE { VALUES ?iata { ${used.slice(i, i + 250).map(c => `"${c}"`).join(" ")} } ?a wdt:P238 ?iata; wdt:P239 ?icao. }`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: UA });
  for (const b of (await r.json()).results.bindings) if (/^[A-Z0-9]{4}$/.test(b.icao.value) && !icao[b.iata.value]) icao[b.iata.value] = b.icao.value;
}
const aeroportos = {};
for (const c of used) aeroportos[c] = ap[c];
fs.writeFileSync(out, JSON.stringify({ data: new Date().toISOString().slice(0, 10), fonte: "Wikipedia (Airlines and destinations)", hubs: HUBS, ops, rotas, aeroportos, icao }));
const pares = new Set(rotas.map(r => r[0] + "-" + r[1]));
console.log(`${rotas.length} rotas · ${pares.size} ligações · ${used.length} aeroportos (${Object.keys(icao).length} com ICAO) · ${ops.length} companhias -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
