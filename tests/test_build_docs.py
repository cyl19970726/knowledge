"""Checks for portable Markdown navigation and honest generated-doc validation."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HAS_MARKDOWN = importlib.util.find_spec('markdown_it') is not None
if HAS_MARKDOWN:
    spec = importlib.util.spec_from_file_location('build_docs', ROOT / 'scripts/build_docs.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)


@unittest.skipUnless(HAS_MARKDOWN, "Install optional .[docs] dependencies for documentation tests")
class DocumentationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.docs = Path(self.tmp.name)
        (self.docs / '_site').mkdir()
        (self.docs / 'diagrams').mkdir()
        (self.docs / 'design').mkdir()
        for name in ('template.html', 'style.css', 'reader.js'):
            (self.docs / '_site' / name).write_bytes((ROOT / 'docs/_site' / name).read_bytes())
        (self.docs / '_site/mermaid.bundle.js').write_text('// Offline runtime fixture\n')
        (self.docs / 'README.md').write_text('# Intro\n\n[Next](design/detail.md#细节)\n\n| A | B |\n|---|---|\n| x | y |\n')
        (self.docs / 'design/detail.md').write_text('# Detail\n\n## 细节\n\nText\n\n## 细节\n\n<script>alert(1)</script>\n')
        entries = [dict(id=id_, path=path, title=id_, group='test', status='draft', date='2026-10-12', summary='test') for id_, path in [('overview','README.md'),('detail','design/detail.md')]]
        (self.docs / 'catalog.json').write_text(json.dumps({'updated':'2026-10-12','documents':entries}))
        (self.docs / 'diagrams/manifest.json').write_text('{"diagrams":[]}')

    def add_knowledge(self, *, body='# Knowledge\n\n[Business](../index.html#old-overview)\n'):
        knowledge = self.docs / 'knowledge'
        knowledge.mkdir()
        (knowledge / 'README.md').write_text(body)
        (knowledge / 'catalog.json').write_text(json.dumps({
            'title': 'Knowledge Reader', 'brand': 'Knowledge Library',
            'brand_mark': 'K / B', 'edition': '知识库', 'home_id': 'knowledge-home',
            'updated': '2026-10-26',
            'documents': [dict(id='knowledge-home', path='README.md', title='Knowledge',
                               group='知识文档', status='current', date='2026-10-26', summary='knowledge')],
            'external_documents': {'../index.html': ['old-overview']},
        }))
        return knowledge

    def import_knowledge(self):
        catalog_path = self.docs / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['imports'] = ['knowledge/catalog.json']
        catalog['hash_aliases'] = {'old-overview': 'overview'}
        catalog_path.write_text(json.dumps(catalog))

    def test_links_tables_safe_html_and_repeated_headings(self):
        page, _ = builder.build(self.docs)
        self.assertIn('href="#detail--细节"', page)
        self.assertIn('id="detail--细节-1"', page)
        self.assertIn('<th>A</th>', page)
        self.assertNotIn('<script>alert(1)</script>', page)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', page)

    def test_mermaid_fence_keeps_escaped_source_and_other_code_fences(self):
        (self.docs / 'README.md').write_text('''# Intro

```mermaid
flowchart LR
  A[<script>alert(1)</script>] --> B
```

```python
print("ordinary code")
```
''')
        page, manifest = builder.build(self.docs)
        self.assertIn('src="_site/mermaid.bundle.js"', page)
        self.assertIn('<figure class="mermaid-figure" data-mermaid-diagram>', page)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', page)
        self.assertNotIn('<script>alert(1)</script>', page)
        self.assertIn('<pre><code class="language-python">print(&quot;ordinary code&quot;)', page)
        self.assertEqual(page.count('data-mermaid-diagram'), 2)  # markup and reader selector
        self.assertIn('_site/mermaid.bundle.js', json.loads(manifest)['source_sha256'])

    def test_group_navigation_keeps_all_documents_and_opens_first_three_groups(self):
        catalog_path = self.docs / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['documents'][0]['group'] = '产品文档'
        catalog['documents'][1]['group'] = '总体与专项架构'
        for id_, group in [('third', '模块技术设计'), ('fourth', '历史档案')]:
            path = f'{id_}.md'
            (self.docs / path).write_text(f'# {id_}')
            catalog['documents'].append(dict(id=id_, path=path, title=id_, group=group,
                                             status='draft', date='2026-10-12', summary='test'))
        catalog_path.write_text(json.dumps(catalog))

        page, _ = builder.build(self.docs)
        self.assertIn('<details class="nav-section" data-nav-group="产品文档" open>', page)
        self.assertIn('<details class="nav-section" data-nav-group="总体与专项架构" open>', page)
        self.assertIn('<details class="nav-section" data-nav-group="模块技术设计" open>', page)
        self.assertIn('<details class="nav-section" data-nav-group="历史档案">', page)
        self.assertNotIn('<details class="nav-section" data-nav-group="历史档案" open>', page)
        for id_ in ('overview', 'detail', 'third', 'fourth'):
            self.assertIn(f'<article id="{id_}"', page)

        match = re.search(r'<script id="document-index" type="application/json">(.*?)</script>', page)
        self.assertIsNotNone(match)
        index = json.loads(match.group(1))
        self.assertEqual([doc['id'] for doc in index], ['overview', 'detail', 'third', 'fourth'])
        self.assertEqual([doc['group'] for doc in index], ['产品文档', '总体与专项架构', '模块技术设计', '历史档案'])

    def test_optional_subgroups_keep_chapter_order_and_escape_labels(self):
        catalog_path = self.docs / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['documents'][0]['subgroup'] = '总体与 <路线>'
        catalog['documents'][1]['subgroup'] = '获取 & 理解'
        catalog_path.write_text(json.dumps(catalog))

        page, _ = builder.build(self.docs)
        self.assertIn('role="heading" aria-level="3">总体与 &lt;路线&gt;</div>', page)
        self.assertIn('role="heading" aria-level="3">获取 &amp; 理解</div>', page)
        self.assertLess(page.index('href="#overview"', page.index('data-nav-group="test"')),
                        page.index('href="#detail"', page.index('data-nav-group="test"')))
        match = re.search(r'<script id="document-index" type="application/json">(.*?)</script>', page)
        index = json.loads(match.group(1))
        self.assertEqual([doc['subgroup'] for doc in index], ['总体与 <路线>', '获取 & 理解'])

        del catalog['documents'][1]['subgroup']
        catalog_path.write_text(json.dumps(catalog))
        page, _ = builder.build(self.docs)
        self.assertIn('<a class="nav-link" href="#detail">', page)
        match = re.search(r'<script id="document-index" type="application/json">(.*?)</script>', page)
        self.assertNotIn('subgroup', json.loads(match.group(1))[1])

    def test_product_catalog_follows_reading_route(self):
        catalog = json.loads((ROOT / 'docs/catalog.json').read_text())
        actual = [(doc['id'], doc.get('subgroup')) for doc in catalog['documents'] if doc['group'] == '产品文档']
        expected = [
            ('overview', '总体与路线'), ('product-questions', '总体与路线'), ('product', '总体与路线'),
            ('workbench', '总体与路线'), ('roadmap', '总体与路线'),
            ('closed-loop-acceptance', '总体与路线'),
            ('daily', '获取与理解'), ('daily-learning-policy', '获取与理解'), ('materials', '获取与理解'),
            ('business-research', '获取与理解'), ('product-analysis', '获取与理解'),
            ('memory', '知识与创作'), ('daily-research', '知识与创作'), ('creation', '知识与创作'),
            ('creation-pilot', '知识与创作'),
            ('accounts', '发布与学习'), ('outcomes', '发布与学习'),
        ]
        if catalog.get('imports'):
            expected.remove(('memory', '知识与创作'))
            self.assertNotIn('memory', {doc['id'] for doc in catalog['documents']})
            imported = json.loads((ROOT / 'docs/knowledge/catalog.json').read_text())
            self.assertIn('memory', {doc['id'] for doc in imported['documents']})
        self.assertEqual(actual, expected)
        by_id = {doc['id']: doc for doc in catalog['documents']}
        if catalog.get('imports'):
            by_id.update({doc['id']: doc for doc in imported['documents']})
        for doc_id in ['knowledge-daily-redesign', 'knowledge-daily-workflows']:
            self.assertEqual(by_id[doc_id]['group'], '历史档案')
            self.assertEqual(by_id[doc_id]['lifecycle'], 'archive')
        if catalog.get('imports'):
            self.assertEqual(by_id['knowledge-purpose-architecture']['group'], '历史与依据')
            self.assertEqual(by_id['knowledge-purpose-architecture']['lifecycle'], 'record')
        else:
            self.assertEqual(by_id['knowledge-purpose-architecture']['group'], '研究记录')
            self.assertEqual(by_id['knowledge-purpose-architecture']['lifecycle'], 'research')

    def test_hash_aliases_are_embedded_and_flattened_to_existing_anchors(self):
        catalog_path = self.docs / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['hash_aliases'] = {
            'old-overview': 'overview',
            'old-section': 'detail--细节',
            'legacy-start': 'old-overview',
        }
        catalog_path.write_text(json.dumps(catalog))
        page, _ = builder.build(self.docs)
        match = re.search(r'<script id="document-aliases" type="application/json">(.*?)</script>', page)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match.group(1)), {
            'old-overview': 'overview',
            'old-section': 'detail--细节',
            'legacy-start': 'overview',
        })
        self.assertIn('history.replaceState(null', page)

    def test_invalid_hash_aliases_fail(self):
        catalog_path = self.docs / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        for aliases, error in [
            ({'overview': 'detail'}, 'conflicts with existing anchor'),
            ({'old-a': 'old-b', 'old-b': 'old-a'}, 'Hash alias cycle'),
            ({'old-heading': 'detail--does-not-exist'}, 'Unknown hash alias target'),
        ]:
            catalog['hash_aliases'] = aliases
            catalog_path.write_text(json.dumps(catalog))
            with self.subTest(aliases=aliases), self.assertRaisesRegex(ValueError, error):
                builder.build(self.docs)

    def test_unknown_fragment_fails(self):
        (self.docs / 'README.md').write_text('[Missing](design/detail.md#absent)')
        with self.assertRaisesRegex(ValueError, 'Unknown heading'):
            builder.build(self.docs)

    def test_unlisted_document_fails(self):
        (self.docs / 'forgotten.md').write_text('# Forgotten')
        with self.assertRaisesRegex(ValueError, 'Catalog mismatch'):
            builder.build(self.docs)

    def test_stale_output_is_rejected(self):
        page, manifest = builder.build(self.docs)
        (self.docs / 'index.html').write_text(page)
        (self.docs / 'build-manifest.json').write_text(manifest)
        command = [sys.executable, str(ROOT/'scripts/build_docs.py'), '--docs-dir', str(self.docs), '--check']
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        (self.docs / 'design/detail.md').write_text('# Updated')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unknown heading', result.stderr)
        (self.docs / 'README.md').write_text('# Changed content')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Stale documentation', result.stderr)

    def test_diagram_hash_mismatch_fails(self):
        (self.docs / 'diagrams/chart.html').write_text('changed')
        (self.docs / 'diagrams/manifest.json').write_text(json.dumps({'diagrams':[{'html':'chart.html','artifact_sha256':'bad'}]}))
        with self.assertRaisesRegex(ValueError, 'Diagram hash mismatch'):
            builder.build(self.docs)

    def test_links_cannot_escape_portable_directory(self):
        (self.docs / 'README.md').write_text('[Private](../private.txt)')
        with self.assertRaisesRegex(ValueError, 'escapes portable docs'):
            builder.build(self.docs)

    def test_imports_flatten_and_root_aliases_resolve_into_imported_documents(self):
        knowledge = self.add_knowledge(body='# Knowledge\n\n## Section\n')
        self.import_knowledge()
        catalog = json.loads((self.docs / 'catalog.json').read_text())
        catalog['hash_aliases']['old-knowledge'] = 'knowledge-home--section'
        (self.docs / 'catalog.json').write_text(json.dumps(catalog))
        (self.docs / 'README.md').write_text('# Intro\n\n[Knowledge](knowledge/README.md#section)\n')
        loaded, _, docs = builder.load_documents(self.docs)
        self.assertEqual([doc['id'] for doc in docs.values()], ['overview', 'detail', 'knowledge-home'])
        self.assertEqual([doc['path'] for doc in loaded['documents']],
                         ['README.md', 'design/detail.md', 'knowledge/README.md'])
        page, _ = builder.build(self.docs)
        self.assertIn('href="#knowledge-home--section"', page)
        self.assertIn('"old-knowledge": "knowledge-home--section"', page)
        self.assertTrue(knowledge.is_dir())

    def test_import_duplicates_cycles_and_escapes_fail(self):
        self.add_knowledge(body='# Knowledge\n')
        self.import_knowledge()
        root_path = self.docs / 'catalog.json'
        child_path = self.docs / 'knowledge/catalog.json'
        root = json.loads(root_path.read_text())
        child = json.loads(child_path.read_text())
        for mutation, error in [
            (lambda: child['documents'][0].update(id='overview'), 'Duplicate catalog ID or path'),
            (lambda: root['documents'].append({**root['documents'][0], 'id':'another', 'path':'knowledge/README.md'}), 'Duplicate catalog ID or path'),
            (lambda: child.update(imports=['../catalog.json']), 'Catalog import cycle'),
            (lambda: root.update(imports=['../../outside/catalog.json']), 'Catalog import escapes directory'),
            (lambda: root.update(imports=['knowledge/catalog.json', 'knowledge/catalog.json']), 'Duplicate catalog import'),
        ]:
            root_path.write_text(json.dumps(root))
            child_path.write_text(json.dumps(child))
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                mutation()
                root_path.write_text(json.dumps(root))
                child_path.write_text(json.dumps(child))
                builder.load_documents(self.docs)
            root = json.loads(root_path.read_text())
            child = json.loads(child_path.read_text())
            root['imports'] = ['knowledge/catalog.json']
            root['documents'] = root['documents'][:2]
            child['documents'][0]['id'] = 'knowledge-home'
            child.pop('imports', None)

    def test_standalone_brand_search_assets_and_external_anchor_without_business_markdown(self):
        knowledge = self.add_knowledge(body='# Knowledge\n\n[Business](../index.html#old-overview)\n\n![Shared](../assets/shared.png)\n\n```mermaid\nflowchart LR\nA-->B\n```\n')
        self.import_knowledge()
        (self.docs / 'assets').mkdir()
        (self.docs / 'assets/shared.png').write_bytes(b'png fixture')
        catalog_path = knowledge / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['shared_assets'] = ['../assets/shared.png']
        catalog_path.write_text(json.dumps(catalog))
        (self.docs / 'README.md').unlink()
        (self.docs / 'design/detail.md').unlink()
        command = [sys.executable, str(ROOT / 'scripts/build_docs.py'), '--docs-dir', str(knowledge),
                   '--assets-dir', str(self.docs)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((knowledge / 'index.html').is_file())
        self.assertTrue((knowledge / 'build-manifest.json').is_file())
        self.assertEqual(subprocess.run(command + ['--check'], capture_output=True).returncode, 0)
        page, receipt = builder.build(knowledge, self.docs)
        self.assertIn('<title>Knowledge Reader</title>', page)
        self.assertIn('document.title = active.title + \' · \' + "Knowledge Library";', page)
        self.assertNotIn("document.title = active.title + ' · Commerce Creative Lab';", page)
        self.assertIn('href="#knowledge-home"', page)
        self.assertIn('Knowledge Library', page)
        self.assertIn('src="../_site/mermaid.bundle.js"', page)
        self.assertIn('src="../assets/shared.png"', page)
        self.assertIn('href="../index.html#old-overview"', page)
        index = json.loads(re.search(r'<script id="document-index" type="application/json">(.*?)</script>', page).group(1))
        self.assertEqual([item['id'] for item in index], ['knowledge-home'])
        self.assertIn('../assets/shared.png', json.loads(receipt)['source_sha256'])

    def test_standalone_brand_cannot_break_out_of_inline_reader_script(self):
        knowledge = self.add_knowledge(body='# Knowledge\n')
        catalog_path = knowledge / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['brand'] = '</script><img src=x onerror=alert(1)>'
        catalog_path.write_text(json.dumps(catalog))
        page, _ = builder.build(knowledge, self.docs)
        self.assertNotIn('</script><img', page)
        self.assertIn('&lt;/script&gt;&lt;img', page)
        self.assertIn('\\u003c/script>', page)

    def test_external_refs_require_declaration_and_root_requires_existing_anchor(self):
        knowledge = self.add_knowledge()
        self.import_knowledge()
        catalog_path = knowledge / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        del catalog['external_documents']
        catalog_path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, 'Undeclared external document anchor'):
            builder.build(knowledge, self.docs)
        catalog['external_documents'] = {'../index.html': ['missing-anchor']}
        catalog_path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, 'Undeclared external document anchor'):
            builder.build(knowledge, self.docs)
        (knowledge / 'README.md').write_text('# Knowledge\n\n[Missing](../index.html#missing-anchor)')
        builder.build(knowledge, self.docs)
        with self.assertRaisesRegex(ValueError, 'Unknown external document anchor'):
            builder.build(self.docs)

    def test_shared_diagram_must_be_declared_and_hash_verified(self):
        knowledge = self.add_knowledge(body='# Knowledge\n\n[Chart](../diagrams/chart.html)\n')
        (self.docs / 'diagrams/chart.html').write_text('<h1 id="chart">Chart</h1>')
        import hashlib
        checksum = hashlib.sha256((self.docs / 'diagrams/chart.html').read_bytes()).hexdigest()
        (self.docs / 'diagrams/manifest.json').write_text(json.dumps({'diagrams':[
            {'html':'chart.html', 'artifact_sha256':checksum,
             'specification':'chart.json', 'specification_sha256':hashlib.sha256(b'{}').hexdigest()}]}))
        (self.docs / 'diagrams/chart.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'escapes portable docs'):
            builder.build(knowledge, self.docs)
        catalog_path = knowledge / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        catalog['shared_assets'] = ['../diagrams/chart.html']
        catalog_path.write_text(json.dumps(catalog))
        page, _ = builder.build(knowledge, self.docs)
        self.assertIn('data-diagram="true"', page)
        (self.docs / 'diagrams/chart.html').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'Diagram hash mismatch'):
            builder.build(knowledge, self.docs)

    def test_undeclared_shared_image_fails(self):
        knowledge = self.add_knowledge(body='# Knowledge\n\n![Shared](../assets/shared.png)\n')
        (self.docs / 'assets').mkdir()
        (self.docs / 'assets/shared.png').write_bytes(b'png fixture')
        with self.assertRaisesRegex(ValueError, 'escapes portable docs'):
            builder.build(knowledge, self.docs)


if __name__ == '__main__':
    unittest.main()
