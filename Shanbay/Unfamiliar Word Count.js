// ==UserScript==
// @name         Unfamiliar Word Count
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  记录不认识单词 + 单词本 + 次数统计
// @match        https://web.shanbay.com/*
// @run-at       document-start
// @icon         https://assets0.baydn.com/static/img/shanbay_favicon.png
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'unknown_words_store_v3';
    const LEGACY_STORAGE_KEY = 'unknown_words_map';
    const PANEL_STATE_KEY = 'unknown_words_panel_state_v2';
    const PANEL_ID = 'tm-unknown-word-panel';
    const STORE_VERSION = 3;
    const DEFAULT_BOOK_ID = 'book_default';
    const DEFAULT_BOOK_NAME = '默认单词本';

    const DEFAULT_PANEL_STATE = {
        collapsed: false,
        left: null,
        top: null
    };

    let lastWord = null;
    let countedBookIds = new Set();

    let panel = null;
    let titleEl = null;
    let summaryEl = null;
    let listEl = null;
    let toggleButton = null;
    let bookSelectEl = null;
    let createBookButton = null;
    let deleteBookButton = null;

    let store = loadStore();
    let panelState = loadPanelState();
    let dragState = null;

    function getCurrentWord() {
        const selectors = [
            '[class*="index_word"] span',
            '[class*="VocabPronounce_word"]'
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el && el.innerText.trim()) {
                return el.innerText.trim();
            }
        }

        return null;
    }

    function normalizeWordMap(words) {
        const normalized = {};

        if (!words || typeof words !== 'object') {
            return normalized;
        }

        Object.entries(words).forEach(function ([word, count]) {
            if (typeof word !== 'string') {
                return;
            }

            const trimmedWord = word.trim();
            const normalizedCount = Number(count);

            if (!trimmedWord || !Number.isFinite(normalizedCount) || normalizedCount <= 0) {
                return;
            }

            normalized[trimmedWord] = Math.round(normalizedCount);
        });

        return normalized;
    }

    function normalizeBookName(name, fallbackName) {
        if (typeof name === 'string' && name.trim()) {
            return name.trim();
        }

        return fallbackName;
    }

    function createBookData(id, name, words, fallbackName) {
        return {
            id,
            name: normalizeBookName(name, fallbackName),
            words: normalizeWordMap(words)
        };
    }

    function createDefaultStore(words) {
        return {
            version: STORE_VERSION,
            activeBookId: DEFAULT_BOOK_ID,
            bookOrder: [DEFAULT_BOOK_ID],
            books: {
                [DEFAULT_BOOK_ID]: createBookData(DEFAULT_BOOK_ID, DEFAULT_BOOK_NAME, words, DEFAULT_BOOK_NAME)
            }
        };
    }

    function saveStoreData(storeData) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(storeData));
    }

    function getLegacyData() {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);

        if (!raw) {
            return null;
        }

        try {
            return normalizeWordMap(JSON.parse(raw));
        } catch (error) {
            console.warn('[Unfamiliar Word Count] Failed to parse legacy data:', error);
            return null;
        }
    }

    function normalizeStore(rawStore) {
        if (!rawStore || typeof rawStore !== 'object') {
            return createDefaultStore();
        }

        const rawBooks = rawStore.books && typeof rawStore.books === 'object'
            ? rawStore.books
            : {};
        const books = {};
        const bookOrder = [];

        function appendBook(bookId, fallbackName) {
            if (typeof bookId !== 'string' || !bookId || books[bookId]) {
                return;
            }

            const rawBook = rawBooks[bookId];

            if (!rawBook || typeof rawBook !== 'object') {
                return;
            }

            books[bookId] = createBookData(bookId, rawBook.name, rawBook.words, fallbackName);
            bookOrder.push(bookId);
        }

        if (Array.isArray(rawStore.bookOrder)) {
            rawStore.bookOrder.forEach(function (bookId, index) {
                appendBook(bookId, index === 0 ? DEFAULT_BOOK_NAME : `单词本 ${bookOrder.length + 1}`);
            });
        }

        Object.keys(rawBooks).forEach(function (bookId) {
            appendBook(bookId, bookOrder.length === 0 ? DEFAULT_BOOK_NAME : `单词本 ${bookOrder.length + 1}`);
        });

        if (!bookOrder.length) {
            return createDefaultStore();
        }

        const activeBookId = typeof rawStore.activeBookId === 'string' && books[rawStore.activeBookId]
            ? rawStore.activeBookId
            : bookOrder[0];

        return {
            version: STORE_VERSION,
            activeBookId,
            bookOrder,
            books
        };
    }

    function loadStore() {
        const raw = localStorage.getItem(STORAGE_KEY);
        let nextStore = null;

        if (raw) {
            try {
                nextStore = normalizeStore(JSON.parse(raw));
            } catch (error) {
                console.warn('[Unfamiliar Word Count] Failed to parse data:', error);
            }
        }

        if (!nextStore) {
            const legacyData = getLegacyData();
            nextStore = legacyData ? createDefaultStore(legacyData) : createDefaultStore();
        }

        saveStoreData(nextStore);
        return nextStore;
    }

    function saveStore() {
        saveStoreData(store);
    }

    function getActiveBook() {
        return store.books[store.activeBookId] || store.books[store.bookOrder[0]] || null;
    }

    function getBookWordCount(book) {
        return Object.keys(book.words).length;
    }

    function getBookTotalCount(book) {
        return Object.values(book.words).reduce(function (sum, count) {
            return sum + count;
        }, 0);
    }

    function isBookNameTaken(name) {
        return store.bookOrder.some(function (bookId) {
            return store.books[bookId] && store.books[bookId].name === name;
        });
    }

    function createBookId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return `book_${window.crypto.randomUUID()}`;
        }

        return `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function promptCreateBook() {
        const input = window.prompt('请输入新单词本名称');

        if (input === null) {
            return;
        }

        const name = input.trim();

        if (!name) {
            window.alert('单词本名称不能为空。');
            return;
        }

        if (isBookNameTaken(name)) {
            window.alert('单词本名称已存在。');
            return;
        }

        let bookId = createBookId();

        while (store.books[bookId]) {
            bookId = createBookId();
        }

        store.books[bookId] = createBookData(bookId, name, {}, name);
        store.bookOrder.push(bookId);
        store.activeBookId = bookId;

        saveStore();
        updateUI();
    }

    function deleteActiveBook() {
        if (store.bookOrder.length <= 1) {
            window.alert('至少保留一个单词本。');
            return;
        }

        const activeBook = getActiveBook();

        if (!activeBook) {
            return;
        }

        const confirmed = window.confirm(
            `确定删除单词本“${activeBook.name}”吗？该词本里的记录会一并删除。`
        );

        if (!confirmed) {
            return;
        }

        delete store.books[activeBook.id];
        store.bookOrder = store.bookOrder.filter(function (bookId) {
            return bookId !== activeBook.id;
        });
        store.activeBookId = store.bookOrder[0];
        countedBookIds.delete(activeBook.id);

        saveStore();
        updateUI();
    }

    function switchActiveBook(bookId) {
        if (!store.books[bookId] || store.activeBookId === bookId) {
            return;
        }

        store.activeBookId = bookId;
        saveStore();
        updateUI();
    }

    function loadPanelState() {
        const raw = localStorage.getItem(PANEL_STATE_KEY);

        if (!raw) {
            return { ...DEFAULT_PANEL_STATE };
        }

        try {
            const parsed = JSON.parse(raw);
            return {
                ...DEFAULT_PANEL_STATE,
                ...(parsed && typeof parsed === 'object' ? parsed : {})
            };
        } catch (error) {
            console.warn('[Unfamiliar Word Count] Failed to parse panel state:', error);
            return { ...DEFAULT_PANEL_STATE };
        }
    }

    function savePanelState() {
        localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panelState));
    }

    function addWord(word) {
        if (!word) {
            return;
        }

        const activeBook = getActiveBook();

        if (!activeBook) {
            return;
        }

        if (word === lastWord && countedBookIds.has(activeBook.id)) {
            console.log('已记录过，不重复计数:', word, `(${activeBook.name})`);
            return;
        }

        lastWord = word;
        countedBookIds.add(activeBook.id);
        activeBook.words[word] = (activeBook.words[word] || 0) + 1;

        saveStore();
        updateUI();

        console.log('记录:', word, '->', activeBook.name);
    }

    function removeWord(word) {
        const activeBook = getActiveBook();

        if (!activeBook) {
            return;
        }

        delete activeBook.words[word];
        saveStore();
        updateUI();
    }

    function injectStyles() {
        if (document.getElementById(`${PANEL_ID}-style`)) {
            return;
        }

        const style = document.createElement('style');
        style.id = `${PANEL_ID}-style`;
        style.textContent = `
            #${PANEL_ID} {
                position: fixed;
                z-index: 998;
                width: 320px;
                max-height: min(520px, calc(100vh - 32px));
                display: flex;
                flex-direction: column;
                color: #f5f7fb;
                background: linear-gradient(180deg, rgba(20, 24, 32, 0.96), rgba(13, 17, 24, 0.94));
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 16px;
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
                backdrop-filter: blur(12px);
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                transition: box-shadow 0.2s ease, transform 0.2s ease, width 0.2s ease;
            }

            #${PANEL_ID}.is-collapsed {
                width: 220px;
            }

            #${PANEL_ID}.is-dragging {
                transition: none;
                box-shadow: 0 24px 48px rgba(0, 0, 0, 0.34);
                transform: scale(1.01);
            }

            #${PANEL_ID} * {
                box-sizing: border-box;
            }

            #${PANEL_ID} button,
            #${PANEL_ID} select {
                font: inherit;
            }

            #${PANEL_ID} .tm-uwc__header {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 14px;
                background: linear-gradient(135deg, rgba(66, 89, 125, 0.34), rgba(22, 33, 47, 0.18));
                cursor: grab;
                touch-action: none;
                user-select: none;
            }

            #${PANEL_ID}.is-dragging .tm-uwc__header {
                cursor: grabbing;
            }

            #${PANEL_ID} .tm-uwc__header-left {
                min-width: 0;
                flex: 1;
            }

            #${PANEL_ID} .tm-uwc__title {
                font-size: 14px;
                font-weight: 700;
                line-height: 1.3;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            #${PANEL_ID} .tm-uwc__summary {
                margin-top: 3px;
                font-size: 12px;
                color: rgba(231, 238, 248, 0.72);
            }

            #${PANEL_ID} .tm-uwc__actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-shrink: 0;
            }

            #${PANEL_ID} .tm-uwc__hint {
                display: inline-flex;
                align-items: center;
                padding: 4px 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.08);
                font-size: 11px;
                color: rgba(255, 255, 255, 0.78);
                user-select: none;
            }

            #${PANEL_ID}.is-collapsed .tm-uwc__hint {
                display: none;
            }

            #${PANEL_ID} .tm-uwc__toggle {
                min-width: 34px;
                height: 34px;
                padding: 0 10px;
                border: 0;
                border-radius: 10px;
                background: rgba(255, 255, 255, 0.08);
                color: #f5f7fb;
                cursor: pointer;
                user-select: none;
                transition: background 0.2s ease, transform 0.2s ease;
            }

            #${PANEL_ID} .tm-uwc__toggle:hover {
                background: rgba(255, 255, 255, 0.16);
                transform: translateY(-1px);
            }

            #${PANEL_ID} .tm-uwc__body {
                display: flex;
                flex-direction: column;
                min-height: 0;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
            }

            #${PANEL_ID}.is-collapsed .tm-uwc__body {
                display: none;
            }

            #${PANEL_ID} .tm-uwc__bookbar {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 14px 0;
            }

            #${PANEL_ID} .tm-uwc__select {
                min-width: 0;
                flex: 1;
                height: 34px;
                padding: 0 12px;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                outline: none;
                background: rgba(255, 255, 255, 0.06);
                color: #f5f7fb;
                font-size: 13px;
                transition: border-color 0.2s ease, background 0.2s ease;
            }

            #${PANEL_ID} .tm-uwc__select:hover,
            #${PANEL_ID} .tm-uwc__select:focus {
                border-color: rgba(255, 255, 255, 0.18);
                background: rgba(255, 255, 255, 0.08);
            }

            #${PANEL_ID} .tm-uwc__select option {
                color: #11161f;
            }

            #${PANEL_ID} .tm-uwc__tool-button {
                height: 34px;
                padding: 0 10px;
                border: 0;
                border-radius: 10px;
                background: rgba(255, 255, 255, 0.08);
                color: #f5f7fb;
                cursor: pointer;
                flex-shrink: 0;
                user-select: none;
                transition: background 0.2s ease, transform 0.2s ease, opacity 0.2s ease;
            }

            #${PANEL_ID} .tm-uwc__tool-button:hover {
                background: rgba(255, 255, 255, 0.16);
                transform: translateY(-1px);
            }

            #${PANEL_ID} .tm-uwc__tool-button:disabled {
                opacity: 0.46;
                cursor: not-allowed;
                transform: none;
            }

            #${PANEL_ID} .tm-uwc__toolbar {
                padding: 10px 14px 0;
                font-size: 12px;
                line-height: 1.5;
                color: rgba(231, 238, 248, 0.72);
                user-select: none;
            }

            #${PANEL_ID} .tm-uwc__list {
                position: relative;
                overflow-y: auto;
                padding: 10px 10px 14px 14px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                scrollbar-gutter: stable;
                scrollbar-width: thin;
                scrollbar-color: rgba(135, 172, 255, 0.78) rgba(255, 255, 255, 0.06);
            }

            #${PANEL_ID} .tm-uwc__list::-webkit-scrollbar {
                width: 10px;
            }

            #${PANEL_ID} .tm-uwc__list::-webkit-scrollbar-track {
                margin: 10px 0 14px;
                border-radius: 999px;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.08));
            }

            #${PANEL_ID} .tm-uwc__list::-webkit-scrollbar-thumb {
                border: 2px solid transparent;
                border-radius: 999px;
                background: linear-gradient(180deg, rgba(151, 184, 255, 0.92), rgba(103, 135, 217, 0.92));
                background-clip: padding-box;
                box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
            }

            #${PANEL_ID} .tm-uwc__list:hover::-webkit-scrollbar-thumb {
                background: linear-gradient(180deg, rgba(174, 201, 255, 0.96), rgba(115, 148, 228, 0.96));
                background-clip: padding-box;
            }

            #${PANEL_ID} .tm-uwc__list::-webkit-scrollbar-corner {
                background: transparent;
            }

            #${PANEL_ID} .tm-uwc__empty {
                padding: 18px 14px 20px;
                font-size: 13px;
                line-height: 1.6;
                color: rgba(231, 238, 248, 0.72);
            }

            #${PANEL_ID} .tm-uwc__item {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 10px;
                padding: 10px 12px;
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.05);
                transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
            }

            #${PANEL_ID} .tm-uwc__item:hover {
                background: rgba(255, 255, 255, 0.08);
                border-color: rgba(255, 255, 255, 0.1);
                transform: translateY(-1px);
            }

            #${PANEL_ID} .tm-uwc__word {
                min-width: 0;
                flex: 1;
                font-size: 13px;
                line-height: 1.4;
                white-space: normal;
                overflow-wrap: anywhere;
                word-break: break-word;
                user-select: text;
                cursor: text;
            }

            #${PANEL_ID} .tm-uwc__item-right {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-shrink: 0;
                padding-top: 1px;
            }

            #${PANEL_ID} .tm-uwc__badge {
                min-width: 30px;
                padding: 4px 8px;
                border-radius: 999px;
                background: rgba(255, 116, 96, 0.18);
                color: #ffb7ae;
                font-size: 12px;
                font-weight: 700;
                text-align: center;
                user-select: none;
            }

            #${PANEL_ID} .tm-uwc__delete {
                border: 0;
                padding: 5px 8px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.06);
                color: rgba(255, 255, 255, 0.74);
                cursor: pointer;
                user-select: none;
                transition: background 0.2s ease, color 0.2s ease;
            }

            #${PANEL_ID} .tm-uwc__delete:hover {
                background: rgba(255, 107, 107, 0.18);
                color: #ffd1d1;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function buildPanel() {
        if (!document.body || document.getElementById(PANEL_ID)) {
            return;
        }

        injectStyles();

        panel = document.createElement('section');
        panel.id = PANEL_ID;

        const header = document.createElement('div');
        header.className = 'tm-uwc__header';

        const headerLeft = document.createElement('div');
        headerLeft.className = 'tm-uwc__header-left';

        titleEl = document.createElement('div');
        titleEl.className = 'tm-uwc__title';

        summaryEl = document.createElement('div');
        summaryEl.className = 'tm-uwc__summary';

        headerLeft.appendChild(titleEl);
        headerLeft.appendChild(summaryEl);

        const actions = document.createElement('div');
        actions.className = 'tm-uwc__actions';

        const hint = document.createElement('div');
        hint.className = 'tm-uwc__hint';
        hint.textContent = '按 2 记录';

        toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'tm-uwc__toggle';
        toggleButton.addEventListener('click', function (event) {
            event.stopPropagation();
            panelState.collapsed = !panelState.collapsed;
            syncPanelState();
        });

        actions.appendChild(hint);
        actions.appendChild(toggleButton);

        header.appendChild(headerLeft);
        header.appendChild(actions);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'tm-uwc__body';

        const bookbar = document.createElement('div');
        bookbar.className = 'tm-uwc__bookbar';

        bookSelectEl = document.createElement('select');
        bookSelectEl.className = 'tm-uwc__select';
        bookSelectEl.title = '切换当前单词本';
        bookSelectEl.addEventListener('change', function () {
            switchActiveBook(bookSelectEl.value);
        });

        createBookButton = document.createElement('button');
        createBookButton.type = 'button';
        createBookButton.className = 'tm-uwc__tool-button';
        createBookButton.textContent = '新建';
        createBookButton.title = '新建单词本';
        createBookButton.addEventListener('click', promptCreateBook);

        deleteBookButton = document.createElement('button');
        deleteBookButton.type = 'button';
        deleteBookButton.className = 'tm-uwc__tool-button';
        deleteBookButton.textContent = '删本';
        deleteBookButton.addEventListener('click', deleteActiveBook);

        bookbar.appendChild(bookSelectEl);
        bookbar.appendChild(createBookButton);
        bookbar.appendChild(deleteBookButton);

        const toolbar = document.createElement('div');
        toolbar.className = 'tm-uwc__toolbar';
        toolbar.textContent = '按 2 记录到当前单词本，拖动标题栏移动，点击单词右侧按钮删除';

        listEl = document.createElement('div');
        listEl.className = 'tm-uwc__list';

        bodyEl.appendChild(bookbar);
        bodyEl.appendChild(toolbar);
        bodyEl.appendChild(listEl);

        panel.appendChild(header);
        panel.appendChild(bodyEl);
        document.body.appendChild(panel);

        initDrag(header);
        syncPanelState();
        updateUI();

        requestAnimationFrame(function () {
            applyPanelPosition();
        });
    }

    function syncPanelState() {
        if (!panel || !toggleButton) {
            return;
        }

        panel.classList.toggle('is-collapsed', panelState.collapsed);
        toggleButton.textContent = panelState.collapsed ? '>' : '-';
        toggleButton.title = panelState.collapsed ? '展开面板' : '收起面板';
        toggleButton.setAttribute('aria-label', toggleButton.title);

        requestAnimationFrame(function () {
            applyPanelPosition();
            savePanelState();
        });
    }

    function updateBookControls() {
        if (!bookSelectEl || !deleteBookButton) {
            return;
        }

        const fragment = document.createDocumentFragment();

        store.bookOrder.forEach(function (bookId) {
            const book = store.books[bookId];

            if (!book) {
                return;
            }

            const option = document.createElement('option');
            option.value = bookId;
            option.selected = bookId === store.activeBookId;
            option.textContent = getBookWordCount(book)
                ? `${book.name} (${getBookWordCount(book)})`
                : book.name;
            fragment.appendChild(option);
        });

        bookSelectEl.innerHTML = '';
        bookSelectEl.appendChild(fragment);
        deleteBookButton.disabled = store.bookOrder.length <= 1;
        deleteBookButton.title = deleteBookButton.disabled ? '至少保留一个单词本' : '删除当前单词本';
    }

    function clampPosition(left, top) {
        if (!panel) {
            return { left, top };
        }

        const margin = 12;
        const panelWidth = panel.offsetWidth || (panelState.collapsed ? 220 : 320);
        const panelHeight = panel.offsetHeight || 120;
        const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
        const maxTop = Math.max(margin, window.innerHeight - panelHeight - margin);

        return {
            left: Math.min(Math.max(left, margin), maxLeft),
            top: Math.min(Math.max(top, margin), maxTop)
        };
    }

    function applyPanelPosition() {
        if (!panel) {
            return;
        }

        let left = panelState.left;
        let top = panelState.top;

        if (typeof left !== 'number' || typeof top !== 'number') {
            const panelWidth = panel.offsetWidth || (panelState.collapsed ? 220 : 320);
            const panelHeight = panel.offsetHeight || 200;
            left = window.innerWidth - panelWidth - 24;
            top = window.innerHeight - panelHeight - 24;
        }

        const next = clampPosition(left, top);
        panelState.left = next.left;
        panelState.top = next.top;

        panel.style.left = `${next.left}px`;
        panel.style.top = `${next.top}px`;
    }

    function initDrag(handle) {
        handle.addEventListener('pointerdown', function (event) {
            if (event.button !== 0) {
                return;
            }

            if (event.target.closest('button')) {
                return;
            }

            if (!panel) {
                return;
            }

            const rect = panel.getBoundingClientRect();
            dragState = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top
            };

            handle.setPointerCapture(event.pointerId);
            panel.classList.add('is-dragging');
            event.preventDefault();
        });

        handle.addEventListener('pointermove', function (event) {
            if (!dragState || !panel || dragState.pointerId !== event.pointerId) {
                return;
            }

            const next = clampPosition(
                event.clientX - dragState.offsetX,
                event.clientY - dragState.offsetY
            );

            panelState.left = next.left;
            panelState.top = next.top;
            panel.style.left = `${next.left}px`;
            panel.style.top = `${next.top}px`;
        });

        function stopDrag(event) {
            if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
            }

            dragState = null;

            if (panel) {
                panel.classList.remove('is-dragging');
            }

            savePanelState();
        }

        handle.addEventListener('pointerup', stopDrag);
        handle.addEventListener('pointercancel', stopDrag);
    }

    function updateUI() {
        if (!titleEl || !summaryEl || !listEl) {
            return;
        }

        const activeBook = getActiveBook();

        if (!activeBook) {
            return;
        }

        updateBookControls();

        const sorted = Object.entries(activeBook.words).sort(function (a, b) {
            return b[1] - a[1];
        });
        const totalCount = getBookTotalCount(activeBook);

        titleEl.textContent = `不认识单词 ${sorted.length}`;
        summaryEl.textContent = sorted.length
            ? `${activeBook.name} · 累计记录 ${totalCount} 次`
            : `${activeBook.name} · 按 2 把当前单词加入列表`;

        listEl.innerHTML = '';

        if (!sorted.length) {
            const empty = document.createElement('div');
            empty.className = 'tm-uwc__empty';
            empty.textContent = `当前单词本“${activeBook.name}”还没有记录。看到不会的词时，按键盘 2 即可加入统计。`;
            listEl.appendChild(empty);
            requestAnimationFrame(function () {
                applyPanelPosition();
            });
            return;
        }

        const fragment = document.createDocumentFragment();

        sorted.forEach(function ([word, count]) {
            const item = document.createElement('div');
            item.className = 'tm-uwc__item';

            const text = document.createElement('div');
            text.className = 'tm-uwc__word';
            text.textContent = word;
            text.title = word;

            const right = document.createElement('div');
            right.className = 'tm-uwc__item-right';

            const badge = document.createElement('span');
            badge.className = 'tm-uwc__badge';
            badge.textContent = String(count);

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'tm-uwc__delete';
            del.textContent = '删';
            del.title = `删除 ${word}`;
            del.addEventListener('click', function () {
                removeWord(word);
            });

            right.appendChild(badge);
            right.appendChild(del);

            item.appendChild(text);
            item.appendChild(right);

            fragment.appendChild(item);
        });

        listEl.appendChild(fragment);

        requestAnimationFrame(function () {
            applyPanelPosition();
        });
    }

    function isEditableElement(element) {
        if (!element) {
            return false;
        }

        const tagName = element.tagName;
        return (
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) ||
            element.isContentEditable ||
            element.getAttribute('role') === 'textbox'
        );
    }

    function mountWhenReady() {
        if (document.body) {
            buildPanel();
            return;
        }

        document.addEventListener('DOMContentLoaded', buildPanel, { once: true });
    }

    document.addEventListener('keydown', function (event) {
        if (isEditableElement(document.activeElement)) {
            return;
        }

        const word = getCurrentWord();

        if (word !== lastWord) {
            lastWord = word;
            countedBookIds = new Set();
        }

        if (event.key === '2') {
            addWord(word);
        }

        if (event.key === '1') {
            console.log('认识:', word);
        }
    });

    window.addEventListener('resize', function () {
        if (!panel) {
            return;
        }

        applyPanelPosition();
        savePanelState();
    });

    mountWhenReady();
})();
