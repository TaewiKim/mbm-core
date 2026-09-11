// E16 — external benchmark drop-in on LoCoMo (long multi-session memory QA, Maharana et al.).
// Their task, their metric (answer correctness). We compare:
//   native     : model answers from the top-K content-retrieved dialog turns (binding-blind RAG).
//   native+MBM : the SAME retrieved candidates, then the message-bound gate keeps only turns whose
//                provenance scope matches the active message's entity scope (the reader/scope check,
//                the one gate dimension a free QA legitimately supplies via the named speaker), and,
//                for temporal questions, prefers the latest session (active-status/supersession).
// No oracle (gold evidence/answer) is shown to the model or the gate. Scored by a blind judge.
// Honest by design: if the gate is a no-op or hurts multi-hop questions, the null is reported.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function parseArgs(a){const o={};for(let i=0;i<a.length;i++)if(a[i].startsWith("--")){o[a[i].slice(2)]=a[i+1]&&!a[i+1].startsWith("--")?a[++i]:"true";}return o;}
const STOP = new Set("the a an of to in on at for and or but is are was were did do does what when where who why how did her his their they she he it as with about into over".split(" "));
const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter((w)=>w && !STOP.has(w));
function overlap(q, t){const qs=new Set(toks(q));let n=0;for(const w of new Set(toks(t)))if(qs.has(w))n++;return n;}

function flattenTurns(conv){
  const turns=[];
  for(const k of Object.keys(conv)){
    const m=/^session_(\d+)$/.exec(k); if(!m) continue;
    const sess=Number(m[1]); const date=conv[`session_${sess}_date_time`]||"";
    for(const turn of conv[k]||[]) turns.push({session:sess,date,speaker:turn.speaker,dia_id:turn.dia_id,text:turn.text});
  }
  return turns;
}

function retrieve(turns, question, k){
  return turns.map((t)=>({t,s:overlap(question,t.text)+(question.includes(t.speaker)?1:0)}))
    .sort((a,b)=>b.s-a.s).slice(0,k).map((x)=>x.t);
}

// active-message scope from the question (no oracle): the named speaker, and temporal intent.
function activeScope(question, speakers){
  const entity = speakers.find((sp)=>question.toLowerCase().includes(sp.toLowerCase())) || null;
  const temporal = /\b(when|date|last|first|recent|before|after|latest|now|currently)\b/i.test(question);
  return {entity, temporal};
}

// message-bound gate over retrieved candidates (reader/scope + recency). Falls through to native only
// if it would empty the set (so the gate is never trivially worse by deleting everything).
function gate(cands, scope){
  let kept = cands;
  if(scope.entity){
    const e=scope.entity.toLowerCase();
    kept = cands.filter((t)=>t.speaker.toLowerCase()===e || t.text.toLowerCase().includes(e));
  }
  if(scope.temporal && kept.length>1){
    const maxS=Math.max(...kept.map((t)=>t.session));
    kept = kept.filter((t)=>t.session>=maxS-1); // prefer the latest sessions
  }
  return kept.length ? kept : cands;
}

const fmt = (cs) => cs.map((t)=>`[S${t.session} ${t.date}] ${t.speaker}: ${t.text}`).join("\n");

async function answer({apiKey,model,question,context}){
  const body={model,instructions:["Answer the question using ONLY the provided conversation excerpts.","Reply with a short, direct answer. If the excerpts do not contain the answer, reply exactly: undefined."].join("\n"),
    input:[{role:"user",content:`Conversation excerpts:\n${context}\n\nQuestion: ${question}\nShort answer:`}]};
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`ans ${r.status}`);
  return (d.output_text ?? (d.output??[]).flatMap((o)=>(o.content??[]).map((c)=>c.text||"")).join("")).trim();
}
async function judge({apiKey,model,question,gold,pred}){
  const sch={type:"object",additionalProperties:false,properties:{correct:{type:"boolean"}},required:["correct"]};
  const body={model,instructions:"Decide if the predicted answer matches the reference answer for the question (semantically equivalent; ignore phrasing). If reference is 'undefined', correct iff prediction is also undefined/none. Return JSON {correct}.",
    input:[{role:"user",content:`Question: ${question}\nReference: ${gold}\nPrediction: ${pred}\nMatch?`}],
    text:{format:{type:"json_schema",name:"m",strict:true,schema:sch}}};
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`judge ${r.status}`);
  return JSON.parse(d.output_text ?? (d.output??[]).flatMap((o)=>(o.content??[]).map((c)=>c.text||"")).join("")).correct;
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  const model=args.model||"gpt-5.4-nano", judgeModel=args.judge||"gpt-5.4-mini";
  const K=Number(args.k??10), convLimit=Number(args.convs??2), qLimit=Number(args.qlimit??0);
  const out=args.out||"results/eval/e16-locomo.jsonl";
  const apiKey=process.env.OPENAI_API_KEY; if(!apiKey) throw new Error("OPENAI_API_KEY required");
  const data=JSON.parse(readFileSync("data/external/locomo10.json","utf8")).slice(0,convLimit);
  mkdirSync(dirname(out),{recursive:true}); writeFileSync(out,"");
  let n=0;
  for(const [ci,conv] of data.entries()){
    const turns=flattenTurns(conv.conversation);
    const speakers=[conv.conversation.speaker_a,conv.conversation.speaker_b].filter(Boolean);
    let qa=conv.qa; if(qLimit>0) qa=qa.slice(0,qLimit);
    for(const q of qa){
      const gold=String(q.answer);
      const cands=retrieve(turns,q.question,K);
      const scope=activeScope(q.question,speakers);
      const gated=gate(cands,scope);
      let err="",predN=null,predM=null,okN=null,okM=null;
      try{
        predN=await answer({apiKey,model,question:q.question,context:fmt(cands)});
        predM=await answer({apiKey,model,question:q.question,context:fmt(gated)});
        okN=await judge({apiKey,model:judgeModel,question:q.question,gold,pred:predN});
        okM=await judge({apiKey,model:judgeModel,question:q.question,gold,pred:predM});
      }catch(e){err=e.message;}
      appendFileSync(out,JSON.stringify({experiment:"E16",benchmark:"locomo",conv:ci,model,category:q.category,
        question:q.question,gold,entity:scope.entity,temporal:scope.temporal,cands:cands.length,gated:gated.length,
        native_correct:okN,mbm_correct:okM,native_pred:predN,mbm_pred:predM,error:err})+"\n");
      n++; if(n%25===0) console.log(`[E16] ${n} (conv ${ci})`);
    }
  }
  console.log(`[E16] wrote ${n} rows to ${out}`);
}
main().catch((e)=>{console.error(e);process.exit(1);});
