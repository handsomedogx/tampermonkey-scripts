// ==UserScript==
// @name         Unfamiliar Word Count
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  记录不认识单词 + 次数统计
// @match        https://web.shanbay.com/*
// @run-at       document-start
// @icon         https://assets0.baydn.com/static/img/shanbay_favicon.png
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'unknown_words_map';

    // ===== 状态锁 =====
    let lastWord = null;
    let hasCounted = false;

    // ===== 获取单词 =====
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

    // ===== 数据 =====
    function getData() {
        const data = localStorage.getItem(STORAGE_KEY);
        return data ? JSON.parse(data) : {};
    }

    function saveData(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    function addWord(word) {
        if (!word) return;

        // ✅ 状态锁：同一单词只记录一次
        if (word === lastWord && hasCounted) {
            console.log('已记录过，不重复计数:', word);
            return;
        }

        lastWord = word;
        hasCounted = true;

        const data = getData();

        if (!data[word]) {
            data[word] = 1;
        } else {
            data[word]++;
        }

        saveData(data);
        updateUI();

        console.log('记录:', word);
    }

    function removeWord(word) {
        const data = getData();
        delete data[word];
        saveData(data);
        updateUI();
    }

    // ===== UI =====
    const panel = document.createElement('div');
    panel.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        width: 260px;
        max-height: 420px;
        background: #181818;
        color: #fff;
        font-size: 13px;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        backdrop-filter: blur(6px);
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        padding: 10px 12px;
        background: linear-gradient(135deg, #2c2c2c, #1f1f1f);
        font-weight: bold;
        cursor: pointer;
    `;

    const list = document.createElement('div');
    list.style.cssText = `
        overflow-y: auto;
        padding: 8px;
    `;

    panel.appendChild(header);
    panel.appendChild(list);
    document.body.appendChild(panel);

    let collapsed = false;

    header.onclick = () => {
        collapsed = !collapsed;
        list.style.display = collapsed ? 'none' : 'block';
    };

    function updateUI() {
        const data = getData();

        const sorted = Object.entries(data)
            .sort((a, b) => b[1] - a[1]);

        header.innerText = `📚 不认识单词 (${sorted.length})`;

        list.innerHTML = '';

        sorted.forEach(([word, count]) => {
            const item = document.createElement('div');
            item.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
                padding: 6px 8px;
                background: rgba(255,255,255,0.05);
                border-radius: 6px;
                transition: 0.2s;
            `;

            item.onmouseenter = () => {
                item.style.background = 'rgba(255,255,255,0.1)';
            };
            item.onmouseleave = () => {
                item.style.background = 'rgba(255,255,255,0.05)';
            };

            const text = document.createElement('span');
            text.innerText = word;

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.alignItems = 'center';
            right.style.gap = '6px';

            const badge = document.createElement('span');
            badge.innerText = count;
            badge.style.cssText = `
                background: #ff4757;
                padding: 2px 6px;
                border-radius: 10px;
                font-size: 12px;
            `;

            const del = document.createElement('span');
            del.innerText = '✖';
            del.style.cursor = 'pointer';
            del.style.opacity = '0.6';

            del.onmouseenter = () => del.style.opacity = '1';
            del.onmouseleave = () => del.style.opacity = '0.6';

            del.onclick = () => removeWord(word);

            right.appendChild(badge);
            right.appendChild(del);

            item.appendChild(text);
            item.appendChild(right);

            list.appendChild(item);
        });
    }

    // ===== 键盘监听 =====
    document.addEventListener('keydown', function (event) {
        if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

        const word = getCurrentWord();

        // ✅ 如果单词变化 → 重置状态锁
        if (word !== lastWord) {
            lastWord = word;
            hasCounted = false;
        }

        if (event.key === '2') {
            addWord(word);
        }

        if (event.key === '1') {
            console.log('认识:', word);
        }
    });

    updateUI();

})();
