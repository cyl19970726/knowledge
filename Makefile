.PHONY: test check docs docs-check docs-knowledge docs-knowledge-check ts-check

test:
	python3 -m unittest discover -s tests -v

check: test docs-check ts-check
	python3 -m compileall -q scripts

docs: docs-knowledge
	python3 scripts/build_docs.py --external-business

docs-check: docs-knowledge-check
	python3 scripts/build_docs.py --check --external-business
	python3 scripts/check_knowledge_docs_migration.py --external-business

docs-knowledge:
	python3 scripts/build_docs.py --docs-dir docs/knowledge --assets-dir docs

docs-knowledge-check:
	python3 scripts/build_docs.py --docs-dir docs/knowledge --assets-dir docs --check

ts-check:
	npm run build
	npm test
