# tampermonkey-scripts

这个仓库收集了一些自用的 Tampermonkey 用户脚本，按站点/用途分目录存放。

## 目录

| 目录 | 脚本文件 | 作用 |
| --- | --- | --- |
| `ChatGPT Issue navigation` | `index.js` | 为 ChatGPT 对话页生成“问题目录”侧栏，支持搜索、定位和高亮当前问题 |
| `JD gold price` | `index.js` | 为京东金融积存金页面增加便捷下单/出货控制面板，并复用已捕获请求参数 |
| `Shanbay space to next word` | `index.js` | 在扇贝网页学习页中按空格直接跳到下一词 |
| `Tubi bilingual subtitles` | `tubi-bilingual-subtitles.user.js` | 在 Tubi 播放页捕获字幕、翻译并显示双语字幕 |

## 安装方式

1. 在浏览器中安装 Tampermonkey。
2. 打开对应目录中的脚本文件。
3. 新建 Tampermonkey 脚本并粘贴内容保存。
4. 打开脚本匹配的网站页面，确认脚本已启用。

## 各目录说明

- [ChatGPT Issue navigation/README.MD](./ChatGPT%20Issue%20navigation/README.MD)
- [JD gold price/README.MD](./JD%20gold%20price/README.MD)
- [Shanbay space to next word/README.MD](./Shanbay%20space%20to%20next%20word/README.MD)
- [Tubi bilingual subtitles/README.md](./Tubi%20bilingual%20subtitles/README.md)

## 备注

- 这些脚本主要按当前页面结构编写，目标站点改版后可能需要调整选择器或请求逻辑。
- `JD gold price` 涉及真实交易页面，请先理解脚本行为、页面请求和相关风险后再使用。
