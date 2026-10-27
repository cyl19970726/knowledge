# Independent Knowledge Product

This repository contains only the standalone knowledge product and its generic document adapter. Keep commerce adapters, business source owners, application databases, credentials, and other business runtime content out of the core.

- Use the Node 24 version in `.node-version`; preserve the existing package names and workspace dependency direction.
- Core source lives in `packages/contracts`, `packages/knowledge*`, `packages/adapters/knowledge-service`, `packages/adapters/knowledge-document`, and `apps/knowledge-*`. The document adapter is the second-business integration reference, not a commerce-specific implementation.
- Keep implementation, local engineering validation, deployment, and business acceptance distinct. Demo fixtures are synthetic and do not establish real-world knowledge quality.
- Database tests require an explicit `TEST_DATABASE_URL` for a dedicated disposable test database. Never load business `.env` files or reuse application data. Set `TEST_DATABASE_REQUIRED=1` for required database acceptance so missing configuration fails visibly.
- Product, architecture, capabilities, operations, current state, and maintenance each have one owning document under `docs/knowledge/`; start at `docs/knowledge/README.md`. The root `docs/README.md` is only the core navigation entry, and root `docs/catalog.json` imports `knowledge/catalog.json` rather than maintaining a business document inventory.
- Edit Markdown and catalog source only. Generate both readers with `make docs`, validate with `make docs-check`, and never edit generated HTML directly. Preserve stable IDs, retained text, live section successors, historical aliases, and `docs/knowledge/migration-map.json`.
- The core migration check uses `--external-business` because business documents belong to their external owning repository. The default remains strict for the commerce repository; do not weaken preservation or current-guide checks.
- Run the relevant core build and tests plus documentation checks before delivery. Report missing database coverage explicitly; never present skipped integration tests as passing coverage.
- Skills are project-local by default. Do not install or register global skills without explicit authorization.

## Branch and release handoff

- Isolate concurrent implementation in a dedicated worktree or clone and a feature branch. Preserve other tasks' changes and do not commit unless requested.
- Integrate releases through pull requests. Report implementation, review, merge, deployment, and business acceptance as separate states.
- Every handoff lists changed behavior, commands actually run, results, remaining limitations, and any database or semantic acceptance still needed.
