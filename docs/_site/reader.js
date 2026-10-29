(() => {
  'use strict';
  const docs = JSON.parse(document.getElementById('document-index').textContent);
  const aliases = JSON.parse(document.getElementById('document-aliases').textContent);
  const articles = new Map(docs.map(d => [d.id, document.getElementById(d.id)]));
  const texts = new Map(docs.map(d => [d.id, articles.get(d.id).textContent.replace(/\s+/g, ' ')]));
  const search = document.getElementById('search');
  const results = document.getElementById('search-results');
  const sidebar = document.querySelector('.sidebar');
  sidebar.id = 'sidebar-nav';
  let active = docs[0];
  let mermaidId = 0;
  const mermaidJobs = new WeakMap();
  function centerNarrowDiagrams() {
    if (!window.matchMedia('(max-width:740px)').matches) return;
    document.querySelectorAll('.doc.active .mermaid-figure').forEach(figure => {
      figure.scrollLeft = Math.max(0, (figure.scrollWidth - figure.clientWidth) / 2);
    });
  }
  window.addEventListener('resize', () => requestAnimationFrame(centerNarrowDiagrams));
  function renderMermaid(article) {
    return Promise.all([...article.querySelectorAll('[data-mermaid-diagram]')].map(figure => {
      if (mermaidJobs.has(figure)) return mermaidJobs.get(figure);
      const job = (async () => {
        if (!window.mermaid) return;
        const source = figure.querySelector('.mermaid-source');
        const output = figure.querySelector('.mermaid-output');
        try {
          const { svg } = await window.mermaid.render(`docs-mermaid-${++mermaidId}`, source.textContent);
          output.innerHTML = svg;
          const diagram = output.querySelector('svg');
          const naturalWidth = diagram?.viewBox?.baseVal?.width;
          if (naturalWidth) figure.style.setProperty('--diagram-width', `${Math.ceil(naturalWidth)}px`);
          source.hidden = true;
          requestAnimationFrame(centerNarrowDiagrams);
        } catch (error) {
          console.warn('Mermaid diagram could not be rendered; source remains visible.', error);
          output.replaceChildren();
        }
      })();
      mermaidJobs.set(figure, job);
      return job;
    }));
  }
  function makeLink(href, title, className) {
    const a = document.createElement('a'); a.href = href; a.textContent = title;
    if (className) a.className = className;
    return a;
  }
  function resetSearch() {
    search.value = ''; results.hidden = true;
    document.getElementById('documents').hidden = false;
    document.body.classList.remove('searching');
  }
  function navigate() {
    let target;
    try { target = decodeURIComponent(location.hash.slice(1)); } catch { target = ''; }
    if (aliases[target]) {
      target = aliases[target];
      try { history.replaceState(null, '', location.pathname + location.search + '#' + encodeURIComponent(target)); } catch {}
    }
    active = docs.find(d => target === d.id || d.headings.some(h => h.id === target)) || docs[0];
    for (const d of docs) articles.get(d.id).classList.toggle('active', d.id === active.id);
    renderMermaid(articles.get(active.id));
    document.querySelectorAll('.nav-link').forEach(a => {
      if (a.hash === '#' + active.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('.nav-section').forEach((section, position) => {
      if (position < 3) section.open = true;
      else section.open = section.dataset.navGroup === active.group;
    });
    resetSearch();
    document.getElementById('breadcrumb').textContent = [active.group, active.subgroup, active.title].filter(Boolean).join(' / ');
    document.title = active.title + ' · ' + __DOC_BRAND_JSON__;
    const toc = document.getElementById('toc-links'); toc.replaceChildren();
    active.headings.filter(h => h.level > 1 && h.level < 4).forEach(h => toc.append(makeLink('#' + h.id, h.title, h.level === 3 ? 'sub' : '')));
    const controls = document.getElementById('chapter-switch'); controls.replaceChildren();
    const chapterDocs = docs.filter(d => d.group === active.group);
    const i = chapterDocs.indexOf(active);
    for (const [doc, label, cls] of [[chapterDocs[i - 1], '上一章', 'previous'], [chapterDocs[i + 1], '下一章', 'next']]) {
      if (!doc) continue;
      const a = makeLink('#' + doc.id, doc.title, cls); const span = document.createElement('span'); span.textContent = label; a.prepend(span); controls.append(a);
    }
    sidebar.classList.remove('open'); document.getElementById('menu').setAttribute('aria-expanded', 'false');
    requestAnimationFrame(() => {
      if (target.includes('--')) {
        const heading = document.getElementById(target);
        if (heading) window.scrollTo({top: Math.max(0, window.scrollY + heading.getBoundingClientRect().top - 98), behavior: 'instant'});
      }
      else window.scrollTo({top: 0, behavior: 'instant'});
    });
  }
  function renderSearch() {
    const query = search.value.trim().toLocaleLowerCase();
    if (!query) { resetSearch(); return; }
    results.hidden = false; document.getElementById('documents').hidden = true; document.body.classList.add('searching');
    const list = document.getElementById('result-list'); list.replaceChildren();
    let count = 0;
    for (const d of docs) {
      const text = texts.get(d.id); const pos = text.toLocaleLowerCase().indexOf(query);
      if (pos < 0) continue;
      count++;
      const a = makeLink('#' + d.id, '', 'search-hit'); const label = document.createElement('strong'); label.textContent = d.title;
      const snippet = document.createElement('p'); snippet.textContent = (pos > 45 ? '…' : '') + text.slice(Math.max(0, pos - 45), pos + query.length + 95) + '…';
      const meta = document.createElement('small'); meta.textContent = [d.group, d.subgroup, d.status].filter(Boolean).join(' · ');
      a.append(meta, label, snippet); list.append(a);
    }
    document.getElementById('result-count').textContent = `找到 ${count} 篇包含“${search.value.trim()}”的文档`;
    window.scrollTo({top: 0, behavior: 'instant'});
  }
  search.addEventListener('input', renderSearch);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) resetSearch(); });
  document.addEventListener('click', e => {
    const a = e.target.closest('a'); if (!a) return;
    if (a.dataset.diagram) {
      e.preventDefault(); const dialog = document.getElementById('diagram-dialog');
      document.getElementById('diagram-title').textContent = a.textContent;
      document.getElementById('diagram-frame').src = a.getAttribute('href');
      document.getElementById('diagram-open').href = a.getAttribute('href'); dialog.showModal();
    } else if (a.getAttribute('href')?.startsWith('#') && a.getAttribute('href') !== '#reading') {
      e.preventDefault();
      if (a.hash !== location.hash) history.pushState(null, '', a.getAttribute('href'));
      navigate();
    }
  });
  const dialog = document.getElementById('diagram-dialog');
  document.getElementById('diagram-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => document.getElementById('diagram-frame').removeAttribute('src'));
  document.getElementById('menu').onclick = () => {
    const open = sidebar.classList.toggle('open'); document.getElementById('menu').setAttribute('aria-expanded', String(open));
  };
  async function print(all) {
    resetSearch();
    if (all) {
      for (const article of articles.values()) await renderMermaid(article);
    } else await renderMermaid(articles.get(active.id));
    document.body.classList.toggle('print-all', all);
    window.print();
  }
  document.getElementById('print-current').onclick = () => print(false);
  document.getElementById('print-all').onclick = () => print(true);
  window.addEventListener('afterprint', () => document.body.classList.remove('print-all'));
  window.addEventListener('hashchange', navigate);
  window.addEventListener('popstate', navigate);
  window.addEventListener('load', navigate);
  navigate();
})();
