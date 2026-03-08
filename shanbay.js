// ==UserScript==
// @name         Space to Next Word
// @namespace    https://tampermonkey.net/
// @version      1.1.0
// @description  Press Space to go next (handles DOM recreation)
// @match        https://web.shanbay.com/*
// @run-at       document-start
// @grant        none
// @all-frames   true
// ==/UserScript==

(() => {
  'use strict';

  const DEBUG = false;

  // 更稳：适配 “StudyPage_nextBtn__xxxxxx” 这种 hash 变化
  const BTN_SELECTOR = '[class^="StudyPage_nextBtn__"], .StudyPage_nextBtn__W0wra';

  const log = (...args) => {
    if (!DEBUG) return;
    console.log('%c[SpaceNext]', 'color:#4CAF50;font-weight:bold;', ...args);
  };

  function isTypingContext(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute?.('role');
    if (role && role.toLowerCase() === 'textbox') return true;
    return false;
  }

  function getBtn() {
    return document.querySelector(BTN_SELECTOR);
  }

  function smartClick(btn) {
    // 有些站点需要更“像人”的事件链
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    btn.click();
  }

  function clickNext() {
    const btn = getBtn();
    if (!btn) {
      log('no button');
      return false;
    }
    log('click');
    smartClick(btn);
    return true;
  }

  function bindHotkeyOnce() {
    if (window.__spaceNextBound) return;
    window.__spaceNextBound = true;

    window.addEventListener(
      'keydown',
      (e) => {
        // 用 key 更通用（某些环境 code 不稳定）
        if (e.key !== ' ') return;

        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (isTypingContext(document.activeElement)) return;

        e.preventDefault();
        e.stopPropagation();

        clickNext();
      },
      true
    );

    log('hotkey bound');
  }

  function observeDom() {
    const mark = (btn) => {
      if (!btn || btn.__spaceMarked) return;
      btn.__spaceMarked = true;
      try {
        const t = btn.getAttribute('title') || '';
        btn.setAttribute('title', t ? `${t} (Space)` : 'Space');
      } catch {}
      log('button found/marked');
    };

    const mo = new MutationObserver(() => {
      const btn = getBtn();
      if (btn) mark(btn);
    });

    const start = () => {
      mark(getBtn());
      mo.observe(document.documentElement, { childList: true, subtree: true });
      log('observer started');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  bindHotkeyOnce();
  observeDom();
})();