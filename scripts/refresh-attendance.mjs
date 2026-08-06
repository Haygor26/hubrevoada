import fs from 'fs';

const FILE = new URL('../index.html', import.meta.url);
const CREDS_FILE = new URL('./.wcl-credentials.json', import.meta.url);

function loadCredentials() {
  const [argId, argSecret] = process.argv.slice(2);
  if (argId && argSecret) return { clientId: argId, clientSecret: argSecret };
  if (process.env.WCL_CLIENT_ID && process.env.WCL_CLIENT_SECRET) {
    return { clientId: process.env.WCL_CLIENT_ID, clientSecret: process.env.WCL_CLIENT_SECRET };
  }
  if (fs.existsSync(CREDS_FILE)) {
    const { clientId, clientSecret } = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  throw new Error('faltam credenciais: node refresh-attendance.mjs <client_id> <client_secret> (ou WCL_CLIENT_ID/WCL_CLIENT_SECRET, ou scripts/.wcl-credentials.json)');
}

const GUILD_NAME = 'Revoada Bafônica';
const GUILD_SERVER_SLUG = 'azralon';
const GUILD_SERVER_REGION = 'US';
const LOG_OWNERS = ['mattchi', 'victoriarf']; // owners dos logs de core, case-insensitive
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

async function fetchGuildReports(token, startTime, endTime) {
  const query = `
    query($name: String!, $slug: String!, $region: String!, $page: Int, $startTime: Float, $endTime: Float) {
      reportData {
        reports(guildName: $name, guildServerSlug: $slug, guildServerRegion: $region, page: $page, startTime: $startTime, endTime: $endTime) {
          data { code startTime owner { name } }
          has_more_pages
        }
      }
    }`;
  let all = [];
  let page = 1;
  while (true) {
    const data = await gql(token, query, {
      name: GUILD_NAME, slug: GUILD_SERVER_SLUG, region: GUILD_SERVER_REGION,
      page, startTime, endTime
    });
    const { data: rows, has_more_pages } = data.reportData.reports;
    all = all.concat(rows);
    if (!has_more_pages) break;
    page++;
  }
  return all;
}

async function fetchReportAttendees(token, code) {
  const query = `
    query($code: String!) {
      reportData {
        report(code: $code) {
          playerDetails(translate: true, startTime: 0, endTime: 999999999)
        }
      }
    }`;
  const data = await gql(token, query, { code });
  let pd = data.reportData.report.playerDetails;
  if (typeof pd === 'string') pd = JSON.parse(pd);
  const details = pd?.data?.playerDetails || pd?.playerDetails || pd || {};
  const names = [];
  for (const bucket of ['tanks', 'healers', 'dps']) {
    for (const p of details[bucket] || []) if (p?.name) names.push(p.name);
  }
  return names;
}

function nightKeyFromTimestamp(ms) {
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, month: 'numeric', day: 'numeric' });
  const parts = fmt.formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${Number(parts.month)}/${Number(parts.day)}`;
}

async function main() {
  const { clientId, clientSecret } = loadCredentials();
  let html = fs.readFileSync(FILE, 'utf8');

  const nightsMatch = html.match(/var NIGHTS = (\[[\s\S]*?\]);/);
  if (!nightsMatch) throw new Error('NIGHTS não encontrado no index.html');
  const NIGHTS = JSON.parse(nightsMatch[1]);
  const nightKeys = NIGHTS.map(n => `${n[0]}/${n[1]}`);

  const rosterNames = [...html.matchAll(/\['([^']+)','[a-z]+','[^']+',\d+,'[a-z0-9-]+',\d+\]/g)].map(m => m[1]);
  const rosterByNormalized = new Map(rosterNames.map(n => [stripAccents(n), n]));

  const firstNight = Date.UTC(NIGHTS[0][2], NIGHTS[0][0] - 1, NIGHTS[0][1]) - 12 * 3600 * 1000;
  const lastNight = Date.UTC(NIGHTS[NIGHTS.length - 1][2], NIGHTS[NIGHTS.length - 1][0] - 1, NIGHTS[NIGHTS.length - 1][1]) + 36 * 3600 * 1000;

  console.log('Autenticando na WarcraftLogs...');
  const token = await getToken(clientId, clientSecret);

  console.log('Buscando reports da guild...');
  const reports = await fetchGuildReports(token, firstNight / 1000, lastNight / 1000);
  const coreReports = reports.filter(r => LOG_OWNERS.includes((r.owner?.name || '').toLowerCase()));
  console.log(`${reports.length} reports no período, ${coreReports.length} de owners de core (${LOG_OWNERS.join(', ')}).`);

  const ATT = {};
  const loggedNightKeys = new Set();

  for (const report of coreReports) {
    const key = nightKeyFromTimestamp(report.startTime);
    if (!nightKeys.includes(key)) continue; // fora das noites de core cadastradas
    console.log(`  lendo report ${report.code} (${key})...`);
    const names = await fetchReportAttendees(token, report.code);
    loggedNightKeys.add(key);
    for (const rawName of names) {
      const rosterName = rosterByNormalized.get(stripAccents(rawName));
      if (!rosterName) continue; // personagem fora do roster (alt, trial, etc.)
      ATT[rosterName] = ATT[rosterName] || {};
      ATT[rosterName][key] = 1;
    }
  }

  let lastLogged = -1;
  nightKeys.forEach((k, i) => { if (loggedNightKeys.has(k)) lastLogged = i; });

  html = html.replace(/var LAST_LOGGED = -?\d+;/, `var LAST_LOGGED = ${lastLogged};`);
  html = html.replace(/var ATT = \{[\s\S]*?\};/, `var ATT = ${JSON.stringify(ATT)};`);

  fs.writeFileSync(FILE, html, 'utf8');
  console.log(`Pronto. ${loggedNightKeys.size} noites com log, LAST_LOGGED=${lastLogged}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
