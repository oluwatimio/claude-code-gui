// Spotlight-style modal component. Pure UI chrome: builds the DOM, manages
// focus, keyboard nav, and calls a config object's handlers for data and
// rendering. Callers (file opener, content search, etc.) supply the config.
//
// Usage:
//   const spotlight = Spotlight.create(document.body);
//   spotlight.open({
//     icon: svgString,
//     placeholder: 'Open file…',
//     debounce: 0,
//     async search(query) { return results; },
//     renderRow(result, container, query) { ... },
//     async renderPreview(result, container, query) { ... },
//     onAccept(result) { ... },
//     emptyText: 'No matches',
//     typeHint: 'Type to search',
//   });

(function (global) {
  function createSpotlight(rootEl) {
    const overlay = document.createElement('div');
    overlay.className = 'spotlight-overlay hidden';
    overlay.innerHTML = `
      <div class="spotlight">
        <div class="spotlight-header">
          <span class="spotlight-icon"></span>
          <input type="text" class="spotlight-input" spellcheck="false" autocomplete="off" />
          <span class="spotlight-spinner hidden"></span>
          <kbd class="spotlight-esc">esc</kbd>
        </div>
        <div class="spotlight-body">
          <div class="spotlight-results" role="listbox"></div>
          <div class="spotlight-preview"></div>
        </div>
        <div class="spotlight-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span class="spotlight-status"></span>
        </div>
      </div>
    `;
    rootEl.appendChild(overlay);

    const iconEl = overlay.querySelector('.spotlight-icon');
    const input = overlay.querySelector('.spotlight-input');
    const spinner = overlay.querySelector('.spotlight-spinner');
    const resultsEl = overlay.querySelector('.spotlight-results');
    const previewEl = overlay.querySelector('.spotlight-preview');
    const statusEl = overlay.querySelector('.spotlight-status');

    let active = null;           // { config, results, selected, querySeq, previewSeq }
    let debounceTimer = null;

    function isOpen() { return !!active; }

    function setSpinner(on) {
      spinner.classList.toggle('hidden', !on);
    }

    function setStatus(text) {
      statusEl.textContent = text || '';
    }

    function renderEmpty(message) {
      resultsEl.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'spotlight-empty';
      el.textContent = message;
      resultsEl.appendChild(el);
      previewEl.innerHTML = '';
    }

    function renderResults() {
      if (!active) return;
      resultsEl.innerHTML = '';
      if (!active.results.length) {
        const empty = input.value.trim()
          ? (active.config.emptyText || 'No matches')
          : (active.config.typeHint || 'Start typing');
        renderEmpty(empty);
        return;
      }
      active.results.forEach((result, idx) => {
        const row = document.createElement('div');
        row.className = 'spotlight-row' + (idx === active.selected ? ' selected' : '');
        row.setAttribute('role', 'option');
        try {
          active.config.renderRow(result, row, input.value);
        } catch (e) {
          row.textContent = '(render error)';
        }
        row.addEventListener('mouseenter', () => {
          if (active && active.selected !== idx) {
            active.selected = idx;
            updateSelection();
            triggerPreview();
          }
        });
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (!active) return;
          active.selected = idx;
          accept();
        });
        resultsEl.appendChild(row);
      });
      updateSelection();
      scrollSelectedIntoView();
      triggerPreview();
    }

    function updateSelection() {
      const rows = resultsEl.querySelectorAll('.spotlight-row');
      rows.forEach((el, i) => el.classList.toggle('selected', active && i === active.selected));
    }

    function scrollSelectedIntoView() {
      if (!active) return;
      const row = resultsEl.children[active.selected];
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }

    async function triggerPreview() {
      if (!active || !active.results.length) { previewEl.innerHTML = ''; return; }
      const result = active.results[active.selected];
      const seq = ++active.previewSeq;
      previewEl.innerHTML = '<div class="spotlight-preview-loading">Loading preview…</div>';
      try {
        const maybe = await active.config.renderPreview(result, previewEl, input.value);
        // renderPreview typically mutates previewEl directly; the loading
        // placeholder is replaced. If it doesn't, bail out of stale state.
        if (!active || seq !== active.previewSeq) return;
        if (maybe === undefined && previewEl.querySelector('.spotlight-preview-loading')) {
          previewEl.innerHTML = '';
        }
      } catch (e) {
        if (!active || seq !== active.previewSeq) return;
        previewEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'spotlight-preview-error';
        err.textContent = `Preview failed: ${e && e.message ? e.message : e}`;
        previewEl.appendChild(err);
      }
    }

    async function runQuery(query) {
      if (!active) return;
      const seq = ++active.querySeq;
      setSpinner(true);
      try {
        const results = await Promise.resolve(active.config.search(query));
        if (!active || seq !== active.querySeq) return;
        active.results = Array.isArray(results) ? results : [];
        active.selected = 0;
        renderResults();
        const label = active.results.length ? `${active.results.length} result${active.results.length === 1 ? '' : 's'}` : '';
        setStatus(label);
      } catch (e) {
        if (!active || seq !== active.querySeq) return;
        renderEmpty(`Search failed: ${e && e.message ? e.message : e}`);
        setStatus('');
      } finally {
        if (active && seq === active.querySeq) setSpinner(false);
      }
    }

    function scheduleQuery() {
      if (!active) return;
      clearTimeout(debounceTimer);
      const delay = Math.max(0, active.config.debounce || 0);
      if (delay === 0) { runQuery(input.value); return; }
      debounceTimer = setTimeout(() => runQuery(input.value), delay);
    }

    function moveSelection(delta) {
      if (!active || !active.results.length) return;
      const n = active.results.length;
      active.selected = ((active.selected + delta) % n + n) % n;
      updateSelection();
      scrollSelectedIntoView();
      triggerPreview();
    }

    function accept() {
      if (!active || !active.results.length) return;
      const result = active.results[active.selected];
      const handler = active.config.onAccept;
      close();
      try { if (handler) handler(result); } catch (e) { console.error('spotlight accept', e); }
    }

    function open(config) {
      if (!config || typeof config.search !== 'function') return;
      // Re-opening with a new config replaces the previous one.
      active = { config, results: [], selected: 0, querySeq: 0, previewSeq: 0 };
      iconEl.innerHTML = config.icon || '';
      input.value = config.initialQuery || '';
      input.placeholder = config.placeholder || '';
      overlay.classList.remove('hidden');
      setSpinner(false);
      setStatus('');
      previewEl.innerHTML = '';
      renderEmpty(config.typeHint || 'Start typing');
      setTimeout(() => { input.focus(); input.select(); }, 0);
      if (input.value) runQuery(input.value);
    }

    function close() {
      if (!active) return;
      active = null;
      overlay.classList.add('hidden');
      clearTimeout(debounceTimer);
      resultsEl.innerHTML = '';
      previewEl.innerHTML = '';
      setSpinner(false);
      setStatus('');
    }

    // Event handlers (live for the life of the component).
    input.addEventListener('input', scheduleQuery);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener('keydown', (e) => {
      if (!active) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); accept(); return; }
      if (e.key === 'Home' && !e.shiftKey && e.target === input && !input.value) {
        // Only hijack Home when input is empty, so typing isn't disrupted.
        e.preventDefault();
        if (active && active.results.length) { active.selected = 0; updateSelection(); scrollSelectedIntoView(); triggerPreview(); }
      }
      if (e.key === 'End' && !e.shiftKey && e.target === input && !input.value) {
        e.preventDefault();
        if (active && active.results.length) { active.selected = active.results.length - 1; updateSelection(); scrollSelectedIntoView(); triggerPreview(); }
      }
    });

    return { open, close, isOpen };
  }

  global.Spotlight = { create: createSpotlight };
})(typeof window !== 'undefined' ? window : globalThis);
