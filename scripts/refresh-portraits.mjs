// Rebaixa os avatares de todo o ROSTER via Blizzard API e regrava o var PORTRAITS do index.html
// como data URIs (snapshot — não acompanha troca de transmog, tem que rodar de novo).
// Uso: node scripts/refresh-portraits.mjs
import fs from 'fs';

const FILE = new URL('../index.html', import.meta.url);
const CREDS_FILE = new URL('./.blizzard-credentials.json', import.meta.url);

function loadCredentials() {
  if (process.env.BNET_CLIENT_ID && process.env.BNET_CLIENT_SECRET) {
    return { clientId: process.env.BNET_CLIENT_ID, clientSecret: process.env.BNET_CLIENT_SECRET };
  }
  if (fs.existsSync(CREDS_FILE)) {
    const { clientId, clientSecret } = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  throw new Error('faltam credenciais: defina BNET_CLIENT_ID/BNET_CLIENT_SECRET ou scripts/.blizzard-credentials.json');
}

async function getToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`oauth falhou: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

// avatar do personagem: /character-media -> assets[key=avatar].value
async function fetchAvatarUrl(token, name, realm) {
  const url = `https://us.api.blizzard.com/profile/wow/character/${realm}/${encodeURIComponent(name.toLowerCase())}/character-media?namespace=profile-us&locale=en_US`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`character-media HTTP ${r.status}`);
  const d = await r.json();
  const avatar = (d.assets || []).find(a => a.key === 'avatar');
  if (!avatar) throw new Error('sem asset avatar');
  return avatar.value;
}

async function toDataUri(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download avatar HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${buf.toString('base64')}`;
}

const { clientId, clientSecret } = loadCredentials();
let html = fs.readFileSync(FILE, 'utf8');

// ROSTER: [nome, classe, spec, ilvl, reino, specId]
const roster = [...html.matchAll(/\['([^']+)','[a-z]+','[^']+',\d+,'([a-z0-9-]+)',\d+\]/g)].map(m => [m[1], m[2]]);
if (!roster.length) throw new Error('ROSTER não encontrado no index.html');
const oldMatch = html.match(/var PORTRAITS = (\{[\s\S]*?\});/);
if (!oldMatch) throw new Error('PORTRAITS não encontrado no index.html');
const oldPortraits = JSON.parse(oldMatch[1]);

console.log('Autenticando na Blizzard...');
const token = await getToken(clientId, clientSecret);

const portraits = {};
let ok = 0, reused = 0, fail = 0;

for (const [name, realm] of roster) {
  try {
    portraits[name] = await toDataUri(await fetchAvatarUrl(token, name, realm));
    ok++;
    console.log(`  ${name} (${realm}) ok`);
  } catch (err) {
    if (oldPortraits[name]) {
      portraits[name] = oldPortraits[name];
      reused++;
      console.log(`  ${name} (${realm}) FALHOU (${err.message}) — mantido o portrait antigo`);
    } else {
      fail++;
      console.log(`  ${name} (${realm}) FALHOU (${err.message}) — sem portrait`);
    }
  }
}

html = html.replace(/var PORTRAITS = \{[\s\S]*?\};/, `var PORTRAITS = ${JSON.stringify(portraits)};`);
fs.writeFileSync(FILE, html, 'utf8');
const kb = Math.round(Buffer.byteLength(JSON.stringify(portraits)) / 1024);
console.log(`Portraits: ${ok} atualizados, ${reused} reaproveitados, ${fail} sem imagem (${roster.length} no roster, ~${kb}KB).`);
