import type {QueryAnswerer} from '../../packages/knowledge-application/src/ask.ts';

/** Explicit local UI fixture. This is not an LLM, semantic evaluation, or production answerer. */
export function createSyntheticQueryAnswerer():QueryAnswerer {
  return {id:'synthetic-ui-fixture',model:'synthetic-no-model',supportsMoneyLimit:true,
    async answer(input){
      input.signal.throwIfAborted();
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
