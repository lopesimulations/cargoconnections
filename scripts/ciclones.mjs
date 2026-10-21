// Baixa os ciclones tropicais ativos (furacões, tufões, ciclones) do GDACS e grava um ciclones.json
// com a posição atual, a trilha percorrida e a previsão. Como o METAR, o GDACS não libera CORS,
// então isto roda no GitHub Actions e o site lê o arquivo gerado.
// Usa os arquivos estáticos do GDACS (RSS dos ciclones e o GeoJSON de cada um), que respondem em segundos;
// a API de consultas (gdacsapi) às vezes leva minutos e derrubava os ciclones do site.
// O arquivo é gravado logo no início com o que já estava publicado e regravado a cada tempestade obtida,
// com prazo total de 5 min; o que não chegar a tempo fica como estava, desde que tenha boletim das últimas 36 h.
// Uso: node scripts/ciclones.mjs <saída.json> [url do ciclones.json publicado]
import { writeFileSync } from "node:fs";

const [out = "ciclones.json", prevUrl] = process.argv.slice(2);
const deadline = Date.now() + 5 * 60e3;
const fetchT = async (url, max = 60000) => {
  const ms = Math.min(max, deadline - Date.now());
  if (ms < 3000) throw new Error("sem tempo");
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "cargoconnections (GitHub Actions)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r;
};
// "21/10/2026 12:00:00" ou "21 Oct 2026 00:00:00" (UTC) -> ISO
const iso = s => {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  const d = m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])) : new Date(s + " UTC");
  return isNaN(d) ? null : d.toISOString();
};
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)); return m ? m[1].trim() : ""; };

const now = new Date();
const fresh = c => c && c.atual && c.atual.t && now - new Date(c.atual.t) <= 36 * 3600e3;
const prev = await (async () => { if (!prevUrl) return []; try { return ((await (await fetchT(`${prevUrl}?t=${Date.now()}`, 20000)).json()).ciclones || []).filter(fresh); } catch { return []; } })();
const novos = new Map();
let fonte = "GDACS (último boletim obtido)";
const save = () => {
  const ciclones = [...novos.values(), ...prev.filter(c => !novos.has(c.id))];
  writeFileSync(out, JSON.stringify({ atualizado_em: now.toISOString(), fonte, ciclones }));
  return ciclones;
};
save(); // se o GDACS travar, o site ainda recebe os ciclones publicados antes

try {
  const rss = await (await fetchT("https://www.gdacs.org/xml/rss_tc_7d.xml")).text();
  fonte = "GDACS";
  const ativos = new Set();
  for (const it of rss.split("<item>").slice(1)) {
    if (tag(it, "gdacs:iscurrent") !== "true") continue;
    const id = +tag(it, "gdacs:eventid"), ep = tag(it, "gdacs:episodeid");
    ativos.add(id);
    try {
      const gj = await (await fetchT(`https://www.gdacs.org/contentdata/resources/TC/${id}/geojson_${id}_${ep}.geojson`)).json();
      const F = gj.features || [], cen = F.find(f => f.properties.Class === "Point_Centroid");
      if (!cen) continue;
      const P = cen.properties;
      const atual = { t: iso(P.todate), lat: +P.latitude, lon: +P.longitude, v: Math.round(+P.current_windspeed || +P.windspeed), st: P.current_stormstatus || P.stormstatus || "" };
      if (!atual.t || now - new Date(atual.t) > 36 * 3600e3) continue; // sem boletim novo há 36 h: já se dissipou
      const pts = F.filter(f => /^Point_\d+$/.test(f.properties.Class))
        .map(f => ({ prev: f.properties.polygonlabel === "previous position", t: iso(f.properties.trackdate), lat: +f.properties.latitude, lon: +f.properties.longitude, v: Math.round(+f.properties.windspeed), st: f.properties.stormstatus || "" }))
        .filter(q => q.t).sort((a, b) => a.t.localeCompare(b.t));
      const real = pts.filter(q => q.prev && q.t < atual.t); // posições anteriores; a atual entra no fim da trilha
      novos.set(id, {
        id, nome: String(P.eventname || tag(it, "gdacs:eventname")).replace(/-\d+$/, ""), alerta: P.alertlevel || tag(it, "gdacs:alertlevel"),
        fonte: P.source, link: `https://www.gdacs.org/report.aspx?eventtype=TC&eventid=${id}`, atual,
        // trilha: [lon, lat, horário ISO, vento km/h]
        trilha: [...real.slice(-29).map(q => [q.lon, q.lat, q.t, q.v]), [atual.lon, atual.lat, atual.t, atual.v]],
        previsao: pts.filter(q => !q.prev && q.t > atual.t).map(({ t, lat, lon, v, st }) => ({ t, lat, lon, v, st })),
      });
      save();
    } catch (e) { console.warn(`${tag(it, "gdacs:eventname")}: ${e.message}`); }
  }
  // tempestades que o GDACS já não lista como ativas saem do arquivo
  for (let i = prev.length - 1; i >= 0; i--) if (!ativos.has(prev[i].id)) prev.splice(i, 1);
} catch (e) { console.warn(`lista do GDACS: ${e.message}`); }
const ciclones = save();
console.log(`${ciclones.length} ciclone(s): ${ciclones.map(c => `${c.nome} ${c.atual.v} km/h`).join(", ") || "nenhum"} (${fonte}) -> ${out}`);
