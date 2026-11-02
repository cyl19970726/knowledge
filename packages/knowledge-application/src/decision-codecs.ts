import {
  DecisionBatchResultSchema, DecisionQuestionSchema,
  type DecisionAnswer, type DecisionBatchResult, type DecisionQuestion,
} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';

// These are offline wire codecs. State is supplied as text; it is never interpreted as instructions here.
const MAX_WIRE_BYTES=1_000_000;
const MAX_QUESTIONS=100;
const EPSILON=0.000001;

type RecordValue=Record<string,unknown>;
function invalid(message:string):never{
  throw new KnowledgeError('DECISION_WIRE_INVALID',message,422);
}
function object(value:unknown,label:string):RecordValue{
  if(value===null||typeof value!=='object'||Array.isArray(value))invalid(`${label} must be an object`);
  return value as RecordValue;
}
function compact(value:unknown,label:string):string{
  let json:string|undefined;
  try{json=JSON.stringify(value);}catch{invalid(`${label} must be JSON`);}
  if(json===undefined||Buffer.byteLength(json,'utf8')>MAX_WIRE_BYTES)invalid(`${label} exceeds the JSON size limit`);
  return json;
}
function questionsValid(questions:readonly DecisionQuestion[]):DecisionQuestion[]{
  if(!Array.isArray(questions)||questions.length<1||questions.length>MAX_QUESTIONS)invalid('Expected 1 to 100 questions');
  const seen=new Set<string>();
  const parsed:DecisionQuestion[]=[];
  for(const raw of questions){
    const result=DecisionQuestionSchema.safeParse(raw);
    if(!result.success)invalid('Question does not match the public contract');
    const q=result.data;
    if(seen.has(q.id))invalid(`Duplicate question id: ${q.id}`);
    seen.add(q.id);
    if(q.type==='choice'&&new Set(q.options.map(o=>o.value)).size!==q.options.length)
      invalid(`Duplicate choice value: ${q.id}`);
    if(q.type==='score'){
      if(q.levels.length>10)invalid('Providers accept at most 10 score levels');
      if(new Set(q.levels.map(l=>l.value)).size!==q.levels.length)invalid(`Duplicate score value: ${q.id}`);
      if(q.levels.some((l,i)=>i>0&&l.value<=q.levels[i-1]!.value))invalid(`Score levels must be increasing: ${q.id}`);
    }
    parsed.push(q);
  }
  compact(parsed,'Questions');
  return parsed;
}
function request(model:string,state:string,questions:readonly DecisionQuestion[]):DecisionQuestion[]{
  if(typeof model!=='string'||model.length===0||model.length>200)invalid('Invalid model');
  if(typeof state!=='string')invalid('State must be text');
  const qs=questionsValid(questions);
  compact({model,state,questions:qs},'Request');
  return qs;
}
function probability(value:unknown,label:string):number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)invalid(`Invalid probability: ${label}`);
  return value;
}
function confidence(value:unknown,label:string):number{
  return probability(value,label);
}
function distribution(values:unknown,keys:readonly string[],label:string):Record<string,number>{
  const source=object(values,label);
  if(Object.keys(source).length!==keys.length||keys.some(key=>!Object.hasOwn(source,key)))
    invalid(`Distribution option set differs: ${label}`);
  const result=Object.create(null) as Record<string,number>;
  let sum=0;
  for(const key of keys){const p=probability(source[key],`${label}.${key}`);result[key]=p;sum+=p;}
  if(Math.abs(sum-1)>EPSILON)invalid(`Distribution does not sum to one: ${label}`);
  return result;
}
function arrayDistribution(raw:unknown,keys:readonly string[],label:string,score=false):Record<string,number>{
  if(!Array.isArray(raw)||raw.length!==keys.length)invalid(`Distribution length differs: ${label}`);
  const mapped=Object.create(null) as Record<string,unknown>;
  for(const item of raw){
    const entry=object(item,label);
    const key=score?String(entry.value):entry.value;
    if(typeof key!=='string'||!keys.includes(key)||Object.hasOwn(mapped,key))invalid(`Unknown or duplicate distribution value: ${label}`);
    const numeric=entry.value;
    if(score&&(typeof numeric!=='number'||!Number.isInteger(numeric)||numeric<0||numeric>=keys.length))
      invalid(`Invalid level index: ${label}`);
    mapped[key]=entry.probability;
  }
  return distribution(mapped,keys,label);
}
function usage(root:RecordValue):{inputTokens:number|null;outputTokens:number|null}{
  if(root.usage===undefined)return {inputTokens:null,outputTokens:null};
  const u=object(root.usage,'Usage');
  const count=(value:unknown,label:string):number|null=>{
    if(value===undefined)return null;
    if(!Number.isSafeInteger(value)||typeof value!=='number'||value<0)invalid(`Invalid token count: ${label}`);
    return value;
  };
  return {inputTokens:count(u.input_tokens,'input_tokens'),outputTokens:count(u.output_tokens,'output_tokens')};
}
function batch(raw:unknown,answers:DecisionAnswer[],requestId?:string):DecisionBatchResult{
  const root=object(raw,'Response');
  if(typeof root.model!=='string'||!root.model||root.model.length>200)invalid('Missing actual model');
  const result=DecisionBatchResultSchema.safeParse({modelReturned:root.model,answers,...usage(root),requestId:requestId??null,raw});
  if(!result.success)invalid('Result does not match the public contract');
  return result.data;
}
function base(q:DecisionQuestion):DecisionAnswer{
  return {id:q.id,type:q.type,state:'answered',value:null,probability:null,distribution:null,confidence:null,reason:null};
}
function choiceState(value:string):DecisionAnswer['state']{
  return value==='insufficient_evidence'?'insufficient_evidence':'answered';
}
function weighted(d:Record<string,number>,levels:readonly {value:number}[]):number{
  return levels.reduce((sum,level,i)=>sum+level.value*d[String(i)]!,0);
}
function close(actual:number,expected:number,label:string):void{
  if(!Number.isFinite(actual)||Math.abs(actual-expected)>0.011)invalid(`Weighted score differs from distribution: ${label}`);
}

export function encodeJevDecision(model:string,state:string,questions:readonly DecisionQuestion[]):RecordValue{
  const qs=request(model,state,questions);
  const named=Object.fromEntries(qs.map(q=>{
    if(q.type==='predicate')return [q.id,{type:'noul',instructions:q.instructions,...(q.yes||q.no?{criteria:{...(q.yes?{true:q.yes}:{}),...(q.no?{false:q.no}:{})}}:{})}];
    if(q.type==='choice')return [q.id,{type:'choice',instructions:q.instructions,criteria:Object.fromEntries(q.options.map(o=>[o.value,o.description]))}];
    return [q.id,{type:'score',instructions:q.instructions,criteria:q.levels.map(l=>l.description)}];
  }));
  return {model,state,questions:named};
}
export function encodeOpenAIDecision(model:string,state:string,questions:readonly DecisionQuestion[]):RecordValue{
  const qs=request(model,state,questions);
  return {model,input:state,questions:qs.map(q=>{
    if(q.type==='predicate')return {type:'predicate',name:q.id,instructions:[q.instructions,q.yes?`Yes: ${q.yes}`:'',q.no?`No: ${q.no}`:''].filter(Boolean).join('\n')};
    if(q.type==='choice')return {type:'choice',name:q.id,instructions:q.instructions,choices:q.options.map(o=>({value:o.value,description:o.description}))};
    return {type:'score',name:q.id,instructions:q.instructions,levels:q.levels.map(l=>({label:String(l.value),description:l.description}))};
  })};
}
export function decodeJevDecision(raw:unknown,questions:readonly DecisionQuestion[],requestId?:string):DecisionBatchResult{
  const qs=questionsValid(questions);
  compact(raw,'Response');
  const root=object(raw,'Response');
  const found=object(root.answers,'Answers');
  if(Object.keys(found).length!==qs.length||qs.some(q=>!Object.hasOwn(found,q.id)))invalid('Answer set differs from questions');
  const answers=qs.map(q=>{
    const a=object(found[q.id],`Answer ${q.id}`);
    const out=base(q);
    if(q.type==='predicate'){
      if(a.type!=='noul')invalid(`Wrong answer type: ${q.id}`);
      out.probability=probability(a.noul,q.id);
      return out;
    }
    if(a.type!==q.type)invalid(`Wrong answer type: ${q.id}`);
    out.confidence=confidence(a.confidence,q.id);
    if(q.type==='choice'){
      if(typeof a.choice!=='string'||!q.options.some(o=>o.value===a.choice))invalid(`Unknown choice: ${q.id}`);
      const d=distribution(a.probabilities,q.options.map(o=>o.value),q.id);
      if(d[a.choice]!<Math.max(...Object.values(d))-EPSILON)invalid(`Choice is not a maximum: ${q.id}`);
      out.value=a.choice;out.distribution=d;out.state=choiceState(a.choice);
      return out;
    }
    const keys=q.levels.map((_,i)=>String(i));
    const d=distribution(a.probabilities,keys,q.id);
    const legend=object(a.legend,`Score legend ${q.id}`);
    if(Object.keys(legend).length!==keys.length||keys.some((key,i)=>legend[key]!==q.levels[i]!.description))
      invalid(`Score legend differs: ${q.id}`);
    if(typeof a.score!=='number')invalid(`Missing score: ${q.id}`);
    close(a.score,weighted(d,q.levels.map((_,i)=>({value:i}))),q.id);
    out.value=weighted(d,q.levels);out.distribution=Object.fromEntries(q.levels.map((l,i)=>[String(l.value),d[String(i)]!]));
    return out;
  });
  return batch(raw,answers,requestId);
}
export function decodeOpenAIDecision(raw:unknown,questions:readonly DecisionQuestion[],requestId?:string):DecisionBatchResult{
  const qs=questionsValid(questions);
  compact(raw,'Response');
  const root=object(raw,'Response');
  if(!Array.isArray(root.answers)||root.answers.length!==qs.length)invalid('Answer count differs from questions');
  const seen=new Set<string>();
  const answers=root.answers.map((item,i)=>{
    const q=qs[i]!;
    const a=object(item,`Answer ${i}`);
    if(a.name!==q.id||seen.has(q.id))invalid(`Answer name/order differs: ${q.id}`);
    seen.add(q.id);
    const out=base(q);
    if(a.type==='refusal'){out.state='refused';out.reason='Provider refused this question';return out;}
    if(a.type!==q.type)invalid(`Wrong answer type: ${q.id}`);
    if(q.type==='predicate'){out.probability=probability(a.probability,q.id);return out;}
    out.confidence=confidence(a.confidence,q.id);
    if(q.type==='choice'){
      if(typeof a.choice!=='string'||!q.options.some(o=>o.value===a.choice))invalid(`Unknown choice: ${q.id}`);
      const d=arrayDistribution(a.probabilities,q.options.map(o=>o.value),q.id);
      if(d[a.choice]!<Math.max(...Object.values(d))-EPSILON)invalid(`Choice is not a maximum: ${q.id}`);
      out.value=a.choice;out.distribution=d;out.state=choiceState(a.choice);
      return out;
    }
    const keys=q.levels.map((_,i)=>String(i));
    const d=arrayDistribution(a.probabilities,keys,q.id,true);
    for(const item of a.probabilities as RecordValue[]){
      const index=item.value as number;
      if(item.label!==String(q.levels[index]!.value))invalid(`Score level label differs: ${q.id}`);
    }
    if(typeof a.score!=='number')invalid(`Missing score: ${q.id}`);
    close(a.score,weighted(d,q.levels.map((_,i)=>({value:i}))),q.id);
    out.value=weighted(d,q.levels);out.distribution=Object.fromEntries(q.levels.map((l,i)=>[String(l.value),d[String(i)]!]));
    return out;
  });
  return batch(raw,answers,requestId);
}
