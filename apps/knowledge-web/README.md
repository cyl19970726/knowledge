# Knowledge web

Independent browser application for the generic knowledge service. It imports only the public knowledge client and contracts; the graph projection and Cytoscape/ELK Worker stay inside this application.

## Local run

From the repository root:

```sh
npm run build:knowledge-client
npm run dev:knowledge-api
npm run dev:knowledge-web
```

The web server listens on `127.0.0.1:4310` and proxies `/api` to the local knowledge API at `127.0.0.1:4311`. Supply the API's authorized project ID, space ID, and local bearer token in the connection dialog. `VITE_KNOWLEDGE_PROJECT_ID`, `VITE_KNOWLEDGE_SPACE_ID`, and `VITE_KNOWLEDGE_PURPOSE` can prefill non-secret fields. No token is embedded in the build or stored in browser storage. An empty purpose uses the first purpose returned by the API's capabilities response.

```sh
npm run build -w @commerce/knowledge-web
npm run test -w @commerce/knowledge-web
npm run preview -w @commerce/knowledge-web
```

The production preview listens on `127.0.0.1:4312` and proxies to the same local API, without live reload. The UI reads only data returned by the knowledge API. It does not contain production knowledge fixtures. When the API is read-only, research and feedback submission are disabled from its capability response. The Canvas graph has a DOM list for node and relation selection. Browser validation can inspect `data-graph-debug` on `[data-testid="knowledge-graph"]` for measured layout duration, rendered positions, counts, camera, and layout state.
