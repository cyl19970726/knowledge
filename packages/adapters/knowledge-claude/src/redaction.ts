import {readFileSync,statSync} from 'node:fs';
import {z} from 'zod';

/**
 * Names that must never appear in model output. Read from a private file; the terms themselves are never
 * logged, stored in the ledger or returned in errors. Only replacement counts are reported.
 */
export interface RedactionPolicy {terms:readonly string[];replacement:string}
const PolicySchema=z.strictObject({terms:z.array(z.string().trim().min(1).max(200)).min(1).max(200),replacement:z.string().trim().min(1).max(100)});

export function readRedactionFile(path:string):RedactionPolicy{
  const stat=statSync(path);
  if(!stat.isFile())throw new Error('Redaction file must be a regular file');
  if((stat.mode&0o077)!==0)throw new Error('Redaction file must not be readable by group or others (chmod 600)');
  let parsed:unknown;
  try{parsed=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('Redaction file is not valid JSON');}
  const result=PolicySchema.safeParse(parsed);
  // The error never echoes file content.
  if(!result.success)throw new Error('Redaction file must be {"terms":[...],"replacement":"..."}');
  if(result.data.terms.some(term=>result.data.replacement.toLowerCase().includes(term.toLowerCase())))
    throw new Error('Redaction replacement must not contain a protected term');
  return result.data;
}

const escapeRegExp=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export interface Redactor {
  /** Replaces every protected term; Latin letters match case-insensitively. */
  redact(text:string):{text:string;count:number};
  contains(text:string):boolean;
  /** Prompt rule added to every model call. */
  readonly instruction:string;
}
export function createRedactor(policy:RedactionPolicy):Redactor{
  // Longest first so a full name is replaced before a shorter part of it.
  const terms=[...new Set(policy.terms)].sort((a,b)=>b.length-a.length);
  const pattern=new RegExp(terms.map(escapeRegExp).join('|'),'giu');
  return {
    redact(text){let count=0;const out=text.replace(pattern,()=>{count++;return policy.replacement;});return {text:out,count};},
    contains(text){pattern.lastIndex=0;const found=pattern.test(text);pattern.lastIndex=0;return found;},
    instruction:`Privacy rule: never write any of these personal names or their variants in your output, in any field: ${terms.map(term=>JSON.stringify(term)).join(', ')}. Refer to that person only as "${policy.replacement}". This applies even when the evidence names her.`,
  };
}
