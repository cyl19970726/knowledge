#!/usr/bin/env python3
"""Build a portable, offline documentation reader from declared Markdown catalogs.

An imported catalog keeps document paths relative to its own folder. A standalone
catalog may declare ``external_documents`` as {"../index.html": ["stable-anchor"]}
and ``shared_assets`` as relative file paths. Its title, home_id, brand,
brand_mark and edition control the shared reader's visible identity.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def slug(text: str) -> str:
    return re.sub(r'\s+', '-', re.sub(r'[^\w\s-]', '', text.lower())).strip('-') or 'section'


def _inside(path: Path, boundary: Path, description: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(boundary.resolve()):
        raise ValueError(f'{description} escapes directory')
    return resolved


def _relative_file(base: Path, name: str, boundary: Path, description: str) -> Path:
    if not isinstance(name, str) or not name or Path(name).is_absolute() or '\\' in name:
        raise ValueError(f'Invalid {description}: {name}')
    return _inside(base / name, boundary, description)


def load_documents(directory: Path, assets_dir: Path | None = None):
    directory = directory.resolve()
    assets_dir = (assets_dir or directory).resolve()
    if not directory.is_relative_to(assets_dir):
        raise ValueError('Docs directory must be inside assets directory')
    visiting, seen_catalogs = set(), set()
    entries, aliases, external, shared = [], {}, {}, {}

    def visit(catalog_path: Path):
        catalog_path = _inside(catalog_path, directory, 'Catalog import')
        if catalog_path in visiting:
            raise ValueError(f'Catalog import cycle: {catalog_path}')
        if catalog_path in seen_catalogs:
            raise ValueError(f'Duplicate catalog import: {catalog_path}')
        visiting.add(catalog_path)
        seen_catalogs.add(catalog_path)
        current = json.loads(catalog_path.read_text())
        folder = catalog_path.parent
        for entry in current['documents']:
            path = _relative_file(folder, entry['path'], folder, 'Catalog path')
            if path.suffix != '.md':
                raise ValueError(f'Catalog path is not Markdown: {entry["path"]}')
            entries.append({**entry, 'path': str(path.relative_to(directory)), '_catalog_dir': folder})
        if not isinstance(current.get('hash_aliases', {}), dict):
            raise ValueError('hash_aliases must be an object')
        for key, value in current.get('hash_aliases', {}).items():
            if key in aliases:
                raise ValueError(f'Duplicate hash alias: {key}')
            aliases[key] = value
        if not isinstance(current.get('external_documents', {}), dict):
            raise ValueError('external_documents must be an object')
        for key, value in current.get('external_documents', {}).items():
            target = _relative_file(folder, key, assets_dir, 'External document')
            if target != assets_dir / 'index.html':
                # Imported catalogs may name only the main report as an external document.
                raise ValueError(f'Unsupported external document: {key}')
            if not isinstance(value, list) or not value or any(not isinstance(a, str) or not a for a in value):
                raise ValueError('external_documents anchors must be a non-empty list')
            external.setdefault(folder, {}).setdefault(target, set()).update(value)
        if not isinstance(current.get('shared_assets', []), list):
            raise ValueError('shared_assets must be a list')
        for name in current.get('shared_assets', []):
            target = _relative_file(folder, name, assets_dir, 'Shared asset')
            if target.suffix == '.md' or not target.is_file():
                raise ValueError(f'Invalid shared asset: {name}')
            shared.setdefault(folder, set()).add(target)
        imports = current.get('imports', [])
        if not isinstance(imports, list):
            raise ValueError('imports must be a list')
        for name in imports:
            target = _relative_file(folder, name, directory, 'Catalog import')
            if target.name != 'catalog.json':
                raise ValueError(f'Import must name catalog.json: {name}')
            visit(target)
        visiting.remove(catalog_path)
        return current

    catalog = visit(directory / 'catalog.json')
    catalog = {**catalog, 'documents': entries, 'hash_aliases': aliases,
               '_external_documents': external, '_shared_assets': shared}
    ids = [entry['id'] for entry in entries]
    paths = [entry['path'] for entry in entries]
    if len(set(ids)) != len(ids) or len(set(paths)) != len(paths):
        raise ValueError('Duplicate catalog ID or path')
    if any(not re.fullmatch(r'[a-z][a-z0-9-]*', id_) for id_ in ids):
        raise ValueError('Catalog IDs must be stable ASCII slugs')
    found = {str(p.relative_to(directory)) for p in directory.rglob('*.md')}
    if found != set(paths):
        raise ValueError(f'Catalog mismatch: missing={found-set(paths)}, unknown={set(paths)-found}')
    md = MarkdownIt('commonmark', {'html': False}).enable('table')
    original_fence = md.renderer.rules['fence']

    def render_fence(tokens, idx, options, env):
        token = tokens[idx]
        if token.info.strip().split()[:1] != ['mermaid']:
            return original_fence(tokens, idx, options, env)
        source = html.escape(token.content)
        return (f'<figure class="mermaid-figure" data-mermaid-diagram>'
                f'<div class="mermaid-output" role="img" aria-label="Mermaid diagram"></div>'
                f'<pre class="mermaid-source"><code>{source}</code></pre></figure>\n')

    md.renderer.rules['fence'] = render_fence
    docs = {}
    for entry in entries:
        subgroup = entry.get('subgroup')
        if subgroup is not None and (not isinstance(subgroup, str) or not subgroup.strip()):
            raise ValueError('Catalog subgroup must be a non-empty string')
        path = _relative_file(directory, entry['path'], directory, 'Catalog path')
        tokens = md.parse(path.read_text())
        headings, counts = [], {}
        for i, token in enumerate(tokens):
            if token.type == 'heading_open':
                title = ''.join(t.content for t in tokens[i + 1].children or [] if t.type in {'text', 'code_inline'})
                base = slug(title)
                number = counts.get(base, 0)
                counts[base] = number + 1
                local = base + (f'-{number}' if number else '')
                anchor = entry['id'] + '--' + local
                token.attrSet('id', anchor)
                headings.append({'id': anchor, 'local': local, 'title': title, 'level': int(token.tag[1])})
        docs[path] = {**entry, 'tokens': tokens, 'headings': headings}
    return catalog, md, docs


def resolve_link(url: str, current: Path, directory: Path, docs: dict, *, image=False,
                 assets_dir: Path | None = None, external=None, shared=None,
                 root_anchors=None) -> str:
    assets_dir = assets_dir or directory
    external = external or {}
    shared = shared or set()
    parts = urlsplit(url)
    if parts.scheme or parts.netloc:
        if parts.scheme not in {'https', 'http', 'mailto'} or image:
            raise ValueError(f'Unsupported or remote image link: {url}')
        return url
    path = (current.parent / unquote(parts.path)).resolve() if parts.path else current
    anchor = unquote(parts.fragment)
    if not image and path == assets_dir / 'index.html' and path != directory / 'index.html':
        if parts.query or not anchor or anchor not in external.get(path, set()):
            raise ValueError(f'Undeclared external document anchor: {current.name}: {url}')
        return quote(os.path.relpath(path, directory), safe='/') + '#' + quote(anchor)
    if not image and path == directory / 'index.html' and path in external:
        if parts.query or not anchor or anchor not in external[path]:
            raise ValueError(f'Undeclared external document anchor: {current.name}: {url}')
        if root_anchors is not None and anchor not in root_anchors:
            raise ValueError(f'Unknown external document anchor: {current.name}: {url}')
        return '#' + anchor
    if not path.is_relative_to(directory.resolve()):
        if not path.is_relative_to(assets_dir) or path not in shared or path.suffix == '.md':
            raise ValueError(f'Link escapes portable docs: {current.name}: {url}')
    if not path.is_file():
        raise ValueError(f'Broken link: {current.name}: {url}')
    if path.suffix == '.md' and not image:
        if path not in docs:
            raise ValueError(f'Markdown target missing in catalog: {url}')
        target = docs[path]
        if anchor:
            mapping = {h['local']: h['id'] for h in target['headings']}
            if anchor not in mapping:
                raise ValueError(f'Unknown heading: {current.name}: {url}')
            return '#' + mapping[anchor]
        return '#' + target['id']
    if parts.fragment:
        # HTML diagrams own their internal navigation; validate static anchors when requested.
        if path.suffix == '.html' and not re.search(r'id=[\"\']' + re.escape(unquote(parts.fragment)) + r'[\"\']', path.read_text()):
            raise ValueError(f'Unknown HTML anchor: {url}')
    relative = quote(os.path.relpath(path, directory), safe='/')
    return relative + ('?' + parts.query if parts.query else '') + ('#' + parts.fragment if parts.fragment else '')


def validate_diagrams(directory: Path, only_html: set[str] | None = None):
    manifest = json.loads((directory / 'diagrams/manifest.json').read_text())
    for diagram in manifest['diagrams']:
        if only_html is not None and diagram['html'] not in only_html:
            continue
        for key, hash_key in [('html', 'artifact_sha256'), ('specification', 'specification_sha256')]:
            path = directory / 'diagrams' / diagram[key]
            if not path.resolve().is_relative_to((directory / 'diagrams').resolve()):
                raise ValueError('Diagram path escapes directory')
            if digest(path) != diagram[hash_key]:
                raise ValueError(f'Diagram hash mismatch: {path.name}')
    return manifest


class UnknownHashAliasTarget(ValueError):
    pass


def validate_hash_aliases(catalog: dict, docs: dict,
                          unresolved_aliases: set[str] | None = None) -> dict[str, str]:
    aliases = catalog.get('hash_aliases', {})
    if not isinstance(aliases, dict):
        raise ValueError('hash_aliases must be an object')
    available = {doc['id'] for doc in docs.values()}
    available.update(heading['id'] for doc in docs.values() for heading in doc['headings'])
    if any(not isinstance(key, str) or not key for key in aliases):
        raise ValueError('Hash alias keys must be non-empty strings')
    if any(not isinstance(target, str) or not target for target in aliases.values()):
        raise ValueError('Hash alias targets must be non-empty strings')
    conflict = set(aliases) & available
    if conflict:
        raise ValueError(f'Hash alias conflicts with existing anchor: {sorted(conflict)[0]}')

    resolved = {}
    unresolved_aliases = unresolved_aliases or set()

    def resolve(key: str, visiting: set[str]) -> str:
        if key in available:
            return key
        if key not in aliases:
            raise UnknownHashAliasTarget(f'Unknown hash alias target: {key}')
        if key in visiting:
            raise ValueError(f'Hash alias cycle: {key}')
        visiting.add(key)
        target = resolve(aliases[key], visiting)
        visiting.remove(key)
        resolved[key] = target
        return target

    for key in aliases:
        try:
            resolve(key, set())
        except UnknownHashAliasTarget:
            if key not in unresolved_aliases:
                raise
    return resolved


def build(directory: Path, assets_dir: Path | None = None, *, external_business: bool = False):
    directory = directory.resolve()
    assets_dir = (assets_dir or directory).resolve()
    if not (assets_dir / '_site/mermaid.bundle.js').is_file():
        raise ValueError('Missing offline Mermaid runtime: _site/mermaid.bundle.js')
    catalog, md, docs = load_documents(directory, assets_dir)
    standalone = directory != assets_dir
    unresolved_aliases = set()
    if external_business:
        if standalone:
            raise ValueError('--external-business applies only to the root reader')
        mapping = json.loads((directory / 'knowledge/migration-map.json').read_text())
        unresolved_aliases = {key for key, target in mapping['rootAliasesAtBaseline'].items()
                              if catalog['hash_aliases'].get(key) == target}
    aliases = validate_hash_aliases(catalog, docs, unresolved_aliases)
    if (directory / 'diagrams/manifest.json').is_file():
        diagrams = validate_diagrams(directory)
    else:
        diagrams = {'diagrams': []}
    shared_diagrams = set()
    if standalone:
        shared_diagrams = {p for paths in catalog['_shared_assets'].values() for p in paths
                           if p.is_relative_to(assets_dir / 'diagrams') and p.suffix == '.html'}
        if shared_diagrams:
            parent_diagrams = validate_diagrams(
                assets_dir, {str(p.relative_to(assets_dir / 'diagrams')) for p in shared_diagrams})
            declared = {(assets_dir / 'diagrams' / d['html']).resolve() for d in parent_diagrams['diagrams']}
            if not shared_diagrams <= declared:
                raise ValueError('Shared diagram missing from diagrams manifest')
    diagram_paths = {quote(os.path.relpath(directory / 'diagrams' / d['html'], directory), safe='/')
                     for d in diagrams['diagrams']}
    diagram_paths.update(quote(os.path.relpath(p, directory), safe='/') for p in shared_diagrams)
    root_anchors = ({d['id'] for d in docs.values()} |
                    {h['id'] for d in docs.values() for h in d['headings']} | set(aliases)) \
        if not standalone and not external_business else None
    home_id = catalog.get('home_id', 'overview')
    if not isinstance(home_id, str) or not re.fullmatch(r'[a-z][a-z0-9-]*', home_id):
        raise ValueError('Catalog home_id must be a stable document ID')
    if home_id not in {d['id'] for d in docs.values()}:
        raise ValueError(f'Unknown catalog home_id: {home_id}')
    articles, groups, index = [], {}, []
    for path, doc in docs.items():
        for token in doc['tokens']:
            for child in token.children or []:
                key = 'src' if child.type == 'image' else 'href' if child.type == 'link_open' else None
                if not key:
                    continue
                owner = doc['_catalog_dir']
                value = resolve_link(child.attrGet(key), path, directory, docs, image=key == 'src',
                                     assets_dir=assets_dir,
                                     external=catalog['_external_documents'].get(owner, {}),
                                     shared=catalog['_shared_assets'].get(owner, set()),
                                     root_anchors=root_anchors)
                child.attrSet(key, value)
                if key == 'src':
                    child.attrSet('loading', 'lazy')
                elif urlsplit(value).path in diagram_paths:
                    child.attrSet('data-diagram', 'true')
                elif value.startswith(('http:', 'https:')):
                    child.attrSet('target', '_blank')
                    child.attrSet('rel', 'noopener noreferrer')
        body = md.renderer.render(doc['tokens'], md.options, {})
        body = body.replace('<table>', '<div class="table-scroll"><table>').replace('</table>', '</table></div>')
        e = html.escape
        articles.append(f'<article id="{doc["id"]}" class="doc" aria-label="{e(doc["title"])}"><div class="chapter-meta"><span>{e(doc["status"])}</span><span>{e(doc["date"])}</span></div>{body}</article>')
        subgroup = doc.get('subgroup')
        link_class = 'nav-link nav-link-nested' if subgroup else 'nav-link'
        nav_link = f'<a class="{link_class}" href="#{doc["id"]}">{e(doc["title"])}</a>'
        groups.setdefault(doc['group'], []).append((subgroup, nav_link))
        index.append({k: doc[k] for k in ['id', 'title', 'group', 'status', 'summary', 'headings']})
        if subgroup:
            index[-1]['subgroup'] = subgroup
    nav = []
    for position, (group, items) in enumerate(groups.items()):
        opened = ' open' if position < 3 else ''
        links, previous_subgroup = [], None
        for subgroup, link in items:
            if subgroup and subgroup != previous_subgroup:
                links.append(f'<div class="nav-subgroup" role="heading" aria-level="3">{html.escape(subgroup)}</div>')
            links.append(link)
            previous_subgroup = subgroup
        nav.append(f'<details class="nav-section" data-nav-group="{html.escape(group, quote=True)}"{opened}><summary>{html.escape(group)}</summary>{"".join(links)}</details>')
    template = (assets_dir / '_site/template.html').read_text()
    brand = catalog.get('brand', '知识库')
    if not isinstance(brand, str) or not brand.strip():
        raise ValueError('Catalog brand must be a non-empty string')
    page_title = catalog.get('title', '知识产品文档')
    if not isinstance(page_title, str) or not page_title.strip():
        raise ValueError('Catalog title must be a non-empty string')
    brand_mark = catalog.get('brand_mark', 'K')
    edition = catalog.get('edition', '核心产品文档')
    if any(not isinstance(value, str) or not value.strip() for value in (brand_mark, edition)):
        raise ValueError('Catalog brand_mark and edition must be non-empty strings')
    reader_script = (assets_dir / '_site/reader.js').read_text()
    brand_placeholder = '__DOC_BRAND_JSON__'
    if reader_script.count(brand_placeholder) != 1:
        raise ValueError('Shared reader brand placeholder changed')
    safe_brand = json.dumps(brand, ensure_ascii=True).replace('<', '\\u003c')
    reader_script = reader_script.replace(brand_placeholder, safe_brand)
    replacements = {
        '{{STYLE}}': (assets_dir / '_site/style.css').read_text(),
        '{{SCRIPT}}': reader_script,
        '{{PAGE_TITLE}}': html.escape(page_title),
        '{{HOME_ID}}': html.escape(home_id, quote=True),
        '{{BRAND}}': html.escape(brand),
        '{{BRAND_MARK}}': html.escape(brand_mark),
        '{{EDITION}}': html.escape(edition),
        '{{MERMAID_SRC}}': html.escape(quote(os.path.relpath(assets_dir / '_site/mermaid.bundle.js', directory), safe='/'), quote=True),
        '{{NAV}}': '\n'.join(nav), '{{ARTICLES}}': '\n'.join(articles),
        '{{INDEX}}': json.dumps(index, ensure_ascii=False).replace('<', '\\u003c'),
        '{{ALIASES}}': json.dumps(aliases, ensure_ascii=False).replace('<', '\\u003c'),
        '{{DATE}}': html.escape(catalog['updated']),
    }
    template = re.sub(r'\{\{[A-Z_]+\}\}', lambda match: replacements[match.group()], template)
    generated_ids = re.findall(r'\bid="([^\"]+)"', template)
    if len(generated_ids) != len(set(generated_ids)):
        raise ValueError('Duplicate HTML IDs')
    inputs = {p for p in directory.rglob('*') if p.is_file() and
              (p.suffix in {'.md', '.css', '.js'} or p.name in {'catalog.json', 'template.html'})}
    inputs.update(assets_dir / '_site' / name for name in ('template.html', 'style.css', 'reader.js', 'mermaid.bundle.js'))
    inputs.update(p for paths in catalog['_shared_assets'].values() for p in paths)
    if shared_diagrams:
        inputs.add(assets_dir / 'diagrams/manifest.json')
    manifest = {
        'schema_version': 1, 'updated': catalog['updated'], 'documents': len(docs),
        'diagrams': len(diagrams['diagrams']), 'output_sha256': hashlib.sha256(template.encode()).hexdigest(),
        'source_sha256': {os.path.relpath(p, directory): digest(p) for p in sorted(inputs)},
        'checks': ['catalog_completeness', 'local_links_and_fragments', 'hash_aliases', 'unique_ids', 'diagram_hashes'],
        'note': 'Build receipt, not product implementation or analysis-quality acceptance.',
    }
    return template, json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate inputs and fail if generated files are stale')
    parser.add_argument('--docs-dir', type=Path, default=ROOT / 'docs')
    parser.add_argument('--assets-dir', type=Path, help='Shared template/runtime and explicit asset boundary')
    parser.add_argument('--external-business', action='store_true',
                        help='Omit baseline aliases whose business targets live outside the core reader')
    args = parser.parse_args()
    try:
        page, manifest = build(args.docs_dir, args.assets_dir, external_business=args.external_business)
        for name, content in [('index.html', page), ('build-manifest.json', manifest)]:
            target = args.docs_dir / name
            if args.check:
                if not target.is_file() or target.read_text() != content:
                    raise ValueError(f'Stale documentation: {name}; run make docs')
            else:
                target.write_text(content)
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(1, f'Documentation error: {exc}\n')
    print('Documentation validated' if args.check else f'Built {args.docs_dir}/index.html')


if __name__ == '__main__':
    main()
