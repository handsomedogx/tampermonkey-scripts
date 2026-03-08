// ==UserScript==
// @name         ChatGPT对话目录（问题导航）
// @namespace    https://example.com/
// @version      0.2.2
// @description  Sidebar TOC of user questions in a ChatGPT conversation, jump to question.
// @match        https://chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'cgtoc_state_v2';

  const state = {
    collapsed: GM_getValue(STORE_KEY + '_collapsed', false),
    pos: GM_getValue(STORE_KEY + '_pos', { top: 120, right: 16 }),
  };

  GM_addStyle(`
    #cgtoc-panel {
      position: fixed;
      top: ${state.pos.top}px;
      right: ${state.pos.right}px;
      width: 320px;
      max-height: 72vh;
      z-index: 999999;
      background: rgba(24,24,24,0.92);
      color: #eee;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      backdrop-filter: blur(8px);
      overflow: hidden;
      font-size: 13px;
    }
    #cgtoc-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 10px;
      cursor: move;
      user-select: none;
      border-bottom: 1px solid rgba(255,255,255,0.10);
    }
    #cgtoc-title { font-weight: 700; flex: 1; }
    #cgtoc-btn {
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
      color: #eee;
      border-radius: 10px;
      padding: 4px 8px;
      cursor: pointer;
    }
    #cgtoc-body { display: ${state.collapsed ? 'none' : 'block'}; padding: 10px; }
    #cgtoc-search {
      width: 100%;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.06);
      color: #eee;
      padding: 8px 10px;
      outline: none;
      margin-bottom: 8px;
    }
    #cgtoc-list { overflow: auto; max-height: calc(72vh - 110px); padding-right: 6px; }

    .cgtoc-item {
      padding: 8px 8px;
      border-radius: 10px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .cgtoc-item:hover { background: rgba(255,255,255,0.08); }
    .cgtoc-item.active {
      background: rgba(59,130,246,0.25);
      border-color: rgba(59,130,246,0.35);
    }
    .cgtoc-text {
      flex: 1;
      line-height: 1.25;
      min-width: 0;
    }
    .cgtoc-text .line1 {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 600;
    }
  `);

  function createPanel() {
    if (document.getElementById('cgtoc-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'cgtoc-panel';

    const header = document.createElement('div');
    header.id = 'cgtoc-header';

    const title = document.createElement('div');
    title.id = 'cgtoc-title';
    title.textContent = '问题目录';

    const btn = document.createElement('button');
    btn.id = 'cgtoc-btn';
    btn.textContent = state.collapsed ? '展开' : '折叠';
    btn.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      GM_setValue(STORE_KEY + '_collapsed', state.collapsed);
      document.getElementById('cgtoc-body').style.display = state.collapsed ? 'none' : 'block';
      btn.textContent = state.collapsed ? '展开' : '折叠';
    });

    header.appendChild(title);
    header.appendChild(btn);

    const body = document.createElement('div');
    body.id = 'cgtoc-body';

    const search = document.createElement('input');
    search.id = 'cgtoc-search';
    search.placeholder = '搜索问题…';

    const list = document.createElement('div');
    list.id = 'cgtoc-list';

    body.appendChild(search);
    body.appendChild(list);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    makeDraggable(panel, header);

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const el of list.querySelectorAll('.cgtoc-item')) {
        const t = el.getAttribute('data-title') || '';
        el.style.display = t.toLowerCase().includes(q) ? '' : 'none';
      }
    });
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0, startY = 0;
    let startTop = 0, startRight = 0;

    handle.addEventListener('mousedown', (e) => {
      const id = e.target && e.target.id;
      if (id === 'cgtoc-btn') return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panel.getBoundingClientRect();
      startTop = rect.top;
      startRight = window.innerWidth - rect.right;

      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newTop = Math.max(8, Math.min(window.innerHeight - 60, startTop + dy));
      const newRight = Math.max(8, Math.min(window.innerWidth - 120, startRight - dx));

      panel.style.top = `${newTop}px`;
      panel.style.right = `${newRight}px`;

      state.pos = { top: newTop, right: newRight };
      GM_setValue(STORE_KEY + '_pos', state.pos);
    });

    window.addEventListener('mouseup', () => dragging = false);
  }

  // ====== ChatGPT DOM targeting (based on your snippet) ======
  function getConversationRoot() {
    return document.querySelector('main') || document.body;
  }

  function findTurns() {
    const root = getConversationRoot();
    const articles = Array.from(root.querySelectorAll('article[data-testid^="conversation-turn-"]'));
    return articles;
  }

  function isUserTurn(article) {
    const t = article.getAttribute('data-turn');
    return t === 'user';
  }

  function extractUserQuestionText(userArticle) {
    const tNode = userArticle.querySelector('[data-message-author-role="user"] .whitespace-pre-wrap');
    const t = (tNode?.innerText || '').trim().replace(/\s+/g, ' ');
    return t;
  }

  function ensureAnchor(el, prefix, idx) {
    const id = `${prefix}-${idx}`;
    if (!el.id) el.id = id;
    el.dataset.cgtocId = el.id;
    return el.id;
  }

    function buildTOC() {
        createPanel();
        const list = document.getElementById('cgtoc-list');
        if (!list) return;

        const turns = findTurns();
        if (!turns.length) return;

        const items = [];
        let qIndex = 0;

        for (let i = 0; i < turns.length; i++) {
            const art = turns[i];
            if (!isUserTurn(art)) continue;

            const qText = extractUserQuestionText(art);
            if (!qText) continue;

            const qAnchor = ensureAnchor(art, 'cgtoc-q', qIndex);

            items.push({
                qIndex,
                title: qText.length > 70 ? qText.slice(0, 70) + '…' : qText,
                full: qText,
                qAnchor,
                qEl: art,
            });

            qIndex++;
        }

        list.innerHTML = '';
        for (const it of items) {
            const row = document.createElement('div');
            row.className = 'cgtoc-item';
            row.setAttribute('data-title', it.full);

            const text = document.createElement('div');
            text.className = 'cgtoc-text';
            text.innerHTML = `<div class="line1">${it.qIndex + 1}. ${escapeHtml(it.title)}</div>`;  // HTML转义

            row.appendChild(text);
            row.addEventListener('click', () => jumpTo(it.qAnchor));

            list.appendChild(row);
        }

        setupScrollSpy();
    }

    // 处理 HTML 转义的辅助函数
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

  function jumpTo(anchorId) {
    const el = document.getElementById(anchorId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setupScrollSpy() {
    const list = document.getElementById('cgtoc-list');
    if (!list) return;

    const handler = throttle(() => {
      let best = -1;
      let bestDist = Infinity;

      for (let i = 0; i < lastItems.length; i++) {
        const n = lastItems[i].qEl;
        if (!n?.getBoundingClientRect) continue;
        const r = n.getBoundingClientRect();
        const dist = Math.abs(r.top - 120);
        if (r.bottom > 80 && r.top < window.innerHeight && dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }

      const rows = Array.from(list.querySelectorAll('.cgtoc-item'));
      rows.forEach((row, idx) => row.classList.toggle('active', idx === best));
    }, 120);

    window.addEventListener('scroll', handler, { passive: true });
  }

  function throttle(fn, wait) {
    let last = 0, timer = null;
    return (...args) => {
      const now = Date.now();
      if (now - last >= wait) {
        last = now;
        fn(...args);
      } else {
        clearTimeout(timer);
        timer = setTimeout(() => {
          last = Date.now();
          fn(...args);
        }, wait - (now - last));
      }
    };
  }

  function observe() {
    const root = getConversationRoot();
    const obs = new MutationObserver(throttle(() => buildTOC(), 300));
    obs.observe(root, { childList: true, subtree: true });
  }

  function boot() {
    createPanel();
    buildTOC();
    observe();
  }

  setTimeout(boot, 1200);
})();