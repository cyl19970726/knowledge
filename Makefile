.PHONY: demo test check docs docs-check docs-knowledge docs-knowledge-check ts-check

demo:
	python3 scripts/serve.py

test:
	python3 -m unittest discover -s tests -v

check: test
	python3 -m compileall -q scripts pipeline/legacy

docs: docs-knowledge
	python3 scripts/build_docs.py

docs-check: docs-knowledge-check
	python3 scripts/build_docs.py --check

docs-knowledge:
	python3 scripts/build_docs.py --docs-dir docs/knowledge --assets-dir docs

docs-knowledge-check:
	python3 scripts/build_docs.py --docs-dir docs/knowledge --assets-dir docs --check

ts-check:
	npm run build
	npm test
