/** A bounded word-overlap reader, not synonym or semantic retrieval. */
export const WIKI_LEXICAL_METHOD_VERSION='wiki-lexical-v1' as const;
const MAX_TERMS=64;
const stopwords=new Set(['的','了','和','与','或','及','在','是','有','为','把','被','对','从','到','这','那','我','你','他',
  '我们','你们','他们','这个','那个','这些','那些','一个','一些','什么','怎么','如何','怎样','为什么','是否','可以','应该',
  '需要','有关','关于','里面','其中','还有','以及','或者','如果','那么','就是','the','and','for','with','from','what',
  'how','why','when','where','this','that','are','can','should']);
const han=/^\p{Script=Han}+$/u;
const latin=/^[\p{Script=Latin}\p{Number}]+$/u;
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});

export interface WikiLexicalPlan {methodVersion:typeof WIKI_LEXICAL_METHOD_VERSION;terms:string[];termsTruncated:boolean;}
export function planWikiLexicalQuery(rawQuery:string):WikiLexicalPlan{
  const normalized=rawQuery.normalize('NFKC').toLowerCase();
  const found:string[]=[],seen=new Set<string>();
  let termsTruncated=false;
  const add=(term:string)=>{
    if(term.length<2||stopwords.has(term)||seen.has(term))return;
    if(term.length>64){termsTruncated=true;return;}
    if(found.length===MAX_TERMS){termsTruncated=true;return;}
    seen.add(term);found.push(term);
  };
  for(const segment of segmenter.segment(normalized)){
    if(!segment.isWordLike)continue;
    for(const token of segment.segment.match(/[\p{Script=Han}]+|[\p{Script=Latin}\p{Number}]+/gu)??[]){
      if(han.test(token)){
        if(stopwords.has(token))continue;
        add(token);
        if(Array.from(token).length>3){
          const chars=Array.from(token);
          for(const width of [3,2])for(let start=0;start+width<=chars.length;start++)
            add(chars.slice(start,start+width).join(''));
        }
      }else if(latin.test(token))add(token);
    }
  }
  return {methodVersion:WIKI_LEXICAL_METHOD_VERSION,terms:found,termsTruncated};
}
