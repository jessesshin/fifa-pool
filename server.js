const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'fifa-pool-data.txt');
const HTML_FILE = path.join(__dirname, 'fifa-pool-shared.html');

const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

const SYNC_EVERY_MS = 5 * 60 * 1000;

const GROUP_DATES = [
  '20260611','20260612','20260613','20260614','20260615','20260616',
  '20260617','20260618','20260619','20260620','20260621','20260622',
  '20260623','20260624','20260625','20260626','20260627'
];

const R32_DATES = [
  '20260628','20260629','20260630','20260701','20260702','20260703'
];

const RESULT_DATES_AROUND_TODAY = () => {
  const now = new Date();
  return [-1, 0, 1].map(offset => {
    const d = new Date(now.getTime() + offset * 86400000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  });
};

const ROUNDS = [
  { id:'r32', matches:16 },
  { id:'r16', matches:8 },
  { id:'qf',  matches:4 },
  { id:'sf',  matches:2 },
  { id:'f',   matches:1 }
];

const R32_SLOTS = [
  ['Runner-up Group A','Runner-up Group B'],
  ['Winner Group E','Best 3rd A/B/C/D/F'],
  ['Winner Group F','Runner-up Group C'],
  ['Winner Group C','Runner-up Group F'],
  ['Winner Group I','Best 3rd C/D/F/G/H'],
  ['Runner-up Group E','Runner-up Group I'],
  ['Winner Group A','Best 3rd C/E/F/H/I'],
  ['Winner Group L','Best 3rd E/H/I/J/K'],
  ['Winner Group D','Best 3rd B/E/F/I/J'],
  ['Winner Group G','Best 3rd A/E/H/I/J'],
  ['Runner-up Group K','Runner-up Group L'],
  ['Winner Group H','Runner-up Group J'],
  ['Winner Group B','Best 3rd E/F/G/I/J'],
  ['Winner Group J','Runner-up Group H'],
  ['Winner Group K','Best 3rd D/E/I/J/L'],
  ['Runner-up Group D','Runner-up Group G']
];

function defaultData(){
  return {
    pool: [],
    actual: {},
    slotMap: {},
    liveSync: {
      lastChecked: null,
      source: 'ESPN',
      updatedMatches: 0,
      groupSlotsUpdated: 0,
      r32SlotsUpdated: 0,
      message: 'Not checked yet'
    },
    updatedAt: new Date().toISOString()
  };
}

function readData(){
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    const d = defaultData();
    writeData(d);
    return d;
  }
}

function writeData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function send(res, code, body, type='application/json'){
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function collectJson(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e){ reject(e); }
    });
  });
}

/* ---------------- TEAM MATCHING ---------------- */

function stripFlags(s){
  return String(s || '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
}

function normalizeTeam(s){
  let x = stripFlags(s)
    .toLowerCase()
    .replace(/\bmen\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases = {
    'usa': 'united states',
    'us': 'united states',
    'united states of america': 'united states',
    'bosnia': 'bosnia and herzegovina',
    'bosnia herz': 'bosnia and herzegovina',
    'bosnia herzegovina': 'bosnia and herzegovina',
    'bosnia and herzegovina': 'bosnia and herzegovina',
    'cote d ivoire': 'ivory coast',
    'côte d ivoire': 'ivory coast',
    'ivory coast': 'ivory coast',
    'czechia': 'czech republic',
    'korea republic': 'south korea',
    'republic of korea': 'south korea',
    'dr congo': 'congo dr',
    'democratic republic of congo': 'congo dr',
    'cape verde': 'cabo verde',
    'curacao': 'curaçao'
  };

  return aliases[x] || x;
}

function sameTeam(a,b){
  return normalizeTeam(a) && normalizeTeam(a) === normalizeTeam(b);
}

function resolve(slot, slotMap){
  return slotMap?.[slot] || slot;
}

function isPlaceholder(team){
  return !team ||
    String(team).includes('Group') ||
    String(team).includes('Best 3rd') ||
    String(team).startsWith('3RD') ||
    String(team).startsWith('1') ||
    String(team).startsWith('2');
}

/* ---------------- ESPN FETCH ---------------- */

async function fetchScores(dates){
  const all = [];

  for(const date of dates){
    try {
      const r = await fetch(`${ESPN_SCOREBOARD_URL}?dates=${date}`);
      if(!r.ok) continue;
      const data = await r.json();
      all.push(...(data.events || []));
    } catch(e) {
      console.warn('ESPN fetch failed for', date, e.message);
    }
  }

  const seen = new Set();
  return all.filter(e => !seen.has(e.id) && seen.add(e.id));
}

function getCompetitors(event){
  const comp = event?.competitions?.[0];
  const competitors = comp?.competitors || [];

  if(competitors.length < 2) return null;

  return competitors.map(c => ({
    name:
      c.team?.displayName ||
      c.team?.shortDisplayName ||
      c.team?.name ||
      c.team?.abbreviation ||
      '',
    score: Number(c.score),
    winner: c.winner === true
  }));
}

function getGroup(event){
  const comp = event?.competitions?.[0];

  const text = [
    comp?.notes?.[0]?.headline,
    comp?.altGameNote,
    event?.shortName,
    event?.name
  ].filter(Boolean).join(' ');

  const m = String(text).match(/Group\s+([A-L])/i);
  return m ? `Group ${m[1].toUpperCase()}` : null;
}

/* ---------------- GROUP STANDINGS ---------------- */

function addStanding(groups, group, teams){
  groups[group] = groups[group] || {};

  const [a,b] = teams;
  if(!a?.name || !b?.name) return;
  if(!Number.isFinite(a.score) || !Number.isFinite(b.score)) return;

  for(const t of [a,b]){
    groups[group][t.name] = groups[group][t.name] || {
      team: t.name,
      pts: 0,
      gd: 0,
      gf: 0,
      ga: 0,
      played: 0
    };
  }

  const A = groups[group][a.name];
  const B = groups[group][b.name];

  A.played++;
  B.played++;

  A.gf += a.score;
  A.ga += b.score;
  A.gd += a.score - b.score;

  B.gf += b.score;
  B.ga += a.score;
  B.gd += b.score - a.score;

  if(a.score > b.score) A.pts += 3;
  else if(b.score > a.score) B.pts += 3;
  else {
    A.pts++;
    B.pts++;
  }
}

function sortedTeams(obj){
  return Object.values(obj).sort((a,b) =>
    b.pts - a.pts ||
    b.gd - a.gd ||
    b.gf - a.gf ||
    a.team.localeCompare(b.team)
  );
}

async function syncGroupWinners(data){
  const events = await fetchScores(GROUP_DATES);
  const groups = {};

  for(const event of events){
    const comp = event?.competitions?.[0];
    if(comp?.status?.type?.completed !== true) continue;

    const group = getGroup(event);
    if(!group) continue;

    const teams = getCompetitors(event);
    if(!teams) continue;

    addStanding(groups, group, teams);
  }

  data.slotMap = data.slotMap || {};

  let filled = 0;
  let groupsComplete = 0;

  for(const [group, obj] of Object.entries(groups)){
    const teams = sortedTeams(obj);
    const completedMatches =
      Object.values(obj).reduce((sum,t) => sum + t.played, 0) / 2;

    if(completedMatches >= 6 && teams.length >= 4){
      groupsComplete++;

      const letter = group.split(' ')[1];

      const winnerKey = `Winner Group ${letter}`;
      const runnerKey = `Runner-up Group ${letter}`;

      if(data.slotMap[winnerKey] !== teams[0].team){
        data.slotMap[winnerKey] = teams[0].team;
        filled++;
      }

      if(data.slotMap[runnerKey] !== teams[1].team){
        data.slotMap[runnerKey] = teams[1].team;
        filled++;
      }
    }
  }

  return { filled, groupsComplete };
}

/* ---------------- ESPN ROUND OF 32 SCHEDULE SOURCE OF TRUTH ---------------- */

async function syncR32SlotsFromEspnSchedule(data){
  const events = await fetchScores(R32_DATES);

  data.slotMap = data.slotMap || {};

  let filled = 0;

  for(const event of events){
    const teams = getCompetitors(event);
    if(!teams) continue;

    const espnTeams = teams.map(t => t.name).filter(Boolean);
    if(espnTeams.length < 2) continue;

    for(const [index, slotPair] of R32_SLOTS.entries()){
      const [slotA, slotB] = slotPair;
      const resolvedA = resolve(slotA, data.slotMap);
      const resolvedB = resolve(slotB, data.slotMap);

      const aKnown = !isPlaceholder(resolvedA);
      const bKnown = !isPlaceholder(resolvedB);

      const espnA = espnTeams[0];
      const espnB = espnTeams[1];

      // If side A is known and side B is placeholder, use ESPN opponent.
      if(aKnown && isPlaceholder(resolvedB)){
        if(sameTeam(resolvedA, espnA)){
          if(data.slotMap[slotB] !== espnB){
            data.slotMap[slotB] = espnB;
            filled++;
          }
        } else if(sameTeam(resolvedA, espnB)){
          if(data.slotMap[slotB] !== espnA){
            data.slotMap[slotB] = espnA;
            filled++;
          }
        }
      }

      // If side B is known and side A is placeholder, use ESPN opponent.
      if(bKnown && isPlaceholder(resolvedA)){
        if(sameTeam(resolvedB, espnA)){
          if(data.slotMap[slotA] !== espnB){
            data.slotMap[slotA] = espnB;
            filled++;
          }
        } else if(sameTeam(resolvedB, espnB)){
          if(data.slotMap[slotA] !== espnA){
            data.slotMap[slotA] = espnA;
            filled++;
          }
        }
      }

      // If both are placeholders, use matchup order only when event date/order clearly lines up.
      // This is intentionally conservative to avoid wrong slots.
      // Most disputed Best 3rd slots resolve through one known group winner.
    }
  }

  return { filled };
}

/* ---------------- BRACKET/WINNER SYNC ---------------- */

function matchId(roundIndex, matchIndex){
  return `${ROUNDS[roundIndex].id}-${matchIndex}`;
}

function getMatchTeams(data, roundIndex, matchIndex){
  if(roundIndex === 0){
    return R32_SLOTS[matchIndex].map(s => resolve(s, data.slotMap || {}));
  }

  const prev = ROUNDS[roundIndex - 1];

  return [
    data.actual?.[`${prev.id}-${matchIndex * 2}`] || '',
    data.actual?.[`${prev.id}-${matchIndex * 2 + 1}`] || ''
  ];
}

function currentBracketMatches(data){
  const out = [];

  ROUNDS.forEach((round, roundIndex) => {
    for(let i=0; i<round.matches; i++){
      const [a,b] = getMatchTeams(data, roundIndex, i);

      if(
        a &&
        b &&
        !isPlaceholder(a) &&
        !isPlaceholder(b)
      ){
        out.push({
          id: matchId(roundIndex, i),
          a,
          b
        });
      }
    }
  });

  return out;
}

function eventWinner(event){
  const comp = event?.competitions?.[0];

  if(comp?.status?.type?.completed !== true) return null;

  const teams = getCompetitors(event);
  if(!teams) return null;

  const marked = teams.find(t => t.winner);
  if(marked){
    return {
      winner: marked.name,
      teams: teams.map(t => t.name)
    };
  }

  if(
    Number.isFinite(teams[0].score) &&
    Number.isFinite(teams[1].score) &&
    teams[0].score !== teams[1].score
  ){
    return {
      winner: teams[0].score > teams[1].score ? teams[0].name : teams[1].name,
      teams: teams.map(t => t.name)
    };
  }

  return null;
}

async function syncEspnResults(){
  const data = readData();

  let updated = 0;

  try{
    const groupSync = await syncGroupWinners(data);

    // This is the key accuracy fix:
    // ESPN's actual R32 schedule fills Best 3rd slots instead of guessing.
    const r32Sync = await syncR32SlotsFromEspnSchedule(data);

    const events = await fetchScores([
      ...RESULT_DATES_AROUND_TODAY(),
      ...R32_DATES
    ]);

    const bracketMatches = currentBracketMatches(data);

    for(const event of events){
      const result = eventWinner(event);
      if(!result) continue;

      const found = bracketMatches.find(m => {
        const [x,y] = result.teams;
        return (
          (sameTeam(m.a, x) && sameTeam(m.b, y)) ||
          (sameTeam(m.a, y) && sameTeam(m.b, x))
        );
      });

      if(found && !data.actual?.[found.id]){
        data.actual = data.actual || {};
        data.actual[found.id] = sameTeam(found.a, result.winner)
          ? found.a
          : found.b;

        if(found.id === 'f-0'){
          data.actual['champ-0'] = data.actual['f-0'];
        }

        updated++;
      }
    }

    data.liveSync = {
      lastChecked: new Date().toISOString(),
      source: 'ESPN',
      updatedMatches: updated,
      groupSlotsUpdated: groupSync.filled,
      r32SlotsUpdated: r32Sync.filled,
      message:
        `Checked ESPN; ${groupSync.groupsComplete}/12 groups complete; ` +
        `${groupSync.filled} group slot(s) updated; ` +
        `${r32Sync.filled} R32 slot(s) updated; ` +
        `${updated} winner(s) updated`
    };

    data.updatedAt = new Date().toISOString();
    writeData(data);

    console.log(data.liveSync.message);
    return data;

  }catch(e){
    data.liveSync = {
      lastChecked: new Date().toISOString(),
      source: 'ESPN',
      updatedMatches: 0,
      groupSlotsUpdated: 0,
      r32SlotsUpdated: 0,
      message: `ESPN sync failed: ${e.message}`
    };

    writeData(data);
    console.warn(data.liveSync.message);
    return data;
  }
}

/* ---------------- SERVER ---------------- */

const server = http.createServer(async (req,res) => {
  try{
    const url = new URL(req.url, `http://${req.headers.host}`);

    if(
      req.method === 'GET' &&
      (
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/fifa-pool-shared.html'
      )
    ){
      return send(
        res,
        200,
        fs.readFileSync(HTML_FILE, 'utf8'),
        'text/html; charset=utf-8'
      );
    }

    if(req.method === 'GET' && url.pathname === '/pool-data.txt'){
      return send(
        res,
        200,
        JSON.stringify(readData(), null, 2),
        'application/json; charset=utf-8'
      );
    }

    if(req.method === 'POST' && url.pathname === '/api/submit'){
      const entry = await collectJson(req);

      if(!entry.name || !entry.picks){
        return send(res, 400, JSON.stringify({error:'Missing name or picks'}));
      }

      const data = readData();

      data.pool = (data.pool || [])
        .filter(p => p.name.toLowerCase() !== entry.name.toLowerCase());

      data.pool.push({
        name: entry.name,
        picks: entry.picks,
        ts: entry.ts || Date.now()
      });

      data.updatedAt = new Date().toISOString();

      writeData(data);
      return send(res, 200, JSON.stringify(data));
    }

    if(req.method === 'POST' && url.pathname === '/api/state'){
      const incoming = await collectJson(req);
      const old = readData();

      const data = {
        pool: incoming.pool || [],
        actual: incoming.actual || {},
        slotMap: incoming.slotMap || {},
        liveSync: old.liveSync || {},
        updatedAt: new Date().toISOString()
      };

      writeData(data);
      return send(res, 200, JSON.stringify(data));
    }

    if(req.method === 'POST' && url.pathname === '/api/espn-sync'){
      const data = await syncEspnResults();
      return send(res, 200, JSON.stringify(data));
    }

    return send(res, 404, 'Not found', 'text/plain');

  }catch(e){
    return send(res, 500, JSON.stringify({error:e.message}));
  }
});

server.listen(PORT, () => {
  console.log(`FIFA pool running on port ${PORT}`);
  syncEspnResults();
  setInterval(syncEspnResults, SYNC_EVERY_MS);
});
