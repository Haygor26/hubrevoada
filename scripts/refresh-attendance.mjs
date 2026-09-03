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

// WCL guild id (NÃO é o guild id do Raider.io, é outro número) — descoberto via
// guildData.guild(name, serverSlug, serverRegion) ou reportData.report(code).guild.id
const GUILD_ID = 693273;
const LOG_OWNERS = ['mattchi', 'victoriarf', 'lipitakke', 'haygor']; // owners dos logs de core, case-insensitive
const TIMEZONE = 'America/Sao_Paulo';

// bosses rastreados no Pulls, na ordem exibida no site — precisa bater com os KILLS_* do index.html
const VA_BOSSES = [
  ["Nek'zali the Soulcoiler", 3470],
  ['Entombed Sentinels', 3445],
  ['The Lost Explorers', 3497],
  ['Vashnik the Malignant', 3455],
  ['Sszorak', 3420],
  ['The Twin Fangs', 3421],
  ['The Coiled Altar', 3429],
  ["Ula'tek", 3492]
];
const TG_BOSSES = [['Nymrissa Wavecaller', 3379]];
const DIFF = { normal: 3, heroic: 4, mythic: 5 };

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
  // IMPORTANTE: usar guildID (numérico), NÃO guildName/guildServerSlug/guildServerRegion —
  // essa segunda forma retorna vazio pra reports marcados privados. guildID enxerga tudo.
  const query = `
    query($guildID: Int!, $page: Int, $startTime: Float, $endTime: Float) {
      reportData {
        reports(guildID: $guildID, page: $page, startTime: $startTime, endTime: $endTime) {
          data { code startTime owner { name } }
          has_more_pages
        }
      }
    }`;
  let all = [];
  let page = 1;
  while (true) {
    const data = await gql(token, query, { guildID: GUILD_ID, page, startTime, endTime });
    const { data: rows, has_more_pages } = data.reportData.reports;
    all = all.concat(rows);
    if (!has_more_pages) break;
    page++;
  }
  return all;
}

async function fetchReportDetails(token, code) {
  const query = `
    query($code: String!) {
      reportData {
        report(code: $code) {
          startTime
          owner { name }
          playerDetails(translate: true, startTime: 0, endTime: 999999999)
          fights { name kill difficulty encounterID }
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
  return { startTime: report.startTime, owner: report.owner?.name, names, fights: report.fights || [] };
}

function nightKeyFromTimestamp(ms) {
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, month: 'numeric', day: 'numeric' });
  const parts = fmt.formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${Number(parts.month)}/${Number(parts.day)}`;
}

// tally de pulls/kill por encounterID+dificuldade a partir da lista de fights de 1 report.
// `pulls` = total de pulls no report; `pullsToKill` = quantos pulls foram necessários até a
// primeira kill (inclusive) — depois que o boss morre, os pulls de farm não contam mais.
function tallyFights(fights) {
  const tally = {};
  for (const f of fights) {
    if (!f.encounterID || !f.difficulty) continue;
    const key = f.encounterID + ':' + f.difficulty;
    const t = tally[key] = tally[key] || { pulls: 0, killed: false, pullsToKill: 0 };
    t.pulls++;
    if (!t.killed) {
      t.pullsToKill = t.pulls;
      if (f.kill) t.killed = true;
    }
  }
  return tally;
}

// combina o tally de vários reports da MESMA noite (loggers duplicados) pegando o
// máximo de pulls em vez de somar — evita contar a mesma sessão duas vezes
function mergeSameNightTallies(tallies) {
  const merged = {};
  for (const t of tallies) {
    for (const key of Object.keys(t)) {
      const m = merged[key] = merged[key] || { pulls: 0, killed: false, pullsToKill: 0 };
      m.pulls = Math.max(m.pulls, t[key].pulls);
      // entre loggers da mesma noite, vale o que viu mais pulls até a kill (sessão inteira)
      if (t[key].killed) {
        m.pullsToKill = m.killed ? Math.max(m.pullsToKill, t[key].pullsToKill) : t[key].pullsToKill;
        m.killed = true;
      } else if (!m.killed) {
        m.pullsToKill = Math.max(m.pullsToKill, t[key].pullsToKill);
      }
    }
  }
  return merged;
}

// acumula os tallies (já deduplicados por noite) em ordem CRONOLÓGICA: soma os pulls das noites
// anteriores e para de contar na noite em que o boss morreu — o número exibido é "quantos pulls
// foram necessários pra matar", não o total de pulls da season (farm depois da kill não conta).
function accumulateTallies(nights) {
  const acc = {};
  for (const { tally } of nights) {
    for (const key of Object.keys(tally)) {
      const a = acc[key] = acc[key] || { pulls: 0, killed: false };
      if (a.killed) continue;
      a.pulls += tally[key].pullsToKill;
      if (tally[key].killed) a.killed = true;
    }
  }
  return acc;
}

// monta o array [[nome, pulls, killed], ...] pra uma dificuldade, a partir do tally agregado
function buildKillsArray(bossList, difficulty, tally) {
  return bossList.map(([name, encounterID]) => {
    const t = tally[encounterID + ':' + difficulty];
    return [name, t ? t.pulls : 0, t ? t.killed : false];
  });
}

function replaceArray(html, varName, arr) {
  const re = new RegExp(`var ${varName} = \\[[\\s\\S]*?\\];`);
  if (!re.test(html)) throw new Error(`${varName} não encontrado no index.html`);
  const literal = '[\n    ' + arr.map(([n, p, k]) => `[${JSON.stringify(n)},${p},${k}]`).join(',\n    ') + '\n  ]';
  return html.replace(re, `var ${varName} = ${literal};`);
}

function updateProgressCard(html, killedVA, killedTG, killedVA_H, killedTG_H) {
  const totalNormal = killedVA + killedTG;
  const totalHeroic = killedVA_H + killedTG_H;
  const totalBosses = VA_BOSSES.length + TG_BOSSES.length;
  const pctN = (totalNormal / totalBosses * 100).toFixed(1).replace(/\.0$/, '');
  const pctH = (totalHeroic / totalBosses * 100).toFixed(1).replace(/\.0$/, '');
  html = html.replace(/<span class="lbl">Normal<\/span><b>\d+ \/ 9<\/b>/, `<span class="lbl">Normal</span><b>${totalNormal} / 9</b>`);
  html = html.replace(/<div class="fill n" data-w="[\d.]+"><\/div>/, `<div class="fill n" data-w="${pctN}"></div>`);
  html = html.replace(/<span class="lbl">Heroico<\/span><b>\d+ \/ 9<\/b>/, `<span class="lbl">Heroico</span><b>${totalHeroic} / 9</b>`);
  html = html.replace(/<div class="fill h" data-w="[\d.]+"><\/div>/, `<div class="fill h" data-w="${pctH}"></div>`);
  html = html.replace(/<span class="k">\d+\/9<\/span><span class="l">Normal · [^<]*<\/span>/, `<span class="k">${totalNormal}/9</span><span class="l">Normal · em progressão</span>`);
  const heroLabel = totalHeroic > 0 ? 'em progressão' : 'aguardando reset';
  html = html.replace(/<span class="k accent">\d+\/9<\/span><span class="l">Heroico · [^<]*<\/span>/, `<span class="k accent">${totalHeroic}/9</span><span class="l">Heroico · ${heroLabel}</span>`);
  html = html.replace(/<span class="hint">\d+\/9 chefes abatidos no Normal<\/span>/, `<span class="hint">${totalNormal}/9 chefes abatidos no Normal</span>`);
  return html;
}

async function main() {
  const explicitCodes = process.argv.slice(2);
  const isAutoMode = explicitCodes.length === 0;

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

  let codesToProcess;
  if (!isAutoMode) {
    console.log(`Usando ${explicitCodes.length} código(s) passado(s) na linha de comando.`);
    codesToProcess = explicitCodes;
  } else {
    console.log('Buscando reports da guild (por guildID)...');
    const firstNight = Date.UTC(NIGHTS[0][2], NIGHTS[0][0] - 1, NIGHTS[0][1]) - 12 * 3600 * 1000;
    const lastNight = Date.UTC(NIGHTS[NIGHTS.length - 1][2], NIGHTS[NIGHTS.length - 1][0] - 1, NIGHTS[NIGHTS.length - 1][1]) + 36 * 3600 * 1000;
    const reports = await fetchGuildReports(token, firstNight, lastNight);
    const coreReports = reports.filter(r => LOG_OWNERS.includes((r.owner?.name || '').toLowerCase()));
    console.log(`${reports.length} reports no período, ${coreReports.length} de owners de core (${LOG_OWNERS.join(', ')}).`);
    codesToProcess = coreReports.map(r => r.code);
  }

  if (codesToProcess.length === 0) {
    console.log('Nenhum report pra processar — nada foi alterado no arquivo.');
    return;
  }

  const touchedKeys = new Set();
  const tallyByNight = {}; // nightKey -> [tally1, tally2, ...] (um tally por report daquela noite)
  const nightStart = {};   // nightKey -> menor startTime, pra ordenar as noites cronologicamente

  for (const code of codesToProcess) {
    console.log(`Lendo report ${code}...`);
    let rep;
    try {
      rep = await fetchReportDetails(token, code);
    } catch (err) {
      console.log(`  ERRO: ${err.message}`);
      continue;
    }
    const key = nightKeyFromTimestamp(rep.startTime);
    (tallyByNight[key] = tallyByNight[key] || []).push(tallyFights(rep.fights));
    nightStart[key] = Math.min(nightStart[key] ?? Infinity, rep.startTime);
    if (!nightKeys.includes(key)) {
      console.log(`  AVISO: noite ${key} não está em NIGHTS (attendance pulada, mas kills contam).`);
    } else {
      console.log(`  noite ${key}, ${rep.names.length} jogadores no log.`);
      let matched = 0;
      for (const rawName of rep.names) {
        const rosterName = rosterByNormalized.get(stripAccents(rawName));
        if (!rosterName) continue;
        ATT[rosterName] = ATT[rosterName] || {};
        ATT[rosterName][key] = 1;
        matched++;
      }
      console.log(`  ${matched} bateram com o roster.`);
      touchedKeys.add(key);
    }
  }

  if (touchedKeys.size > 0) {
    nightKeys.forEach((k, i) => { if (touchedKeys.has(k) && i > lastLogged) lastLogged = i; });
    html = html.replace(/var LAST_LOGGED = -?\d+;/, `var LAST_LOGGED = ${lastLogged};`);
    html = html.replace(/var ATT = \{[\s\S]*?\};/, `var ATT = ${JSON.stringify(ATT)};`);
    console.log(`Presença: noites atualizadas ${[...touchedKeys].join(', ')}. LAST_LOGGED=${lastLogged}.`);
  } else {
    console.log('Presença: nenhuma noite válida processada.');
  }

  // --- kills/pulls ---
  // modo auto: guildID search já cobre a temporada inteira -> recalcula os arrays do zero (sem risco de duplicar pulls)
  // modo explícito (códigos passados na mão): só temos ESSES reports, então faz merge (máximo) com o que já tava salvo
  function mergeKillsArray(existingVarName, freshArr) {
    if (isAutoMode) return freshArr;
    const m = html.match(new RegExp(`var ${existingVarName} = (\\[[\\s\\S]*?\\]);`));
    if (!m) return freshArr;
    const existing = JSON.parse(m[1]);
    return freshArr.map(([name, pulls, killed], i) => {
      const old = existing[i] || [name, 0, false];
      // boss já morto no arquivo: o número de pulls até a kill é definitivo, não mexe mais
      if (old[2]) return [name, old[1], true];
      return [name, Math.max(pulls, old[1]), killed];
    });
  }

  // dedup: vários reports da mesma noite (loggers em paralelo) viram 1 tally (máximo);
  // depois acumula em ordem cronológica, parando na noite da kill (pulls até matar)
  const fightsTally = accumulateTallies(
    Object.keys(tallyByNight)
      .sort((a, b) => nightStart[a] - nightStart[b])
      .map(k => ({ tally: mergeSameNightTallies(tallyByNight[k]) }))
  );

  const vaNormal = mergeKillsArray('KILLS_N', buildKillsArray(VA_BOSSES, DIFF.normal, fightsTally));
  const vaHeroic = mergeKillsArray('KILLS_H', buildKillsArray(VA_BOSSES, DIFF.heroic, fightsTally));
  const tgNormal = mergeKillsArray('KILLS_N_TG', buildKillsArray(TG_BOSSES, DIFF.normal, fightsTally));
  const tgHeroic = mergeKillsArray('KILLS_H_TG', buildKillsArray(TG_BOSSES, DIFF.heroic, fightsTally));
  const tgMythic = mergeKillsArray('KILLS_M_TG', buildKillsArray(TG_BOSSES, DIFF.mythic, fightsTally));

  html = replaceArray(html, 'KILLS_N', vaNormal);
  html = replaceArray(html, 'KILLS_H', vaHeroic);
  html = replaceArray(html, 'KILLS_N_TG', tgNormal);
  html = replaceArray(html, 'KILLS_H_TG', tgHeroic);
  html = replaceArray(html, 'KILLS_M_TG', tgMythic);

  const killedVA = vaNormal.filter(([, , k]) => k).length;
  const killedTG = tgNormal.filter(([, , k]) => k).length;
  const killedVA_H = vaHeroic.filter(([, , k]) => k).length;
  const killedTG_H = tgHeroic.filter(([, , k]) => k).length;
  html = updateProgressCard(html, killedVA, killedTG, killedVA_H, killedTG_H);

  fs.writeFileSync(FILE, html, 'utf8');
  console.log(`Kills: Venomous Abyss ${killedVA}/${VA_BOSSES.length} Normal + ${killedVA_H}/${VA_BOSSES.length} Heroico, Tidebound Grotto ${killedTG}/${TG_BOSSES.length} Normal + ${killedTG_H}/${TG_BOSSES.length} Heroico.`);
  console.log('Pronto.');
}

main().catch(err => { console.error(err); process.exit(1); });
