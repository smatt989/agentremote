// Measure wiki quality on an isolated state copy: churn, duplicates, hedging, silent claim drops,
// verification, talk activity, and (optionally) question answering through the real MCP tools.
// Usage: node scripts/eval-wiki.mjs STATE_DIRECTORY [--questions FILE] [--since-days N | --since EPOCH_MS] [--json OUT]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../desktop/src/store.mjs';

const args=process.argv.slice(2);const directory=args[0];if(!directory)throw Error('Usage: node scripts/eval-wiki.mjs STATE_DIRECTORY [--questions FILE] [--since-days N] [--json OUT]');
const option=name=>{const i=args.indexOf(name);return i>0?args[i+1]:undefined;};
const sinceDays=Number(option('--since-days')||7);const since=option('--since')?Number(option('--since')):Date.now()-sinceDays*86400000;
const store=new Store(directory);const k=store.knowledge;k.refresh();const db=store.db;

const articles=db.prepare('SELECT * FROM wiki_articles').all().map(r=>({...r,data:JSON.parse(r.data)}));
const prose=articles.flatMap(a=>[a.data.summary,...a.data.sections.map(s=>s.text)]).join('\n');
const words=prose.split(/\s+/).filter(Boolean).length;
const hedges=(prose.match(/assistant[- ]reported|not (?:been )?independently verified|unverified|require[sd]? verification|verify before relying|not confirmed by the evidence/gi)||[]).length;
const claimOf=new Map(db.prepare('SELECT id,claim FROM wiki_evidence').all().map(r=>[r.id,r.claim]));
const claims=new Map(db.prepare('SELECT id,status FROM wiki_claims').all().map(r=>[r.id,r.status]));
const cited=new Set(articles.flatMap(a=>a.data.sections.flatMap(s=>s.evidence)).map(id=>claimOf.get(id)).filter(Boolean));
const verified=new Set(db.prepare("SELECT claim FROM wiki_evidence WHERE json_extract(data,'$.trust') LIKE 'Verified%'").all().map(r=>r.claim));
const removals=new Set(db.prepare("SELECT data FROM wiki_talk WHERE kind IN ('removal','handoff')").all().flatMap(r=>JSON.parse(r.data).claims));

// A claim cited in one revision and absent from the next, still a member of the article, without a recorded reason.
let drops=0,transitions=0;
for(const article of new Set(db.prepare('SELECT article FROM wiki_revisions WHERE created>=?').all(since).map(r=>r.article))){
  const revisions=db.prepare('SELECT data,created FROM wiki_revisions WHERE article=? ORDER BY revision').all(article).map(r=>({...JSON.parse(r.data),created:r.created}));
  const members=new Set(db.prepare('SELECT claim FROM wiki_membership WHERE article=?').all(article).map(r=>r.claim));
  for(let i=1;i<revisions.length;i++){
    if(revisions[i].created<since)continue;transitions++;
    const set=r=>new Set(r.sections.flatMap(s=>s.evidence).map(id=>claimOf.get(id)).filter(id=>id&&members.has(id)));
    const after=set(revisions[i]);for(const c of set(revisions[i-1]))if(!after.has(c)&&!removals.has(c)&&claims.get(c)!=='superseded')drops++;
  }
}
const duplicates=k.duplicateCandidates().filter(p=>p.sameScope&&p.score>=0.6);
const talk=db.prepare('SELECT kind,status,count(*) n FROM wiki_talk GROUP BY kind,status ORDER BY kind,status').all();
const metrics={
  articles:articles.length,published:articles.filter(a=>a.data.synthesized).length,pending:articles.filter(a=>a.pending).length,
  rewritesSince:db.prepare('SELECT count(*) n FROM wiki_revisions WHERE created>=?').get(since).n,sinceDays,
  maxRewritesPerArticle:db.prepare('SELECT max(n) m FROM (SELECT count(*) n FROM wiki_revisions WHERE created>=? GROUP BY article)').get(since).m||0,
  hedgesPer1000Words:words?Math.round(hedges/words*10000)/10:0,proseWords:words,
  citedClaims:cited.size,citedSuperseded:[...cited].filter(c=>claims.get(c)==='superseded').length,verifiedClaims:verified.size,
  silentDrops:drops,revisionTransitions:transitions,
  sameScopeDuplicateCandidates:duplicates.length,duplicateExamples:duplicates.slice(0,6).map(p=>p.a+' ~ '+p.b),
  talk,
};

// Question answering through the same MCP tools agents use, against this state copy only.
const questionsFile=option('--questions');
if(questionsFile){
  // The MCP tools require a session that exists in this state copy.
  const session=store.sessions().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0]?.id;if(!session)throw Error('This state copy has no sessions to run the MCP tools under.');
  const questions=JSON.parse(readFileSync(questionsFile,'utf8'));const tools=resolve(dirname(fileURLToPath(import.meta.url)),'../desktop/src/mac-tools.mjs');
  const config=JSON.stringify({mcpServers:{wiki:{command:process.execPath,args:[tools],env:{AGENT_REMOTE_STATE:resolve(directory),AGENT_REMOTE_SESSION:session}}}});
  const ask=q=>new Promise((done,fail)=>{
    const cwd=mkdtempSync(join(tmpdir(),'agentremote-eval-'));
    const child=spawn(process.env.AGENT_REMOTE_CLAUDE||'claude',// --safe-mode would also disable the MCP server under test.
    ['-p','--setting-sources','project','--disable-slash-commands','--tools','','--strict-mcp-config','--mcp-config',config,'--allowedTools','mcp__wiki__knowledge_search,mcp__wiki__knowledge_read','--no-session-persistence','--output-format','json','--model',process.env.AGENT_REMOTE_EVAL_MODEL||'sonnet','--system-prompt','Answer the question using only the knowledge_search and knowledge_read tools. Answer in one or two sentences. If the wiki does not say, answer "unknown".'],{cwd,stdio:['pipe','pipe','pipe'],env:{...process.env,CLAUDE_CODE_SKIP_PROMPT_HISTORY:'1'}});
    let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',()=>{});
    const timer=setTimeout(()=>child.kill('SIGKILL'),240000);
    child.on('exit',()=>{clearTimeout(timer);rmSync(cwd,{recursive:true,force:true});try{done(JSON.parse(out).result||'');}catch(e){fail(e);}});
    child.stdin.end(q);
  });
  const results=[];
  for(const q of questions){let answer='';try{answer=await ask(q.question);}catch{answer='(error)';}results.push({question:q.question,answer:answer.slice(0,400),correct:new RegExp(q.expect,'i').test(answer)});console.error((results.at(-1).correct?'✓ ':'✗ ')+q.question);}
  metrics.questions={correct:results.filter(r=>r.correct).length,total:results.length,results};
}
store.close();
const out=option('--json');if(out)writeFileSync(out,JSON.stringify(metrics,null,2));
console.log(JSON.stringify({...metrics,questions:metrics.questions?{correct:metrics.questions.correct,total:metrics.questions.total}:undefined},null,2));
