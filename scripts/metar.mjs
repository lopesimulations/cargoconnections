// Baixa o METAR de todos os aeroportos do site (hubs e destinos) e grava um metar.json.
// O aviationweather.gov não libera CORS, então o navegador não consegue buscar direto;
// este script roda no GitHub Actions e o site lê o arquivo gerado.
// Uso: node scripts/metar.mjs <index.html> <saída.json>
import { readFileSync, writeFileSync } from "node:fs";

const [src = "index.html", out = "metar.json"] = process.argv.slice(2);
const html = readFileSync(src, "utf8");
const m = html.match(/const ICAO=(\{.*?\});/);
if (!m) throw new Error("mapa ICAO não encontrado em " + src);
const ids = [...new Set(Object.values(JSON.parse(m[1])))].filter(i => /^[A-Z0-9]{4}$/.test(i));

const metar = {};
for (let i = 0; i < ids.length; i += 40) {
  const url = `https://aviationweather.gov/api/data/metar?format=raw&ids=${ids.slice(i, i + 40).join(",")}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "rotas-cargueiras (GitHub Actions)" } });
    if (!r.ok) { console.warn(`lote ${i / 40 + 1}: HTTP ${r.status}`); continue; }
    for (const l of (await r.text()).split("\n")) {
      const s = l.trim().replace(/^(METAR|SPECI)\s+/, "");
      if (/^[A-Z0-9]{4}\s/.test(s)) metar[s.slice(0, 4)] = s;
    }
  } catch (e) { console.warn(`lote ${i / 40 + 1}: ${e.message}`); }
}

const n = Object.keys(metar).length;
if (!n) { console.error("nenhum METAR recebido"); process.exit(1); }
writeFileSync(out, JSON.stringify({ atualizado_em: new Date().toISOString(), fonte: "aviationweather.gov (METAR)", metar }));
console.log(`${n} de ${ids.length} aeroportos com METAR -> ${out}`);
