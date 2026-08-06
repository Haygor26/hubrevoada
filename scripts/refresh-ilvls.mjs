import fs from 'fs';

const TOKEN = process.argv[2];
if (!TOKEN) throw new Error('usage: node refresh-ilvls.mjs <token>');

const FILE = new URL('../index.html', import.meta.url);
let html = fs.readFileSync(FILE, 'utf8');

const entryRe = /\['([^']+)','([a-z]+)','([^']+)',(\d+),'([a-z0-9-]+)',(\d+)\]/g;
const entries = [...html.matchAll(entryRe)];

async function getIlvl(name, realm) {
  const slug = name.toLowerCase();
  const url = `https://us.api.blizzard.com/profile/wow/character/${realm}/${encodeURIComponent(slug)}?namespace=profile-us&locale=en_US`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) return { error: r.status };
  const d = await r.json();
  return { ilvl: d.equipped_item_level };
}

const changes = [];
for (const m of entries) {
  const [full, name, cls, spec, ilvl, realm] = m;
  const res = await getIlvl(name, realm);
  if (res.error) {
    console.log(`ERRO ${name}-${realm}: HTTP ${res.error}`);
    continue;
  }
  if (res.ilvl !== Number(ilvl)) {
    changes.push({ name, realm, before: Number(ilvl), after: res.ilvl });
    const newEntry = full.replace(`,${ilvl},'${realm}'`, `,${res.ilvl},'${realm}'`);
    html = html.replace(full, newEntry);
  }
}

fs.writeFileSync(FILE, html, 'utf8');
if (changes.length === 0) {
  console.log('Nenhuma mudança de ilvl.');
} else {
  console.log('Mudanças:');
  changes.forEach(c => console.log(`  ${c.name} (${c.realm}): ${c.before} -> ${c.after}`));
}
