import {EntityMentionExtractionSchema,type EntityMentionExtraction} from '@commerce/knowledge-contracts';
import {KnowledgeError} from '@commerce/knowledge-core/types';

/** Check proposals against the exact source bytes; this does not resolve entity identity. */
export function validateEntityMentionSpans(content:string,raw:unknown):EntityMentionExtraction{
  if(typeof content!=='string')
    throw new KnowledgeError('ENTITY_MENTION_CONTENT_INVALID','Exact source text is required',422);
  const parsed=EntityMentionExtractionSchema.safeParse(raw);
  if(!parsed.success)
    throw new KnowledgeError('ENTITY_MENTION_EXTRACTION_INVALID','Entity mention extraction does not match the public contract',422);
  const bytes=Buffer.from(content,'utf8'),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  if(decoder.decode(bytes)!==content)
    throw new KnowledgeError('ENTITY_MENTION_CONTENT_INVALID','Exact source text is not valid Unicode',422);
  const seen=new Set<string>();
  for(const mention of parsed.data.mentions){
    if(mention.startByte>=mention.endByte||mention.endByte>bytes.length)
      throw new KnowledgeError('ENTITY_MENTION_SPAN_INVALID','Entity mention byte range is outside the exact source',422);
    let surface:string;
    try{surface=decoder.decode(bytes.subarray(mention.startByte,mention.endByte));}
    catch{throw new KnowledgeError('ENTITY_MENTION_SPAN_INVALID','Entity mention divides a UTF-8 character',422);}
    if(surface!==mention.surface)
      throw new KnowledgeError('ENTITY_MENTION_SURFACE_MISMATCH','Entity mention surface differs from the exact source bytes',422);
    const identity=JSON.stringify([mention.entityType,mention.startByte,mention.endByte]);
    if(seen.has(identity))
      throw new KnowledgeError('ENTITY_MENTION_DUPLICATE','The same entity type and byte range was proposed twice',422);
    seen.add(identity);
  }
  return parsed.data;
}
