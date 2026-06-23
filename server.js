const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'fifa-pool-data.txt');
const HTML_FILE = path.join(__dirname, 'fifa-pool-shared.html');
const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const SYNC_EVERY_MS = 5 * 60 * 1000;

const ROUNDS = [
  { id:'r32', matches:16 },
  { id:'r16', matches:8 },
  { id:'qf', matches:4 },
  { id:'sf', matches:2 },
  { id:'f', matches:1 }
];
const R32_SLOTS = [
  ['Runner-up Group A', 'Runner-up Group B'],
  ['Winner Group E', 'Best 3rd A/B/C/D/F'],
  ['Winner Group F', 'Runner-up Group C'],
  ['Winner Group C', 'Runner-up Group F'],
  ['Winner Group I', 'Best 3rd C/D/F/G/H'],
  ['Runner-up Group E', 'Runner-up Group I'],
  ['Winner Group A', 'Best 3rd C/E/F/H/I'],
  ['Winner Group L', 'Best 3rd E/H/I/J/K'],
  ['Winner Group D', 'Best 3rd B/E/F/I/J'],
  ['Winner Group G', 'Best 3rd A/E/H/I/J'],
  ['Runner-up Group K', 'Runner-up Group L'],
  ['Winner Group H', 'Runner-up Group J'],
  ['Winner Group B', 'Best 3rd E/F/G/I/J'],
  ['Winner Group J', 'Runner-up Group H'],
  ['Winner Group K', 'Best 3rd D/E/I/J/L'],
  ['Runner-up Group D', 'Runner-up Group G']
];

function defaultData(){
  return { pool:[], actual:{}, slotMap:{}, liveSync:{lastChecked:null, source:'ESPN', updatedMatches:0, message:'Not checked yet'}, updatedAt:new Date().toISOString() };
}
function readData(){
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { const d = defaultData(); writeData(d); return d; }
}
function writeData(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }
function send(res, code, body, type='application/json'){
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store'});
  res.end(body);
}
function collectJson(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e){ reject(e); } });
  });
}

function stripFlags(s){ return String(s || '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim(); }
function normalizeTeam(s){
  let x = stripFlags(s).toLowerCase();
  x = x.replace(/\bmen\b/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const aliases = {
    'usa':'united states',
    'united states of america':'united states',
    'us':'united states',
    'england':'england',
    'czechia':'czech republic',
    'czech republic':'czech republic',
    'korea republic':'south korea',
    'republic of korea':'south korea',
    'south korea':'south korea',
    'cote d ivoire':'ivory coast',
    'côte d ivoire':'ivory coast',
    'ivory coast':'ivory coast',
    'dr congo':'congo dr',
    'congo dr':'congo dr',
    'congo democratic republic':'congo dr'
  };
  return aliases[x] || x;
}
function sameTeam(a,b){ return normalizeTeam(a) && normalizeTeam(a) === normalizeTeam(b); }
function resolve(slot, slotMap){ return slotMap?.[slot] || slot; }
function matchId(roundIdx, matchIdx){ return `${ROUNDS[roundIdx].id}-${matchIdx}`; }
function getMatchTeams(data, roundIdx, matchIdx){
  if(roundIdx === 0) return R32_SLOTS[matchIdx].map(s => resolve(s, data.slotMap || {}));
  const prevRound = ROUNDS[roundIdx - 1];
  return [
    data.actual?.[`${prevRound.id}-${matchIdx * 2}`] || '',
    data.actual?.[`${prevRound.id}-${matchIdx * 2 + 1}`] || ''
  ];
}
function currentBracketMatches(data){
  const out = [];
  ROUNDS.forEach((round, rIdx) => {
    for(let i=0; i<round.matches; i++){
      const [a,b] = getMatchTeams(data, rIdx, i);
      if(a && b && !String(a).includes('Group') && !String(b).includes('Group') && !String(a).includes('Best 3rd') && !String(b).includes('Best 3rd')){
        out.push({ id:matchId(rIdx, i), a, b });
      }
    }
  });
  return out;
}
function getCompetitors(event){
  const comp = event?.competitions?.[0];
  const competitors = comp?.competitors || [];
  if(competitors.length < 2) return null;
  return competitors.map(c => ({
    name: c.team?.displayName || c.team?.shortDisplayName || c.team?.name || c.team?.abbreviation,
    score: Number(c.score),
    winner: c.winner === true
  }));
}
function eventWinner(event){
  const comp = event?.competitions?.[0];
  const completed = comp?.status?.type?.completed === true;
  if(!completed) return null;
  const teams = getCompetitors(event);
  if(!teams) return null;
  const marked = teams.find(t => t.winner);
  if(marked) return { winner:marked.name, teams:teams.map(t => t.name) };
  if(Number.isFinite(teams[0].score) && Number.isFinite(teams[1].score) && teams[0].score !== teams[1].score){
    return { winner: teams[0].score > teams[1].score ? teams[0].name : teams[1].name, teams:teams.map(t => t.name) };
  }
  return null;
}
function espnDateStrings(){
  const dates = [];
  const now = new Date();
  for(const offset of [-1,0,1]){
    const d = new Date(now.getTime() + offset * 86400000);
    dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
  }
  return dates;
}
async function fetchEspnEvents(){
  const all = [];
  for(const date of espnDateStrings()){
    const r = await fetch(`${ESPN_SCOREBOARD_URL}?dates=${date}`);
    if(!r.ok) continue;
    const data = await r.json();
    all.push(...(data.events || []));
  }
  const seen = new Set();
  return all.filter(e => !seen.has(e.id) && seen.add(e.id));
}
async function syncEspnResults(){
  const data = readData();
  let updated = 0;
  try{
    const events = await fetchEspnEvents();
    const bracketMatches = currentBracketMatches(data);
    for(const event of events){
      const result = eventWinner(event);
      if(!result) continue;
      const found = bracketMatches.find(m => {
        const [x,y] = result.teams;
        return (sameTeam(m.a, x) && sameTeam(m.b, y)) || (sameTeam(m.a, y) && sameTeam(m.b, x));
      });
      if(found && !data.actual?.[found.id]){
        data.actual = data.actual || {};
        const winnerLabel = sameTeam(found.a, result.winner) ? found.a : found.b;
        data.actual[found.id] = winnerLabel;
        updated++;
      }
    }
    data.liveSync = { lastChecked:new Date().toISOString(), source:'ESPN', updatedMatches:updated, message:`Checked ${events.length} ESPN events` };
    data.updatedAt = new Date().toISOString();
    writeData(data);
    console.log(`ESPN sync complete: ${updated} match(es) updated.`);
    return data;
  }catch(e){
    data.liveSync = { lastChecked:new Date().toISOString(), source:'ESPN', updatedMatches:0, message:`ESPN sync failed: ${e.message}` };
    writeData(data);
    console.warn(data.liveSync.message);
    return data;
  }
}

const server = http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url, `http://${req.headers.host}`);
    if(req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/fifa-pool-shared.html')){
      return send(res, 200, fs.readFileSync(HTML_FILE, 'utf8'), 'text/html; charset=utf-8');
    }
    if(req.method === 'GET' && url.pathname === '/pool-data.txt'){
      return send(res, 200, JSON.stringify(readData(), null, 2), 'application/json; charset=utf-8');
    }
    if(req.method === 'POST' && url.pathname === '/api/submit'){
      const entry = await collectJson(req);
      if(!entry.name || !entry.picks) return send(res, 400, JSON.stringify({error:'Missing name or picks'}));
      const data = readData();
      data.pool = (data.pool || []).filter(p => p.name.toLowerCase() !== entry.name.toLowerCase());
      data.pool.push({ name:entry.name, picks:entry.picks, ts:entry.ts || Date.now() });
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
  console.log(`FIFA pool running: http://localhost:${PORT}`);
  syncEspnResults();
  setInterval(syncEspnResults, SYNC_EVERY_MS);
});
