// Monta o pax.json do modo Passageiros a partir da coleta (tabelas "Airlines and destinations" da Wikipedia):
// rotas compactas [origem, destino, índice da companhia, marca], aeroportos, hubs por região e códigos ICAO.
// Uso: node scripts/pax-build.mjs <coleta.json> <pax.json>
import fs from "node:fs";

const [inp, out] = process.argv.slice(2);
const J = JSON.parse(fs.readFileSync(inp, "utf8"));
// 10 principais hubs de passageiros por região (+ Manaus e Viracopos na América do Sul e Honolulu na América do Norte)
const HUBS = {
  NAM: ["ATL", "DFW", "DEN", "ORD", "LAX", "JFK", "LAS", "MCO", "CLT", "MIA", "HNL"],
  CAM: ["MEX", "CUN", "GDL", "TIJ", "MTY", "PTY", "SJO", "SDQ", "PUJ", "SJU"],
  SAM: ["BOG", "GRU", "SCL", "LIM", "CGH", "BSB", "AEP", "GIG", "MDE", "CNF", "MAO", "VCP"],
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
const W = "https://en.wikipedia.org/w/api.php?format=json&formatversion=2&";
const nomes = [...new Set(J.rotas.map(r => r.op))], canon = {};
for (let i = 0; i < nomes.length; i += 50) {
  const r = await fetch("https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=query&redirects=1&titles=" + encodeURIComponent(nomes.slice(i, i + 50).join("|")), { headers: UA });
  const q = (await r.json()).query || {}, norm = {};
  for (const n of q.normalized || []) norm[n.to] = n.from;
  for (const d of q.redirects || []) { canon[d.from] = d.to; if (norm[d.from]) canon[norm[d.from]] = d.to; }
}
const titulo = {}; // nome exibido -> título do artigo (para achar a companhia no Wikidata)
for (const r of J.rotas) { const t = canon[r.op] || r.op; r.op = t.replace(/ \((airline|company|airline brand)\)$/i, ""); titulo[r.op] = t; }
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
// código ICAO de cada companhia (Wikidata P230): liga o indicativo dos voos no ADS-B (ex.: TAM3456) à companhia
// e preenche a companhia no SimBrief. Marcas regionais não têm código próprio: voam com as operadoras abaixo.
const MARCAS = {
  "United Express": ["SKW", "RPA", "ASH", "GJS", "CPZ", "AWI"], "American Eagle": ["ENY", "PDT", "PSA", "SKW", "RPA", "JIA"],
  "Delta Connection": ["EDV", "SKW", "RPA", "CPZ"], "Air Canada Express": ["JZA", "CRQ"], "Alaska Airlines": ["ASA", "QXE", "SKW"],
  // sem código no Wikidata
  "LATAM Airlines Chile": ["LAN"], QantasLink: ["QLK", "NWK"], "Super Air Jet": ["SJV"], "Greater Bay Airlines": ["HGB"], "Avianca El Salvador": ["TAI"],
};
const opc = ops.map(o => MARCAS[o] ? MARCAS[o].join(" ") : "");
for (let i = 0; i < ops.length; i += 50) {
  const part = ops.slice(i, i + 50).map(o => titulo[o] || o);
  const r = await fetch("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&sites=enwiki&props=claims|sitelinks&sitefilter=enwiki&titles=" + encodeURIComponent(part.join("|")), { headers: UA });
  for (const e of Object.values((await r.json()).entities || {})) {
    const t = e.sitelinks?.enwiki?.title, k = part.indexOf(t) < 0 ? -1 : i + part.indexOf(t);
    if (k < 0 || opc[k]) continue;
    // código em uso: rank preferido, senão o primeiro sem data de fim (P582)
    const cs = (e.claims?.P230 || []).filter(c => c.mainsnak?.datavalue && !c.qualifiers?.P582);
    const c = cs.find(c => c.rank === "preferred") || cs[0];
    if (c && /^[A-Z]{3}$/.test(c.mainsnak.datavalue.value)) opc[k] = c.mainsnak.datavalue.value;
  }
}
// frota atual de cada companhia (tabela "Fleet" do artigo na Wikipedia), em códigos ICAO de tipo:
// reserva da aeronave provável quando a companhia ainda não foi vista no ADS-B
const TIPO = [[/A220-100|CS100/, "BCS1"], [/A220-300|CS300/, "BCS3"], [/A319neo/, "A19N"], [/A320neo/, "A20N"], [/A321neo|A321LR|A321XLR/, "A21N"],
  [/A318/, "A318"], [/A319/, "A319"], [/A320/, "A320"], [/A321/, "A321"], [/A330-200/, "A332"], [/A330-300/, "A333"], [/A330-800/, "A338"],
  [/A330-900/, "A339"], [/A340-300/, "A343"], [/A340-600/, "A346"], [/A350-900/, "A359"], [/A350-1000/, "A35K"], [/A380/, "A388"],
  [/737 MAX 7|737-7\b/, "B37M"], [/737 MAX 8|737-8\b|737-8200/, "B38M"], [/737 MAX 9|737-9\b/, "B39M"], [/737 MAX 10|737-10\b/, "B3XM"],
  [/737-600/, "B736"], [/737-700/, "B737"], [/737-800/, "B738"], [/737-900/, "B739"], [/757-200/, "B752"], [/757-300/, "B753"],
  [/767-300/, "B763"], [/767-400/, "B764"], [/777-200LR/, "B77L"], [/777-300ER/, "B77W"], [/777-200/, "B772"], [/777-300/, "B773"],
  [/787-8/, "B788"], [/787-9/, "B789"], [/787-10/, "B78X"], [/747-400/, "B744"], [/747-8/, "B748"], [/717/, "B712"],
  [/E190-E2|E190 E2|E2-190/, "E290"], [/E195-E2|E195 E2|E2-195/, "E295"], [/E170|Embraer 170/, "E170"], [/E175|Embraer 175/, "E175"],
  [/E190|Embraer 190/, "E190"], [/E195|Embraer 195/, "E195"], [/ERJ[- ]?145/, "E145"], [/CRJ[- ]?200/, "CRJ2"], [/CRJ[- ]?700/, "CRJ7"],
  [/CRJ[- ]?900/, "CRJ9"], [/CRJ[- ]?1000/, "CRJX"], [/ATR 72/, "AT76"], [/ATR 42/, "AT46"], [/Cessna 208|Caravan/, "C208"], [/Q400|Dash 8-400|DHC-8-400/, "DH8D"], [/Superjet/, "SU95"],
  [/C919/, "C919"], [/ARJ21|C909/, "AJ27"]];
// frota informada à mão quando o artigo não tem tabela "Fleet" que dê para ler
const FROTA_EXTRA = { "Azul Conecta": "C208" };
const frota = [];
for (let i = 0; i < ops.length; i++) {
  const t = titulo[ops[i]] || ops[i], tipos = new Set();
  try {
    const secs = (await (await fetch(W + "action=parse&prop=sections&redirects=1&page=" + encodeURIComponent(t), { headers: UA })).json()).parse?.sections || [];
    const f = secs.find(s => /^(current )?fleet$/i.test(s.line.replace(/<[^>]+>/g, "").trim()));
    if (f) {
      let html = (await (await fetch(W + "action=parse&prop=text&redirects=1&page=" + encodeURIComponent(t) + "&section=" + f.index, { headers: UA })).json()).parse?.text || "";
      html = html.split(/<h[2-4][^>]*>[^<]*(?:<[^>]+>)*[^<]*(?:former|retired|historic|past|previous|cargo)/i)[0]; // só a frota atual de passageiros
      const tab = html.split(/<table/i)[1] || "";
      for (const tr of tab.split(/<tr[\s>]/i).slice(2)) {
        const cels = tr.split(/<\/t[dh]>/i).map(c => c.replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;/g, " ").replace(/\[\d+\]/g, "").trim());
        if (/^(—|–|-|0)?$/.test(cels[1] || "")) continue; // coluna "In service" vazia ou zero: só encomenda
        const m = TIPO.find(([re]) => re.test(cels[0]));
        if (m) tipos.add(m[1]);
      }
    }
  } catch (e) { /* sem frota na Wikipedia */ }
  frota.push(tipos.size ? [...tipos].join(" ") : FROTA_EXTRA[ops[i]] || "");
  await new Promise(r => setTimeout(r, 150));
}
console.log(`${frota.filter(Boolean).length} de ${ops.length} companhias com frota na Wikipedia`);
const aeroportos = {};
for (const c of used) aeroportos[c] = ap[c];
fs.writeFileSync(out, JSON.stringify({ data: new Date().toISOString().slice(0, 10), fonte: "Wikipedia (Airlines and destinations)", hubs: HUBS, ops, opc, frota, rotas, aeroportos, icao }));
console.log(`${opc.filter(Boolean).length} de ${ops.length} companhias com código ICAO`);
const pares = new Set(rotas.map(r => r[0] + "-" + r[1]));
console.log(`${rotas.length} rotas · ${pares.size} ligações · ${used.length} aeroportos (${Object.keys(icao).length} com ICAO) · ${ops.length} companhias -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
