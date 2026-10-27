import {ArrowRight} from 'lucide-react';
import type {KnowledgeDocument,KnowledgeRef,SourceContent} from '@commerce/knowledge-contracts';
import {refKey} from './graph/view-model';

const sourceKinds:Record<string,string>={analysis_artifact:'分析报告原件',evidence_object:'证据原件',analysis_report_projection:'分析报告投影'};
const assertions:Record<string,string>={source_claim:'来源记录的主张',direct_observation:'原件中的直接观察',inference:'推断',caller_reported:'调用者报告'};
const assurances:Record<string,string>={read_time_only:'读取时核对权限',local_transaction:'本地事务内核对',owner_lease:'来源所有者限时授权',unknown:'尚未确认'};
const reasons:Record<string,string>={SOURCE_CONTENT_UNSUPPORTED:'当前原件格式暂不支持显示。',SOURCE_READ_LIMIT:'原件超过当前单次读取大小。',SOURCE_METADATA_ONLY:'当前权限仅允许查看来源信息。'};
export const sourceKindName=(value:string)=>sourceKinds[value]??value;
export const sourceAssertionName=(value:string)=>assertions[value]??value;
export const sourceAssuranceName=(value:string)=>assurances[value]??value;
export const sourceReasonName=(value:string)=>reasons[value]??value;
export function sourceLimitation(value:string):string{
  const known:Record<string,string>={
    'This is the exact stored analysis artifact, not independently verified media or business outcomes. Reading it does not count as viewing its cited frames.':'这是保存的准确分析报告；读取报告不等于独立核对媒体、经营结果或其中引用的帧图。',
    'Only this exact stored frame/text object is delivered. No continuous video, action interval, audio or caption coverage is asserted.':'只展示这一份帧图或文本原件，没有据此核对连续视频、动作过程、音轨或字幕。',
    'Repeated reports or frames from this asset remain one source group. Access grants no publication assurance.':'同一素材的重复报告或帧仍属于原来源组；当前可读不代表取得发表授权。',
    'Only this stored frame; no continuous video, audio or adjacent frames':'仅此采样帧；没有读取连续视频、音轨或相邻帧。',
    'Only the exact report/text object; cited media has not been read':'仅此报告或文本原件；其中引用的媒体并未随报告一起读取。',
  };
  if(known[value])return known[value];
  const prefix='Registered locator scope (not read coverage): ';
  if(value.startsWith(prefix)){
    try{const scope=JSON.parse(value.slice(prefix.length));
      if(scope.kind==='segment'&&Number.isFinite(scope.startMs)&&Number.isFinite(scope.endMs))
        return `登记定位范围：${scope.startMs/1000}–${scope.endMs/1000}秒；该位置记录不等于实际观看覆盖。`;
      if(scope.kind==='whole')return '原件登记为完整范围；登记范围不等于实际观看覆盖。';
    }catch{/* An unknown owner description remains visible verbatim. */}
  }
  return value;
}

export function CitationList({citations,onOpen}:{citations:KnowledgeDocument['citations'];onOpen:(ref:KnowledgeRef,locator:string|null)=>void}){
  const names={source:'来源主张',analysis:'准确分析报告',evidence:'准确证据原件',knowledge:'知识引用'};
  return <section className="citation-list"><h3>直接引用与来源主张</h3>
    <p className="minor-note">正文的引用保留准确来源版本；它不等于本次实际读取来源。</p>
    {citations===undefined?<p className="muted">当前内容投影未提供直接引用，不能推断原件没有引用。</p>:citations.length===0?<p className="muted">此准确版本未列出直接引用。</p>:citations.map((citation,index)=><article className="citation-item" key={`${refKey(citation.ref)}-${index}`}>
      <div className="eyebrow">{names[citation.ref.domain]}</div><p>{citation.supports}</p>
      <small>原引用定位：{citation.locator??'未提供'} · {citation.ref.objectId.slice(0,8)} · {citation.ref.versionId.slice(0,8)}</small>
      <button className="text-button" onClick={()=>onOpen(citation.ref,citation.locator)}>查看准确来源 <ArrowRight size={15}/></button>
    </article>)}
  </section>;
}

function readableText(text:string){try{return JSON.stringify(JSON.parse(text),null,2);}catch{return text;}}
export function SourceContentView({source}:{source:SourceContent}){return <div className="prose source-prose" data-source-read="content_read">
  <p role="status">内容已读 · {source.actualCoverage.byteCount} 字节 · 仅此准确版本</p>
  {source.media?<figure><img className="source-frame" src={`data:${source.media.mimeType};base64,${source.media.base64}`} alt="来源所有者返回的准确帧原件"/>
    <figcaption>仅此帧，不表示观看连续视频或听取音频。</figcaption></figure>:<pre className="source-original-text">{readableText(source.content)}</pre>}
  {source.actualCoverage.exclusions.map(item=><p className="minor-note" key={item}>{sourceLimitation(item)}</p>)}
</div>;}
