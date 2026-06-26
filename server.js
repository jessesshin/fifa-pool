const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'fifa-pool-data.txt');
const HTML_FILE = path.join(__dirname, 'fifa-pool-shared.html');

const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const SYNC_EVERY_MS = 5 * 60 * 1000;

const GROUP_START = new Date('2026-06-11T00:00:00Z');
const GROUP_END = new Date('2026-06-27T00:00:00Z');

const ROUNDS = [
  {id:'r32',matches:16},
  {id:'r16',matches:8},
  {id:'qf',matches:4},
  {id:'sf',matches:2},
  {id:'f',matches:1}
];

const R32_SLOTS = [
 ['Runner-up Group A','Runner-up Group B'],['Winner Group E','Best 3rd A/B/C/D/F'],
 ['Winner Group F','Runner-up Group C'],['Winner Group C','Runner-up Group F'],
 ['Winner Group I','Best 3rd C/D/F/G/H'],['Runner-up Group E','Runner-up Group I'],
 ['Winner Group A','Best 3rd C/E/F/H/I'],['Winner Group L','Best 3rd E/H/I/J/K'],
 ['Winner Group D','Best 3rd B/E/F/I/J'],['Winner Group G','Best 3rd A/E/H/I/J'],
 ['Runner-up Group K','Runner-up Group L'],['Winner Group H','Runner-up Group J'],
 ['Winner Group B','Best 3rd E/F/G/I/J'],['Winner Group J','Runner-up Group H'],
 ['Winner Group K','Best 3rd D/E/I/J/L'],['Runner-up Group D','Runner-up Group G']
];

function defaultData(){
  return {
    pool:[],
    actual:{},
    slotMap:{},
    liveSync:{
      lastChecked:null,
      source:'ESPN',
      updatedMatches:0,
      groupSlotsUpdated:0,
      message:'Not checked yet'
    },
    updatedAt:new Date().toISOString()
  };
}

function readData(){
  try{return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}
  catch{const d=defaultData();writeData(d);return d;}
}
function writeData(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2),'utf8');
}

function send(res,code,body,type='application/json'){
  res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store'});
  res.end(body);
}

function collectJson(req){
  return new Promise((resolve,reject)=>{
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{resolve(JSON.parse(body||'{}'));}
      catch(e){reject(e);}
    });
  });
}

/* ---------------- TEAM MATCHING ---------------- */

function normalizeTeam(s){
  let x = String(s||'')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g,' ')
    .replace(/\s+/g,' ')
    .trim();

  const aliases = {
    'usa':'united states',
    'us':'united states',
    'cote d ivoire':'ivory coast',
    'côte d ivoire':'ivory coast',
    'bosnia':'bosnia and herzegovina'
  };

  return aliases[x] || x;
}

function sameTeam(a,b){
  return normalizeTeam(a) === normalizeTeam(b);
}

function resolve(slot, map){
  return map?.[slot] || slot;
}

/* ---------------- ESPN FETCH ---------------- */

async function fetchScores(dates){
  const all=[];
  for(const d of dates){
    const r=await fetch(`${ESPN_SCOREBOARD_URL}?dates=${d}`);
    if(!r.ok) continue;
    const j=await r.json();
    all.push(...(j.events||[]));
  }
  return all;
}

/* ---------------- GROUP TABLE ---------------- */

function addStanding(groups, group, [a,b]){
  groups[group] = groups[group] || {};
  for(const t of [a,b]){
    groups[group][t.name] = groups[group][t.name] || {team:t.name,pts:0,gd:0,gf:0};
  }

  const A = groups[group][a.name];
  const B = groups[group][b.name];

  A.gf+=a.score; B.gf+=b.score;
  A.gd+=a.score-b.score; B.gd+=b.score-a.score;

  if(a.score>b.score) A.pts+=3;
  else if(b.score>a.score) B.pts+=3;
  else {A.pts++;B.pts++;}
}

function sorted(group){
  return Object.values(group).sort((a,b)=>
    b.pts-a.pts || b.gd-a.gd || b.gf-a.gf
  );
}

/* ✅ FIXED 3RD PLACE LOGIC */
async function syncGroups(data){
  const dates=[];
  for(let d=new Date(GROUP_START); d<=GROUP_END; d=new Date(d.getTime()+86400000)){
    dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
  }

  const events = await fetchScores(dates);
  const groups={};

  for(const e of events){
    const comp=e?.competitions?.[0];
    if(!comp?.status?.type?.completed) continue;

    const name = comp?.notes?.[0]?.headline || comp?.altGameNote || '';
    const g = name.match(/Group ([A-L])/i);
    if(!g) continue;

    const group=`Group ${g[1]}`;

    const t = comp.competitors.map(c=>({
      name:c.team.displayName,
      score:Number(c.score)
    }));

    addStanding(groups, group, t);
  }

  data.slotMap = data.slotMap || {};
  let filled = 0;
  const thirds=[];

  for(const [g,obj] of Object.entries(groups)){
    const teams = sorted(obj);
    const letter = g.split(' ')[1];

    data.slotMap[`Winner Group ${letter}`]=teams[0].team;
    data.slotMap[`Runner-up Group ${letter}`]=teams[1].team;

    if(teams[2]) thirds.push({group:letter,...teams[2]});
  }

  if(thirds.length>=8){
    const ranked = thirds.sort((a,b)=>b.pts-a.pts||b.gd-a.gd||b.gf-a.gf);
    const best = new Set(ranked.slice(0,8).map(t=>t.group));

    const keys=[
      'Best 3rd B/E/F/I/J',
      'Best 3rd A/E/H/I/J',
      'Best 3rd E/F/G/I/J',
      'Best 3rd D/E/I/J/L'
    ];

    for(const key of keys){
      const groups = key.replace('Best 3rd ','').split('/');
      const match = ranked.find(t => groups.includes(t.group) && best.has(t.group));
      if(match){
        data.slotMap[key] = match.team;
        filled++;
      }
    }
  }

  return {filled};
}

/* ---------------- WINNER MATCHING ---------------- */

async function syncResults(){
  const data = readData();
  let updated=0;

  await syncGroups(data);

  const today = new Date();
  const dates = [-1,0,1].map(d=>{
    const x=new Date(today.getTime()+d*86400000);
    return x.toISOString().slice(0,10).replace(/-/g,'');
  });

  const events = await fetchScores(dates);

  for(const e of events){
    const comp=e?.competitions?.[0];
    if(!comp?.status?.type?.completed) continue;

    const teams = comp.competitors.map(c=>c.team.displayName);
    const winner = comp.competitors.find(c=>c.winner)?.team.displayName;

    const matches = currentMatches(data);

    const found = matches.find(m=>
      (sameTeam(m.a,teams[0]) && sameTeam(m.b,teams[1])) ||
      (sameTeam(m.a,teams[1]) && sameTeam(m.b,teams[0]))
    );

    if(found && !data.actual[found.id]){
      data.actual[found.id]=winner;
      updated++;
    }
  }

  data.liveSync = {
    lastChecked:new Date().toISOString(),
    updatedMatches:updated,
    message:`Updated ${updated} matches`
  };

  writeData(data);
  return data;
}

/* ---------------- BRACKET ---------------- */

function matchId(r,i){ return `${ROUNDS[r].id}-${i}`; }

function currentMatches(data){
  const out=[];
  ROUNDS.forEach((round,r)=>{
    for(let i=0;i<round.matches;i++){
      const [a,b]=getTeams(data,r,i);
      if(a && b && !a.includes('Group') && !b.includes('Group')){
        out.push({id:matchId(r,i),a,b});
      }
    }
  });
  return out;
}

function getTeams(data,r,i){
  if(r===0) return R32_SLOTS[i].map(s=>resolve(s,data.slotMap));
  const prev = ROUNDS[r-1];
  return [
    data.actual[`${prev.id}-${i*2}`],
    data.actual[`${prev.id}-${i*2+1}`]
  ];
}

/* ---------------- SERVER ---------------- */

const server = http.createServer(async(req,res)=>{
  const url = new URL(req.url,`http://${req.headers.host}`);

  if(url.pathname==='/'||url.pathname==='/fifa-pool-shared.html'){
    return send(res,200,fs.readFileSync(HTML_FILE),'text/html');
  }

  if(url.pathname==='/pool-data.txt'){
    return send(res,200,JSON.stringify(readData()));
  }

  if(url.pathname==='/api/espn-sync' && req.method==='POST'){
    const data=await syncResults();
    return send(res,200,JSON.stringify(data));
  }

  return send(res,404,'Not found','text/plain');
});

server.listen(PORT, ()=>{
  console.log(`Running on ${PORT}`);
  syncResults();
  setInterval(syncResults,SYNC_EVERY_MS);
});
