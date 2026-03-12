// ==UserScript==
// @name         Tubi Bilingual Subtitles
// @namespace    https://github.com/handsomedog/tubi-translate
// @version      0.3.0
// @description  Capture Tubi subtitle files, translate them, and render bilingual subtitles over the player.
// @match        https://tubitv.com/*
// @match        https://*.tubitv.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const SETTINGS_KEY = "tb_settings_v1";
  const CACHE_KEY = "tb_translation_cache_v1";
  const MAX_CACHE_ENTRIES = 3000;
  const TICK_MS = 120;

  const DEFAULT_SETTINGS = {
    sourceLang: "auto",
    targetLang: "zh-CN",
    engine: "google-free",
    openaiApiUrl: "https://api.openai.com/v1/chat/completions",
    openaiApiKey: "",
    openaiModel: "",
    openaiSystemPrompt: "You are a subtitle translator. Translate the subtitle text faithfully into the target language. Return only the translated subtitle text.",
    openaiTemperature: 0,
    openaiTimeoutMs: 30000,
    openaiTestText: "Hello. This is a subtitle translation test.",
    showOriginal: true,
    showTranslation: true,
    hideNativeTracks: true,
    fontScale: 1,
    bottomOffsetPx: 82,
    maxWidthPercent: 88,
    lineGapEm: 0.35,
    textAlign: "center",
    originalScale: 1,
    originalColor: "#ffffff",
    originalBgColor: "#000000",
    originalBgOpacity: 0.58,
    originalFontWeight: 700,
    translationScale: 0.92,
    translationColor: "#ffe082",
    translationBgColor: "#000000",
    translationBgOpacity: 0.58,
    translationFontWeight: 600,
    lineBreakMode: "smart",
    originalCaseMode: "smart",
    stylePanelOpen: false,
    enginePanelOpen: false,
    panelCollapsed: true,
    batchChars: 900,
    manualSubtitleUrl: ""
  };

  const STYLE_SETTING_KEYS = [
    "fontScale",
    "bottomOffsetPx",
    "maxWidthPercent",
    "lineGapEm",
    "textAlign",
    "originalScale",
    "originalColor",
    "originalBgColor",
    "originalBgOpacity",
    "originalFontWeight",
    "translationScale",
    "translationColor",
    "translationBgColor",
    "translationBgOpacity",
    "translationFontWeight",
    "lineBreakMode",
    "originalCaseMode"
  ];

  const ENGINE_SETTING_KEYS = [
    "engine",
    "openaiApiUrl",
    "openaiApiKey",
    "openaiModel",
    "openaiSystemPrompt",
    "openaiTemperature",
    "openaiTimeoutMs",
    "openaiTestText"
  ];

  const state = {
    settings: loadSettings(),
    cache: loadCache(),
    video: null,
    host: null,
    overlayRoot: null,
    subtitleBox: null,
    originalNode: null,
    translationNode: null,
    panelNode: null,
    panelToggleNode: null,
    styleControlsNode: null,
    engineControlsNode: null,
    engineTestButtonNode: null,
    actionButtons: {},
    statusNode: null,
    statusText: "Waiting for subtitles",
    styleControlBindings: [],
    engineControlBindings: [],
    engineTestPending: false,
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
    injectStyles();
    registerMenuCommands();
    observePage();

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

    if (state.settings.manualSubtitleUrl) {
      loadSubtitleFromUrl(state.settings.manualSubtitleUrl, "manual");
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
  }

  function onTick() {
    if (!state.video || !state.video.isConnected) {
      queueBindVideo();
    }

    if (!state.video) {
      clearRenderedCue();
      return;
    }

    ensureOverlayAttached();
    syncOverlayLayout();

    syncNativeCaptionVisibility();

    renderActiveCue();
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

  function createOverlay() {
    const root = document.createElement("div");
    root.className = "tb-root";

    const subtitleBox = document.createElement("div");
    subtitleBox.className = "tb-subtitle-box";

    const originalNode = document.createElement("div");
    originalNode.className = "tb-line tb-original";

    const translationNode = document.createElement("div");
    translationNode.className = "tb-line tb-translation";

    subtitleBox.appendChild(originalNode);
    subtitleBox.appendChild(translationNode);

    const launcher = makeLauncherButton();

    const panel = document.createElement("div");
    panel.className = "tb-panel";

    const status = document.createElement("div");
    status.className = "tb-status";
    status.textContent = state.statusText;

    const actions = document.createElement("div");
    actions.className = "tb-actions";
    const manualUrlButton = makeButton("Subtitle URL", "Set a manual subtitle file URL", promptManualUrl);
    const targetLangButton = makeButton("Target Language", "Set the translation target language", promptTargetLanguage);
    const engineButton = makeButton("Engine Settings", "Open translation engine settings", toggleEnginePanel);
    const retryButton = makeButton("Reload Subtitle", "Reload the last detected subtitle file", retryLastSubtitle);
    const originalButton = makeButton("Original: On", "Toggle the original subtitle line", toggleOriginal);
    const translationButton = makeButton("Translation: On", "Toggle the translated subtitle line", toggleTranslation);
    const styleButton = makeButton("Style Panel", "Open subtitle style settings", toggleStylePanel);
    const hideButton = makeButton("Hide Panel", "Hide the subtitle tools panel", collapsePanel);
    const exportButton = makeButton("Export SRT", "Export the current bilingual subtitles as SRT", exportBilingualSrt);

    [
      manualUrlButton,
      targetLangButton,
      engineButton,
      retryButton,
      originalButton,
      translationButton,
      styleButton,
      hideButton,
      exportButton
    ].forEach((button) => actions.appendChild(button));

    const styleControls = createStylePanel();
    const engineControls = createEnginePanel();

    panel.appendChild(status);
    panel.appendChild(actions);
    panel.appendChild(styleControls);
    panel.appendChild(engineControls);

    trapPanelEvents(panel);

    root.appendChild(launcher);
    root.appendChild(panel);
    root.appendChild(subtitleBox);

    state.overlayRoot = root;
    state.subtitleBox = subtitleBox;
    state.originalNode = originalNode;
    state.translationNode = translationNode;
    state.panelNode = panel;
    state.panelToggleNode = launcher;
    state.styleControlsNode = styleControls;
    state.engineControlsNode = engineControls;
    state.actionButtons = {
      manualUrlButton,
      targetLangButton,
      engineButton,
      retryButton,
      originalButton,
      translationButton,
      styleButton,
      hideButton,
      exportButton
    };
    state.statusNode = status;

    applySubtitleStyles();
    refreshActionButtons();

    if (state.settings.enginePanelOpen) {
      setEnginePanelVisible(true, false);
    } else {
      setStylePanelVisible(Boolean(state.settings.stylePanelOpen), false);
    }

    setPanelCollapsed(true, false);
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

  function makeLauncherButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tb-launcher";
    button.textContent = "TB";
    button.title = "Open subtitle tools panel";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel();
    });
    trapPanelEvents(button);
    return button;
  }

  function createStylePanel() {
    state.styleControlBindings = [];

    const controls = document.createElement("div");
    controls.className = "tb-config-panel";

    const layoutSection = makeSection("Layout");
    layoutSection.appendChild(makeRangeControl("Base", "fontScale", {
      min: 0.7,
      max: 1.8,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}x`
    }));
    layoutSection.appendChild(makeRangeControl("Bottom", "bottomOffsetPx", {
      min: 0,
      max: 180,
      step: 1,
      format: (value) => `${value}px`
    }));
    layoutSection.appendChild(makeRangeControl("Width", "maxWidthPercent", {
      min: 60,
      max: 100,
      step: 1,
      format: (value) => `${value}%`
    }));
    layoutSection.appendChild(makeRangeControl("Gap", "lineGapEm", {
      min: 0,
      max: 1,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}em`
    }));
    layoutSection.appendChild(makeSelectControl("Align", "textAlign", [
      ["left", "Left"],
      ["center", "Center"],
      ["right", "Right"]
    ]));
    layoutSection.appendChild(makeSelectControl("Breaks", "lineBreakMode", [
      ["smart", "Smart"],
      ["raw", "Raw"]
    ]));
    layoutSection.appendChild(makeSelectControl("Case", "originalCaseMode", [
      ["smart", "Smart"],
      ["raw", "Raw"]
    ]));

    const originalSection = makeSection("Primary");
    originalSection.appendChild(makeRangeControl("Size", "originalScale", {
      min: 0.7,
      max: 1.8,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}x`
    }));
    originalSection.appendChild(makeRangeControl("Weight", "originalFontWeight", {
      min: 400,
      max: 900,
      step: 100,
      format: (value) => String(value)
    }));
    originalSection.appendChild(makeColorControl("Text", "originalColor"));
    originalSection.appendChild(makeColorControl("BG", "originalBgColor"));
    originalSection.appendChild(makeRangeControl("BG alpha", "originalBgOpacity", {
      min: 0,
      max: 1,
      step: 0.05,
      format: (value) => formatNumber(value, 2)
    }));

    const translationSection = makeSection("Secondary");
    translationSection.appendChild(makeRangeControl("Size", "translationScale", {
      min: 0.7,
      max: 1.8,
      step: 0.05,
      format: (value) => `${formatNumber(value, 2)}x`
    }));
    translationSection.appendChild(makeRangeControl("Weight", "translationFontWeight", {
      min: 400,
      max: 900,
      step: 100,
      format: (value) => String(value)
    }));
    translationSection.appendChild(makeColorControl("Text", "translationColor"));
    translationSection.appendChild(makeColorControl("BG", "translationBgColor"));
    translationSection.appendChild(makeRangeControl("BG alpha", "translationBgOpacity", {
      min: 0,
      max: 1,
      step: 0.05,
      format: (value) => formatNumber(value, 2)
    }));

    const footer = document.createElement("div");
    footer.className = "tb-style-footer";
    footer.appendChild(makeSecondaryButton("Reset Styles", "Reset subtitle style settings to defaults", resetStyleSettings));

    controls.appendChild(layoutSection);
    controls.appendChild(originalSection);
    controls.appendChild(translationSection);
    controls.appendChild(footer);

    syncStyleControlBindings();
    return controls;
  }

  function createEnginePanel() {
    state.engineControlBindings = [];

    const controls = document.createElement("div");
    controls.className = "tb-config-panel";

    const backendSection = makeSection("Translation");
    backendSection.appendChild(makeEngineSelectControl("Mode", "engine", [
      ["google-free", "Google Free"],
      ["openai-compatible", "OpenAI Compatible"]
    ]));

    const openAISection = makeSection("OpenAI");
    openAISection.classList.add("tb-engine-openai-only");
    openAISection.appendChild(makeEngineTextControl("API URL", "openaiApiUrl", {
      placeholder: "https://api.openai.com/v1/chat/completions"
    }));
    openAISection.appendChild(makeEnginePasswordControl("API Key", "openaiApiKey", {
      placeholder: "sk-..."
    }));
    openAISection.appendChild(makeEngineTextControl("Model", "openaiModel", {
      placeholder: "gpt-4.1-mini"
    }));
    openAISection.appendChild(makeEngineNumberControl("Temp", "openaiTemperature", {
      min: 0,
      max: 2,
      step: 0.1
    }));
    openAISection.appendChild(makeEngineNumberControl("Timeout", "openaiTimeoutMs", {
      min: 5000,
      max: 120000,
      step: 1000,
      format: (value) => `${Math.round(value)}ms`
    }));

    const promptSection = makeSection("Prompt");
    promptSection.classList.add("tb-engine-openai-only");
    promptSection.appendChild(makeEngineTextareaControl("System", "openaiSystemPrompt", {
      rows: 4,
      placeholder: "Translate subtitles faithfully and return only the translated text."
    }));

    const testSection = makeSection("Test");
    testSection.classList.add("tb-engine-openai-only");
    testSection.appendChild(makeEngineTextareaControl("Sample", "openaiTestText", {
      rows: 3,
      placeholder: "Enter a short line to verify the model API.",
      retranslateOnChange: false
    }));
    testSection.appendChild(makeHintText("Send one sample request with the current source and target language settings."));

    const testActions = document.createElement("div");
    testActions.className = "tb-inline-actions";
    const testButton = makeSecondaryButton("Test API", "Send a sample request to verify the model API", testOpenAITranslation);
    testActions.appendChild(testButton);
    testSection.appendChild(testActions);

    const footer = document.createElement("div");
    footer.className = "tb-style-footer";
    footer.appendChild(makeSecondaryButton("Reset Settings", "Reset translation engine settings to defaults", resetEngineSettings));

    controls.appendChild(backendSection);
    controls.appendChild(openAISection);
    controls.appendChild(promptSection);
    controls.appendChild(testSection);
    controls.appendChild(footer);

    state.engineTestButtonNode = testButton;
    syncEngineControlBindings();
    syncEnginePanelState();
    setEngineTestPending(false);
    return controls;
  }

  function makeSection(title) {
    const section = document.createElement("section");
    section.className = "tb-section";

    const header = document.createElement("div");
    header.className = "tb-section-title";
    header.textContent = title;

    section.appendChild(header);
    return section;
  }

  function makeRangeControl(label, key, options) {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.className = "tb-range";

    const valueNode = document.createElement("span");
    valueNode.className = "tb-control-value";

    registerStyleControlBinding(key, input, valueNode, options.format);
    input.addEventListener("input", () => {
      applyStyleSetting(key, Number(input.value), true);
    });
    input.addEventListener("change", () => {
      applyStyleSetting(key, Number(input.value), false);
    });

    return makeControlRow(label, input, valueNode);
  }

  function makeSelectControl(label, key, choices) {
    const select = document.createElement("select");
    select.className = "tb-select";

    choices.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    });

    registerStyleControlBinding(key, select, null, null);
    select.addEventListener("change", () => {
      applyStyleSetting(key, select.value, false);
    });

    return makeControlRow(label, select, null);
  }

  function makeColorControl(label, key) {
    const input = document.createElement("input");
    input.type = "color";
    input.className = "tb-color";

    const valueNode = document.createElement("span");
    valueNode.className = "tb-control-value";

    registerStyleControlBinding(key, input, valueNode, (value) => String(value).toUpperCase());
    input.addEventListener("input", () => {
      applyStyleSetting(key, input.value, true);
    });
    input.addEventListener("change", () => {
      applyStyleSetting(key, input.value, false);
    });

    return makeControlRow(label, input, valueNode);
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

  function makeSecondaryButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tb-button tb-button-secondary";
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

  function makeEngineSelectControl(label, key, choices) {
    const select = document.createElement("select");
    select.className = "tb-select";

    choices.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.appendChild(option);
    });

    registerEngineControlBinding(key, select, null, null);
    select.addEventListener("change", () => {
      applyEngineSetting(key, select.value, false, true);
    });

    return makeControlRow(label, select, null);
  }

  function makeEngineTextControl(label, key, options) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tb-text-input";
    input.placeholder = options.placeholder || "";

    registerEngineControlBinding(key, input, null, null);
    input.addEventListener("input", () => {
      applyEngineSetting(key, input.value, true, false);
    });
    input.addEventListener("change", () => {
      applyEngineSetting(key, input.value, false, true);
    });

    return makeControlRow(label, input, null);
  }

  function makeEnginePasswordControl(label, key, options) {
    const input = document.createElement("input");
    input.type = "password";
    input.className = "tb-text-input";
    input.placeholder = options.placeholder || "";

    registerEngineControlBinding(key, input, null, null);
    input.addEventListener("input", () => {
      applyEngineSetting(key, input.value, true, false);
    });
    input.addEventListener("change", () => {
      applyEngineSetting(key, input.value, false, true);
    });

    return makeControlRow(label, input, null);
  }

  function makeEngineNumberControl(label, key, options) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "tb-text-input";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);

    const valueNode = document.createElement("span");
    valueNode.className = "tb-control-value";

    registerEngineControlBinding(key, input, valueNode, options.format || null);
    input.addEventListener("input", () => {
      applyEngineSetting(key, Number(input.value), true, false);
    });
    input.addEventListener("change", () => {
      applyEngineSetting(key, Number(input.value), false, true);
    });

    return makeControlRow(label, input, valueNode);
  }

  function makeEngineTextareaControl(label, key, options) {
    const input = document.createElement("textarea");
    input.className = "tb-textarea";
    input.rows = options.rows || 4;
    input.placeholder = options.placeholder || "";

    registerEngineControlBinding(key, input, null, null);
    input.addEventListener("input", () => {
      applyEngineSetting(key, input.value, true, false);
    });
    input.addEventListener("change", () => {
      applyEngineSetting(key, input.value, false, options.retranslateOnChange !== false);
    });

    return makeControlRow(label, input, null);
  }

  function registerStyleControlBinding(key, input, valueNode, format) {
    state.styleControlBindings.push({
      key,
      input,
      valueNode,
      format
    });
  }

  function registerEngineControlBinding(key, input, valueNode, format) {
    state.engineControlBindings.push({
      key,
      input,
      valueNode,
      format
    });
  }

  function syncStyleControlBindings() {
    state.styleControlBindings.forEach((binding) => {
      syncBoundControl(binding, state.settings[binding.key]);
    });
  }

  function syncEngineControlBindings() {
    state.engineControlBindings.forEach((binding) => {
      syncBoundControl(binding, state.settings[binding.key]);
    });
  }

  function syncBoundControl(binding, value) {
    const isFocusedTextField = document.activeElement === binding.input && (binding.input.tagName === "INPUT" || binding.input.tagName === "TEXTAREA");

    if (!isFocusedTextField && (binding.input.type === "range" || binding.input.type === "color" || binding.input.type === "number" || binding.input.tagName === "SELECT" || binding.input.tagName === "TEXTAREA" || binding.input.tagName === "INPUT")) {
      binding.input.value = String(value ?? "");
    }

    if (binding.valueNode) {
      binding.valueNode.textContent = binding.format ? binding.format(value) : String(value);
    }
  }

  function syncEnginePanelState() {
    if (!state.engineControlsNode) {
      return;
    }

    const usesOpenAI = state.settings.engine === "openai-compatible";
    Array.from(state.engineControlsNode.querySelectorAll(".tb-engine-openai-only")).forEach((node) => {
      node.classList.toggle("tb-hidden", !usesOpenAI);
    });
  }

  function refreshActionButtons() {
    const buttons = state.actionButtons;
    if (!buttons || !buttons.manualUrlButton) {
      return;
    }

    setButtonPresentation(
      buttons.manualUrlButton,
      "Subtitle URL",
      state.settings.manualSubtitleUrl
        ? `Current manual subtitle URL: ${state.settings.manualSubtitleUrl}`
        : "Set a manual subtitle file URL"
    );
    setButtonPresentation(
      buttons.targetLangButton,
      "Target Language",
      `Current target language: ${state.settings.targetLang}`
    );
    setButtonPresentation(
      buttons.engineButton,
      "Engine Settings",
      `Current translation engine: ${getEngineLabel(state.settings.engine)}. Open translation engine settings.`
    );
    setButtonPresentation(
      buttons.retryButton,
      "Reload Subtitle",
      "Reload the last detected subtitle file"
    );
    setButtonPresentation(
      buttons.originalButton,
      state.settings.showOriginal ? "Original: On" : "Original: Off",
      state.settings.showOriginal ? "Hide the original subtitle line" : "Show the original subtitle line"
    );
    setButtonPresentation(
      buttons.translationButton,
      state.settings.showTranslation ? "Translation: On" : "Translation: Off",
      state.settings.showTranslation ? "Hide the translated subtitle line" : "Show the translated subtitle line"
    );
    setButtonPresentation(
      buttons.styleButton,
      "Style Panel",
      "Open subtitle style settings"
    );
    setButtonPresentation(
      buttons.hideButton,
      "Hide Panel",
      "Hide the subtitle tools panel"
    );
    setButtonPresentation(
      buttons.exportButton,
      "Export SRT",
      "Export the current bilingual subtitles as an SRT file"
    );
  }

  function setButtonPresentation(button, label, title) {
    button.textContent = label;
    button.title = title || label;
  }

  function setEngineTestPending(pending) {
    state.engineTestPending = pending;

    if (!state.engineTestButtonNode) {
      return;
    }

    state.engineTestButtonNode.disabled = pending;
    state.engineTestButtonNode.textContent = pending ? "Testing..." : "Test API";
  }

  function toggleStylePanel() {
    setStylePanelVisible(!state.settings.stylePanelOpen, true);
  }

  function toggleEnginePanel() {
    setEnginePanelVisible(!state.settings.enginePanelOpen, true);
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

  function setStylePanelVisible(visible, persist) {
    state.settings.stylePanelOpen = visible;
    state.settings.enginePanelOpen = false;
    updateConfigPanelVisibility();

    if (persist) {
      saveSettings();
    }
  }

  function setEnginePanelVisible(visible, persist) {
    state.settings.enginePanelOpen = visible;
    state.settings.stylePanelOpen = false;
    updateConfigPanelVisibility();

    if (persist) {
      saveSettings();
    }
  }

  function updateConfigPanelVisibility() {
    if (state.styleControlsNode) {
      state.styleControlsNode.classList.toggle("tb-hidden", !state.settings.stylePanelOpen);
    }

    if (state.engineControlsNode) {
      state.engineControlsNode.classList.toggle("tb-hidden", !state.settings.enginePanelOpen);
    }

    if (state.panelNode) {
      state.panelNode.classList.toggle("tb-panel-expanded", state.settings.stylePanelOpen || state.settings.enginePanelOpen);
    }

    syncEnginePanelState();
  }

  function setPanelCollapsed(collapsed, persist) {
    state.settings.panelCollapsed = collapsed;

    if (state.panelNode) {
      state.panelNode.classList.toggle("tb-hidden", collapsed);
    }

    if (state.panelToggleNode) {
      state.panelToggleNode.classList.toggle("tb-hidden", !collapsed);
      state.panelToggleNode.title = collapsed ? "Open subtitle tools" : "Subtitle tools open";
    }

    if (persist) {
      saveSettings();
    }
  }

  function applyStyleSetting(key, value, deferSave) {
    state.settings[key] = value;

    if (deferSave) {
      scheduleSettingsSave();
    } else {
      saveSettings();
    }

    syncStyleControlBindings();
    applySubtitleStyles();
    syncOverlayLayout();
    renderActiveCue();
  }

  function resetStyleSettings() {
    STYLE_SETTING_KEYS.forEach((key) => {
      state.settings[key] = DEFAULT_SETTINGS[key];
    });

    saveSettings();
    syncStyleControlBindings();
    applySubtitleStyles();
    syncOverlayLayout();
    renderActiveCue();
    setStatus("Subtitle styles reset");
  }

  function applyEngineSetting(key, value, deferSave, retranslate) {
    state.settings[key] = normalizeEngineSettingValue(key, value);

    if (deferSave) {
      scheduleSettingsSave();
    } else {
      saveSettings();
    }

    syncEngineControlBindings();
    syncEnginePanelState();
    refreshActionButtons();

    if (!retranslate) {
      return;
    }

    if (key === "engine") {
      const configError = getOpenAIConfigError();
      if (state.settings.engine === "openai-compatible" && configError) {
        state.cueKey = "";
        renderActiveCue();
        setStatus(configError);
        return;
      }

      applyTranslationSettingChange(`Translation engine set to ${getEngineLabel(state.settings.engine)}`);
      return;
    }

    if (state.settings.engine !== "openai-compatible") {
      setStatus("Engine settings saved");
      return;
    }

    const configError = getOpenAIConfigError();
    if (configError) {
      state.cueKey = "";
      renderActiveCue();
      setStatus(configError);
      return;
    }

    applyTranslationSettingChange("OpenAI translation settings updated");
  }

  function resetEngineSettings() {
    ENGINE_SETTING_KEYS.forEach((key) => {
      state.settings[key] = DEFAULT_SETTINGS[key];
    });

    saveSettings();
    syncEngineControlBindings();
    syncEnginePanelState();
    refreshActionButtons();

    if (state.cues.length) {
      applyTranslationSettingChange("Translation engine settings reset");
      return;
    }

    state.cueKey = "";
    renderActiveCue();
    setStatus("Translation engine settings reset");
  }

  async function testOpenAITranslation() {
    if (state.engineTestPending) {
      return;
    }

    if (state.settings.engine !== "openai-compatible") {
      setStatus("Switch the engine to OpenAI Compatible before testing the model API");
      return;
    }

    const configError = getOpenAIConfigError();
    if (configError) {
      setStatus(configError);
      return;
    }

    const sampleText = String(state.settings.openaiTestText || "").trim();
    if (!sampleText) {
      setStatus("Enter sample text before testing the model API");
      return;
    }

    setEngineTestPending(true);
    setStatus("Testing OpenAI-compatible model API...");

    try {
      const translated = normalizeTranslation(await translateSingleTextWithOpenAI(sampleText));
      setStatus(`Model test OK: ${summarizeStatusText(translated, 90)}`);
      console.info("[TB] OpenAI model test succeeded", {
        sampleText,
        translated
      });
    } catch (error) {
      setStatus(`Model test failed: ${error.message}`);
      console.error("[TB] OpenAI model test failed", error);
    } finally {
      setEngineTestPending(false);
    }
  }

  function trapPanelEvents(node) {
    ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"].forEach((eventName) => {
      node.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
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

    const fontSize = Math.max(18, Math.round(videoRect.width * 0.028 * state.settings.fontScale));
    state.subtitleBox.style.paddingBottom = `${state.settings.bottomOffsetPx}px`;
    state.originalNode.style.fontSize = `${Math.round(fontSize * state.settings.originalScale)}px`;
    state.translationNode.style.fontSize = `${Math.round(fontSize * state.settings.translationScale)}px`;
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
    const originalText = state.settings.showOriginal ? formatOriginalTextForDisplay(cue.text) : "";
    const translatedText = state.settings.showTranslation ? formatTranslatedTextForDisplay(getCachedTranslation(cue.text)) : "";
    const nextKey = `${cueIndex}|${originalText}|${translatedText}`;

    if (nextKey === state.cueKey) {
      return;
    }

    state.cueKey = nextKey;

    const showOriginal = Boolean(originalText);
    const showTranslation = Boolean(translatedText);

    state.originalNode.textContent = originalText;
    state.originalNode.style.display = showOriginal ? "block" : "none";

    state.translationNode.textContent = translatedText;
    state.translationNode.style.display = showTranslation ? "block" : "none";

    state.subtitleBox.style.display = (showOriginal || showTranslation) ? "flex" : "none";
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
    state.originalNode.textContent = "";
    state.translationNode.textContent = "";
    state.originalNode.style.display = "none";
    state.translationNode.style.display = "none";
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

    if (normalized === state.currentSubtitleUrl) {
      return;
    }

    loadSubtitleFromUrl(normalized, "auto-detected");
  }

  async function loadSubtitleFromUrl(url, reason) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setStatus("Invalid subtitle URL");
      return;
    }

    const token = ++state.sourceToken;
    state.currentSubtitleUrl = normalized;
    state.lastDetectedSubtitleUrl = normalized;
    state.cues = [];
    state.cueKey = "";
    clearRenderedCue();
    setStatus(`Loading subtitles (${reason})`);

    try {
      const subtitleText = await requestText(normalized);
      if (token !== state.sourceToken) {
        return;
      }

      const cues = parseSubtitleText(subtitleText, normalized);
      if (!cues.length) {
        throw new Error("No cues found");
      }

      state.cues = cues;
      setStatus(`Loaded ${cues.length} cues`);
      renderActiveCue();
    } catch (error) {
      if (token !== state.sourceToken) {
        return;
      }

      state.currentSubtitleUrl = "";
      state.cues = [];
      clearRenderedCue();
      setStatus(`Subtitle load failed: ${error.message}`);
      console.error("[TB] Subtitle load failed", error);
      return;
    }

    try {
      await translateMissingCues(token);
    } catch (error) {
      if (token !== state.sourceToken) {
        return;
      }

      setStatus(`Translation failed: ${error.message}`);
      console.error("[TB] Translation failed", error);
    }
  }

  async function translateMissingCues(token) {
    const uniqueTexts = [];
    const seen = new Set();

    for (const cue of state.cues) {
      const textForTranslation = normalizeCueTextForTranslation(cue.text);

      if (!shouldTranslate(textForTranslation) || seen.has(textForTranslation) || getCachedTranslation(cue.text)) {
        continue;
      }

      seen.add(textForTranslation);
      uniqueTexts.push(textForTranslation);
    }

    if (!uniqueTexts.length) {
      setStatus(`Ready (${state.cues.length} cues)`);
      renderActiveCue();
      return;
    }

    const batches = buildBatches(uniqueTexts, state.settings.batchChars);
    let translatedCount = 0;

    for (const batch of batches) {
      if (token !== state.sourceToken) {
        return;
      }

      setStatus(`Translating ${translatedCount}/${uniqueTexts.length}`);

      const translations = await translateBatch(batch);
      if (token !== state.sourceToken) {
        return;
      }

      const now = Date.now();

      batch.forEach((text, index) => {
        const translated = normalizeTranslation(translations[index] || "");
        if (!translated) {
          return;
        }

        state.cache[buildCacheKey(text)] = {
          value: translated,
          updatedAt: now
        };
      });

      translatedCount += batch.length;
      pruneCache();
      saveCache();
      renderActiveCue();
      await sleep(120);
    }

    setStatus(`Ready (${state.cues.length} cues)`);
  }

  function buildBatches(texts, maxChars) {
    const batches = [];
    let current = [];
    let currentSize = 0;

    for (const text of texts) {
      const size = text.length + 24;

      if (current.length && currentSize + size > maxChars) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }

      current.push(text);
      currentSize += size;
    }

    if (current.length) {
      batches.push(current);
    }

    return batches;
  }

  async function translateBatch(texts) {
    if (state.settings.engine === "google-free") {
      return translateWithGoogle(texts);
    }

    if (state.settings.engine === "openai-compatible") {
      return translateWithOpenAI(texts);
    }

    throw new Error(`Unsupported engine: ${state.settings.engine}`);
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
    body.set("tl", state.settings.targetLang);
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

    throw new Error("Unexpected translation response");
  }

  async function translateWithOpenAI(texts) {
    const translations = [];

    for (const text of texts) {
      translations.push(await translateSingleTextWithOpenAI(text));

      if (texts.length > 1) {
        await sleep(80);
      }
    }

    return translations;
  }

  async function translateSingleTextWithOpenAI(text) {
    const requestConfig = buildOpenAITranslationRequest(text);
    const response = await requestRaw(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      data: requestConfig.data,
      timeout: requestConfig.timeout
    });

    return parseOpenAITranslationResponse(response.responseText);
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

  function buildOpenAITranslationRequest(text) {
    const configError = getOpenAIConfigError();
    if (configError) {
      throw new Error(configError);
    }

    return {
      url: state.settings.openaiApiUrl.trim(),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.settings.openaiApiKey.trim()}`
      },
      data: JSON.stringify({
        model: state.settings.openaiModel.trim(),
        temperature: clamp(state.settings.openaiTemperature, 0, 2),
        messages: [
          {
            role: "system",
            content: state.settings.openaiSystemPrompt.trim() || DEFAULT_SETTINGS.openaiSystemPrompt
          },
          {
            role: "user",
            content: buildOpenAIUserMessage(text)
          }
        ]
      }),
      timeout: clamp(state.settings.openaiTimeoutMs, 5000, 120000)
    };
  }

  function buildOpenAIUserMessage(text) {
    return [
      "Translate the following subtitle text.",
      `Source language: ${state.settings.sourceLang}`,
      `Target language: ${state.settings.targetLang}`,
      "",
      text
    ].join("\n");
  }

  function parseOpenAITranslationResponse(responseText) {
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`OpenAI response is not valid JSON: ${error.message}`);
    }

    if (payload?.error?.message) {
      throw new Error(payload.error.message);
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const text = readTextLikeValue(choice?.message?.content ?? choice?.text ?? "");
    if (!text.trim()) {
      throw new Error("OpenAI translation response is empty");
    }

    return text.trim();
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
    let timeLineIndex = lines.findIndex((line) => line.includes("-->"));
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

  function shouldTranslate(text) {
    return /[\p{L}\p{N}]/u.test(text);
  }

  function getCachedTranslation(text) {
    const entry = state.cache[buildCacheKey(text)];
    if (!entry) {
      return "";
    }

    entry.updatedAt = Date.now();
    return entry.value;
  }

  function buildCacheKey(text) {
    return `${getTranslationProfileCacheKey()}::${state.settings.sourceLang}::${state.settings.targetLang}::${normalizeCueTextForTranslation(text)}`;
  }

  function normalizeTranslation(text) {
    return text
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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

  function promptManualUrl() {
    const initialValue = state.currentSubtitleUrl || state.lastDetectedSubtitleUrl || state.settings.manualSubtitleUrl || "";
    const nextUrl = window.prompt("Subtitle URL", initialValue);
    if (nextUrl === null) {
      return;
    }

    const trimmed = nextUrl.trim();
    state.settings.manualSubtitleUrl = trimmed;
    saveSettings();
    refreshActionButtons();

    if (!trimmed) {
      setStatus("Manual subtitle URL cleared");
      return;
    }

    loadSubtitleFromUrl(trimmed, "manual");
  }

  function promptTargetLanguage() {
    const nextValue = window.prompt("Target language", state.settings.targetLang);
    if (nextValue === null) {
      return;
    }

    const trimmed = nextValue.trim();
    if (!trimmed || trimmed === state.settings.targetLang) {
      return;
    }

    state.settings.targetLang = trimmed;
    refreshActionButtons();
    applyTranslationSettingChange(`Target language set to ${trimmed}`);
  }

  function toggleOriginal() {
    state.settings.showOriginal = !state.settings.showOriginal;
    saveSettings();
    refreshActionButtons();
    state.cueKey = "";
    renderActiveCue();
    setStatus(state.settings.showOriginal ? "Original line on" : "Original line off");
  }

  function toggleTranslation() {
    state.settings.showTranslation = !state.settings.showTranslation;
    saveSettings();
    refreshActionButtons();
    state.cueKey = "";
    renderActiveCue();
    setStatus(state.settings.showTranslation ? "Translation line on" : "Translation line off");
  }

  function retryLastSubtitle() {
    const url = state.currentSubtitleUrl || state.lastDetectedSubtitleUrl || state.settings.manualSubtitleUrl;
    if (!url) {
      setStatus("No subtitle URL detected yet");
      return;
    }

    loadSubtitleFromUrl(url, "retry");
  }

  function applyTranslationSettingChange(message) {
    saveSettings();
    state.cueKey = "";
    renderActiveCue();
    setStatus(message);

    if (!state.cues.length) {
      return;
    }

    const token = ++state.sourceToken;
    translateMissingCues(token).catch((error) => {
      if (token !== state.sourceToken) {
        return;
      }

      setStatus(`Translation failed: ${error.message}`);
    });
  }

  function exportBilingualSrt() {
    if (!state.cues.length) {
      setStatus("No subtitles loaded");
      return;
    }

    const lines = [];
    state.cues.forEach((cue, index) => {
      const translated = getCachedTranslation(cue.text);
      const body = translated ? `${cue.text}\n${translated}` : cue.text;
      lines.push(String(index + 1));
      lines.push(`${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`);
      lines.push(body);
      lines.push("");
    });

    const blob = new Blob([lines.join("\n")], {
      type: "application/x-subrip;charset=utf-8"
    });

    const link = document.createElement("a");
    const suffix = state.settings.targetLang.replace(/[^a-z0-9_-]/gi, "_");
    link.href = URL.createObjectURL(blob);
    link.download = `tubi-bilingual-${suffix}.srt`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setStatus("Bilingual SRT exported");
  }

  function getTranslationProfileCacheKey() {
    if (state.settings.engine === "openai-compatible") {
      const fingerprint = JSON.stringify({
        url: state.settings.openaiApiUrl,
        model: state.settings.openaiModel,
        systemPrompt: state.settings.openaiSystemPrompt,
        temperature: state.settings.openaiTemperature
      });

      return `openai-compatible:${hashString(fingerprint)}`;
    }

    return state.settings.engine;
  }

  function formatSrtTime(seconds) {
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return [
      String(hours).padStart(2, "0"),
      String(minutes).padStart(2, "0"),
      String(secs).padStart(2, "0")
    ].join(":") + `,${String(ms).padStart(3, "0")}`;
  }

  function registerMenuCommands() {
    GM_registerMenuCommand("Open translation engine panel", toggleEnginePanel);
    GM_registerMenuCommand("Switch to Google Translate", () => applyEngineSetting("engine", "google-free", false, true));
    GM_registerMenuCommand("Switch to OpenAI-compatible model", () => applyEngineSetting("engine", "openai-compatible", false, true));
    GM_registerMenuCommand("Test OpenAI-compatible model API", testOpenAITranslation);
    GM_registerMenuCommand(`Set target language (${state.settings.targetLang})`, promptTargetLanguage);
    GM_registerMenuCommand("Set manual subtitle URL", promptManualUrl);
    GM_registerMenuCommand("Reload last detected subtitle URL", retryLastSubtitle);
    GM_registerMenuCommand("Toggle original subtitle line", toggleOriginal);
    GM_registerMenuCommand("Toggle translated subtitle line", toggleTranslation);
    GM_registerMenuCommand("Show or hide subtitle tools panel", togglePanelCollapsed);
    GM_registerMenuCommand("Open subtitle style panel", toggleStylePanel);
    GM_registerMenuCommand("Reset subtitle style settings", resetStyleSettings);
    GM_registerMenuCommand("Clear translation cache", () => {
      state.cache = {};
      saveCache();
      state.cueKey = "";
      renderActiveCue();
      setStatus("Translation cache cleared");
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
    }
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, location.href).toString();
    } catch (error) {
      return "";
    }
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

  function loadSettings() {
    const value = GM_getValue(SETTINGS_KEY, {});
    const raw = (value && typeof value === "object") ? value : {};
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw);
    merged.engine = normalizeEngine(merged.engine);
    merged.openaiApiUrl = String(raw.openaiApiUrl ?? raw.customTranslateUrl ?? DEFAULT_SETTINGS.openaiApiUrl).trim() || DEFAULT_SETTINGS.openaiApiUrl;
    merged.openaiApiKey = String(raw.openaiApiKey ?? DEFAULT_SETTINGS.openaiApiKey).trim();
    merged.openaiModel = String(raw.openaiModel ?? DEFAULT_SETTINGS.openaiModel).trim();
    merged.openaiSystemPrompt = String(raw.openaiSystemPrompt ?? DEFAULT_SETTINGS.openaiSystemPrompt);
    merged.openaiTemperature = clamp(raw.openaiTemperature ?? DEFAULT_SETTINGS.openaiTemperature, 0, 2);
    merged.openaiTimeoutMs = clamp(raw.openaiTimeoutMs ?? raw.customTranslateTimeoutMs ?? DEFAULT_SETTINGS.openaiTimeoutMs, 5000, 120000);
    merged.openaiTestText = String(raw.openaiTestText ?? DEFAULT_SETTINGS.openaiTestText);
    merged.stylePanelOpen = typeof raw.stylePanelOpen === "boolean" ? raw.stylePanelOpen : Boolean(raw.panelOpen);
    merged.enginePanelOpen = Boolean(raw.enginePanelOpen);

    if (merged.enginePanelOpen) {
      merged.stylePanelOpen = false;
    }

    return merged;
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

  function saveCache() {
    GM_setValue(CACHE_KEY, state.cache);
  }

  function getEngineLabel(engine) {
    if (engine === "openai-compatible") {
      return "OpenAI Compatible";
    }

    return "Google Free";
  }

  function normalizeEngine(value) {
    return parseEngineValue(value) || DEFAULT_SETTINGS.engine;
  }

  function parseEngineValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) {
      return "";
    }

    if (normalized === "google" || normalized === "google-free" || normalized === "google_free") {
      return "google-free";
    }

    if (normalized === "openai" || normalized === "openai-compatible" || normalized === "openai_compatible" || normalized === "custom" || normalized === "custom-json" || normalized === "custom_json") {
      return "openai-compatible";
    }

    return "";
  }

  function normalizeEngineSettingValue(key, value) {
    if (key === "engine") {
      return normalizeEngine(value);
    }

    if (key === "openaiApiUrl" || key === "openaiApiKey" || key === "openaiModel") {
      return String(value || "").trim();
    }

    if (key === "openaiSystemPrompt") {
      return String(value || "");
    }

    if (key === "openaiTestText") {
      return String(value || "");
    }

    if (key === "openaiTemperature") {
      return clamp(value, 0, 2);
    }

    if (key === "openaiTimeoutMs") {
      return clamp(value, 5000, 120000);
    }

    return value;
  }

  function getOpenAIConfigError() {
    if (state.settings.engine !== "openai-compatible") {
      return "";
    }

    if (!state.settings.openaiApiUrl.trim()) {
      return "OpenAI API URL is required";
    }

    if (!state.settings.openaiApiKey.trim()) {
      return "OpenAI API key is required";
    }

    if (!state.settings.openaiModel.trim()) {
      return "OpenAI model is required";
    }

    return "";
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .tb-root {
        position: absolute;
        display: block;
        pointer-events: none;
        z-index: 2147483647;
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
        font-family: Arial, sans-serif;
        line-height: 1.25;
      }

      .tb-line {
        display: inline-block;
        width: fit-content;
        max-width: 88%;
        padding: 0.18em 0.45em;
        border-radius: 0.4em;
        background: rgba(0, 0, 0, 0.58);
        color: #ffffff;
        white-space: pre-wrap;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        box-decoration-break: clone;
      }

      .tb-translation {
        color: #ffe082;
      }

      .tb-panel {
        position: absolute;
        top: 12px;
        right: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(260px, calc(100% - 24px));
        padding: 10px;
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.72);
        color: #f5f5f5;
        font: 12px/1.35 Arial, sans-serif;
        pointer-events: auto;
        box-sizing: border-box;
      }

      .tb-launcher {
        position: absolute;
        top: 12px;
        right: 12px;
        min-width: 36px;
        height: 36px;
        border: 0;
        border-radius: 999px;
        padding: 0 10px;
        background: rgba(0, 0, 0, 0.76);
        color: #ffffff;
        font: 700 12px/1 Arial, sans-serif;
        letter-spacing: 0.06em;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
      }

      .tb-launcher:hover {
        background: rgba(0, 0, 0, 0.88);
      }

      .tb-hidden {
        display: none !important;
      }

      .tb-hide-native-captions [data-id="captionsComponent"] {
        display: none !important;
      }

      .tb-panel-expanded {
        width: min(360px, calc(100% - 24px));
      }

      .tb-status {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tb-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .tb-button {
        border: 0;
        padding: 5px 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.14);
        color: #ffffff;
        font: inherit;
        cursor: pointer;
      }

      .tb-button:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      .tb-button:disabled {
        opacity: 0.55;
        cursor: default;
      }

      .tb-button-secondary {
        background: rgba(255, 255, 255, 0.08);
      }

      .tb-config-panel {
        display: grid;
        gap: 10px;
        margin-top: 2px;
        padding-top: 2px;
      }

      .tb-section {
        display: grid;
        gap: 6px;
        padding: 8px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
      }

      .tb-section-title {
        font-weight: 700;
        letter-spacing: 0.02em;
      }

      .tb-control {
        display: grid;
        grid-template-columns: 62px 1fr auto;
        align-items: center;
        gap: 8px;
      }

      .tb-control-label {
        color: rgba(255, 255, 255, 0.86);
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
        padding: 5px 6px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
        font: inherit;
      }

      .tb-textarea {
        min-height: 84px;
        resize: vertical;
      }

      .tb-hint {
        color: rgba(255, 255, 255, 0.66);
        font-size: 11px;
        line-height: 1.4;
      }

      .tb-color {
        height: 28px;
        border: 0;
        padding: 0;
        background: transparent;
        cursor: pointer;
      }

      .tb-control-value {
        min-width: 54px;
        text-align: right;
        color: rgba(255, 255, 255, 0.72);
        font-variant-numeric: tabular-nums;
      }

      .tb-style-footer {
        display: flex;
        justify-content: flex-end;
      }

      .tb-inline-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
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

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function applySubtitleStyles() {
    if (!state.subtitleBox || !state.originalNode || !state.translationNode) {
      return;
    }

    state.subtitleBox.style.gap = `${state.settings.lineGapEm}em`;
    state.subtitleBox.style.textAlign = state.settings.textAlign;
    state.subtitleBox.style.alignItems = mapTextAlignToFlexAlignment(state.settings.textAlign);

    applyLineStyles(state.originalNode, {
      widthPercent: state.settings.maxWidthPercent,
      color: state.settings.originalColor,
      bgColor: state.settings.originalBgColor,
      bgOpacity: state.settings.originalBgOpacity,
      fontWeight: state.settings.originalFontWeight
    });

    applyLineStyles(state.translationNode, {
      widthPercent: state.settings.maxWidthPercent,
      color: state.settings.translationColor,
      bgColor: state.settings.translationBgColor,
      bgOpacity: state.settings.translationBgOpacity,
      fontWeight: state.settings.translationFontWeight
    });
  }

  function applyLineStyles(node, options) {
    node.style.width = "fit-content";
    node.style.maxWidth = `${options.widthPercent}%`;
    node.style.color = options.color;
    node.style.background = hexToRgba(options.bgColor, options.bgOpacity);
    node.style.fontWeight = String(options.fontWeight);
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

    if (state.settings.originalCaseMode !== "smart") {
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
    if (!text || state.settings.lineBreakMode !== "smart") {
      return text;
    }

    return text
      .split(/\n{2,}/)
      .map((block) => normalizeCueBlockLines(block))
      .join("\n\n");
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
    if (dialogueLines.length >= 2) {
      return true;
    }

    return false;
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
    normalized = normalized.replace(/(^|[.!?:]\s+|[\[(]\s*|["“]\s*)([a-z])/g, (match, prefix, char) => {
      return `${prefix}${char.toUpperCase()}`;
    });

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
})();
