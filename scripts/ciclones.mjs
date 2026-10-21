// Baixa os ciclones tropicais ativos (furacões, tufões, ciclones) do GDACS e grava um ciclones.json
// com a posição atual, a trilha percorrida e a previsão. Como o METAR, o GDACS não libera CORS,
// então isto roda no GitHub Actions e o site lê o arquivo gerado.
// O GDACS às vezes fica lento: cada consulta tenta 3 vezes e, se ainda falhar, a tempestade
// é mantida como estava no ciclones.json publicado (desde que tenha boletim das últimas 36 h).
// Uso: node scripts/ciclones.mjs <saída.json> [url do ciclones.json publicado]
import { writeFileSync } from "node:fs";

const [out = "ciclones.json", prevUrl] = process.argv.slice(2);
const API = "https://www.gdacs.org/gdacsapi/api";
const get = async url => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000), headers: { "User-Agent": "cargoconnections (GitHub Actions)" } });
      if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
      return await r.json();
    } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 5000 * i)); }
  }
};
const day = d => d.toISOString().slice(0, 10);
// "20 Oct 2026 18:00" (UTC) -> ISO
const when = s => { const d = new Date(s + " UTC"); return isNaN(d) ? null : d.toISOString(); };
const pt = x => ({ t: when(x.advisory_datetime), lat: +x.latitude, lon: +x.longitude,
  v: Math.round(+x.wind_speed * 3.6), st: [].concat(x.storm_status)[0] || "" });

const now = new Date();
const fresh = c => c && c.atual && c.atual.t && now - new Date(c.atual.t) <= 36 * 3600e3;
const prev = await (async () => { if (!prevUrl) return []; try { return (await get(`${prevUrl}?t=${Date.now()}`)).ciclones || []; } catch { return []; } })();
let list;
try { list = await get(`${API}/events/geteventlist/SEARCH?eventlist=TC&fromDate=${day(new Date(now - 15 * 864e5))}&toDate=${day(now)}&alertlevel=green;orange;red`); }
catch (e) { // lista indisponível: republica o que já estava no ar
  console.warn(`lista do GDACS: ${e.message}`);
  const keep = prev.filter(fresh);
  writeFileSync(out, JSON.stringify({ atualizado_em: now.toISOString(), fonte: "GDACS (último boletim obtido)", ciclones: keep }));
  console.log(`${keep.length} ciclone(s) mantido(s) da versão publicada -> ${out}`);
  process.exit(0);
}
const ciclones = [];
for (const f of list.features || []) {
  const p = f.properties;
  if (p.iscurrent !== "true") continue;
  try {
    const det = await get(`${API}/events/geteventdata?eventtype=TC&eventid=${p.eventid}`);
    const tl = (det.properties.impacts || []).map(i => i.resource && i.resource.timeline).find(Boolean);
    if (!tl) continue;
    const items = (await get(tl)).channel.item || [];
    const real = items.filter(x => x.actual === "True").sort((a, b) => a.advisory_number - b.advisory_number);
    const cur = real.find(x => x.current === "true" || x.current === "True") || real[real.length - 1];
    if (!cur) continue;
    const atual = pt(cur);
    if (!atual.t || now - new Date(atual.t) > 36 * 3600e3) continue; // sem boletim novo há 36 h: já se dissipou
    const prev = items.filter(x => x.actual === "False" && x.advisory_number === cur.advisory_number).map(pt)
      .filter(q => q.t).sort((a, b) => a.t.localeCompare(b.t));
    ciclones.push({
      id: p.eventid, nome: String(p.eventname || p.name).replace(/-\d+$/, ""), alerta: p.alertlevel,
      fonte: p.source, link: p.url && p.url.report, atual,
      // trilha: [lon, lat, horário ISO, vento km/h]
      trilha: real.slice(-30).map(x => { const q = pt(x); return [q.lon, q.lat, q.t, q.v]; }), previsao: prev,
    });
  } catch (e) {
    console.warn(`${p.eventname}: ${e.message}`);
    const old = prev.find(c => c.id === p.eventid);
    if (fresh(old)) ciclones.push(old);
  }
}
writeFileSync(out, JSON.stringify({ atualizado_em: now.toISOString(), fonte: "GDACS", ciclones }));
console.log(`${ciclones.length} ciclone(s) ativo(s): ${ciclones.map(c => `${c.nome} ${c.atual.v} km/h`).join(", ") || "nenhum"} -> ${out}`);
