// ==UserScript==
// @name         Tubi 多轨字幕助手
// @namespace    https://github.com/handsomedog/tubi-translate
// @version      0.4.1
// @description  自动捕获 Tubi 字幕，并以多轨方式叠加显示原文、Google 翻译和模型翻译。
// @match        https://tubitv.com/*
// @match        https://*.tubitv.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const LEGACY_SETTINGS_KEY = "tb_settings_v1";
  const SETTINGS_KEY = "tb_settings_v2";
  const CACHE_KEY = "tb_translation_cache_v2";
  const TARGET_LANG = "zh-CN";
  const TRACK_ORDER = ["source", "google", "model1", "model2"];
  const MODEL_TRACK_IDS = ["model1", "model2"];
  const TRANSLATION_TRACK_IDS = ["google", "model1", "model2"];
  const MAX_CACHE_ENTRIES = 5000;
  const TICK_MS = 120;
  const TRANSLATION_LOOKAHEAD_SECONDS = 75;
  const TRANSLATION_LOOKAHEAD_CUES = 28;
  const TRANSLATION_BACKTRACK_CUES = 2;
  const TRANSLATION_MIN_BATCH_CUES = 4;
  const TRANSLATION_URGENT_LEAD_SECONDS = 18;
  const TRANSLATION_BATCH_COOLDOWN_MS = 900;
  const TRANSLATION_FAILURE_BACKOFF_MS = 5000;

  const TRACK_META = {
    source: {
      label: "源字幕",
      accent: "#ffffff",
      kind: "source"
    },
    google: {
      label: "Google 翻译",
      accent: "#ffe082",
      kind: "google-free"
    },
    model1: {
      label: "模型 1",
      accent: "#8bd6ff",
      kind: "openai-compatible"
    },
    model2: {
      label: "模型 2",
      accent: "#ff9ec4",
      kind: "openai-compatible"
    }
  };

  let migratedLegacySettings = false;

  const state = {
    settings: loadSettings(),
    cache: loadCache(),
    video: null,
    host: null,
    overlayRoot: null,
    subtitleBox: null,
    trackNodes: createTrackNodeMap(),
    panelNode: null,
    panelToggleNode: null,
    statusNode: null,
    statusText: "等待检测字幕",
    batchMetricNodes: createTrackNodeMap(),
    actionButtons: {},
    layoutSectionNode: null,
    layoutSectionBodyNode: null,
    layoutSectionToggleButton: null,
    layoutControlBindings: [],
    trackControlBindings: createTrackBindingMap(),
    trackCardNodes: {},
    trackCardBodyNodes: {},
    trackCardStatusNodes: {},
    trackToggleButtons: {},
    trackExpandButtons: {},
    trackTestButtons: {},
    openCards: new Set(),
    trackRuntimes: createTrackRuntimeMap(),
    renderedTrackTexts: createTrackTextMap(""),
    tickId: 0,
    bindQueued: false,
    cueKey: "",
    cues: [],
    currentSubtitleUrl: "",
    lastDetectedSubtitleUrl: "",
    sourceToken: 0,
    activeCueIndex: -1,
    settingsSaveId: 0
  };

  init();

  function init() {
    patchFetch();
    patchXHR();
    bindKeyboardEventGuard();
    injectStyles();
    observePage();

    if (migratedLegacySettings) {
      saveSettings();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
    } else {
      onDomReady();
    }
  }

  function onDomReady() {
    queueBindVideo();

    if (!state.tickId) {
      state.tickId = window.setInterval(onTick, TICK_MS);
    }
  }

  function observePage() {
    const attachObserver = () => {
      if (!document.documentElement) {
        return;
      }

      const observer = new MutationObserver(() => queueBindVideo());
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    };

    if (document.documentElement) {
      attachObserver();
    } else {
      document.addEventListener("DOMContentLoaded", attachObserver, { once: true });
    }

    window.addEventListener("resize", syncOverlayLayout);
    document.addEventListener("fullscreenchange", () => {
      queueBindVideo();
      window.setTimeout(syncOverlayLayout, 50);
    });
    window.addEventListener("popstate", queueBindVideo);
  }

  function queueBindVideo() {
    if (state.bindQueued) {
      return;
    }

    state.bindQueued = true;
    window.requestAnimationFrame(() => {
      state.bindQueued = false;
      bindLargestVideo();
    });
  }

  function bindLargestVideo() {
    const candidates = Array.from(document.querySelectorAll("video")).filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 200 && rect.height > 120;
    });

    if (!candidates.length) {
      state.video = null;
      state.host = null;
      refreshAllTrackCardHeaders();
      return;
    }

    candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });

    const nextVideo = candidates[0];
    if (nextVideo === state.video && state.overlayRoot?.isConnected) {
      syncOverlayLayout();
      return;
    }

    state.video = nextVideo;
    state.activeCueIndex = -1;
    state.cueKey = "";
    ensureOverlayAttached();
    syncOverlayLayout();
    syncNativeCaptionVisibility();
    refreshAllTrackCardHeaders();
  }

  function ensureOverlayAttached() {
    if (!state.video) {
      return;
    }

    const host = pickOverlayHost(state.video);
    if (!host) {
      return;
    }

    if (!state.overlayRoot) {
      createOverlay();
    }

    if (state.host !== host || !state.overlayRoot.isConnected) {
      state.host = host;

      if (getComputedStyle(host).position === "static") {
        host.style.position = "relative";
      }

      host.appendChild(state.overlayRoot);
    }
  }

  function pickOverlayHost(video) {
    let node = video.parentElement;
    const videoRect = video.getBoundingClientRect();

    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const widthClose = Math.abs(rect.width - videoRect.width) < 4;
      const heightClose = Math.abs(rect.height - videoRect.height) < 4;
      if (widthClose && heightClose) {
        return node;
      }
      node = node.parentElement;
    }

    return video.parentElement || null;
  }

  function onTick() {
    if (!state.video || !state.video.isConnected) {
      queueBindVideo();
    }

    if (!state.video) {
      clearRenderedCue();
      refreshAllTrackCardHeaders();
      return;
    }

    ensureOverlayAttached();
    syncOverlayLayout();
    syncNativeCaptionVisibility();
    renderActiveCue();
    pumpProgressiveTranslation();
    refreshAllTrackCardHeaders();
  }

  function createOverlay() {
    const root = document.createElement("div");
    root.className = "tb-root";

    const subtitleBox = document.createElement("div");
    subtitleBox.className = "tb-subtitle-box";

    TRACK_ORDER.forEach((trackId) => {
      const node = document.createElement("div");
      node.className = `tb-line tb-track-${trackId}`;
      node.dataset.trackId = trackId;
      node.style.setProperty("--tb-track-accent", TRACK_META[trackId].accent);
      subtitleBox.appendChild(node);
      state.trackNodes[trackId] = node;
    });

    const launcher = makeLauncherButton();

    const panel = document.createElement("div");
    panel.className = "tb-panel";

    const panelScroll = document.createElement("div");
    panelScroll.className = "tb-panel-scroll";

    const panelHeader = document.createElement("div");
    panelHeader.className = "tb-panel-header";

    const status = document.createElement("div");
    status.className = "tb-status";
    status.textContent = state.statusText;

    const actions = document.createElement("div");
    actions.className = "tb-actions";

    const retryButton = makeButton("清空缓存并重载", "清空已缓存的译文，并重新请求当前字幕文件", clearCacheAndReloadSubtitle);
    const hideButton = makeButton("收起面板", "隐藏面板，只保留启动按钮", collapsePanel);
    actions.appendChild(retryButton);
    actions.appendChild(hideButton);

    const layoutSection = createLayoutPanel();
    const tracksSection = createTrackManagerPanel();
    const batchMetricsSection = createBatchMetricsFooter();

    panelHeader.appendChild(status);
    panelHeader.appendChild(actions);
    panelScroll.appendChild(panelHeader);
    panelScroll.appendChild(layoutSection);
    panelScroll.appendChild(tracksSection);
    panelScroll.appendChild(batchMetricsSection);
    panel.appendChild(panelScroll);

    trapPanelEvents(panel);

    root.appendChild(launcher);
    root.appendChild(panel);
    root.appendChild(subtitleBox);

    state.overlayRoot = root;
    state.subtitleBox = subtitleBox;
    state.panelNode = panel;
    state.panelToggleNode = launcher;
    state.statusNode = status;
    state.actionButtons = {
      retryButton,
      hideButton
    };

    syncLayoutControlBindings();
    TRACK_ORDER.forEach((trackId) => syncTrackControlBindings(trackId));
    applySubtitleStyles();
    refreshActionButtons();
    refreshAllTrackCardHeaders();
    refreshBatchMetricsFooter();
    setPanelCollapsed(Boolean(state.settings.panelCollapsed), false);
  }

  function createLayoutPanel() {
    state.layoutControlBindings = [];

    const section = makePanelSection("全局布局");
    section.classList.add("tb-panel-section-collapsible");

    const header = document.createElement("div");
    header.className = "tb-panel-section-header";
    header.addEventListener("click", () => toggleLayoutSection());

    const titleWrap = document.createElement("div");
    titleWrap.className = "tb-panel-section-title-wrap";

    const title = document.createElement("div");
    title.className = "tb-section-title";
    title.textContent = "全局布局";

    const meta = document.createElement("div");
    meta.className = "tb-panel-section-meta";
    meta.textContent = "控制所有字幕轨共享的布局和显示规则";

    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const toggleButton = makeMiniButton("", "", () => toggleLayoutSection());
    toggleButton.classList.add("tb-panel-section-toggle");

    header.appendChild(titleWrap);
    header.appendChild(toggleButton);

    const body = document.createElement("div");
    body.className = "tb-panel-section-body";

    body.appendChild(makeRangeControl(state.layoutControlBindings, "基础字号", {
      getValue: () => state.settings.layout.fontScale,
      onInput: (value) => applyLayoutSetting("fontScale", value, true),
      onChange: (value) => applyLayoutSetting("fontScale", value, false),
      min: 0.7,
      max: 1.8,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}x`
    }));
    body.appendChild(makeRangeControl(state.layoutControlBindings, "底部偏移", {
      getValue: () => state.settings.layout.bottomOffsetPx,
      onInput: (value) => applyLayoutSetting("bottomOffsetPx", value, true),
      onChange: (value) => applyLayoutSetting("bottomOffsetPx", value, false),
      min: 0,
      max: 180,
      step: 1,
      format: (value) => `${Math.round(value)}px`
    }));
    body.appendChild(makeRangeControl(state.layoutControlBindings, "最大宽度", {
      getValue: () => state.settings.layout.maxWidthPercent,
      onInput: (value) => applyLayoutSetting("maxWidthPercent", value, true),
      onChange: (value) => applyLayoutSetting("maxWidthPercent", value, false),
      min: 60,
      max: 100,
      step: 1,
      format: (value) => `${Math.round(value)}%`
    }));
    body.appendChild(makeRangeControl(state.layoutControlBindings, "轨间距", {
      getValue: () => state.settings.layout.lineGapEm,
      onInput: (value) => applyLayoutSetting("lineGapEm", value, true),
      onChange: (value) => applyLayoutSetting("lineGapEm", value, false),
      min: 0,
      max: 1.2,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}em`
    }));
    body.appendChild(makeSelectControl(state.layoutControlBindings, "对齐方式", {
      getValue: () => state.settings.layout.textAlign,
      onChange: (value) => applyLayoutSetting("textAlign", value, false),
      choices: [
        ["left", "左对齐"],
        ["center", "居中"],
        ["right", "右对齐"]
      ]
    }));
    body.appendChild(makeSelectControl(state.layoutControlBindings, "换行模式", {
      getValue: () => state.settings.layout.lineBreakMode,
      onChange: (value) => applyLayoutSetting("lineBreakMode", value, false),
      choices: [
        ["smart", "智能合并"],
        ["raw", "保留原样"]
      ]
    }));
    body.appendChild(makeSelectControl(state.layoutControlBindings, "原文大小写", {
      getValue: () => state.settings.layout.originalCaseMode,
      onChange: (value) => applyLayoutSetting("originalCaseMode", value, false),
      choices: [
        ["smart", "智能修正"],
        ["raw", "保留原样"]
      ]
    }));

    section.appendChild(header);
    section.appendChild(body);

    state.layoutSectionNode = section;
    state.layoutSectionBodyNode = body;
    state.layoutSectionToggleButton = toggleButton;
    refreshLayoutSectionState();

    return section;
  }

  function createTrackManagerPanel() {
    const section = makePanelSection("字幕管理");
    section.appendChild(makeHintText("固定顺序为：源字幕、Google 翻译、模型 1、模型 2。已启用译文轨会按播放进度逐步翻译。"));

    TRACK_ORDER.forEach((trackId) => {
      section.appendChild(createTrackCard(trackId));
    });

    return section;
  }

  function createBatchMetricsFooter() {
    const section = makePanelSection("批次统计");
    section.classList.add("tb-batch-metrics");

    MODEL_TRACK_IDS.forEach((trackId) => {
      const row = document.createElement("div");
      row.className = "tb-batch-metric-row";
      row.style.setProperty("--tb-track-accent", TRACK_META[trackId].accent);

      const label = document.createElement("span");
      label.className = "tb-batch-metric-label";
      label.textContent = TRACK_META[trackId].label;

      const value = document.createElement("span");
      value.className = "tb-batch-metric-value";

      row.appendChild(label);
      row.appendChild(value);
      section.appendChild(row);
      state.batchMetricNodes[trackId] = value;
    });

    return section;
  }

  function createTrackCard(trackId) {
    state.trackControlBindings[trackId] = [];

    const card = document.createElement("section");
    card.className = "tb-track-card";
    card.style.setProperty("--tb-track-accent", TRACK_META[trackId].accent);
    card.dataset.trackId = trackId;

    const header = document.createElement("div");
    header.className = "tb-track-card-header";
    header.addEventListener("click", () => toggleTrackCard(trackId));

    const titleWrap = document.createElement("div");
    titleWrap.className = "tb-track-card-title-wrap";

    const title = document.createElement("div");
    title.className = "tb-track-card-title";
    title.textContent = TRACK_META[trackId].label;

    const meta = document.createElement("div");
    meta.className = "tb-track-card-meta";
    meta.textContent = getTrackMetaText(trackId);

    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const headerActions = document.createElement("div");
    headerActions.className = "tb-track-card-actions";

    const status = document.createElement("span");
    status.className = "tb-track-status";

    const toggleButton = makeMiniButton("", "", () => toggleTrackEnabled(trackId));
    const expandButton = makeMiniButton("", "", () => toggleTrackCard(trackId));

    headerActions.appendChild(status);
    headerActions.appendChild(toggleButton);
    headerActions.appendChild(expandButton);

    header.appendChild(titleWrap);
    header.appendChild(headerActions);

    const body = document.createElement("div");
    body.className = "tb-track-card-body tb-hidden";

    const styleSection = document.createElement("div");
    styleSection.className = "tb-track-block";
    styleSection.appendChild(makeBlockTitle("样式"));
    styleSection.appendChild(makeRangeControl(state.trackControlBindings[trackId], "字号倍率", {
      getValue: () => state.settings.tracks[trackId].style.scale,
      onInput: (value) => applyTrackStyleSetting(trackId, "scale", value, true),
      onChange: (value) => applyTrackStyleSetting(trackId, "scale", value, false),
      min: 0.7,
      max: 1.8,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}x`
    }));
    styleSection.appendChild(makeRangeControl(state.trackControlBindings[trackId], "字重", {
      getValue: () => state.settings.tracks[trackId].style.fontWeight,
      onInput: (value) => applyTrackStyleSetting(trackId, "fontWeight", value, true),
      onChange: (value) => applyTrackStyleSetting(trackId, "fontWeight", value, false),
      min: 400,
      max: 900,
      step: 100,
      format: (value) => String(Math.round(value))
    }));
    styleSection.appendChild(makeColorControl(state.trackControlBindings[trackId], "文字颜色", {
      getValue: () => state.settings.tracks[trackId].style.color,
      onInput: (value) => applyTrackStyleSetting(trackId, "color", value, true),
      onChange: (value) => applyTrackStyleSetting(trackId, "color", value, false),
      format: (value) => String(value).toUpperCase()
    }));
    styleSection.appendChild(makeColorControl(state.trackControlBindings[trackId], "底色", {
      getValue: () => state.settings.tracks[trackId].style.bgColor,
      onInput: (value) => applyTrackStyleSetting(trackId, "bgColor", value, true),
      onChange: (value) => applyTrackStyleSetting(trackId, "bgColor", value, false),
      format: (value) => String(value).toUpperCase()
    }));
    styleSection.appendChild(makeRangeControl(state.trackControlBindings[trackId], "底色透明", {
      getValue: () => state.settings.tracks[trackId].style.bgOpacity,
      onInput: (value) => applyTrackStyleSetting(trackId, "bgOpacity", value, true),
      onChange: (value) => applyTrackStyleSetting(trackId, "bgOpacity", value, false),
      min: 0,
      max: 1,
      step: 0.05,
      format: (value) => formatNumber(value, 2)
    }));

    body.appendChild(styleSection);

    if (isModelTrack(trackId)) {
      const configSection = document.createElement("div");
      configSection.className = "tb-track-block";
      configSection.appendChild(makeBlockTitle("模型配置"));
      configSection.appendChild(makeTextControl(state.trackControlBindings[trackId], "接口 URL", {
        getValue: () => state.settings.tracks[trackId].apiUrl,
        onInput: (value) => applyModelSetting(trackId, "apiUrl", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "apiUrl", value, false, true),
        placeholder: "https://api.openai.com/v1/chat/completions"
      }));
      configSection.appendChild(makePasswordControl(state.trackControlBindings[trackId], "API Key", {
        getValue: () => state.settings.tracks[trackId].apiKey,
        onInput: (value) => applyModelSetting(trackId, "apiKey", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "apiKey", value, false, true),
        placeholder: "sk-..."
      }));
      configSection.appendChild(makeTextControl(state.trackControlBindings[trackId], "模型名", {
        getValue: () => state.settings.tracks[trackId].model,
        onInput: (value) => applyModelSetting(trackId, "model", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "model", value, false, true),
        placeholder: "gpt-4.1-mini"
      }));
      configSection.appendChild(makeNumberControl(state.trackControlBindings[trackId], "温度", {
        getValue: () => state.settings.tracks[trackId].temperature,
        onInput: (value) => applyModelSetting(trackId, "temperature", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "temperature", value, false, true),
        min: 0,
        max: 2,
        step: 0.1,
        format: (value) => formatNumber(value, 1)
      }));
      configSection.appendChild(makeNumberControl(state.trackControlBindings[trackId], "超时", {
        getValue: () => state.settings.tracks[trackId].timeoutMs,
        onInput: (value) => applyModelSetting(trackId, "timeoutMs", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "timeoutMs", value, false, true),
        min: 5000,
        max: 120000,
        step: 1000,
        format: (value) => `${Math.round(value)}ms`
      }));
      configSection.appendChild(makeTextareaControl(state.trackControlBindings[trackId], "系统提示词", {
        getValue: () => state.settings.tracks[trackId].systemPrompt,
        onInput: (value) => applyModelSetting(trackId, "systemPrompt", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "systemPrompt", value, false, true),
        rows: 4,
        placeholder: "You are a subtitle translator..."
      }));
      configSection.appendChild(makeTextareaControl(state.trackControlBindings[trackId], "测试文本", {
        getValue: () => state.settings.tracks[trackId].testText,
        onInput: (value) => applyModelSetting(trackId, "testText", value, true, false),
        onChange: (value) => applyModelSetting(trackId, "testText", value, false, false),
        rows: 3,
        placeholder: "输入一段短句用于测试接口。"
      }));
      configSection.appendChild(makeHintText("测试接口只会发送一条短句，不会修改当前字幕状态。"));

      const testActions = document.createElement("div");
      testActions.className = "tb-inline-actions";
      const testButton = makeMiniButton("测试接口", "发送测试文本验证模型接口", () => testModelTrack(trackId));
      testButton.classList.add("tb-button-secondary");
      testActions.appendChild(testButton);
      configSection.appendChild(testActions);

      state.trackTestButtons[trackId] = testButton;
      body.appendChild(configSection);
    } else if (trackId === "google") {
      body.appendChild(makeHintText("使用内置 Google Translate 网页接口，目标语言固定为简体中文。"));
    } else {
      body.appendChild(makeHintText("原文字轨直接显示捕获到的字幕内容，不会发起翻译请求。"));
    }

    card.appendChild(header);
    card.appendChild(body);

    state.trackCardNodes[trackId] = card;
    state.trackCardBodyNodes[trackId] = body;
    state.trackCardStatusNodes[trackId] = status;
    state.trackToggleButtons[trackId] = toggleButton;
    state.trackExpandButtons[trackId] = expandButton;

    syncTrackControlBindings(trackId);
    refreshTrackCardHeader(trackId);
    updateTrackCardOpenState(trackId);

    return card;
  }

  function makePanelSection(titleText) {
    const section = document.createElement("section");
    section.className = "tb-panel-section";

    const title = document.createElement("div");
    title.className = "tb-section-title";
    title.textContent = titleText;

    section.appendChild(title);
    return section;
  }

  function makeBlockTitle(titleText) {
    const title = document.createElement("div");
    title.className = "tb-block-title";
    title.textContent = titleText;
    return title;
  }

  function makeLauncherButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tb-launcher";
    button.textContent = "字幕";
    button.title = "打开字幕面板";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel();
    });
    trapPanelEvents(button);
    return button;
  }

  function makeButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tb-button";
    button.textContent = label;
    button.title = title || label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function makeMiniButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tb-button tb-button-mini";
    button.textContent = label;
    button.title = title || label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function makeHintText(text) {
    const node = document.createElement("div");
    node.className = "tb-hint";
    node.textContent = text;
    return node;
  }

  function makeControlRow(label, input, valueNode) {
    const row = document.createElement("label");
    row.className = "tb-control";

    const nameNode = document.createElement("span");
    nameNode.className = "tb-control-label";
    nameNode.textContent = label;

    const inputWrap = document.createElement("div");
    inputWrap.className = "tb-control-input";
    inputWrap.appendChild(input);

    row.appendChild(nameNode);
    row.appendChild(inputWrap);

    if (valueNode) {
      row.appendChild(valueNode);
    }

    return row;
  }

  function makeRangeControl(bindingList, label, options) {
    const input = document.createElement("input");
    input.type = "range";
    input.className = "tb-range";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);

    const valueNode = document.createElement("span");
    valueNode.className = "tb-control-value";

    registerBinding(bindingList, options.getValue, input, valueNode, options.format);
    input.addEventListener("input", () => options.onInput(Number(input.value)));
    input.addEventListener("change", () => options.onChange(Number(input.value)));

    return makeControlRow(label, input, valueNode);
  }

  function makeSelectControl(bindingList, label, options) {
    const select = document.createElement("select");
    select.className = "tb-select";

    options.choices.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    });

    registerBinding(bindingList, options.getValue, select, null, null);
    select.addEventListener("change", () => options.onChange(select.value));

    return makeControlRow(label, select, null);
  }

  function makeColorControl(bindingList, label, options) {
    const input = document.createElement("input");
    input.type = "color";
    input.className = "tb-color";

    const valueNode = document.createElement("span");
    valueNode.className = "tb-control-value";

    registerBinding(bindingList, options.getValue, input, valueNode, options.format || ((value) => String(value).toUpperCase()));
    input.addEventListener("input", () => options.onInput(input.value));
    input.addEventListener("change", () => options.onChange(input.value));

    return makeControlRow(label, input, valueNode);
  }

  function makeTextControl(bindingList, label, options) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tb-text-input";
    input.placeholder = options.placeholder || "";

    registerBinding(bindingList, options.getValue, input, null, null);
    input.addEventListener("input", () => options.onInput(input.value));
    input.addEventListener("change", () => options.onChange(input.value));

    return makeControlRow(label, input, null);
  }

  function makePasswordControl(bindingList, label, options) {
    const input = document.createElement("input");
    input.type = "password";
    input.className = "tb-text-input";
    input.placeholder = options.placeholder || "";

    registerBinding(bindingList, options.getValue, input, null, null);
    input.addEventListener("input", () => options.onInput(input.value));
    input.addEventListener("change", () => options.onChange(input.value));

    return makeControlRow(label, input, null);
  }

  function makeNumberControl(bindingList, label, options) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "tb-text-input";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);

    const valueNode = document.createElement("span");
    valueNode.className = "tb-control-value";

    registerBinding(bindingList, options.getValue, input, valueNode, options.format || null);
    input.addEventListener("input", () => options.onInput(Number(input.value)));
    input.addEventListener("change", () => options.onChange(Number(input.value)));

    return makeControlRow(label, input, valueNode);
  }

  function makeTextareaControl(bindingList, label, options) {
    const input = document.createElement("textarea");
    input.className = "tb-textarea";
    input.rows = options.rows || 4;
    input.placeholder = options.placeholder || "";

    registerBinding(bindingList, options.getValue, input, null, null);
    input.addEventListener("input", () => options.onInput(input.value));
    input.addEventListener("change", () => options.onChange(input.value));

    return makeControlRow(label, input, null);
  }

  function registerBinding(bindingList, getValue, input, valueNode, format) {
    bindingList.push({
      getValue,
      input,
      valueNode,
      format
    });
  }

  function syncLayoutControlBindings() {
    syncControlBindings(state.layoutControlBindings);
  }

  function syncTrackControlBindings(trackId) {
    syncControlBindings(state.trackControlBindings[trackId] || []);
  }

  function syncControlBindings(bindings) {
    bindings.forEach((binding) => {
      syncBoundControl(binding, binding.getValue());
    });
  }

  function syncBoundControl(binding, value) {
    const isFocusedTextField = document.activeElement === binding.input &&
      (binding.input.tagName === "INPUT" || binding.input.tagName === "TEXTAREA");

    if (!isFocusedTextField) {
      binding.input.value = String(value ?? "");
    }

    if (binding.valueNode) {
      binding.valueNode.textContent = binding.format ? binding.format(value) : String(value ?? "");
    }
  }

  function refreshActionButtons() {
    const { retryButton, hideButton } = state.actionButtons;
    if (!retryButton || !hideButton) {
      return;
    }

    retryButton.textContent = "清空缓存并重载";
    retryButton.title = state.currentSubtitleUrl || state.lastDetectedSubtitleUrl
      ? "清空已缓存的译文，并重新请求当前字幕文件"
      : "清空已缓存的译文，等待自动检测到字幕文件";

    hideButton.textContent = "收起面板";
    hideButton.title = "隐藏面板，只保留启动按钮";
  }

  function toggleLayoutSection() {
    state.settings.layoutPanelOpen = !state.settings.layoutPanelOpen;
    saveSettings();
    refreshLayoutSectionState();
  }

  function refreshLayoutSectionState() {
    const section = state.layoutSectionNode;
    const body = state.layoutSectionBodyNode;
    const toggleButton = state.layoutSectionToggleButton;
    if (!section || !body || !toggleButton) {
      return;
    }

    const open = Boolean(state.settings.layoutPanelOpen);
    section.classList.toggle("tb-panel-section-open", open);
    body.classList.toggle("tb-hidden", !open);
    toggleButton.textContent = open ? "收起" : "展开";
    toggleButton.title = open ? "收起全局布局设置" : "展开全局布局设置";
  }

  function refreshAllTrackCardHeaders() {
    TRACK_ORDER.forEach((trackId) => refreshTrackCardHeader(trackId));
  }

  function refreshBatchMetricsFooter() {
    MODEL_TRACK_IDS.forEach((trackId) => {
      const node = state.batchMetricNodes[trackId];
      if (!node) {
        return;
      }

      const summary = formatBatchMetricsFooterSummary(trackId);
      node.textContent = summary.text;
      node.title = summary.title;
    });
  }

  function formatBatchMetricsFooterSummary(trackId) {
    const metrics = getTrackOpenAIBatchMetrics(trackId);
    const attempts = metrics.attempts;

    if (!attempts) {
      if (metrics.singleRequests) {
        return {
          text: `当前仅单句 ${metrics.singleRequests} 次`,
          title: `尚未触发多句批次翻译，单句请求 ${metrics.singleRequests} 次`
        };
      }

      return {
        text: "暂无数据",
        title: "尚未发起批次翻译"
      };
    }

    return {
      text: `${formatPercent(metrics.successes, attempts)} (${metrics.successes}/${attempts})`,
      title: `批次成功 ${metrics.successes}/${attempts}，回退 ${metrics.fallbacks} 次，单句 ${metrics.singleRequests} 次`
    };
  }

  function refreshTrackCardHeader(trackId) {
    const card = state.trackCardNodes[trackId];
    const statusNode = state.trackCardStatusNodes[trackId];
    const toggleButton = state.trackToggleButtons[trackId];
    const expandButton = state.trackExpandButtons[trackId];
    const testButton = state.trackTestButtons[trackId];
    const track = state.settings.tracks[trackId];

    if (!card || !statusNode || !toggleButton || !expandButton || !track) {
      return;
    }

    const status = computeTrackStatus(trackId);
    statusNode.textContent = status.text;
    statusNode.title = status.title;

    toggleButton.textContent = track.enabled ? "关闭" : "开启";
    toggleButton.title = track.enabled ? `关闭 ${TRACK_META[trackId].label}` : `开启 ${TRACK_META[trackId].label}`;

    expandButton.textContent = state.openCards.has(trackId) ? "收起" : "展开";
    expandButton.title = state.openCards.has(trackId) ? `收起 ${TRACK_META[trackId].label} 配置` : `展开 ${TRACK_META[trackId].label} 配置`;

    card.classList.toggle("tb-track-card-enabled", track.enabled);
    card.classList.toggle("tb-track-card-open", state.openCards.has(trackId));

    if (testButton) {
      const pending = state.trackRuntimes[trackId].testPending;
      testButton.disabled = pending;
      testButton.textContent = pending ? "测试中..." : "测试接口";
    }
  }

  function computeTrackStatus(trackId) {
    const track = state.settings.tracks[trackId];
    const runtime = state.trackRuntimes[trackId];

    if (!track.enabled) {
      return {
        text: "已关闭",
        title: `${TRACK_META[trackId].label} 当前不会显示`
      };
    }

    if (trackId === "source") {
      if (!state.cues.length) {
        return {
          text: "等待字幕",
          title: "等待自动检测字幕文件"
        };
      }

      if (state.activeCueIndex === -1) {
        return {
          text: `已载入 ${state.cues.length} 条`,
          title: `已载入 ${state.cues.length} 条原始字幕`
        };
      }

      return {
        text: state.renderedTrackTexts.source ? "显示中" : "待显示",
        title: state.renderedTrackTexts.source ? "当前原文字幕正在显示" : "当前时间点没有原文字幕可显示"
      };
    }

    if (runtime.testPending) {
      return {
        text: "测试中",
        title: "正在测试模型接口"
      };
    }

    const configError = isModelTrack(trackId) ? getTrackOpenAIConfigError(trackId) : "";
    if (configError) {
      return {
        text: "未配置",
        title: configError
      };
    }

    if (!state.cues.length) {
      return {
        text: "等待字幕",
        title: "等待自动检测字幕文件"
      };
    }

    if (runtime.inFlight) {
      return {
        text: "翻译中",
        title: "正在按播放进度翻译附近字幕"
      };
    }

    if (runtime.lastError) {
      return {
        text: "请求失败",
        title: runtime.lastError
      };
    }

    if (state.activeCueIndex !== -1 && state.renderedTrackTexts[trackId]) {
      return {
        text: "显示中",
        title: `当前 ${TRACK_META[trackId].label} 正在显示`
      };
    }

    return {
      text: "待翻译",
      title: "已启用，将按播放进度逐步翻译"
    };
  }

  function getTrackMetaText(trackId) {
    if (trackId === "source") {
      return "直接显示捕获到的原始字幕";
    }

    if (trackId === "google") {
      return "内置 Google Translate，固定翻译为简体中文";
    }

    return "OpenAI-compatible 模型接口，固定翻译为简体中文";
  }

  function toggleTrackCard(trackId) {
    if (state.openCards.has(trackId)) {
      state.openCards.delete(trackId);
    } else {
      state.openCards.add(trackId);
    }

    updateTrackCardOpenState(trackId);
    refreshTrackCardHeader(trackId);
  }

  function updateTrackCardOpenState(trackId) {
    const body = state.trackCardBodyNodes[trackId];
    if (!body) {
      return;
    }

    body.classList.toggle("tb-hidden", !state.openCards.has(trackId));
  }

  function applyLayoutSetting(key, value, deferSave) {
    state.settings.layout[key] = normalizeLayoutValue(key, value);

    if (deferSave) {
      scheduleSettingsSave();
    } else {
      saveSettings();
    }

    syncLayoutControlBindings();
    applySubtitleStyles();
    syncOverlayLayout();
    state.cueKey = "";
    renderActiveCue();
  }

  function applyTrackStyleSetting(trackId, key, value, deferSave) {
    state.settings.tracks[trackId].style[key] = normalizeTrackStyleValue(key, value);

    if (deferSave) {
      scheduleSettingsSave();
    } else {
      saveSettings();
    }

    syncTrackControlBindings(trackId);
    applySubtitleStyles();
    syncOverlayLayout();
    state.cueKey = "";
    renderActiveCue();
  }

  function applyModelSetting(trackId, key, value, deferSave, retranslate) {
    const track = state.settings.tracks[trackId];
    track[key] = normalizeModelSettingValue(key, value);

    if (deferSave) {
      scheduleSettingsSave();
    } else {
      saveSettings();
    }

    syncTrackControlBindings(trackId);
    refreshTrackCardHeader(trackId);

    if (!retranslate) {
      return;
    }

    resetTrackTranslationRuntime(trackId);
    state.cueKey = "";
    renderActiveCue();

    const configError = getTrackOpenAIConfigError(trackId);
    if (configError) {
      setStatus(`${TRACK_META[trackId].label} 配置不完整：${configError}`);
      refreshTrackCardHeader(trackId);
      return;
    }

    setStatus(`${TRACK_META[trackId].label} 配置已更新`);

    if (track.enabled && state.cues.length) {
      pumpTrackProgressiveTranslation(trackId);
    }
  }

  function toggleTrackEnabled(trackId) {
    const track = state.settings.tracks[trackId];
    track.enabled = !track.enabled;
    saveSettings();

    if (trackId !== "source") {
      resetTrackTranslationRuntime(trackId);
    }

    state.cueKey = "";
    renderActiveCue();
    refreshTrackCardHeader(trackId);

    if (!track.enabled) {
      setStatus(`${TRACK_META[trackId].label} 已关闭`);
      return;
    }

    if (trackId === "source") {
      setStatus("源字幕已开启");
      return;
    }

    const configError = isModelTrack(trackId) ? getTrackOpenAIConfigError(trackId) : "";
    if (configError) {
      setStatus(`${TRACK_META[trackId].label} 已开启，但尚未配置完成`);
      refreshTrackCardHeader(trackId);
      return;
    }

    setStatus(`${TRACK_META[trackId].label} 已开启`);

    if (state.cues.length) {
      pumpTrackProgressiveTranslation(trackId);
    }
  }

  function testModelTrack(trackId) {
    if (!isModelTrack(trackId)) {
      return;
    }

    const runtime = state.trackRuntimes[trackId];
    if (runtime.testPending) {
      return;
    }

    const configError = getTrackOpenAIConfigError(trackId);
    if (configError) {
      setStatus(`${TRACK_META[trackId].label} 配置不完整：${configError}`);
      refreshTrackCardHeader(trackId);
      return;
    }

    const sampleText = String(state.settings.tracks[trackId].testText || "").trim();
    if (!sampleText) {
      setStatus(`${TRACK_META[trackId].label} 需要先填写测试文本`);
      return;
    }

    setTrackTestPending(trackId, true);
    setStatus(`正在测试 ${TRACK_META[trackId].label} 接口...`);

    void (async () => {
      try {
        const translated = normalizeTranslation(await translateSingleTextWithOpenAI(trackId, sampleText));
        setStatus(`${TRACK_META[trackId].label} 测试成功：${summarizeStatusText(translated, 80)}`);
      } catch (error) {
        setStatus(`${TRACK_META[trackId].label} 测试失败：${error.message}`);
        state.trackRuntimes[trackId].lastError = error.message;
      } finally {
        setTrackTestPending(trackId, false);
        refreshTrackCardHeader(trackId);
      }
    })();
  }

  function setTrackTestPending(trackId, pending) {
    state.trackRuntimes[trackId].testPending = pending;
    refreshTrackCardHeader(trackId);
  }

  function togglePanelCollapsed() {
    setPanelCollapsed(!state.settings.panelCollapsed, true);
  }

  function openPanel() {
    setPanelCollapsed(false, true);
  }

  function collapsePanel() {
    setPanelCollapsed(true, true);
  }

  function setPanelCollapsed(collapsed, persist) {
    state.settings.panelCollapsed = collapsed;

    if (state.panelNode) {
      state.panelNode.classList.toggle("tb-hidden", collapsed);
    }

    if (state.panelToggleNode) {
      state.panelToggleNode.classList.toggle("tb-hidden", !collapsed);
      state.panelToggleNode.title = collapsed ? "打开字幕面板" : "字幕面板已展开";
    }

    if (persist) {
      saveSettings();
    }
  }

  function clearCacheAndReloadSubtitle() {
    const url = state.currentSubtitleUrl || state.lastDetectedSubtitleUrl;
    clearTranslationCache();
    resetAllTrackTranslationRuntimes();
    state.cueKey = "";
    renderActiveCue();
    refreshAllTrackCardHeaders();

    if (!url) {
      setStatus("已清空翻译缓存，等待检测字幕地址");
      return;
    }

    loadSubtitleFromUrl(url, "清空缓存后重新载入");
  }

  function trapPanelEvents(node) {
    ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "keydown", "keypress", "keyup"].forEach((eventName) => {
      node.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
  }

  function bindKeyboardEventGuard() {
    const guardTargets = [window, document];
    ["keydown", "keypress", "keyup"].forEach((eventName) => {
      guardTargets.forEach((target) => {
        target.addEventListener(eventName, (event) => {
          if (!isOverlayKeyboardTarget(event.target)) {
            return;
          }

          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
        }, true);
      });
    });
  }

  function isOverlayKeyboardTarget(target) {
    if (!state.overlayRoot || !(target instanceof Node)) {
      return false;
    }

    return state.overlayRoot.contains(target);
  }

  function syncOverlayLayout() {
    if (!state.video || !state.host || !state.overlayRoot || !state.subtitleBox) {
      return;
    }

    const videoRect = state.video.getBoundingClientRect();
    const hostRect = state.host.getBoundingClientRect();

    if (videoRect.width < 120 || videoRect.height < 80) {
      state.overlayRoot.style.display = "none";
      return;
    }

    state.overlayRoot.style.display = "block";
    state.overlayRoot.style.left = `${Math.max(0, videoRect.left - hostRect.left)}px`;
    state.overlayRoot.style.top = `${Math.max(0, videoRect.top - hostRect.top)}px`;
    state.overlayRoot.style.width = `${videoRect.width}px`;
    state.overlayRoot.style.height = `${videoRect.height}px`;

    const fontSize = Math.max(18, Math.round(videoRect.width * 0.028 * state.settings.layout.fontScale));
    state.subtitleBox.style.paddingBottom = `${state.settings.layout.bottomOffsetPx}px`;

    TRACK_ORDER.forEach((trackId) => {
      const node = state.trackNodes[trackId];
      if (!node) {
        return;
      }

      node.style.fontSize = `${Math.round(fontSize * state.settings.tracks[trackId].style.scale)}px`;
    });
  }

  function applySubtitleStyles() {
    if (!state.subtitleBox) {
      return;
    }

    state.subtitleBox.style.gap = `${state.settings.layout.lineGapEm}em`;
    state.subtitleBox.style.textAlign = state.settings.layout.textAlign;
    state.subtitleBox.style.alignItems = mapTextAlignToFlexAlignment(state.settings.layout.textAlign);

    TRACK_ORDER.forEach((trackId) => {
      const node = state.trackNodes[trackId];
      if (!node) {
        return;
      }

      applyLineStyles(node, {
        widthPercent: state.settings.layout.maxWidthPercent,
        color: state.settings.tracks[trackId].style.color,
        bgColor: state.settings.tracks[trackId].style.bgColor,
        bgOpacity: state.settings.tracks[trackId].style.bgOpacity,
        fontWeight: state.settings.tracks[trackId].style.fontWeight
      });
    });
  }

  function applyLineStyles(node, options) {
    node.style.width = "fit-content";
    node.style.maxWidth = `${options.widthPercent}%`;
    node.style.color = options.color;
    node.style.background = hexToRgba(options.bgColor, options.bgOpacity);
    node.style.fontWeight = String(options.fontWeight);
  }

  function renderActiveCue() {
    if (!state.cues.length || !state.video) {
      clearRenderedCue();
      return;
    }

    const cueIndex = findCueIndex(state.video.currentTime);
    if (cueIndex === -1) {
      clearRenderedCue();
      return;
    }

    state.activeCueIndex = cueIndex;
    const cue = state.cues[cueIndex];
    const rendered = createTrackTextMap("");

    TRACK_ORDER.forEach((trackId) => {
      if (!state.settings.tracks[trackId].enabled) {
        return;
      }

      if (trackId === "source") {
        rendered.source = formatOriginalTextForDisplay(cue.text);
        return;
      }

      const cached = getCachedTranslation(trackId, cue.text);
      if (cached) {
        rendered[trackId] = formatTranslatedTextForDisplay(cached);
      }
    });

    const nextKey = `${cueIndex}|${TRACK_ORDER.map((trackId) => `${trackId}:${rendered[trackId]}`).join("|")}`;
    if (nextKey === state.cueKey) {
      return;
    }

    state.cueKey = nextKey;
    state.renderedTrackTexts = rendered;

    let hasVisibleTrack = false;
    TRACK_ORDER.forEach((trackId) => {
      const node = state.trackNodes[trackId];
      const text = rendered[trackId];
      node.textContent = text;
      node.style.display = text ? "block" : "none";
      hasVisibleTrack = hasVisibleTrack || Boolean(text);
    });

    state.subtitleBox.style.display = hasVisibleTrack ? "flex" : "none";
  }

  function clearRenderedCue() {
    if (!state.subtitleBox) {
      return;
    }

    if (state.cueKey === "" && state.subtitleBox.style.display === "none") {
      return;
    }

    state.cueKey = "";
    state.activeCueIndex = -1;
    state.renderedTrackTexts = createTrackTextMap("");

    TRACK_ORDER.forEach((trackId) => {
      const node = state.trackNodes[trackId];
      if (!node) {
        return;
      }

      node.textContent = "";
      node.style.display = "none";
    });

    state.subtitleBox.style.display = "none";
  }

  function findCueIndex(time) {
    let low = 0;
    let high = state.cues.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = state.cues[mid];

      if (time < cue.start) {
        high = mid - 1;
      } else if (time > cue.end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }

    return -1;
  }

  function patchFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }

    window.fetch = function patchedFetch(input, init) {
      const url = extractUrl(input);
      inspectSubtitleUrl(url);

      return originalFetch.call(this, input, init).then((response) => {
        inspectSubtitleUrl(response?.url || url);
        return response;
      });
    };
  }

  function patchXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      inspectSubtitleUrl(url);
      return originalOpen.apply(this, arguments);
    };
  }

  function extractUrl(input) {
    if (typeof input === "string") {
      return input;
    }

    if (input instanceof URL) {
      return input.toString();
    }

    if (input && typeof input.url === "string") {
      return input.url;
    }

    return "";
  }

  function inspectSubtitleUrl(url) {
    if (!url) {
      return;
    }

    const normalized = normalizeUrl(url);
    if (!normalized || !/\.(srt|vtt)(?:$|[?#])/i.test(normalized)) {
      return;
    }

    state.lastDetectedSubtitleUrl = normalized;
    refreshActionButtons();

    if (normalized === state.currentSubtitleUrl) {
      return;
    }

    loadSubtitleFromUrl(normalized, "自动检测");
  }

  async function loadSubtitleFromUrl(url, reason) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setStatus("字幕地址无效");
      return;
    }

    const token = ++state.sourceToken;
    resetAllTrackTranslationRuntimes();
    state.currentSubtitleUrl = normalized;
    state.lastDetectedSubtitleUrl = normalized;
    state.cues = [];
    state.cueKey = "";
    clearRenderedCue();
    refreshActionButtons();
    setStatus(`正在加载字幕（${reason}）`);

    try {
      const subtitleText = await requestText(normalized);
      if (token !== state.sourceToken) {
        return;
      }

      const cues = parseSubtitleText(subtitleText, normalized);
      if (!cues.length) {
        throw new Error("未找到可用字幕条目");
      }

      state.cues = cues;
      setStatus(`已载入 ${cues.length} 条字幕，正在按需翻译`);
      renderActiveCue();
      pumpProgressiveTranslation();
    } catch (error) {
      if (token !== state.sourceToken) {
        return;
      }

      state.currentSubtitleUrl = "";
      state.cues = [];
      clearRenderedCue();
      refreshActionButtons();
      setStatus(`字幕加载失败：${error.message}`);
      console.error("[TB] Subtitle load failed", error);
    }
  }

  function pumpProgressiveTranslation() {
    TRANSLATION_TRACK_IDS.forEach((trackId) => {
      pumpTrackProgressiveTranslation(trackId);
    });
  }

  function pumpTrackProgressiveTranslation(trackId) {
    const track = state.settings.tracks[trackId];
    const runtime = state.trackRuntimes[trackId];

    if (!track?.enabled || !state.cues.length || !state.video || runtime.inFlight) {
      return;
    }

    if (Date.now() < runtime.nextAttemptAt) {
      return;
    }

    const configError = isModelTrack(trackId) ? getTrackOpenAIConfigError(trackId) : "";
    if (configError) {
      return;
    }

    const batch = buildTrackProgressiveTranslationBatch(trackId, state.video.currentTime);
    if (!batch) {
      return;
    }

    void runTrackProgressiveTranslationBatch(trackId, batch, state.sourceToken, runtime.sessionToken);
  }

  function buildTrackProgressiveTranslationBatch(trackId, currentTime) {
    if (!state.cues.length) {
      return null;
    }

    const runtime = state.trackRuntimes[trackId];
    const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
    const anchorIndex = findTranslationAnchorIndex(safeTime);
    if (anchorIndex === -1) {
      return null;
    }

    const texts = [];
    const keys = [];
    const seenTexts = new Set();
    const startIndex = Math.max(0, anchorIndex - TRANSLATION_BACKTRACK_CUES);
    const horizonTime = Math.max(0, safeTime) + TRANSLATION_LOOKAHEAD_SECONDS;
    let batchSize = 0;
    let firstPendingCueStart = Number.POSITIVE_INFINITY;
    let hitBatchCharLimit = false;

    for (let index = startIndex; index < state.cues.length; index += 1) {
      const cue = state.cues[index];
      const cuesAhead = index - anchorIndex;
      const beyondTimeWindow = index > anchorIndex && cue.start > horizonTime;
      const beyondCueWindow = cuesAhead >= TRANSLATION_LOOKAHEAD_CUES;

      if (beyondTimeWindow && beyondCueWindow) {
        break;
      }

      const textForTranslation = normalizeCueTextForTranslation(cue.text);
      if (!shouldTranslate(textForTranslation) || seenTexts.has(textForTranslation)) {
        continue;
      }

      seenTexts.add(textForTranslation);

      const cacheKey = buildCacheKeyFromNormalizedText(trackId, textForTranslation);
      if (hasCachedTranslationByKey(cacheKey) || runtime.pendingKeys.has(cacheKey)) {
        continue;
      }

      firstPendingCueStart = Math.min(firstPendingCueStart, cue.start);

      const size = textForTranslation.length + 24;
      if (texts.length && batchSize + size > state.settings.batchChars) {
        hitBatchCharLimit = true;
        break;
      }

      texts.push(textForTranslation);
      keys.push(cacheKey);
      batchSize += size;
    }

    if (!texts.length) {
      return null;
    }

    if (!shouldDispatchProgressiveBatch({
      textCount: texts.length,
      currentTime: safeTime,
      firstPendingCueStart,
      hitBatchCharLimit
    })) {
      return null;
    }

    return {
      texts,
      keys,
      anchorTime: safeTime
    };
  }

  function shouldDispatchProgressiveBatch({ textCount, currentTime, firstPendingCueStart, hitBatchCharLimit }) {
    if (!textCount) {
      return false;
    }

    if (hitBatchCharLimit || textCount >= TRANSLATION_MIN_BATCH_CUES) {
      return true;
    }

    if (!Number.isFinite(firstPendingCueStart)) {
      return true;
    }

    return firstPendingCueStart <= currentTime + TRANSLATION_URGENT_LEAD_SECONDS;
  }

  function findTranslationAnchorIndex(time) {
    const activeIndex = findCueIndex(time);
    if (activeIndex !== -1) {
      return activeIndex;
    }

    let low = 0;
    let high = state.cues.length - 1;
    let result = state.cues.length;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (state.cues[mid].start < time) {
        low = mid + 1;
      } else {
        result = mid;
        high = mid - 1;
      }
    }

    return result < state.cues.length ? result : -1;
  }

  async function runTrackProgressiveTranslationBatch(trackId, batch, subtitleToken, runtimeToken) {
    const runtime = state.trackRuntimes[trackId];
    const jobId = ++runtime.jobSeq;
    runtime.inFlight = true;
    runtime.activeJobId = jobId;
    runtime.lastError = "";
    batch.keys.forEach((key) => runtime.pendingKeys.set(key, jobId));
    refreshTrackCardHeader(trackId);
    setStatus(`${TRACK_META[trackId].label} 正在翻译 ${batch.texts.length} 条字幕`);

    try {
      const translations = await translateBatch(trackId, batch.texts);
      if (subtitleToken !== state.sourceToken || runtime.sessionToken !== runtimeToken || runtime.activeJobId !== jobId) {
        return;
      }

      const now = Date.now();
      batch.texts.forEach((text, index) => {
        const translated = normalizeTranslation(translations[index] || "");
        if (!translated) {
          return;
        }

        state.cache[buildCacheKeyFromNormalizedText(trackId, text)] = {
          value: translated,
          updatedAt: now
        };
      });

      pruneCache();
      saveCache();
      renderActiveCue();
      setStatus(`${TRACK_META[trackId].label} 已更新至 ${formatPlaybackTime(batch.anchorTime)}`);
    } catch (error) {
      if (subtitleToken !== state.sourceToken || runtime.sessionToken !== runtimeToken || runtime.activeJobId !== jobId) {
        return;
      }

      runtime.lastError = error.message;
      runtime.nextAttemptAt = Date.now() + TRANSLATION_FAILURE_BACKOFF_MS;
      setStatus(`${TRACK_META[trackId].label} 翻译失败：${error.message}`);
      console.error(`[TB] ${trackId} translation failed`, error);
    } finally {
      batch.keys.forEach((key) => {
        if (runtime.pendingKeys.get(key) === jobId) {
          runtime.pendingKeys.delete(key);
        }
      });

      if (runtime.activeJobId === jobId) {
        runtime.inFlight = false;
        runtime.activeJobId = 0;
        runtime.nextAttemptAt = Math.max(runtime.nextAttemptAt, Date.now() + TRANSLATION_BATCH_COOLDOWN_MS);
      }

      refreshTrackCardHeader(trackId);
    }
  }

  function translateBatch(trackId, texts) {
    if (trackId === "google") {
      return translateWithGoogle(texts);
    }

    if (isModelTrack(trackId)) {
      return translateWithOpenAI(trackId, texts);
    }

    throw new Error(`Unsupported track: ${trackId}`);
  }

  async function translateWithGoogle(texts) {
    if (texts.length === 1) {
      return [await translateSingleText(texts[0])];
    }

    const sentinel = `__TB_SPLIT_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const joined = texts.join(`\n${sentinel}\n`);
    const translated = await translateSingleText(joined);
    const strictParts = translated.split(sentinel);

    if (strictParts.length === texts.length) {
      return strictParts.map((part) => part.trim());
    }

    const relaxed = translated.split(new RegExp(`\\s*${escapeRegExp(sentinel)}\\s*`, "g"));
    if (relaxed.length === texts.length) {
      return relaxed.map((part) => part.trim());
    }

    const fallback = [];
    for (const text of texts) {
      fallback.push(await translateSingleText(text));
      await sleep(80);
    }
    return fallback;
  }

  async function translateSingleText(text) {
    const body = new URLSearchParams();
    body.set("client", "gtx");
    body.set("sl", state.settings.sourceLang);
    body.set("tl", TARGET_LANG);
    body.set("dt", "t");
    body.set("dj", "1");
    body.set("q", text);

    const response = await requestRaw("https://translate.googleapis.com/translate_a/single", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      data: body.toString()
    });

    const payload = JSON.parse(response.responseText);
    if (Array.isArray(payload.sentences)) {
      return payload.sentences.map((item) => item.trans || "").join("");
    }

    if (Array.isArray(payload[0])) {
      return payload[0].map((item) => Array.isArray(item) ? (item[0] || "") : "").join("");
    }

    throw new Error("Google 返回结果格式异常");
  }

  async function translateWithOpenAI(trackId, texts) {
    if (!texts.length) {
      return [];
    }

    const metrics = getTrackOpenAIBatchMetrics(trackId);

    if (texts.length === 1) {
      metrics.singleRequests += 1;
      metrics.singleItemsTranslated += 1;
      refreshBatchMetricsFooter();
      return [await translateSingleTextWithOpenAI(trackId, texts[0])];
    }

    metrics.attempts += 1;
    metrics.itemsAttempted += texts.length;

    try {
      const translations = await translateBatchWithOpenAI(trackId, texts);
      metrics.successes += 1;
      metrics.itemsTranslatedInBatch += texts.length;
      refreshBatchMetricsFooter();
      logOpenAIBatchMetrics(trackId, metrics, "info", {
        outcome: "batch_success",
        batchSize: texts.length
      });
      return translations;
    } catch (error) {
      if (!shouldFallbackOpenAIBatch(error)) {
        metrics.hardFailures += 1;
        refreshBatchMetricsFooter();
        logOpenAIBatchMetrics(trackId, metrics, "error", {
          outcome: "batch_failed",
          batchSize: texts.length,
          error: error?.message || String(error)
        });
        throw error;
      }

      try {
        const translations = await translateWithOpenAISerial(trackId, texts);
        metrics.fallbacks += 1;
        metrics.fallbackSuccesses += 1;
        metrics.itemsTranslatedInFallback += texts.length;
        refreshBatchMetricsFooter();
        logOpenAIBatchMetrics(trackId, metrics, "warn", {
          outcome: "batch_fallback_serial_success",
          batchSize: texts.length,
          error: error?.message || String(error)
        });
        return translations;
      } catch (serialError) {
        metrics.fallbacks += 1;
        metrics.fallbackFailures += 1;
        refreshBatchMetricsFooter();
        logOpenAIBatchMetrics(trackId, metrics, "error", {
          outcome: "batch_fallback_serial_failed",
          batchSize: texts.length,
          error: error?.message || String(error),
          fallbackError: serialError?.message || String(serialError)
        });
        throw serialError;
      }
    }
  }

  async function translateWithOpenAISerial(trackId, texts) {
    const translations = [];

    for (const text of texts) {
      translations.push(await translateSingleTextWithOpenAI(trackId, text));
      if (texts.length > 1) {
        await sleep(80);
      }
    }

    return translations;
  }

  async function translateBatchWithOpenAI(trackId, texts) {
    const requestConfig = buildOpenAITranslationRequest(trackId, buildOpenAIBatchUserMessage(texts));
    const response = await requestRaw(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      data: requestConfig.data,
      timeout: requestConfig.timeout
    });

    return parseOpenAIBatchTranslationResponse(response.responseText, texts.length);
  }

  function shouldFallbackOpenAIBatch(error) {
    const message = error?.message || "";
    return message.startsWith("OpenAI batch response");
  }

  function getTrackOpenAIBatchMetrics(trackId) {
    const runtime = state.trackRuntimes[trackId];
    if (!runtime.batchMetrics) {
      runtime.batchMetrics = createOpenAIBatchMetrics();
    }
    return runtime.batchMetrics;
  }

  function logOpenAIBatchMetrics(trackId, metrics, level, details) {
    const logger = getConsoleLogger(level);
    logger(`[TB] ${trackId} batch translation`, {
      track: TRACK_META[trackId]?.label || trackId,
      ...details,
      stats: summarizeOpenAIBatchMetrics(metrics)
    });
  }

  function summarizeOpenAIBatchMetrics(metrics) {
    return {
      attempts: metrics.attempts,
      batchSuccesses: metrics.successes,
      fallbacks: metrics.fallbacks,
      hardFailures: metrics.hardFailures,
      fallbackSuccesses: metrics.fallbackSuccesses,
      fallbackFailures: metrics.fallbackFailures,
      batchSuccessRate: formatPercent(metrics.successes, metrics.attempts),
      fallbackRate: formatPercent(metrics.fallbacks, metrics.attempts),
      itemsAttempted: metrics.itemsAttempted,
      itemsTranslatedInBatch: metrics.itemsTranslatedInBatch,
      itemsTranslatedInFallback: metrics.itemsTranslatedInFallback,
      itemBatchCoverage: formatPercent(metrics.itemsTranslatedInBatch, metrics.itemsAttempted)
    };
  }

  function formatPercent(part, total) {
    if (!total) {
      return "0.0%";
    }

    return `${((part / total) * 100).toFixed(1)}%`;
  }

  function getConsoleLogger(level) {
    if (level === "error") {
      return console.error;
    }

    if (level === "warn") {
      return console.warn;
    }

    return console.info;
  }

  async function translateSingleTextWithOpenAI(trackId, text) {
    const requestConfig = buildOpenAITranslationRequest(trackId, buildOpenAIUserMessage(text));
    const response = await requestRaw(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      data: requestConfig.data,
      timeout: requestConfig.timeout
    });

    return parseOpenAITranslationResponse(response.responseText);
  }

  function buildOpenAITranslationRequest(trackId, userMessage) {
    const configError = getTrackOpenAIConfigError(trackId);
    if (configError) {
      throw new Error(configError);
    }

    const track = state.settings.tracks[trackId];
    return {
      url: track.apiUrl.trim(),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${track.apiKey.trim()}`
      },
      data: JSON.stringify({
        model: track.model.trim(),
        temperature: clamp(track.temperature, 0, 2),
        messages: [
          {
            role: "system",
            content: buildOpenAISystemMessage(trackId)
          },
          {
            role: "user",
            content: userMessage
          }
        ]
      }),
      timeout: clamp(track.timeoutMs, 5000, 120000)
    };
  }

  function buildOpenAISystemMessage(trackId) {
    const track = state.settings.tracks[trackId];
    const basePrompt = track.systemPrompt.trim() || createDefaultModelConfig().systemPrompt;
    return [
      basePrompt,
      "Follow the user's requested output format exactly."
    ].join("\n\n");
  }

  function buildOpenAIUserMessage(text) {
    return [
      "Translate the following subtitle text.",
      `Source language: ${state.settings.sourceLang}`,
      `Target language: ${TARGET_LANG}`,
      "",
      text
    ].join("\n");
  }

  function buildOpenAIBatchUserMessage(texts) {
    return [
      "Translate each subtitle item independently.",
      `Source language: ${state.settings.sourceLang}`,
      `Target language: ${TARGET_LANG}`,
      `Return only a JSON array of translated strings with exactly ${texts.length} items.`,
      "Rules:",
      "- Keep the same item order.",
      "- Do not merge, split, or skip items.",
      "- Preserve meaningful line breaks within each item.",
      "- Do not include markdown, comments, or code fences.",
      "",
      "Subtitle items JSON:",
      JSON.stringify(texts.map((text, index) => ({
        index: index + 1,
        text
      })), null, 2)
    ].join("\n");
  }

  function parseOpenAITranslationResponse(responseText) {
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`OpenAI 响应不是合法 JSON：${error.message}`);
    }

    if (payload?.error?.message) {
      throw new Error(payload.error.message);
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const text = readTextLikeValue(choice?.message?.content ?? choice?.text ?? "");
    if (!text.trim()) {
      throw new Error("OpenAI 翻译结果为空");
    }

    return text.trim();
  }

  function parseOpenAIBatchTranslationResponse(responseText, expectedCount) {
    const text = parseOpenAITranslationResponse(responseText);
    const payload = parseJsonValueFromText(text, "OpenAI batch response");

    if (!Array.isArray(payload)) {
      throw new Error("OpenAI batch response is not a JSON array");
    }

    if (payload.length !== expectedCount) {
      throw new Error(`OpenAI batch response size mismatch: expected ${expectedCount}, got ${payload.length}`);
    }

    return payload.map((item, index) => {
      const translated = readBatchTranslationItem(item).trim();
      if (!translated) {
        throw new Error(`OpenAI batch response item ${index + 1} is empty`);
      }
      return translated;
    });
  }

  function parseJsonValueFromText(text, label) {
    const normalized = stripMarkdownCodeFence(text.trim());
    const directCandidates = [text.trim(), normalized].filter(Boolean);

    for (const candidate of directCandidates) {
      try {
        return JSON.parse(candidate);
      } catch (error) {
        // Fall through.
      }
    }

    const extracted = extractFirstJsonArray(normalized);
    if (!extracted) {
      throw new Error(`${label} is not valid JSON`);
    }

    try {
      return JSON.parse(extracted);
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
  }

  function stripMarkdownCodeFence(text) {
    const match = text.match(/^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/);
    return match ? match[1].trim() : text;
  }

  function extractFirstJsonArray(text) {
    const start = text.indexOf("[");
    if (start === -1) {
      return "";
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (inString && char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "[") {
        depth += 1;
        continue;
      }

      if (char !== "]") {
        continue;
      }

      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }

    return "";
  }

  function readBatchTranslationItem(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("translation" in value) {
        return readTextLikeValue(value.translation);
      }

      if ("translated" in value) {
        return readTextLikeValue(value.translated);
      }

      if ("translatedText" in value) {
        return readTextLikeValue(value.translatedText);
      }

      if ("text" in value) {
        return readTextLikeValue(value.text);
      }

      if ("value" in value) {
        return readTextLikeValue(value.value);
      }
    }

    return readTextLikeValue(value);
  }

  function readTextLikeValue(value) {
    if (value == null) {
      return "";
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => readTextLikeValue(item)).join("");
    }

    if (typeof value === "object") {
      if (typeof value.text === "string") {
        return value.text;
      }

      if (typeof value.content === "string") {
        return value.content;
      }
    }

    return JSON.stringify(value);
  }

  function requestText(url) {
    return requestRaw(url, { method: "GET" }).then((response) => response.responseText);
  }

  function requestRaw(url, options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.data || null,
        timeout: options.timeout || 20000,
        onload: (response) => {
          if (response.status >= 200 && response.status < 400) {
            resolve(response);
            return;
          }
          reject(new Error(`HTTP ${response.status}`));
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timed out"))
      });
    });
  }

  function parseSubtitleText(rawText, urlHint) {
    const normalized = rawText.replace(/\ufeff/g, "").replace(/\r/g, "").trim();
    if (!normalized) {
      return [];
    }

    if (/^WEBVTT/m.test(normalized) || /\.vtt(?:$|[?#])/i.test(urlHint)) {
      return parseVtt(normalized);
    }

    return parseSrt(normalized);
  }

  function parseSrt(text) {
    const blocks = text.split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
      if (!lines.length) {
        continue;
      }

      const cue = parseCueBlock(lines);
      if (cue) {
        cues.push(cue);
      }
    }

    return cues;
  }

  function parseVtt(text) {
    const cleaned = text
      .split("\n")
      .filter((line) => !line.startsWith("WEBVTT"))
      .join("\n");

    const blocks = cleaned.split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
      if (!lines.length || lines[0] === "NOTE" || lines[0] === "STYLE" || lines[0] === "REGION") {
        continue;
      }

      const cue = parseCueBlock(lines);
      if (cue) {
        cues.push(cue);
      }
    }

    return cues;
  }

  function parseCueBlock(lines) {
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex === -1) {
      return null;
    }

    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(/^([\d:.,]+)\s+-->\s+([\d:.,]+)/);
    if (!match) {
      return null;
    }

    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }

    const text = sanitizeCueText(lines.slice(timeLineIndex + 1).join("\n"));
    if (!text) {
      return null;
    }

    return { start, end, text };
  }

  function parseTimestamp(raw) {
    const parts = raw.trim().replace(",", ".").split(":");
    if (parts.length < 2 || parts.length > 3) {
      return NaN;
    }

    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    if (parts.length === 3) {
      hours = Number(parts[0]);
      minutes = Number(parts[1]);
      seconds = Number(parts[2]);
    } else {
      minutes = Number(parts[0]);
      seconds = Number(parts[1]);
    }

    if (![hours, minutes, seconds].every(Number.isFinite)) {
      return NaN;
    }

    return (hours * 3600) + (minutes * 60) + seconds;
  }

  function sanitizeCueText(text) {
    const temp = document.createElement("div");
    temp.innerHTML = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n");

    return temp.textContent
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function resetAllTrackTranslationRuntimes() {
    TRANSLATION_TRACK_IDS.forEach((trackId) => resetTrackTranslationRuntime(trackId));
  }

  function resetTrackTranslationRuntime(trackId) {
    const runtime = state.trackRuntimes[trackId];
    if (!runtime) {
      return;
    }

    runtime.inFlight = false;
    runtime.activeJobId = 0;
    runtime.pendingKeys.clear();
    runtime.nextAttemptAt = 0;
    runtime.lastError = "";
    runtime.batchMetrics = createOpenAIBatchMetrics();
    runtime.sessionToken += 1;
    refreshTrackCardHeader(trackId);
    refreshBatchMetricsFooter();
  }

  function shouldTranslate(text) {
    return /[\p{L}\p{N}]/u.test(text);
  }

  function getCachedTranslation(trackId, text) {
    const entry = state.cache[buildCacheKey(trackId, text)];
    if (!entry) {
      return "";
    }

    entry.updatedAt = Date.now();
    return entry.value;
  }

  function hasCachedTranslationByKey(cacheKey) {
    return Boolean(state.cache[cacheKey]?.value);
  }

  function buildCacheKey(trackId, text) {
    return buildCacheKeyFromNormalizedText(trackId, normalizeCueTextForTranslation(text));
  }

  function buildCacheKeyFromNormalizedText(trackId, text) {
    return `${getTranslationProfileCacheKey(trackId)}::${state.settings.sourceLang}::${TARGET_LANG}::${text}`;
  }

  function getTranslationProfileCacheKey(trackId) {
    if (trackId === "google") {
      return "google-free";
    }

    const track = state.settings.tracks[trackId];
    const fingerprint = JSON.stringify({
      trackId,
      apiUrl: track.apiUrl,
      model: track.model,
      systemPrompt: track.systemPrompt,
      temperature: track.temperature,
      timeoutMs: track.timeoutMs
    });

    return `openai-compatible:${trackId}:${hashString(fingerprint)}`;
  }

  function pruneCache() {
    const keys = Object.keys(state.cache);
    if (keys.length <= MAX_CACHE_ENTRIES) {
      return;
    }

    keys
      .sort((left, right) => (state.cache[left].updatedAt || 0) - (state.cache[right].updatedAt || 0))
      .slice(0, keys.length - MAX_CACHE_ENTRIES)
      .forEach((key) => {
        delete state.cache[key];
      });
  }

  function syncNativeCaptionVisibility() {
    document.documentElement?.classList.toggle("tb-hide-native-captions", Boolean(state.settings.hideNativeTracks));

    if (!state.settings.hideNativeTracks || !state.video || !state.video.textTracks) {
      return;
    }

    for (const track of state.video.textTracks) {
      try {
        if (track.mode !== "disabled") {
          track.mode = "hidden";
        }
      } catch (error) {
        console.debug("[TB] Failed to hide native text track", error);
      }
    }
  }

  function setStatus(message) {
    state.statusText = message;
    if (state.statusNode) {
      state.statusNode.textContent = message;
      state.statusNode.title = message;
    }
  }

  function mapTextAlignToFlexAlignment(textAlign) {
    if (textAlign === "left") {
      return "flex-start";
    }

    if (textAlign === "right") {
      return "flex-end";
    }

    return "center";
  }

  function formatOriginalTextForDisplay(text) {
    const normalizedText = normalizeCueLineBreaksForDisplay(text);

    if (state.settings.layout.originalCaseMode !== "smart") {
      return normalizedText;
    }

    return normalizedText
      .split("\n")
      .map((line) => normalizeUppercaseLine(line))
      .join("\n");
  }

  function formatTranslatedTextForDisplay(text) {
    return normalizeCueLineBreaksForDisplay(text);
  }

  function normalizeCueLineBreaksForDisplay(text) {
    if (!text || state.settings.layout.lineBreakMode !== "smart") {
      return text;
    }

    return text
      .split(/\n{2,}/)
      .map((block) => normalizeCueBlockLines(block))
      .join("\n\n");
  }

  function normalizeCueTextForTranslation(text) {
    if (!text) {
      return text;
    }

    return text
      .split(/\n{2,}/)
      .map((block) => normalizeCueBlockLines(block))
      .join("\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function normalizeCueBlockLines(block) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) {
      return lines[0] || "";
    }

    if (shouldPreserveMultiLineBlock(lines)) {
      return lines.join("\n");
    }

    return lines.join(" ").replace(/\s+/g, " ").trim();
  }

  function shouldPreserveMultiLineBlock(lines) {
    if (lines.length < 2) {
      return false;
    }

    const dialogueLines = lines.filter((line) => /^\s*[-–—]/.test(line));
    return dialogueLines.length >= 2;
  }

  function normalizeUppercaseLine(line) {
    const speakerParts = splitSpeakerCueLine(line);
    if (speakerParts && /[a-z]/.test(speakerParts.prefix) && shouldNormalizeUppercaseLine(speakerParts.body)) {
      return `${speakerParts.prefix}${speakerParts.spacing}${normalizeUppercaseText(speakerParts.body)}`;
    }

    if (!shouldNormalizeUppercaseLine(line)) {
      return line;
    }

    return normalizeUppercaseText(line);
  }

  function splitSpeakerCueLine(line) {
    const match = line.match(/^([^:\n]{1,60}:)(\s*)(.+)$/);
    if (!match) {
      return null;
    }

    return {
      prefix: match[1],
      spacing: match[2],
      body: match[3]
    };
  }

  function normalizeUppercaseText(text) {
    let normalized = text.toLowerCase();
    normalized = normalized.replace(/\bi(?=(?:['’][a-z]+)?\b)/g, "I");
    normalized = normalized.replace(/(^|[.!?:]\s+|[\[(]\s*|["“]\s*)([a-z])/g, (match, prefix, char) => `${prefix}${char.toUpperCase()}`);
    return normalized;
  }

  function shouldNormalizeUppercaseLine(line) {
    const letters = line.match(/[A-Za-z]/g);
    if (!letters || letters.length < 4) {
      return false;
    }

    if (/[a-z]/.test(line)) {
      return false;
    }

    const uppercase = line.match(/[A-Z]/g) || [];
    return uppercase.length / letters.length >= 0.9;
  }

  function loadSettings() {
    const rawV2 = GM_getValue(SETTINGS_KEY, null);
    if (rawV2 && typeof rawV2 === "object" && rawV2.tracks) {
      return normalizeSettings(rawV2);
    }

    const rawLegacy = GM_getValue(LEGACY_SETTINGS_KEY, null);
    if (rawLegacy && typeof rawLegacy === "object") {
      migratedLegacySettings = true;
      return migrateLegacySettings(rawLegacy);
    }

    return createDefaultSettings();
  }

  function normalizeSettings(raw) {
    const defaults = createDefaultSettings();

    return {
      sourceLang: normalizeSourceLang(raw.sourceLang ?? defaults.sourceLang),
      hideNativeTracks: typeof raw.hideNativeTracks === "boolean" ? raw.hideNativeTracks : defaults.hideNativeTracks,
      batchChars: clamp(raw.batchChars ?? defaults.batchChars, 200, 3000),
      panelCollapsed: typeof raw.panelCollapsed === "boolean" ? raw.panelCollapsed : defaults.panelCollapsed,
      layoutPanelOpen: typeof raw.layoutPanelOpen === "boolean" ? raw.layoutPanelOpen : defaults.layoutPanelOpen,
      layout: normalizeLayout(raw.layout, defaults.layout),
      tracks: {
        source: normalizeTrack(raw.tracks?.source, defaults.tracks.source, "source"),
        google: normalizeTrack(raw.tracks?.google, defaults.tracks.google, "google"),
        model1: normalizeTrack(raw.tracks?.model1, defaults.tracks.model1, "model1"),
        model2: normalizeTrack(raw.tracks?.model2, defaults.tracks.model2, "model2")
      }
    };
  }

  function migrateLegacySettings(raw) {
    const defaults = createDefaultSettings();
    const legacyEngine = parseLegacyEngine(raw.engine);
    const translationEnabled = raw.showTranslation !== false;
    const translationStyle = {
      scale: clamp(raw.translationScale ?? defaults.tracks.google.style.scale, 0.7, 1.8),
      color: normalizeHexColor(raw.translationColor ?? defaults.tracks.google.style.color, defaults.tracks.google.style.color),
      bgColor: normalizeHexColor(raw.translationBgColor ?? defaults.tracks.google.style.bgColor, defaults.tracks.google.style.bgColor),
      bgOpacity: clamp(raw.translationBgOpacity ?? defaults.tracks.google.style.bgOpacity, 0, 1),
      fontWeight: normalizeFontWeight(raw.translationFontWeight ?? defaults.tracks.google.style.fontWeight)
    };

    const migrated = createDefaultSettings();
    migrated.sourceLang = normalizeSourceLang(raw.sourceLang ?? defaults.sourceLang);
    migrated.hideNativeTracks = typeof raw.hideNativeTracks === "boolean" ? raw.hideNativeTracks : defaults.hideNativeTracks;
    migrated.batchChars = clamp(raw.batchChars ?? defaults.batchChars, 200, 3000);
    migrated.panelCollapsed = typeof raw.panelCollapsed === "boolean" ? raw.panelCollapsed : defaults.panelCollapsed;
    migrated.layoutPanelOpen = true;
    migrated.layout = normalizeLayout({
      fontScale: raw.fontScale,
      bottomOffsetPx: raw.bottomOffsetPx,
      maxWidthPercent: raw.maxWidthPercent,
      lineGapEm: raw.lineGapEm,
      textAlign: raw.textAlign,
      lineBreakMode: raw.lineBreakMode,
      originalCaseMode: raw.originalCaseMode
    }, defaults.layout);

    migrated.tracks.source.enabled = raw.showOriginal !== false;
    migrated.tracks.source.style = normalizeTrackStyle({
      scale: raw.originalScale,
      color: raw.originalColor,
      bgColor: raw.originalBgColor,
      bgOpacity: raw.originalBgOpacity,
      fontWeight: raw.originalFontWeight
    }, defaults.tracks.source.style);

    migrated.tracks.google.enabled = translationEnabled && legacyEngine !== "openai-compatible";
    migrated.tracks.google.style = normalizeTrackStyle(translationStyle, defaults.tracks.google.style);

    migrated.tracks.model1.enabled = translationEnabled && legacyEngine === "openai-compatible";
    migrated.tracks.model1.style = normalizeTrackStyle(translationStyle, defaults.tracks.model1.style);
    migrated.tracks.model1.apiUrl = String(raw.openaiApiUrl ?? raw.customTranslateUrl ?? defaults.tracks.model1.apiUrl).trim();
    migrated.tracks.model1.apiKey = String(raw.openaiApiKey ?? defaults.tracks.model1.apiKey).trim();
    migrated.tracks.model1.model = String(raw.openaiModel ?? defaults.tracks.model1.model).trim();
    migrated.tracks.model1.systemPrompt = String(raw.openaiSystemPrompt ?? defaults.tracks.model1.systemPrompt);
    migrated.tracks.model1.temperature = clamp(raw.openaiTemperature ?? defaults.tracks.model1.temperature, 0, 2);
    migrated.tracks.model1.timeoutMs = clamp(raw.openaiTimeoutMs ?? raw.customTranslateTimeoutMs ?? defaults.tracks.model1.timeoutMs, 5000, 120000);
    migrated.tracks.model1.testText = String(raw.openaiTestText ?? defaults.tracks.model1.testText);

    migrated.tracks.model2.enabled = false;
    migrated.tracks.model2.style = normalizeTrackStyle(translationStyle, defaults.tracks.model2.style);

    return migrated;
  }

  function saveSettings() {
    if (state.settingsSaveId) {
      window.clearTimeout(state.settingsSaveId);
      state.settingsSaveId = 0;
    }

    GM_setValue(SETTINGS_KEY, state.settings);
  }

  function scheduleSettingsSave() {
    if (state.settingsSaveId) {
      window.clearTimeout(state.settingsSaveId);
    }

    state.settingsSaveId = window.setTimeout(() => {
      state.settingsSaveId = 0;
      GM_setValue(SETTINGS_KEY, state.settings);
    }, 120);
  }

  function loadCache() {
    const value = GM_getValue(CACHE_KEY, {});
    return (value && typeof value === "object") ? value : {};
  }

  function clearTranslationCache() {
    state.cache = {};
    saveCache();
  }

  function saveCache() {
    GM_setValue(CACHE_KEY, state.cache);
  }

  function createDefaultSettings() {
    return {
      sourceLang: "auto",
      hideNativeTracks: true,
      batchChars: 900,
      panelCollapsed: true,
      layoutPanelOpen: true,
      layout: {
        fontScale: 1,
        bottomOffsetPx: 82,
        maxWidthPercent: 88,
        lineGapEm: 0.35,
        textAlign: "center",
        lineBreakMode: "smart",
        originalCaseMode: "smart"
      },
      tracks: {
        source: {
          enabled: true,
          style: createTrackStyle({
            scale: 1,
            color: "#FFFFFF",
            bgColor: "#000000",
            bgOpacity: 0.58,
            fontWeight: 700
          })
        },
        google: {
          enabled: true,
          style: createTrackStyle({
            scale: 0.92,
            color: "#FFE082",
            bgColor: "#000000",
            bgOpacity: 0.58,
            fontWeight: 600
          })
        },
        model1: createModelTrack({
          enabled: false,
          style: createTrackStyle({
            scale: 0.92,
            color: "#8BD6FF",
            bgColor: "#00131E",
            bgOpacity: 0.58,
            fontWeight: 600
          })
        }),
        model2: createModelTrack({
          enabled: false,
          style: createTrackStyle({
            scale: 0.92,
            color: "#FFB1CC",
            bgColor: "#1E0011",
            bgOpacity: 0.58,
            fontWeight: 600
          })
        })
      }
    };
  }

  function createModelTrack(overrides) {
    const config = createDefaultModelConfig();
    return {
      enabled: Boolean(overrides.enabled),
      style: normalizeTrackStyle(overrides.style, createTrackStyle({
        scale: 0.92,
        color: "#FFE082",
        bgColor: "#000000",
        bgOpacity: 0.58,
        fontWeight: 600
      })),
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: config.systemPrompt,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      testText: config.testText
    };
  }

  function createDefaultModelConfig() {
    return {
      apiUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      model: "",
      systemPrompt: "You are a subtitle translator. Translate the subtitle text faithfully into the target language. Follow the requested output format exactly.",
      temperature: 0,
      timeoutMs: 30000,
      testText: "Hello. This is a subtitle translation test."
    };
  }

  function createTrackStyle(values) {
    return {
      scale: values.scale,
      color: values.color,
      bgColor: values.bgColor,
      bgOpacity: values.bgOpacity,
      fontWeight: values.fontWeight
    };
  }

  function normalizeLayout(raw, defaults) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      fontScale: clamp(source.fontScale ?? defaults.fontScale, 0.7, 1.8),
      bottomOffsetPx: clamp(source.bottomOffsetPx ?? defaults.bottomOffsetPx, 0, 180),
      maxWidthPercent: clamp(source.maxWidthPercent ?? defaults.maxWidthPercent, 60, 100),
      lineGapEm: clamp(source.lineGapEm ?? defaults.lineGapEm, 0, 1.2),
      textAlign: normalizeTextAlign(source.textAlign ?? defaults.textAlign),
      lineBreakMode: normalizeLineBreakMode(source.lineBreakMode ?? defaults.lineBreakMode),
      originalCaseMode: normalizeOriginalCaseMode(source.originalCaseMode ?? defaults.originalCaseMode)
    };
  }

  function normalizeTrack(raw, defaults, trackId) {
    const source = raw && typeof raw === "object" ? raw : {};
    const normalized = {
      enabled: typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
      style: normalizeTrackStyle(source.style, defaults.style)
    };

    if (isModelTrack(trackId)) {
      normalized.apiUrl = String(source.apiUrl ?? defaults.apiUrl).trim();
      normalized.apiKey = String(source.apiKey ?? defaults.apiKey).trim();
      normalized.model = String(source.model ?? defaults.model).trim();
      normalized.systemPrompt = String(source.systemPrompt ?? defaults.systemPrompt);
      normalized.temperature = clamp(source.temperature ?? defaults.temperature, 0, 2);
      normalized.timeoutMs = clamp(source.timeoutMs ?? defaults.timeoutMs, 5000, 120000);
      normalized.testText = String(source.testText ?? defaults.testText);
    }

    return normalized;
  }

  function normalizeTrackStyle(raw, defaults) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      scale: clamp(source.scale ?? defaults.scale, 0.7, 1.8),
      color: normalizeHexColor(source.color ?? defaults.color, defaults.color),
      bgColor: normalizeHexColor(source.bgColor ?? defaults.bgColor, defaults.bgColor),
      bgOpacity: clamp(source.bgOpacity ?? defaults.bgOpacity, 0, 1),
      fontWeight: normalizeFontWeight(source.fontWeight ?? defaults.fontWeight)
    };
  }

  function normalizeLayoutValue(key, value) {
    if (key === "fontScale") {
      return clamp(value, 0.7, 1.8);
    }

    if (key === "bottomOffsetPx") {
      return clamp(value, 0, 180);
    }

    if (key === "maxWidthPercent") {
      return clamp(value, 60, 100);
    }

    if (key === "lineGapEm") {
      return clamp(value, 0, 1.2);
    }

    if (key === "textAlign") {
      return normalizeTextAlign(value);
    }

    if (key === "lineBreakMode") {
      return normalizeLineBreakMode(value);
    }

    if (key === "originalCaseMode") {
      return normalizeOriginalCaseMode(value);
    }

    return value;
  }

  function normalizeTrackStyleValue(key, value) {
    if (key === "scale") {
      return clamp(value, 0.7, 1.8);
    }

    if (key === "fontWeight") {
      return normalizeFontWeight(value);
    }

    if (key === "color" || key === "bgColor") {
      return normalizeHexColor(value, "#FFFFFF");
    }

    if (key === "bgOpacity") {
      return clamp(value, 0, 1);
    }

    return value;
  }

  function normalizeModelSettingValue(key, value) {
    if (key === "apiUrl" || key === "apiKey" || key === "model") {
      return String(value || "").trim();
    }

    if (key === "systemPrompt" || key === "testText") {
      return String(value || "");
    }

    if (key === "temperature") {
      return clamp(value, 0, 2);
    }

    if (key === "timeoutMs") {
      return clamp(value, 5000, 120000);
    }

    return value;
  }

  function getTrackOpenAIConfigError(trackId) {
    if (!isModelTrack(trackId)) {
      return "";
    }

    const track = state.settings.tracks[trackId];
    if (!track.apiUrl.trim()) {
      return "接口 URL 未填写";
    }

    if (!track.apiKey.trim()) {
      return "API Key 未填写";
    }

    if (!track.model.trim()) {
      return "模型名未填写";
    }

    return "";
  }

  function parseLegacyEngine(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "openai" || normalized === "openai-compatible" || normalized === "openai_compatible" || normalized === "custom" || normalized === "custom-json") {
      return "openai-compatible";
    }

    return "google-free";
  }

  function normalizeSourceLang(value) {
    const normalized = String(value || "").trim();
    return normalized || "auto";
  }

  function normalizeTextAlign(value) {
    if (value === "left" || value === "right") {
      return value;
    }
    return "center";
  }

  function normalizeLineBreakMode(value) {
    return value === "raw" ? "raw" : "smart";
  }

  function normalizeOriginalCaseMode(value) {
    return value === "raw" ? "raw" : "smart";
  }

  function normalizeHexColor(value, fallback) {
    const match = String(value || "").trim().match(/^#?([a-f\d]{6})$/i);
    if (!match) {
      return fallback;
    }

    return `#${match[1].toUpperCase()}`;
  }

  function normalizeFontWeight(value) {
    const rounded = Math.round(clamp(value, 400, 900) / 100) * 100;
    return clamp(rounded, 400, 900);
  }

  function normalizeTranslation(text) {
    return text
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, location.href).toString();
    } catch (error) {
      return "";
    }
  }

  function formatPlaybackTime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(secs).padStart(2, "0")
      ].join(":");
    }

    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function createTrackNodeMap() {
    return createTrackTextMap(null);
  }

  function createTrackBindingMap() {
    return TRACK_ORDER.reduce((result, trackId) => {
      result[trackId] = [];
      return result;
    }, {});
  }

  function createTrackRuntimeMap() {
    return TRACK_ORDER.reduce((result, trackId) => {
      result[trackId] = {
        inFlight: false,
        jobSeq: 0,
        activeJobId: 0,
        pendingKeys: new Map(),
        nextAttemptAt: 0,
        sessionToken: 0,
        lastError: "",
        testPending: false,
        batchMetrics: createOpenAIBatchMetrics()
      };
      return result;
    }, {});
  }

  function createOpenAIBatchMetrics() {
    return {
      attempts: 0,
      successes: 0,
      fallbacks: 0,
      hardFailures: 0,
      fallbackSuccesses: 0,
      fallbackFailures: 0,
      singleRequests: 0,
      singleItemsTranslated: 0,
      itemsAttempted: 0,
      itemsTranslatedInBatch: 0,
      itemsTranslatedInFallback: 0
    };
  }

  function createTrackTextMap(fillValue) {
    return TRACK_ORDER.reduce((result, trackId) => {
      result[trackId] = fillValue;
      return result;
    }, {});
  }

  function isModelTrack(trackId) {
    return trackId === "model1" || trackId === "model2";
  }

  function hexToRgba(hex, alpha) {
    const match = String(hex).trim().match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!match) {
      return `rgba(0, 0, 0, ${clamp(alpha, 0, 1)})`;
    }

    const red = parseInt(match[1], 16);
    const green = parseInt(match[2], 16);
    const blue = parseInt(match[3], 16);
    return `rgba(${red}, ${green}, ${blue}, ${clamp(alpha, 0, 1)})`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value)));
  }

  function formatNumber(value, digits) {
    return Number(value).toFixed(digits).replace(/\.?0+$/, "");
  }

  function summarizeStatusText(text, maxLength) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hashString(value) {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .tb-root {
        position: absolute;
        display: block;
        pointer-events: none;
        z-index: 2147483647;
        font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      }

      .tb-subtitle-box {
        position: absolute;
        inset: 0;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 0.35em;
        padding-left: 5%;
        padding-right: 5%;
        box-sizing: border-box;
        text-align: center;
        line-height: 1.25;
      }

      .tb-line {
        display: inline-block;
        width: fit-content;
        max-width: 88%;
        padding: 0.18em 0.45em;
        border-radius: 0.45em;
        color: #ffffff;
        white-space: pre-wrap;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        box-decoration-break: clone;
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
      }

      .tb-panel {
        --tb-panel-max-height: min(78vh, 760px);
        position: absolute;
        top: 12px;
        right: 12px;
        width: min(420px, calc(100% - 24px));
        max-height: var(--tb-panel-max-height);
        border-radius: 14px;
        background:
          linear-gradient(180deg, rgba(20, 28, 36, 0.94), rgba(10, 14, 20, 0.92)),
          linear-gradient(135deg, rgba(139, 214, 255, 0.12), rgba(255, 158, 196, 0.08));
        color: #f3f7fb;
        font: 12px/1.45 "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
        pointer-events: auto;
        box-sizing: border-box;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.34);
        backdrop-filter: blur(14px);
      }

      .tb-panel-scroll {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: var(--tb-panel-max-height);
        overflow-y: auto;
        padding: 12px;
        scrollbar-gutter: stable;
        scrollbar-width: thin;
        scrollbar-color: rgba(139, 214, 255, 0.42) rgba(255, 255, 255, 0.04);
      }

      .tb-panel-scroll::-webkit-scrollbar {
        width: 10px;
      }

      .tb-panel-scroll::-webkit-scrollbar-track {
        margin: 10px 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
      }

      .tb-panel-scroll::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background:
          linear-gradient(180deg, rgba(139, 214, 255, 0.52), rgba(255, 158, 196, 0.42)),
          rgba(255, 255, 255, 0.16);
        background-clip: padding-box;
      }

      .tb-panel-scroll::-webkit-scrollbar-thumb:hover {
        background:
          linear-gradient(180deg, rgba(139, 214, 255, 0.68), rgba(255, 158, 196, 0.56)),
          rgba(255, 255, 255, 0.22);
        background-clip: padding-box;
      }

      .tb-panel-header {
        position: sticky;
        top: -12px;
        z-index: 3;
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin: -12px -12px 0;
        padding: 12px 12px 10px;
        background:
          linear-gradient(180deg, rgba(20, 28, 36, 0.98), rgba(15, 21, 29, 0.95)),
          linear-gradient(135deg, rgba(139, 214, 255, 0.1), rgba(255, 158, 196, 0.06));
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(14px);
      }

      .tb-launcher {
        position: absolute;
        top: 12px;
        right: 12px;
        min-width: 52px;
        height: 36px;
        border: 0;
        border-radius: 999px;
        padding: 0 14px;
        background: linear-gradient(135deg, rgba(17, 23, 30, 0.92), rgba(33, 46, 59, 0.92));
        color: #ffffff;
        font: 700 12px/1 "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
        letter-spacing: 0.08em;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.32);
      }

      .tb-launcher:hover {
        background: linear-gradient(135deg, rgba(23, 31, 40, 0.96), rgba(47, 64, 82, 0.96));
      }

      .tb-hidden {
        display: none !important;
      }

      .tb-hide-native-captions [data-id="captionsComponent"] {
        display: none !important;
      }

      .tb-status {
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.06);
        color: rgba(243, 247, 251, 0.96);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tb-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .tb-button {
        border: 0;
        padding: 6px 10px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
        font: inherit;
        cursor: pointer;
        transition: background 0.16s ease, transform 0.16s ease;
      }

      .tb-button:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: translateY(-1px);
      }

      .tb-button:disabled {
        opacity: 0.58;
        cursor: default;
        transform: none;
      }

      .tb-button-mini {
        padding: 5px 9px;
        white-space: nowrap;
      }

      .tb-button-secondary {
        background: rgba(255, 255, 255, 0.08);
      }

      .tb-panel-section {
        display: grid;
        gap: 10px;
        padding: 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.05);
      }

      .tb-panel-section-collapsible {
        gap: 0;
      }

      .tb-panel-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        cursor: pointer;
      }

      .tb-panel-section-title-wrap {
        min-width: 0;
      }

      .tb-panel-section-meta {
        margin-top: 2px;
        color: rgba(243, 247, 251, 0.64);
      }

      .tb-panel-section-body {
        display: grid;
        gap: 10px;
        padding-top: 10px;
      }

      .tb-panel-section-open .tb-panel-section-header {
        padding-bottom: 10px;
        margin-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }

      .tb-section-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.03em;
      }

      .tb-track-card {
        display: grid;
        gap: 10px;
        padding: 10px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        box-shadow: inset 0 0 0 1px transparent;
      }

      .tb-track-card-enabled {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tb-track-accent) 26%, transparent);
      }

      .tb-track-card-open {
        background: rgba(255, 255, 255, 0.07);
      }

      .tb-track-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        cursor: pointer;
      }

      .tb-track-card-title-wrap {
        min-width: 0;
      }

      .tb-track-card-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--tb-track-accent);
      }

      .tb-track-card-meta {
        margin-top: 2px;
        color: rgba(243, 247, 251, 0.64);
      }

      .tb-track-card-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .tb-track-status {
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        color: rgba(243, 247, 251, 0.88);
        font-size: 11px;
        white-space: nowrap;
      }

      .tb-track-card-body {
        display: grid;
        gap: 12px;
      }

      .tb-track-block {
        display: grid;
        gap: 8px;
        padding: 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.04);
      }

      .tb-block-title {
        font-weight: 700;
        color: rgba(243, 247, 251, 0.9);
      }

      .tb-control {
        display: grid;
        grid-template-columns: 78px 1fr auto;
        align-items: center;
        gap: 8px;
      }

      .tb-control-label {
        color: rgba(243, 247, 251, 0.84);
      }

      .tb-control-input {
        min-width: 0;
      }

      .tb-range,
      .tb-select,
      .tb-color,
      .tb-text-input,
      .tb-textarea {
        width: 100%;
        box-sizing: border-box;
      }

      .tb-select,
      .tb-text-input,
      .tb-textarea {
        border: 0;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
        font: inherit;
      }

      .tb-textarea {
        min-height: 88px;
        resize: vertical;
      }

      .tb-color {
        height: 30px;
        border: 0;
        padding: 0;
        background: transparent;
        cursor: pointer;
      }

      .tb-control-value {
        min-width: 58px;
        text-align: right;
        color: rgba(243, 247, 251, 0.7);
        font-variant-numeric: tabular-nums;
      }

      .tb-hint {
        color: rgba(243, 247, 251, 0.66);
        font-size: 11px;
        line-height: 1.45;
      }

      .tb-inline-actions {
        display: flex;
        justify-content: flex-end;
      }

      .tb-batch-metrics {
        gap: 8px;
      }

      .tb-batch-metric-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.04);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tb-track-accent) 20%, transparent);
      }

      .tb-batch-metric-label {
        color: var(--tb-track-accent);
        font-weight: 700;
      }

      .tb-batch-metric-value {
        color: rgba(243, 247, 251, 0.9);
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: nowrap;
      }

      @media (max-width: 720px) {
        .tb-panel {
          width: calc(100% - 16px);
          top: 8px;
          right: 8px;
          left: 8px;
          --tb-panel-max-height: min(72vh, 680px);
        }

        .tb-launcher {
          top: 8px;
          right: 8px;
        }

        .tb-control {
          grid-template-columns: 72px 1fr;
        }

        .tb-control-value {
          grid-column: 2;
          justify-self: end;
        }

        .tb-track-card-header {
          align-items: flex-start;
        }
      }
    `;

    if (document.documentElement) {
      document.documentElement.appendChild(style);
      return;
    }

    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement?.appendChild(style);
    }, { once: true });
  }
})();
