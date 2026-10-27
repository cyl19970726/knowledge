import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeDecisionGuideSchema} from '../../contracts/src/index.ts';
import {WikiContentSchema} from '../src/schemas.ts';
import {SyntheticAnalysis,mediaCitation,ref} from './service-fixtures.ts';

test('legacy Wiki remains valid and a guide needs exact rendered citation markers',()=>{
  const projectId='local-perseek',analysis=new SyntheticAnalysis().add(projectId),pageRef=ref();
  const base={ref:pageRef,projectId,title:'Synthetic finding',question:'What is observed?',
    claimRefs:[],patternRefs:[],relatedRefs:[],disputes:[],nextQuestions:[],
    citations:[mediaCitation(analysis.anchor)]};
  assert.equal(WikiContentSchema.safeParse(base).success,true);
  const guide={judgment:'候选判断〔引证 1〕',applicableWhen:['适用条件〔引证 1〕'],
    avoidWhen:['回避条件〔引证 1〕'],adaptationIdeas:['原创迁移假设：新动作〔引证 1〕'],
    validationPlan:['比较可理解性〔引证 1〕']};
  assert.equal(KnowledgeDecisionGuideSchema.safeParse(guide).success,true);
  assert.equal(WikiContentSchema.safeParse({...base,decisionGuide:{...guide,judgment:`${'x'.repeat(8000)}〔引证 1〕`}}).success,true,'rendered citations fit beyond the model paragraph limit');
  assert.equal(WikiContentSchema.safeParse({...base,decisionGuide:guide}).success,true);
  assert.equal(KnowledgeDecisionGuideSchema.safeParse({...guide,adaptationIdeas:['已验证的效果〔引证 1〕']}).success,false);
  assert.equal(WikiContentSchema.safeParse({...base,decisionGuide:{...guide,avoidWhen:['无标记']}}).success,false);
  assert.equal(WikiContentSchema.safeParse({...base,decisionGuide:{...guide,judgment:'超出范围〔引证 2〕'}}).success,false);
  assert.equal(WikiContentSchema.safeParse({...base,navigationOnly:true,
    navigation:{total:0,covered:0,pending:0,recentPages:[],omittedPages:0},
    relatedRefs:[],citations:[],decisionGuide:guide}).success,false);
});
