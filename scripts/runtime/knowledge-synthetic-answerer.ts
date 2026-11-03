import type {QueryAnswerer} from '../../packages/knowledge-application/src/ask.ts';

type ExactRef={objectId:string;versionId:string};
type FixtureOptions={scenario?:undefined}|{scenario:'starmap-research';refs:{A:ExactRef;B:ExactRef;D:ExactRef}};
/** Explicit local UI fixture. This is not an LLM, semantic evaluation, or production answerer. */
export function createSyntheticQueryAnswerer(options:FixtureOptions={}):QueryAnswerer {
  return {id:'synthetic-ui-fixture',model:'synthetic-no-model',supportsMoneyLimit:true,
    async answer(input){
      input.signal.throwIfAborted();
      if(options.scenario==='starmap-research'){
        // Provider input omits Wiki identity; classify only exact versions supplied by this fixture.
        const read=input.evidence.filter(item=>item.kind==='wiki_page');
        const same=(item:typeof read[number],ref:ExactRef)=>item.ref.objectId===ref.objectId&&item.ref.versionId===ref.versionId;
        const preferred=[options.refs.A,options.refs.B].flatMap(ref=>read.filter(item=>same(item,ref)));
        const picked=[...preferred,...read.filter(item=>!preferred.some(first=>first.id===item.id))].slice(0,2);
        const claims=picked.map(page=>({
          text:same(page,options.refs.A)
            ?'【合成问答演示】A《结果可辨认》提出：商品需要在画面中可被识别与区分；这只是本次已读合成页的有条件说明。'
            :same(page,options.refs.B)
              ?'【合成问答演示】B《特征可靠呈现》提出：关键外观特征应清楚、稳定呈现，再安排叙事与镜头手段；这不是观众效果结论。'
              :`【合成问答演示】本次准确读到《${page.title}》；该页仅是合成研究材料，尚未验证真实观众或经营效果。`,
          evidenceIds:[page.id]}));
        return {answer:claims.length?{outcome:'answered' as const,claims,
          reason:'本地合成说明，仅依据本次实际读到的准确 Wiki 页；未调用真实模型。',
          gaps:['未做真实观众辨认测试',
            read.some(page=>same(page,options.refs.D))?'D 挑战已读，留作反例核对；不作为 A/B 结论的支持':'D 挑战未进入本次读集，不作为答案引文',
            ...picked.flatMap(page=>page.unknowns)]}:{outcome:'needs_evidence' as const,claims:[],
          reason:'本次合成输入没有可引用的 Wiki 页。',gaps:['本次没有可引用的 Wiki 页']},
          cost:{modelCalls:{state:'known' as const,value:0},tokens:{state:'known' as const,value:0},
            money:{state:'known' as const,amount:0,currency:'USD',source:'synthetic_local_no_paid_calls'}},
          modelReturned:'synthetic-no-model',requestId:`synthetic:${input.operationId}`};
      }
      const page=input.evidence.find(item=>item.kind==='wiki_page');
      return {answer:page?{
        outcome:'answered',claims:[{text:`【合成问答演示】读取了《${page.title}》的准确版本。以下仅为工程夹具原文节选，不是模型综合或真实研究结论：\n${page.body.slice(0,200)}`,
          evidenceIds:[page.id]}],reason:'本地合成演示，仅验证引用与交互；没有调用真实模型。',
        gaps:['合成数据与确定性演示回答；尚未验证真实模型的引文推理、条件继承或业务效果',...page.unknowns],
      }:{outcome:'needs_evidence',claims:[],reason:'本次合成输入没有可引用的 Wiki 页。',gaps:['本次没有可引用的 Wiki 页']},
      cost:{modelCalls:{state:'known',value:0},tokens:{state:'known',value:0},
        money:{state:'known',amount:0,currency:'USD',source:'synthetic_local_no_paid_calls'}},
      modelReturned:'synthetic-no-model',requestId:`synthetic:${input.operationId}`};
    }};
}
