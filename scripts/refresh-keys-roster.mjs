// Baixa o roster completo (todos os 5 jogadores, do core ou não) de cada chave
// mítica+ recente feita por membros do core, via raider.io. O endpoint público
// v1 só retorna a run do próprio personagem, sem o grupo inteiro — por isso
// usamos o endpoint interno /api/mythic-plus/runs/{season}/{slug} (sem CORS,
// não dá pra chamar direto do navegador) e baixamos aqui, gravando um JSON
// estático que o hub lê no mesmo domínio (data/keys-roster.json).
import fs from 'node:fs';

const ROSTER = [
  ['Bahryzta', 'azralon'], ['Ormot', 'azralon'],
  ['Athelìa', 'azralon'], ['Buticodeoro', 'azralon'], ['Chiso', 'azralon'], ['Salkiing', 'azralon'], ['Tessagrayh', 'azralon'],
  ['Aloppes', 'azralon'], ['Carina', 'azralon'], ['Dïazepam', 'stormrage'], ['Dracullaura', 'azralon'], ['Euridice', 'azralon'],
  ['Feanori', 'nemesis'], ['Grömdak', 'azralon'], ['Hakarvyr', 'azralon'], ['Hyzor', 'azralon'], ['Inflexível', 'azralon'],
  ['Jazzkiler', 'azralon'], ['Kissuko', 'stormrage'], ['Kolhberg', 'tichondrius'], ['Riswen', 'azralon'], ['Saponáceo', 'area-52'],
  ['Seind', 'azralon'], ['Tiagolargado', 'azralon'], ['Valunii', 'azralon']
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const runsById = new Map();
  for (const [name, realm] of ROSTER) {
    const api = 'https://raider.io/api/v1/characters/profile?region=us&realm=' + encodeURIComponent(realm) +
      '&name=' + encodeURIComponent(name) + '&fields=mythic_plus_recent_runs:20';
    const r = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { console.error('falhou', name, realm, r.status); continue; }
    const data = await r.json();
    (data.mythic_plus_recent_runs || []).forEach((run) => {
      if (!runsById.has(run.keystone_run_id)) runsById.set(run.keystone_run_id, run);
    });
    await sleep(150);
  }

  console.log('chaves únicas encontradas:', runsById.size);
  const top = [...runsById.entries()]
    .sort((a, b) => new Date(b[1].completed_at) - new Date(a[1].completed_at))
    .slice(0, 30);
  console.log('baixando roster completo das', top.length, 'mais recentes (mesmo corte do hub)');

  const out = {};
  for (const [id, run] of top) {
    const apiUrl = run.url.replace('https://raider.io/mythic-plus-runs/', 'https://raider.io/api/mythic-plus/runs/');
    try {
      const r = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { console.error('falhou run', id, r.status); continue; }
      const data = await r.json();
      const roster = (data.keystoneRun && data.keystoneRun.roster) || [];
      out[id] = roster.map((m) => ({
        name: m.character.name,
        realm: m.character.realm.slug,
        class: m.character.class.name
      }));
    } catch (e) {
      console.error('erro run', id, e.message);
    }
    await sleep(150);
  }

  fs.writeFileSync(new URL('../data/keys-roster.json', import.meta.url), JSON.stringify(out));
  console.log('salvo', Object.keys(out).length, 'rosters completos');
}

main();
