#!/usr/bin/env python3
"""Check preserved knowledge text, headings, IDs and both generated readers."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
INLINE = re.compile(r'(!?\[[^\]]*\]\()[^\s)]+(\))')
REFERENCE = re.compile(r'^(\s*\[[^\]\n]+\]:\s*)(\S+)(.*)$', re.M)


def normalized_hash(text: str) -> str:
    text = INLINE.sub(r'\1URL\2', text)
    text = REFERENCE.sub(lambda m: m[1] + 'URL' + m[3], text)
    return hashlib.sha256(text.encode()).hexdigest()


def headings(text: str, doc_id: str) -> list[dict]:
    tokens = MarkdownIt('commonmark', {'html': False}).enable('table').parse(text)
    result, counts = [], {}
    for i, token in enumerate(tokens):
        if token.type != 'heading_open':
            continue
        title = ''.join(c.content for c in tokens[i + 1].children or []
                        if c.type in {'text', 'code_inline'})
        base = re.sub(r'\s+', '-', re.sub(r'[^\w\s-]', '', title.lower())).strip('-') or 'section'
        number = counts.get(base, 0)
        counts[base] = number + 1
        local = base + (f'-{number}' if number else '')
        result.append({'heading': title, 'level': int(token.tag[1]),
                       'anchor': doc_id + '--' + local})
    return result


def main() -> None:
    mapping = json.loads((DOCS / 'knowledge/migration-map.json').read_text())
    catalog = json.loads((DOCS / 'knowledge/catalog.json').read_text())
    by_id = {d['id']: d['path'] for d in catalog['documents']}
    readers = [(DOCS / name).read_text() for name in ('index.html', 'knowledge/index.html')]
    reader_ids = [set(re.findall(r'\bid="([^\"]+)"', text)) for text in readers]
    seen_sources, seen_targets, seen_ids = set(), set(), set()
    total = 0
    for source in mapping['sources'] + mapping.get('deliveries', []):
        for key, seen in [('source', seen_sources), ('destination', seen_targets), ('documentId', seen_ids)]:
            if source[key] in seen:
                raise ValueError(f'Duplicate migration {key}: {source[key]}')
            seen.add(source[key])
        path = (DOCS / source['destination']).resolve()
        if not path.is_relative_to(DOCS / 'knowledge') or not path.is_file():
            raise ValueError(f'Invalid knowledge target: {source["destination"]}')
        if by_id.get(source['documentId']) != str(path.relative_to(DOCS / 'knowledge')):
            raise ValueError(f'Document ID moved or duplicated: {source["documentId"]}')
        text = path.read_text()
        if normalized_hash(text) != source['normalizedTextSha256']:
            raise ValueError(f'Retained text changed: {source["source"]}')
        actual = headings(text, source['documentId'])
        expected = [{k: s[k] for k in ('heading', 'level', 'anchor')} for s in source['sections']]
        if actual != expected:
            raise ValueError(f'Heading mapping changed: {source["source"]}')
        required = {source['documentId']} | {h['anchor'] for h in actual}
        if any(not required <= ids for ids in reader_ids):
            raise ValueError(f'Old HTML anchor missing: {source["documentId"]}')
        total += len(actual)
    root = json.loads((DOCS / 'catalog.json').read_text())
    for alias, target in mapping['rootAliasesAtBaseline'].items():
        if root.get('hash_aliases', {}).get(alias) != target:
            raise ValueError(f'Legacy alias changed: {alias}')
    for path in mapping['businessRetained']:
        if not (DOCS / path).is_file() or path.startswith('knowledge/'):
            raise ValueError(f'Business document lost: {path}')
    print(f'Knowledge documentation migration verified: {len(seen_sources)} complete sources, '
          f'{total} headings, both readers and legacy aliases.')


if __name__ == '__main__':
    main()
