# Tubi Bilingual Subtitles

Tampermonkey userscript for Tubi that:

- detects subtitle requests such as `.srt` or `.vtt`
- downloads the subtitle file directly
- translates each cue into a target language
- renders original and translated lines over the video
- exports a bilingual `.srt` file

## Current MVP behavior

- Site: `https://tubitv.com/*`
- Subtitle source: auto-detected network requests, or a manual subtitle URL
- Translation engine: built-in Google web endpoint, or an OpenAI-compatible chat completions model
- Output: original line + translated line in an overlay
- Native Tubi captions: hidden from the page while keeping subtitle loading enabled

## Install

1. Install Tampermonkey.
2. Create a new script.
3. Paste the contents of `tubi-bilingual-subtitles.user.js`.
4. Open a Tubi video page and start playback.

## Controls

- `TB`: open the hidden subtitle tools panel
- `Subtitle URL`: set a subtitle URL manually
- `Target Language`: change the target language, default `zh-CN`
- `Engine Settings`: open the translation engine panel and switch between `google-free` and `openai-compatible`
- `Reload Subtitle`: reload the last detected subtitle URL
- `Original: On/Off`: toggle the original subtitle line
- `Translation: On/Off`: toggle the translated line
- `Style Panel`: open the style panel and adjust subtitle appearance live
- `Hide Panel`: collapse the tools panel back into the `TB` launcher
- `Export SRT`: export the current bilingual subtitle file

The same actions are also exposed through the Tampermonkey menu.
The main GUI is hidden by default each time the page loads.

## Engine panel

Click `Engine Settings` to open a dedicated translation settings panel. It persists:

- `Mode`: `google-free` or `openai-compatible`
- `API URL`: full OpenAI-compatible `chat/completions` endpoint
- `API Key`: bearer token
- `Model`: model id such as `gpt-4.1-mini` or a compatible provider model name
- `Temp`: request temperature
- `Timeout`: request timeout in milliseconds
- `System`: system prompt used for subtitle translation
- `Sample`: a test line for verifying the model API

The engine panel also includes a `Test API` button that sends one sample request with the current source and target language settings, then reports the result in the status bar.

### OpenAI-compatible example

- Mode: `openai-compatible`
- API URL: `https://api.openai.com/v1/chat/completions`
- API Key: `YOUR_KEY`
- Model: `gpt-4.1-mini`
- Temp: `0`
- Timeout: `30000`
- System:

```text
You are a subtitle translator. Translate the subtitle text faithfully into the target language. Return only the translated subtitle text.
```

When OpenAI mode is active, the script sends one request per subtitle line using the standard Chat Completions payload and reads the translated text from `choices[0].message.content`.

## Style panel

The built-in GUI can adjust and persist:

- global subtitle base size, bottom offset, width, line gap, and text alignment
- subtitle line break mode: `Smart` merges forced line wraps inside one cue, `Raw` keeps the source formatting
- original subtitle case mode: `Smart` for all-caps cleanup or `Raw` to keep source text
- primary subtitle font size, font weight, text color, background color, and background opacity
- secondary subtitle font size, font weight, text color, background color, and background opacity

## Known limitations

- This MVP assumes Tubi loads plain `.srt` or `.vtt` subtitle files.
- If Tubi renders subtitles through a custom DOM layer, you may still need to turn off native captions manually to avoid duplicate subtitles.
- The default translation backend is the public Google Translate web endpoint. It is useful for prototyping, but not a hard-reliability backend.
- The OpenAI-compatible mode currently translates subtitle lines one by one for predictable cue mapping, so it can be slower and more expensive than Google mode.
- Some subtitle files contain ads, music cues, or sound descriptions such as `[ BELL RINGING ]`; those will be translated as normal lines.
- The `Smart` case cleanup only affects on-screen display of fully uppercase original subtitles.

## Next improvements

- add subtitle offset controls
- add per-video cache keyed by subtitle URL
- support custom site selectors if Tubi changes player structure
