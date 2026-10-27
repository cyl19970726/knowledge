import {KnowledgeClientError,type KnowledgeClient} from '@commerce/knowledge-client';
import type {KnowledgeRef,SourceRecord,SourceContent,SourceUpsert} from '@commerce/knowledge-contracts';
type Observer={start:()=>void;metadata:(value:SourceRecord)=>void;content:(value:SourceContent)=>void;anchor:(message:string)=>void;error:(error:unknown)=>void};
type Client=Pick<KnowledgeClient,'source'|'sourceContent'>;
function locatorAnchor(locator:string|null):SourceUpsert['anchors'][number]|null {
  const match=locator?.match(/^(time_range|page|paragraph|record):(.+)$/);
  return match?{kind:match[1] as SourceUpsert['anchors'][number]['kind'],value:match[2],resolved:true}:null;
}

/** One active source view. Late metadata, content and failures cannot cross a switch or navigation. */
export class SourceReads {
  private sequence=0;
  private abort:AbortController|null=null;
  cancel(){this.sequence++;this.abort?.abort();this.abort=null;}
  async open(client:Client,ref:KnowledgeRef,purpose:string,locator:string|null,observer:Observer):Promise<void>{
    this.cancel();const sequence=this.sequence,abort=new AbortController();this.abort=abort;
    const commit=(action:()=>void)=>{if(sequence===this.sequence&&!abort.signal.aborted)action();};
    observer.start();
    try{
      const response=await client.source(ref,purpose,{signal:abort.signal});
      if(sequence!==this.sequence||abort.signal.aborted)return;
      observer.metadata(response.data);if(!response.data.readability.contentReadable)return;
      const anchor=locatorAnchor(locator);
      if(locator&&!anchor)observer.anchor('引用定位格式未适配；将读取准确来源原件，未声称定位到段落。');
      let content;
      try{content=await client.sourceContent(response.data.ref,purpose,anchor??undefined,{signal:abort.signal});}
      catch(error){
        if(sequence!==this.sequence||abort.signal.aborted)return;
        if(!(error instanceof KnowledgeClientError)||error.code!=='SOURCE_ANCHOR_UNRESOLVED'||!anchor)throw error;
        observer.anchor('来源所有者未确认此引用锚点；将读取准确来源原件，请按定位符自行核对。');
        content=await client.sourceContent(response.data.ref,purpose,undefined,{signal:abort.signal});
      }
      commit(()=>{observer.content(content.data);if(content.data.anchor)observer.anchor(content.data.anchor.value.startsWith('{')?'来源所有者已确认这张原件的引用定位。':`来源所有者已确认原引用锚点：${content.data.anchor.kind}:${content.data.anchor.value}。`);});
    }catch(error){commit(()=>observer.error(error));}
  }
}
