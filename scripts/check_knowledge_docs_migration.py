#!/usr/bin/env python3
"""Check preserved knowledge text, live successors, IDs and both generated readers."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
KNOWLEDGE = DOCS / 'knowledge'
INLINE = re.compile(r'(!?\[[^\]]*\]\()[^\s)]+(\))')
REFERENCE = re.compile(r'^(\s*\[[^\]\n]+\]:\s*)(\S+)(.*)$', re.M)
LIVE_LIFECYCLES = {'current', 'instructions'}


def normalized_hash(text: str) -> str:
    text = INLINE.sub(r'\1URL\2', text)
    text = REFERENCE.sub(lambda m: m[1] + 'URL' + m[3], text)
    return hashlib.sha256(text.encode()).hexdigest()


def heading_slug(title: str) -> str:
    return re.sub(r'\s+', '-', re.sub(r'[^\w\s-]', '', title.lower())).strip('-') or 'section'


def headings(text: str, doc_id: str) -> list[dict]:
    tokens = MarkdownIt('commonmark', {'html': False}).enable('table').parse(text)
    result, counts = [], {}
    for i, token in enumerate(tokens):
        if token.type != 'heading_open':
            continue
        title = ''.join(c.content for c in tokens[i + 1].children or []
                        if c.type in {'text', 'code_inline'})
        base = heading_slug(title)
        number = counts.get(base, 0)
        counts[base] = number + 1
        local = base + (f'-{number}' if number else '')
        result.append({'heading': title, 'level': int(token.tag[1]),
                       'anchor': doc_id + '--' + local})
    return result


def check_current_guide(guide: str, source: str, heading: str,
                        by_path: dict[str, dict], cache: dict[str, set[str]]) -> None:
    if not isinstance(guide, str) or guide.count('#') != 1:
        raise ValueError(f'Current guide must name one Markdown section: {source}#{heading}')
    relative, encoded_fragment = guide.split('#')
    fragment = unquote(encoded_fragment)
    if not relative.startswith('knowledge/') or not relative.endswith('.md') or not fragment:
        raise ValueError(f'Current guide needs a knowledge Markdown file and section: {guide}')
    path = (DOCS / relative).resolve()
    if not path.is_relative_to(KNOWLEDGE) or not path.is_file():
        raise ValueError(f'Current guide target missing: {guide}')
    catalog_path = str(path.relative_to(KNOWLEDGE))
    document = by_path.get(catalog_path)
    if document is None:
        raise ValueError(f'Current guide target absent from catalog: {guide}')
    if document.get('lifecycle') not in LIVE_LIFECYCLES:
        raise ValueError(f'Current document retired without a live successor: {source}#{heading} -> {guide}')
    if catalog_path not in cache:
        prefix = document['id'] + '--'
        cache[catalog_path] = {
            h['anchor'][len(prefix):]
            for h in headings(path.read_text(), document['id'])
        }
    if fragment not in cache[catalog_path]:
        raise ValueError(f'Current guide section missing: {guide}')


def main(*, external_business: bool = False) -> None:
    mapping = json.loads((KNOWLEDGE / 'migration-map.json').read_text())
    catalog = json.loads((KNOWLEDGE / 'catalog.json').read_text())
    by_id = {d['id']: d['path'] for d in catalog['documents']}
    by_path = {d['path']: d for d in catalog['documents']}
    readers = [(DOCS / name).read_text() for name in ('index.html', 'knowledge/index.html')]
    reader_ids = [set(re.findall(r'\bid="([^\"]+)"', text)) for text in readers]
    seen_sources, seen_targets, seen_ids = set(), set(), set()
    guide_cache: dict[str, set[str]] = {}
    total = 0
    for source in mapping['sources'] + mapping.get('deliveries', []):
        for key, seen in [('source', seen_sources), ('destination', seen_targets), ('documentId', seen_ids)]:
            if source[key] in seen:
                raise ValueError(f'Duplicate migration {key}: {source[key]}')
            seen.add(source[key])
        path = (DOCS / source['destination']).resolve()
        if not path.is_relative_to(KNOWLEDGE) or not path.is_file():
            raise ValueError(f'Invalid knowledge target: {source["destination"]}')
        if by_id.get(source['documentId']) != str(path.relative_to(KNOWLEDGE)):
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
    for source in mapping['sources']:
        for section in source['sections']:
            check_current_guide(section.get('currentGuide'), source['source'], section['heading'],
                                by_path, guide_cache)
    root = json.loads((DOCS / 'catalog.json').read_text())
    for alias, target in mapping['rootAliasesAtBaseline'].items():
        if root.get('hash_aliases', {}).get(alias) != target:
            raise ValueError(f'Legacy alias changed: {alias}')
    if external_business:
        print(f'External business responsibility: {len(mapping["businessRetained"])} documents; '
              'presence checks skipped in --external-business mode.')
    else:
        for path in mapping['businessRetained']:
            if not (DOCS / path).is_file() or path.startswith('knowledge/'):
                raise ValueError(f'Business document lost: {path}')
    print(f'Knowledge documentation migration verified: {len(seen_sources)} complete sources, '
          f'{total} headings, live section successors, both readers and legacy aliases.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--external-business', action='store_true',
                        help='Skip businessRetained presence checks owned by an external repository')
    arguments = parser.parse_args()
    main(external_business=arguments.external_business)
