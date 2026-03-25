# Shanbay

这个目录收集了运行在 `https://web.shanbay.com/*` 学习页面上的 Tampermonkey 脚本。当前目录已经从旧的单脚本说明整理为目录级说明，覆盖空格跳词和生词统计两个脚本。

## 脚本列表

| 文件 | 作用 |
| --- | --- |
| `Space to Next Word.js` | 在非输入状态下按空格触发“下一词”按钮，并在按钮可用时追加 `Space` 提示 |
| `Unfamiliar Word Count.js` | 按 `2` 记录当前不认识的单词并累计次数，在右上角面板查看和删除统计 |

## 安装

1. 安装 Tampermonkey。
2. 选择需要的脚本文件；两个脚本可以单独安装，也可以同时安装。
3. 新建脚本并粘贴对应文件内容。
4. 保存后打开扇贝网页学习页面。

## Space to Next Word

### 使用

- 在非输入状态下按空格，会触发“下一词”按钮。
- 如果当前焦点位于 `input`、`textarea`、`select`、可编辑区域或 `role="textbox"` 节点，脚本不会接管空格键。

### 实现说明

- 使用 `[class^="StudyPage_nextBtn__"]` 前缀选择器兼容按钮类名哈希变化。
- 通过 `MutationObserver` 监听 DOM 变化，按钮被重新渲染后仍会自动恢复可用状态。
- 触发点击时会依次发送 `mousedown`、`mouseup` 和 `click`，尽量模拟真实交互。

## Unfamiliar Word Count

### 使用

- 按 `2`：把当前单词记入“不认识”列表，并累计出现次数。
- 按 `1`：仅在控制台输出当前单词“认识”，不写入统计。
- 右上角悬浮面板会按次数倒序展示单词，点击 `✖` 可以删除对应记录。

### 数据与实现

- 统计数据保存在浏览器 `localStorage` 的 `unknown_words_map`。
- 通过 `lastWord` 和 `hasCounted` 状态锁避免同一单词在未切换前被重复计数。
- 当前单词优先从 `[class*="index_word"] span` 和 `[class*="VocabPronounce_word"]` 选择器中提取。

## 注意事项

- 两个脚本都依赖扇贝当前页面 DOM 结构；如果站点改版，选择器可能需要同步调整。
- `Unfamiliar Word Count.js` 的统计数据保存在当前浏览器本地，不会自动跨设备同步。
