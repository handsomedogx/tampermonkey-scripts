// ==UserScript==
// @name         京东金融便携购入/购出
// @namespace    http://tampermonkey.net/
// @version      2026-03-02
// @description  try to take over the world!
// @author       You
// @match        https://dingpan.jd.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=jd.com
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  const panel = document.createElement("div");
  panel.id = "hsd_panel";
  panel.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "right: 0",
    "z-index: 100000",
    "width: 100%",
    "box-sizing: border-box",
    "padding: 8px 12px",
    "background: #181818",
    "color: #e5e7eb",
    "font-family: Consolas, monospace",
    "backdrop-filter: blur(4px)",
    "display: flex",
    "align-items: stretch",
    "gap: 12px",
  ].join(";");

  panel.innerHTML = `
    <div
      id="ds_log"
      style="flex:1;min-width:0;height:58px;overflow-y:auto;font-size:11px;color:#e5e7eb;line-height:1.4;background:rgba(255,255,255,0.06);padding:6px 8px;border-radius:6px;border:1px solid #334155;scrollbar-width:thin;scrollbar-color:#64748b transparent;word-break:break-all;box-sizing:border-box;"
    ></div>
    <div style="display:grid;grid-template-columns:repeat(2,90px);grid-auto-rows:25px;justify-content:flex-end;align-content:center;gap:8px;flex-shrink:0;">
      <button id="clear_log_btn" style="width:90px;height:25px;line-height:25px;background:#eb9654;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;pointer-events:all;">清理日志</button>
      <button id="auto_mode_btn" style="width:90px;height:25px;line-height:25px;background:#475569;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;pointer-events:all;">自动模式:关</button>
      <button id="sell_btn" style="width:90px;height:25px;line-height:25px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;pointer-events:all;">出货</button>
      <button id="ds_btn" style="width:90px;height:25px;line-height:25px;background:#16a34a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;pointer-events:all;">下单</button>
    </div>
`;

  document.body.appendChild(panel);

  // --- 2. 自动滚动日志函数 ---
  const dsLog = (msg) => {
    const time = new Date().toLocaleTimeString().split(" ")[0];
    const logEl = document.getElementById("ds_log");
    const entry = document.createElement("div");
    entry.innerHTML = `<span>[${time}]</span> ${msg}`;
    logEl.appendChild(entry);

    // 关键：自动滚动到底部
    logEl.scrollTop = logEl.scrollHeight;

    // 限制日志条数，防止占用过多内存
    if (logEl.childNodes.length > 100) logEl.removeChild(logEl.firstChild);
  };

  let lastBuyUrl = "";
  let lastBuyMethod = "GET";
  let lastBuyBody = null;
  let lastBuyHeaders = {};
  let lastSellUrl = "";
  let lastSellMethod = "GET";
  let lastSellBody = null;
  let lastSellHeaders = {};
  const popupBlocked = true;
  let autoModeEnabled = false;
  const RETRY_DELAY_MS = 500;
  const tradeState = {
    buy: { inFlight: false, timer: null, attempt: 0 },
    sell: { inFlight: false, timer: null, attempt: 0 },
  };
  let price = null;
  let priceId = null;
  const defaultProductSku = "1961543816";

  const getProductSkuFromReqUrl = (urlString) => {
    if (!urlString) return "";
    try {
      const urlObj = new URL(urlString, location.href);
      const reqDataRaw = new URLSearchParams(urlObj.search).get("reqData");
      if (!reqDataRaw) return "";
      const reqData = JSON.parse(reqDataRaw);
      return reqData?.productSku ? String(reqData.productSku) : "";
    } catch (e) {
      return "";
    }
  };

  const resolveHoldingProductSku = () => {
    return getProductSkuFromReqUrl(lastBuyUrl) || getProductSkuFromReqUrl(lastSellUrl) || defaultProductSku;
  };

  const clearLogBtn = document.getElementById("clear_log_btn");
  const autoModeBtn = document.getElementById("auto_mode_btn");

  const updateAutoModeBtn = () => {
    autoModeBtn.textContent = `自动模式:${autoModeEnabled ? "开" : "关"}`;
    autoModeBtn.style.background = autoModeEnabled ? "#2563eb" : "#475569";
  };

  const stopRetryByToggle = (type) => {
    const state = tradeState[type];
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
      dsLog(`已停止${type === "buy" ? "下单" : "出货"}自动重试`);
    }
    if (!state.inFlight) state.attempt = 0;
  };

  const TRADE_ERROR_POPUP_KEYWORDS = ["当前无法交易", "请稍后再试", "投资有风险", "谨慎操作"];
  let popupDiscoverObserver = null;
  const popupRootObservers = new Map();

  const normalizeText = (text) => String(text || "").replace(/\s+/g, "");

  const isTradeErrorPopup = (popupEl) => {
    if (!(popupEl instanceof Element)) return false;
    const titleText = normalizeText(popupEl.querySelector(".gosc-dialog__header")?.textContent);
    const messageText = normalizeText(popupEl.querySelector(".gosc-dialog__message")?.textContent);
    if (!messageText) return false;
    const matched = TRADE_ERROR_POPUP_KEYWORDS.some((keyword) => messageText.includes(keyword));
    if (!matched) return false;
    return !titleText || titleText.includes("温馨提示");
  };

  const removePopupInstance = (popupEl) => {
    const popupRoot = popupEl.closest(".gosc-popup") || popupEl;
    if (!(popupRoot instanceof Element) || !popupRoot.isConnected) return false;
    const popupRootObserver = popupRootObservers.get(popupRoot);
    if (popupRootObserver) {
      popupRootObserver.disconnect();
      popupRootObservers.delete(popupRoot);
    }
    popupRoot.style.setProperty("display", "none", "important");
    popupRoot.remove();
    return true;
  };

  const blockTradeErrorPopupsIn = (scope) => {
    if (!scope || typeof scope.querySelectorAll !== "function") return 0;
    const popups = [];
    if (scope instanceof Element && scope.matches(".gosc-popup")) {
      popups.push(scope);
    }
    scope.querySelectorAll(".gosc-popup").forEach((el) => popups.push(el));
    let blockedCount = 0;
    popups.forEach((popup) => {
      if (isTradeErrorPopup(popup) && removePopupInstance(popup)) {
        blockedCount += 1;
      }
    });
    return blockedCount;
  };

  const tryBlockTradeErrorPopups = () => {
    if (!popupBlocked) return;
    const blockedCount = blockTradeErrorPopupsIn(document);
    if (blockedCount > 0) {
      dsLog(`已拦截交易提示弹窗 x${blockedCount}`);
    }
  };

  const ensurePopupRootObserver = (popupRoot) => {
    if (!(popupRoot instanceof Element) || !popupRoot.matches(".gosc-popup")) return;
    if (popupRootObservers.has(popupRoot)) return;
    const observer = new MutationObserver(() => {
      if (!popupBlocked) return;
      const blockedCount = blockTradeErrorPopupsIn(popupRoot);
      if (blockedCount > 0) {
        dsLog(`已拦截交易提示弹窗 x${blockedCount}`);
      }
    });
    observer.observe(popupRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    popupRootObservers.set(popupRoot, observer);
  };

  const attachPopupRootObserversIn = (scope) => {
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    if (scope instanceof Element && scope.matches(".gosc-popup")) {
      ensurePopupRootObserver(scope);
    }
    scope.querySelectorAll(".gosc-popup").forEach((popupRoot) => {
      ensurePopupRootObserver(popupRoot);
    });
  };

  const ensurePopupObserver = () => {
    if (popupDiscoverObserver || !document.body) return;
    popupDiscoverObserver = new MutationObserver((mutationList) => {
      if (!popupBlocked) return;
      let blockedCount = 0;
      mutationList.forEach((mutation) => {
        if (mutation.type !== "childList") return;
        mutation.addedNodes.forEach((node) => {
          attachPopupRootObserversIn(node);
          blockedCount += blockTradeErrorPopupsIn(node);
        });
      });
      if (blockedCount > 0) {
        dsLog(`已拦截交易提示弹窗 x${blockedCount}`);
      }
    });
    popupDiscoverObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  };

  clearLogBtn.onclick = function () {
    const logEl = document.getElementById("ds_log");
    if (logEl) {
      logEl.innerHTML = "";
    }
  };

  autoModeBtn.onclick = function () {
    autoModeEnabled = !autoModeEnabled;
    updateAutoModeBtn();
    dsLog(`自动模式已${autoModeEnabled ? "开启" : "关闭"}`);
    if (!autoModeEnabled) {
      stopRetryByToggle("buy");
      stopRetryByToggle("sell");
    }
  };

  updateAutoModeBtn();
  ensurePopupObserver();
  attachPopupRootObserversIn(document);
  tryBlockTradeErrorPopups();

  const tradeConfigs = {
    buy: {
      actionName: "下单",
      successText: "✅ 恭喜！下单成功",
      getRequestMeta: () => ({
        url: lastBuyUrl,
        method: (lastBuyMethod || "GET").toUpperCase(),
        body: lastBuyBody,
        headers: { ...(lastBuyHeaders || {}) },
      }),
      buildFinalUrl: (originalUrl, newPrice, newPriceId) => {
        const urlObj = new URL(originalUrl, location.href);
        const params = new URLSearchParams(urlObj.search);
        const reqData = JSON.parse(params.get("reqData"));
        reqData.orderPrice = `${newPrice}`;
        reqData.orderSellPrice = `${newPrice}`;
        reqData.priceUuid = `${newPriceId}`;
        params.set("reqData", JSON.stringify(reqData));
        urlObj.search = params.toString();
        return urlObj.toString();
      },
    },
    sell: {
      actionName: "出货",
      successText: "✅ 恭喜！出货成功",
      getRequestMeta: () => ({
        url: lastSellUrl,
        method: (lastSellMethod || "GET").toUpperCase(),
        body: lastSellBody,
        headers: { ...(lastSellHeaders || {}) },
      }),
      buildFinalUrl: (originalUrl, newPrice, newPriceId) => {
        const urlObj = new URL(originalUrl, location.href);
        const params = new URLSearchParams(urlObj.search);
        const reqData = JSON.parse(params.get("reqData"));
        reqData.orderSellPrice = `${newPrice}`;
        reqData.priceUuid = `${newPriceId}`;
        reqData.orderPrice = `${newPrice}`;
        reqData.askPrice = `${newPrice}`;
        params.set("reqData", JSON.stringify(reqData));
        urlObj.search = params.toString();
        return urlObj.toString();
      },
    },
  };

  const isTradeActive = (state) => state.inFlight || state.timer !== null;

  const scheduleRetry = (type) => {
    if (!autoModeEnabled) return;
    const state = tradeState[type];
    const config = tradeConfigs[type];
    if (!state || !config || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      runTradeAttempt(type);
    }, RETRY_DELAY_MS);
    dsLog(`自动模式已开启，${RETRY_DELAY_MS}ms 后重试${config.actionName}`);
  };

  const runTradeAttempt = (type) => {
    const config = tradeConfigs[type];
    const state = tradeState[type];
    if (!config || !state || state.inFlight) return;

    state.attempt += 1;
    dsLog(`正在执行${config.actionName}请求${autoModeEnabled ? `（第${state.attempt}次）` : ""}`);

    const { url, method, body, headers } = config.getRequestMeta();
    console.log("[dog]trade type:", type);
    console.log("[dog]trade url:", url);
    console.log("[dog]price:", price);
    console.log("[dog]priceId:", priceId);

    if (!url || !price || !priceId) {
      dsLog("错误：尚未捕获完整参数!");
      state.attempt = 0;
      return;
    }

    let finalUrl = "";
    try {
      finalUrl = config.buildFinalUrl(url, price, priceId);
      console.log("[dog]最终发送的加密请求:", finalUrl);
    } catch (e) {
      dsLog(`构造请求失败:${e}`);
      if (autoModeEnabled) {
        scheduleRetry(type);
      } else {
        state.attempt = 0;
      }
      return;
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr._isReplay = true;
      xhr.open(method, finalUrl, true);
      xhr.withCredentials = true;
      Object.keys(headers || {}).forEach((name) => {
        if (!/^cookie$/i.test(name)) {
          xhr.setRequestHeader(name, headers[name]);
        }
      });
      state.inFlight = true;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        state.inFlight = false;
        console.log("[dog]交易返回结果:", xhr.responseText);

        let success = false;
        let failMsg = "";

        if (xhr.status < 200 || xhr.status >= 300) {
          failMsg = `HTTP ${xhr.status}`;
        } else {
          try {
            const result = JSON.parse(xhr.responseText);
            success = !!result?.success;
            failMsg = result?.resultMsg || "未知错误";
          } catch (e) {
            failMsg = `结果解析异常:${e}`;
          }
        }

        if (success) {
          dsLog(config.successText);
          state.attempt = 0;
          getHoldingStatStd();
          return;
        }

        dsLog(`❌ 错误：${failMsg}`);
        if (autoModeEnabled) {
          scheduleRetry(type);
        } else {
          state.attempt = 0;
        }
      };
      const bodyToSend = method === "GET" || method === "HEAD" ? null : body;
      xhr.send(bodyToSend);
    } catch (e) {
      state.inFlight = false;
      dsLog(`发送请求失败:${e}`);
      if (autoModeEnabled) {
        scheduleRetry(type);
      } else {
        state.attempt = 0;
      }
    }
  };

  const triggerTrade = (type) => {
    const config = tradeConfigs[type];
    const state = tradeState[type];
    if (!config || !state) return;
    if (isTradeActive(state)) {
      dsLog(`${config.actionName}请求执行中，请稍候`);
      return;
    }
    runTradeAttempt(type);
  };

  // --- Hook 逻辑 ---
  const originOpen = XMLHttpRequest.prototype.open;
  const originSend = XMLHttpRequest.prototype.send;
  const originSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this._url = new URL(url, location.href).toString();
    } catch (e) {
      this._url = url;
    }
    this._method = method;
    this._headers = {};
    return originOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this._headers) this._headers = {};
    this._headers[name] = value;
    return originSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // 1. 捕获最新价格
    if (typeof this._url === "string" && this._url.includes("stdLatestPrice")) {
      this.addEventListener("load", function () {
        try {
          const result = JSON.parse(this.responseText);
          price = result.resultData.datas.price;
          priceId = result.resultData.datas.id;
          //dsLog(`实时价已更新: ${price}, ID: ${priceId}`);
        } catch (e) {
          dsLog("价格解析异常");
          console.log("[dog]格解析异常", e);
        }
      });
    }

    // 2. 捕获购买请求（凭证）
    if (typeof this._url === "string" && this._url.includes("stdRechargeAndBuyGold") && !this._isReplay) {
      dsLog("💴 捕获到购买请求凭证！");
      lastBuyUrl = this._url;
      lastBuyMethod = this._method || "GET";
      lastBuyBody = body ?? null;
      lastBuyHeaders = { ...(this._headers || {}) };
    }

    // 3. 捕获出售请求（凭证）
    if (typeof this._url === "string" && this._url.includes("stdSellGold") && !this._isReplay) {
      dsLog("💴 捕获到出售请求凭证！");
      lastSellUrl = this._url;
      lastSellMethod = this._method || "GET";
      lastSellBody = body ?? null;
      lastSellHeaders = { ...(this._headers || {}) };
    }
    return originSend.apply(this, arguments);
  };
  // 下单逻辑
  document.getElementById("ds_btn").onclick = function () {
    triggerTrade("buy");
  };
  // 出货逻辑
  document.getElementById("sell_btn").onclick = function () {
    triggerTrade("sell");
  };
  // 查询持仓逻辑
  function getHoldingStatStd() {
    const productSku = resolveHoldingProductSku();
    const reqBody = `reqData=${encodeURIComponent(JSON.stringify({ productSku }))}`;
    // dsLog(`正在查询持仓... productSku=${productSku}`);
    const positionUrl = "https://ms.jr.jd.com/gw2/generic/jrm/h5/m/getHoldingStatStd";
    const xhr = new XMLHttpRequest();

    xhr.open("POST", positionUrl, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8;");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        dsLog(`❌ 持仓查询失败，HTTP ${xhr.status}`);
        return;
      }
      try {
        const result = JSON.parse(xhr.responseText);
        if (!result?.success) {
          dsLog(`❌ 持仓查询失败：${result?.resultMsg || "未知错误"}`);
          return;
        }
        if (result?.resultData?.status && result.resultData.status !== "SUCCESS") {
          dsLog(`❌ 持仓查询失败[${result?.resultData?.errorCode || "-"}]: ${result?.resultData?.errorMessage || "未知错误"}`);
          return;
        }
        const datas = result?.resultData?.datas || {};
        const totalGram = datas.totalGram;
        const availableGram = datas.availableGram;
        if (totalGram === undefined || totalGram === null) {
          dsLog("❌ 持仓查询成功，但未返回 totalGram");
          return;
        }
        dsLog(`✅ 当前持仓总克重: ${totalGram}g`);
      } catch (e) {
        dsLog(`❌ 持仓结果解析异常: ${e}`);
      }
    };
    xhr.send(reqBody);
  }
})();
