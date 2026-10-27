import { ContentPlatformSchema, type AnalysisContextSnapshot, type ContentPlatform } from '../../contracts/src/index.ts';
import type { Applicability } from './types.ts';

/** Missing means an unchanged historical TikTok revision; [] means explicitly unverified. */
export function applicablePlatforms(scope:Applicability):ContentPlatform[] {
  return scope.platforms ?? ['tiktok'];
}

export function platformFit(scope:Applicability,target:ContentPlatform):'direct'|'transfer'|null {
  if(target==='unknown')return null;
  const sources=applicablePlatforms(scope);
  if(sources.includes(target))return 'direct';
  return sources.some(platform=>platform!=='unknown')&&
    scope.platformTransfers?.some(item=>item.to===target&&item.rationale.trim())?'transfer':null;
}

/** Historical post archives were TikTok; unattached media has no inferred platform. */
export function platformOfAnalysis(snapshot:AnalysisContextSnapshot):ContentPlatform {
  const post=snapshot.sourceContext.post;
  if(post)return post.platform===undefined?'tiktok':ContentPlatformSchema.parse(post.platform);
  const observed=snapshot.sourceContext.providerObservations
    .filter(item=>['public_search','provider_api'].includes(item.acquisition.source)&&item.platformPostId!==null)
    .map(item=>ContentPlatformSchema.safeParse(item.platform))
    .filter(result=>result.success).map(result=>result.data)
    .filter(platform=>platform!=='unknown');
  return observed.length&&new Set(observed).size===1?observed[0]!:'unknown';
}
