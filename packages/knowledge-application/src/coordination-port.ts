import type {CoordinationRun,CoordinationRequest} from '@commerce/knowledge-contracts';
import type {ReadContext} from './index.ts';
export interface CoordinationOperationPort {
 reserve(context:ReadContext,inputDigest:string,initial:CoordinationRun):Promise<{created:boolean;result:CoordinationRun}>;
 checkpoint(context:ReadContext,id:string,result:CoordinationRun):Promise<void>;
 finish(context:ReadContext,id:string,result:CoordinationRun):Promise<void>;
 reconcile?(context:ReadContext,id:string,result:CoordinationRun):Promise<CoordinationRun>;
 get(context:ReadContext,id:string):Promise<CoordinationRun|null>;
 byTask(context:ReadContext,taskId:string):Promise<CoordinationRun|null>;
}
export type {CoordinationRun,CoordinationRequest};
