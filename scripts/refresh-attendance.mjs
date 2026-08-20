import fs from 'fs';

const FILE = new URL('../index.html', import.meta.url);
const CREDS_FILE = new URL('./.wcl-credentials.json', import.meta.url);

function loadCredentials() {
  if (process.env.WCL_CLIENT_ID && process.env.WCL_CLIENT_SECRET) {
    return { clientId: process.env.WCL_CLIENT_ID, clientSecret: process.env.WCL_CLIENT_SECRET };
  }
  if (fs.existsSync(CREDS_FILE)) {
    const { clientId, clientSecret } = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  throw new Error('faltam credenciais: defina WCL_CLIENT_ID/WCL_CLIENT_SECRET ou scripts/.wcl-credentials.json');
}

const TIMEZONE = 'America/Sao_Paulo';

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function getToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`oauth falhou: HTTP ${r.status}`);
  const d = await r.json();
  return d.access_token;
}

async function gql(token, query, variables) {
  const r = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const d = await r.json();
  if (d.errors) throw new Error('GraphQL erro: ' + JSON.stringify(d.errors));
  return d.data;
}

async function fetchReport(token, code) {
  const query = `
    query($code: String!) {
      reportData {
        report(code: $code) {
          startTime
          owner { name }
          playerDetails(translate: true, startTime: 0, endTime: 999999999)
        }
      }
    }`;
  const data = await gql(token, query, { code });
  const report = data.reportData.report;
  if (!report) throw new Error(`report ${code} não encontrado (código errado?)`);
  let pd = report.playerDetails;
  if (typeof pd === 'string') pd = JSON.parse(pd);
  const details = pd?.data?.playerDetails || pd?.playerDetails || pd || {};
  const names = [];
  for (const bucket of ['tanks', 'healers', 'dps']) {
    for (const p of details[bucket] || []) if (p?.name) names.push(p.name);
  }
  return { startTime: report.startTime, owner: report.owner?.name, names };
}

function nightKeyFromTimestamp(ms) {
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, month: 'numeric', day: 'numeric' });
  const parts = fmt.formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${Number(parts.month)}/${Number(parts.day)}`;
}

async function main() {
  const codes = process.argv.slice(2);
  if (codes.length === 0) {
    throw new Error('usage: node refresh-attendance.mjs <reportCode1> [reportCode2] ...\n' +
      '(busca por guilda não funciona — reports da guild são privados e client_credentials não os enxerga; sempre passar o código do report direto)');
  }

  const { clientId, clientSecret } = loadCredentials();
  let html = fs.readFileSync(FILE, 'utf8');

  const nightsMatch = html.match(/var NIGHTS = (\[[\s\S]*?\]);/);
  if (!nightsMatch) throw new Error('NIGHTS não encontrado no index.html');
  const NIGHTS = JSON.parse(nightsMatch[1]);
  const nightKeys = NIGHTS.map(n => `${n[0]}/${n[1]}`);

  const rosterNames = [...html.matchAll(/\['([^']+)','[a-z]+','[^']+',\d+,'[a-z0-9-]+',\d+\]/g)].map(m => m[1]);
  const rosterByNormalized = new Map(rosterNames.map(n => [stripAccents(n), n]));

  const attMatch = html.match(/var ATT = (\{[\s\S]*?\});/);
  const lastLoggedMatch = html.match(/var LAST_LOGGED = (-?\d+);/);
  if (!attMatch || !lastLoggedMatch) throw new Error('ATT/LAST_LOGGED não encontrados no index.html');
  const ATT = JSON.parse(attMatch[1]);
  let lastLogged = Number(lastLoggedMatch[1]);

  console.log('Autenticando na WarcraftLogs...');
  const token = await getToken(clientId, clientSecret);

  const touchedKeys = new Set();
  for (const code of codes) {
    console.log(`Lendo report ${code}...`);
    const { startTime, owner, names } = await fetchReport(token, code);
    const key = nightKeyFromTimestamp(startTime);
    if (!nightKeys.includes(key)) {
      console.log(`  AVISO: noite ${key} (owner ${owner}) não está em NIGHTS, pulando.`);
      continue;
    }
    console.log(`  noite ${key}, owner ${owner}, ${names.length} jogadores no log.`);
    let matched = 0;
    for (const rawName of names) {
      const rosterName = rosterByNormalized.get(stripAccents(rawName));
      if (!rosterName) continue; // personagem fora do roster (alt, trial, etc.)
      ATT[rosterName] = ATT[rosterName] || {};
      ATT[rosterName][key] = 1;
      matched++;
    }
    console.log(`  ${matched} bateram com o roster.`);
    touchedKeys.add(key);
  }

  if (touchedKeys.size === 0) {
    console.log('Nenhuma noite válida processada — nada foi alterado no arquivo.');
    return;
  }

  nightKeys.forEach((k, i) => { if (touchedKeys.has(k) && i > lastLogged) lastLogged = i; });

  html = html.replace(/var LAST_LOGGED = -?\d+;/, `var LAST_LOGGED = ${lastLogged};`);
  html = html.replace(/var ATT = \{[\s\S]*?\};/, `var ATT = ${JSON.stringify(ATT)};`);

  fs.writeFileSync(FILE, html, 'utf8');
  console.log(`Pronto. Noites atualizadas: ${[...touchedKeys].join(', ')}. LAST_LOGGED=${lastLogged}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
