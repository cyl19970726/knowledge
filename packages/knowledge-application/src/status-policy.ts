import type {RevisionView} from '@commerce/knowledge-core/types';
import {getWikiPageProfile,matchesWikiPageFrozenBinding,wikiPageProfileFingerprint} from '@commerce/knowledge-core/wiki-page';
import {digest} from '@commerce/knowledge-core/utils';

/** One current eligibility policy for document reads, external use, and research admission. */
export function knowledgeRevisionSpace(view:RevisionView):string{
  return view.revision.binding?.spaceId??
    (['case','collection','comparison','pattern'].includes(view.revision.kind)?'legacy:video-research':'legacy:knowledge');
}
export function evaluateKnowledgeRevision(view:RevisionView,purpose:string){
  const revision=view.revision,content=revision.kind==='wiki_page'?revision.content:null;
  const profileId=content?.profile.id??revision.kind,profileVersion=content?.profile.version??'legacy';
  const registered=content?getWikiPageProfile(profileId,profileVersion):undefined;
  const contentSupported=!!registered&&matchesWikiPageFrozenBinding(revision);
  const spaceId=knowledgeRevisionSpace(view);
  const reasons:string[]=[];
  if(!view.published)reasons.push('not_published');
  if(!view.validity.valid)reasons.push(...view.validity.issues.map(issue=>issue.reason));
  if(!view.current)reasons.push('not_current');
  if(!contentSupported)reasons.push('content_version_unsupported');
  if(view.review?.purpose!==purpose||!(view.review.decision==='approved_for_purpose'||
    view.review.decision==='exploration_only'&&purpose==='exploration_reading'))reasons.push('not_reviewed_for_purpose');
  return {spaceId,profile:{id:profileId,version:profileVersion,
    digest:registered?wikiPageProfileFingerprint(registered):digest({id:profileId,version:profileVersion,unclassified:true})},
    contentSupported,reasons,admitted:reasons.length===0};
}
