# tampermonkey-scripts

这个仓库收集了一些自用的 Tampermonkey 用户脚本，按站点/用途分目录存放。

## 目录

| 目录 | 脚本文件 | 作用 |
| --- | --- | --- |
| `ChatGPT Issue navigation` | `index.js` | 为 ChatGPT 对话页生成悬浮“问题目录”，支持搜索，并增强了对当前消息 DOM 结构的适配 |
| `JD gold price` | `index.js` | 为京东金融积存金页面增加便捷下单/出货控制面板，并复用已捕获请求参数 |
| `Shanbay` | `Space to Next Word.js` / `Unfamiliar Word Count.js` | 在扇贝网页学习页中提供空格跳词快捷键，以及生词次数统计面板 |
| `Tubi bilingual subtitles` | `tubi-bilingual-subtitles.user.js` | 在 Tubi 播放页捕获字幕并叠加固定四轨字幕，支持缓存清空重载、批次统计和左右方向键快退/快进 |

## 安装方式

1. 在浏览器中安装 Tampermonkey。
2. 打开对应目录中的脚本文件；如果目录里有多个脚本，按需选择安装。
3. 新建 Tampermonkey 脚本并粘贴内容保存。
4. 打开脚本匹配的网站页面，确认脚本已启用。

## 各目录说明

- [ChatGPT Issue navigation/README.MD](./ChatGPT%20Issue%20navigation/README.MD)
- [JD gold price/README.MD](./JD%20gold%20price/README.MD)
- [Shanbay/README.MD](./Shanbay/README.MD)
- [Tubi bilingual subtitles/README.md](./Tubi%20bilingual%20subtitles/README.md)

## 近期变更

- `2026-03-19` `feat(userscripts): improve ChatGPT TOC and Tubi seek hotkeys`
  - `ChatGPT Issue navigation` 增强了对当前对话 DOM 结构和用户消息提取逻辑的兼容性。
  - `Tubi bilingual subtitles` 增加左右方向键 `5s` 快退/快进。
- `2026-03-15` `feat: add batch stats panel and cache reset action`
  - `Tubi bilingual subtitles` 新增模型轨批次统计，并将“重新载入字幕”调整为“清空缓存并重载”。
- `2026-03-15` `refactor: rebuild Tubi subtitles userscript as a multi-track overlay`
  - `Tubi bilingual subtitles` 从早期双语字幕脚本重构为固定四轨叠加面板。

## 备注

- 这些脚本主要按当前页面结构编写，目标站点改版后可能需要调整选择器或请求逻辑。
- `JD gold price` 涉及真实交易页面，请先理解脚本行为、页面请求和相关风险后再使用。
- 所有脚本按现状提供（`as is`），使用者需要自行确认目标网站条款、平台规则以及适用法律。

## 许可证

本仓库采用 [MIT License](./LICENSE)。
