import {readFileSync,statSync} from 'node:fs';
import {z} from 'zod';

/**
 * Names that must never appear in model output. Read from a private file; the names themselves are never
 * logged, stored in the ledger or returned in errors. Only replacement counts are reported.
 *
 * File format:
 *   {"terms":["<full name>", ...],
 *    "secondaryTerms":["<given name alone>", ...],          // optional
 *    "replacement":{"zh":"当事女性","default":"the woman"}}  // or one string for every language
 *
 * - terms are always replaced.
 * - secondaryTerms (an ambiguous short form) are replaced only when a primary term appears in the same output
 *   or in that call's input, so the same short name in an unrelated event is left alone.
 * - Matching is on NFKC-normalised, case-folded text with invisible characters (zero-width, bidi marks,
 *   variation selectors, U+034F, soft hyphen) removed. Wherever a term has a space or separator, and between
 *   the characters of a CJK term, any run of spaces or separators (·・•‧-_ and similar) also matches, as does
 *   none. Alphabetic terms match whole words, where only Latin, Cyrillic and Greek letters and digits count as
 *   word characters: a name written right against Han, kana or hangul still matches. Nothing outside the
 *   listed names is generalised.
 * - The replacement is chosen per occurrence: "zh" when Han characters surround it, otherwise "default".
 */
const Term=z.string().trim().min(1).max(200);
const PolicySchema=z.strictObject({terms:z.array(Term).min(1).max(200),secondaryTerms:z.array(Term).max(50).optional(),
  replacement:z.union([z.string().trim().min(1).max(100),z.strictObject({zh:z.string().trim().min(1).max(100),default:z.string().trim().min(1).max(100)})])});
export interface RedactionPolicy {terms:readonly string[];secondaryTerms?:readonly string[];replacement:string|{zh:string;default:string}}

/** Invisible characters a writer or model can slip into a name; removed before matching. */
const INVISIBLE=/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E0FFF}]/gu;
const fold=(value:string)=>value.normalize('NFKC').replace(INVISIBLE,'').toLowerCase();
export function readRedactionFile(path:string):RedactionPolicy{
  const stat=statSync(path);
  if(!stat.isFile())throw new Error('Redaction file must be a regular file');
  if((stat.mode&0o077)!==0)throw new Error('Redaction file must not be readable by group or others (chmod 600)');
  let parsed:unknown;
  try{parsed=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('Redaction file is not valid JSON');}
  const result=PolicySchema.safeParse(parsed);
  // Errors never echo file content.
  if(!result.success)throw new Error('Redaction file must be {"terms":[...],"secondaryTerms":[...],"replacement":{"zh":"...","default":"..."}}');
  const policy=result.data;
  const replacements=typeof policy.replacement==='string'?[policy.replacement]:[policy.replacement.zh,policy.replacement.default];
  const all=[...policy.terms,...policy.secondaryTerms??[]].map(fold);
  if(replacements.some(text=>all.some(term=>fold(text).includes(term))))throw new Error('Redaction replacement must not contain a protected term');
  return policy;
}

const SEPARATORS='\\s\\u00B7\\u2027\\u2022\\u30FB\\uFF65\\u2010-\\u2015\\u002D\\u005F\\u02D1\\u0387';
const SEP=`[${SEPARATORS}]*`;
const han=/\p{Script=Han}/u;
/** Word characters for alphabetic names: Latin, Cyrillic and Greek letters and digits. Han, kana and hangul are not. */
const WORD='[\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{N}]';
const escapeRegExp=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function termPattern(term:string):string{
  const parts=fold(term).split(new RegExp(`[${SEPARATORS}]+`,'u')).filter(Boolean);
  // CJK names may be written with separators between any characters; Latin names only where the term has one.
  const body=parts.map(part=>han.test(part)?[...part].map(escapeRegExp).join(SEP):escapeRegExp(part)).join(SEP);
  const wordChar=new RegExp(WORD,'u');
  const latinStart=wordChar.test((parts[0]??'')[0]??'');
  const lastPart=parts.at(-1)??'';
  const latinEnd=wordChar.test(lastPart.at(-1)??'');
  return `${latinStart?`(?<!${WORD})`:''}(?:${body})${latinEnd?`(?!${WORD})`:''}`;
}
function compile(terms:readonly string[]):RegExp|null{
  const unique=[...new Set(terms.map(term=>term.trim()).filter(Boolean))].sort((a,b)=>b.length-a.length);
  return unique.length?new RegExp(unique.map(termPattern).join('|'),'gu'):null;
}

/** NFKC + case folding per code point, keeping a map back to the original text so only the name itself is replaced. */
function folded(text:string){
  let value='';const start:number[]=[],end:number[]=[];let offset=0;
  for(const char of text){const piece=fold(char);for(let i=0;i<piece.length;i++){start.push(offset);end.push(offset+char.length);}value+=piece;offset+=char.length;}
  return {value,start,end};
}
function spans(pattern:RegExp|null,text:string):{from:number;to:number}[]{
  if(!pattern)return [];
  const f=folded(text),found:{from:number;to:number}[]=[];
  pattern.lastIndex=0;
  for(let m=pattern.exec(f.value);m;m=pattern.exec(f.value)){
    if(!m[0].length){pattern.lastIndex++;continue;}
    found.push({from:f.start[m.index],to:f.end[m.index+m[0].length-1]});
  }
  pattern.lastIndex=0;
  return found;
}

export interface Redactor {
  /** Replaces protected names; secondary forms only when `context` or the text itself contains a primary name. */
  redact(text:string,context?:string):{text:string;count:number};
  /** True when the text contains a primary or secondary form. */
  contains(text:string):boolean;
  /** Prompt rule added to every call. */
  readonly instruction:string;
}
export function createRedactor(policy:RedactionPolicy):Redactor{
  const primary=compile(policy.terms),secondary=compile(policy.secondaryTerms??[]);
  const zh=typeof policy.replacement==='string'?policy.replacement:policy.replacement.zh;
  const other=typeof policy.replacement==='string'?policy.replacement:policy.replacement.default;
  const pick=(text:string,from:number,to:number)=>han.test(text.slice(Math.max(0,from-12),from)+text.slice(to,to+12))?zh:other;
  const names=[...policy.terms,...policy.secondaryTerms??[]].map(term=>JSON.stringify(term)).join(', ');
  return {
    redact(text,context=''){
      const found=spans(primary,text);
      const triggered=found.length>0||spans(primary,context).length>0;
      if(triggered)found.push(...spans(secondary,text));
      if(!found.length)return {text,count:0};
      // Keep non-overlapping spans, earliest first, longest at the same start.
      found.sort((a,b)=>a.from-b.from||b.to-a.to);
      let out='',cursor=0,count=0;
      for(const span of found){if(span.from<cursor)continue;out+=text.slice(cursor,span.from)+pick(text,span.from,span.to);cursor=span.to;count++;}
      return {text:out+text.slice(cursor),count};
    },
    contains(text){return spans(primary,text).length>0||spans(secondary,text).length>0;},
    instruction:`Privacy rule: never write any of these personal names or their variants in your output, in any field: ${names}. `+
      `Refer to that person only as "${zh}" in Chinese text and "${other}" in other languages. This applies even when the evidence names her.`,
  };
}
