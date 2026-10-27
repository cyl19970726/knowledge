# Runtime-neutral knowledge client

`createKnowledgeClient({baseUrl,scope,fetch?,headers?})` runs in browser or Node and has no React, database or business dependency. It validates outbound DTOs and every response with `@commerce/knowledge-contracts`. An injected `fetch` and headers callback support authenticated host environments. The route is `/api/v1/projects/{projectId}/spaces/{spaceId}/knowledge`.

Read methods return `Envelope<T>`: `capabilities`, `profiles`, `query`, `catalog`, `document`, `history`, `compare`, `graph`, `impact`, `source`, `sourceContent`, `receipt`, `researchOperation`, `researchResult`, `operation`, `lookupOperation`, `reviewTicket`, `use`, `feedback`, `changes` and `feedbackResolutions`.

Write methods require `{idempotencyKey}`: `registerSource`, `research`, `cancelResearch`, `candidate`, `requestReview`, `decideReview`, `recordUse`, `recordFeedback`, `registerFeedbackSource`. The client does not retry. `KnowledgeClientError.commitStatus === 'unknown'` after a lost write response means the caller must use `lookupOperation({operation,key})` with the original key or a known operation ID. Transport loss and malformed write responses remain unknown even if the server may have committed. A structured server error preserves its declared commit status.

The client is a transport and validation layer. The server must authenticate the caller, bind effective scope, authorize purpose and validate exact source and publication semantics.
