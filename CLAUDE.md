# Prism LLearn — notes for Claude

Learn English and Chinese from what the user likes to watch / read. Paste a YouTube link (subtitles via yt-dlp), a web
page (Readability) or text, or open a video file (+ .srt/.vtt/.ass or subtitles inside an mkv) → every word is clickable
and coloured by what the learner knows; click = Thai meaning (offline dictionaries + "meaning in this sentence"), IPA /
pinyin, voice; keep as a card → FSRS review (with the clip the word came from); listen-and-type; GitHub-style
learning heatmap + streak; export CSV / Anki. Fully offline and free except fetching YouTube / web pages.
Built 2026-11-24 at the user's request ("L" = language). **The user wants nothing that costs money** (no paid APIs).

Read first: `../CLAUDE.md` (suite rules) and `../docs/LESSONS.md`.
More detail: `docs/features.md`, `docs/pitfalls.md`, `docs/changelog.md`, `docs/ideas.md`.

## What the user opens
Desktop `Prism LLearn.lnk` → `prism-llearn\app\bin\prism-llearn.exe`, with `app\bin\runtime\` beside it (~4 GB, not in git):
- `yt-dlp.exe` (2026.11.23; updates itself with `-U` after an unexplained failure — `PRISM_NOYTUPDATE=1` in tests), `ffmpeg.exe` (copied from Prism Rec; merge downloads, mkv subtitles, remux)
- `llama\` llama.cpp b12651 Vulkan build (llama-server + ggml/llama dlls) + `models\translategemma-4b-it-Q4_K_M.gguf` (2.5 GB, bullerwins GGUF, Gemma terms)
- `tts\` sherpa-onnx v2.0.3 C API (`sherpa-onnx-c-api.dll`, `onnxruntime*.dll`) + `kokoro\` (kokoro-multi-lang-v1_1, en + zh)
- `dict\en.json` (31 MB), `zh.json` (13 MB), `LICENSES.txt` — built by `tools/dict/build.py` (see below)
- `whisper\` whisper.cpp v1.9.5 Vulkan build (copied from Prism VoiceOpen `runtime\gpu`; rebuild there with `tools/build-whisper-vulkan.sh`)
  + `models\ggml-large-v3-turbo-q5_0.bin` (574 MB, Accurate), `ggml-small-q8_0.bin` (264 MB, Fast), `ggml-silero-v6.2.0.bin` (VAD, unused)
Downloads + build data live in `%USERPROFILE%\PrismLLearnBuild\dl` (outside OneDrive).

## Build
`bash tools/build.sh` (Git Bash, from `prism-llearn/`) — WinLibs + GNU Rust, target `%USERPROFILE%\PrismLLearnBuild\target`,
kills the running app, copies the exe into `app\bin`. Check `ls -l app/bin/prism-llearn.exe` afterwards.
Dictionaries: `python -X utf8 tools/dict/build.py %USERPROFILE%\PrismLLearnBuild\dl\data` (needs `pip install wordfreq openpyxl`;
sources: kaikki.org English Wiktionary jsonl.gz, VOLUBILIS Mundo xlsx, CC-CEDICT, complete-hsk-vocabulary hsk.json).
Icon: `tools/brand/logos.js` entry `llearn` (gold + speech bubble "A"); `render.js --write --only=llearn`, `apply-web.js`.

## Layout (`app/src-tauri/src`)
- `main.rs` — shell (Prism IPC names `win:min` → `win_min`), saving (`db_load/db_save` = `%APPDATA%\com.prism.llearn\state.json`,
  `src_*` = `src\<id>.json` per lesson, temp file + .bak), dialogs, `llearn` protocol, test hooks, single instance.
- `dict.rs` — loads dict JSON with `RawValue` entries; `lookup_en` (form → lemma unless the form has its own Thai), `lookup_zh`
  (traditional → simplified), `zh_words` (segmentation list for the page), `en_many` / `zh_many` (colouring), `top` (placement).
- `llama_share.rs` — one translator for LLearn + Prism Shot (same file in prism-shot — edit both); `inbox_take` in main.rs =
  words / texts sent by Prism Shot (`%APPDATA%\com.prism.llearn\inbox\`), imported by `takeInbox()` in app.js.
- `tr.rs` — llama-server child (job object, GPU `-ngl 99`, falls back to CPU), idle unload 15 min, raw TranslateGemma prompt, cache `%LOCALAPPDATA%\com.prism.llearn\tr\`.
- `tts.rs` — sherpa-onnx C API via libloading (structs mirror `c-api.h` v2.0.3!), model kept loaded, WAV cache `…\tts\`, served `http://llearn.localhost/tts/…`.
- `yt.rs` — yt-dlp `-J` (meta cached in memory), json3 subtitle fetch with curl, offline download (→ `%USERPROFILE%\Videos\Prism LLearn`, progress events `yt:progress`), web page fetch (base64 → page decodes charset).
- `media.rs` — video files: sibling subs, ffmpeg probe / extract embedded subs, convert (remux, then full h264), `http://llearn.localhost/file/<token>` with Range.
- `whisper.rs` — whisper-server children (slots `batch` / `live`, GPU → CPU `-ng` retry, idle unload 5 min), multipart `/inference` with cancel, WAV helpers.
- `asr.rs` — AI subtitle jobs: queue, audio (ffmpeg / yt-dlp audio only) → `%LOCALAPPDATA%\com.prism.llearn\asr\<lesson id>\` (audio.wav, plan.json, c<n>.json pieces, result.json), ~90 s pieces cut at quiet points, parse tokens → words, learner lines (`build_cues`), redo range. Events `asr:progress|done|range|queue`.
- `live.rs` — live subtitles: WASAPI loopback → 16 kHz → phrases (loudness) → whisper `live` slot; events `live:partial|final|state|level`. Window `live` = `renderer/live.html` + `js/live.js` (cards go to the main window via `live:tell`).
- `util.rs` — paths, log `%LOCALAPPDATA%\com.prism.llearn\prism.log`, hidden child processes, curl fetch, tiny local HTTP client.

## Page (`app/renderer/js`)
`app.js` (shell, views, keys, drop/paste, test hooks) · `asr.js` (AI jobs, queue in `S.asrQ`, Home queue card, export, live window bridge) · `store.js` (state S, activity per day, streak, autosave) · `reader.js`
(lesson page, translation queue, dictation, offline download) · `players.js` (YouTube postMessage player, `<video>`) ·
`popup.js` (word card) · `words.js` (lookups, lemma/pinyin caches, colours, cards, voice, translate queue) · `text.js`
(tokenize, Chinese max-match, json3/SRT/VTT/ASS, Readability article) · `srs.js` (FSRS-4.5) · `review.js` · `home.js`
(heatmap, stats, settings, placement test) · `wordlist.js` (word bank + CSV/Anki export) · `vendor/Readability.js` (Mozilla, Apache-2.0).

## Test hooks
`PRISM_ACT` (comma list): `en` `th` `dark` `light` `classic` `glass` `info` `view:home|learn|review|words|keys` `open:<urlencoded link or id>`
`text:<urlencoded>` `file:<urlencoded path>` `src:<lesson id>` `word:<n>` (click nth word) `cue:<n>` `key:<key|space>` `click:<urlencoded css>`
`placement:en|zh` `review` `rvstart` `wait:<ms>` `quit`, AI: `live` `aimenu` `aidialog` `edit` `editcue:<n>` `shiftcue:<n>` `scroll:<px>` `del:<id+id…>` (delete test lessons).
`PRISM_OFFSCREEN=1` = window off-screen, no focus (tests). `PRISM_CPU=1` = whisper on the CPU (fallback test). `PRISM_LIVE_WAV=<16 kHz wav>` = live subtitles hear this file, not the speakers.
`shotw.ps1 <png> [title]` screenshots the live window. `PRISM_MULTI=1` skips single instance, `PRISM_RUNTIME` overrides the runtime folder.
Test kit in `%USERPROFILE%\PrismLLearnBuild\test\`: `run.sh "<acts>" <sec> <png>` (starts the exe, screenshots OUR window only via `shot.ps1`),
`extract.mjs` (Thai strings without English), `mk_en.py` (writes lang-en.js from a table — edit lang-en.js directly for small additions), `media\` (test video + srt + mkv).

## Rules specific to this app
- Nothing that costs money. Online only for YouTube / web pages; everything else offline.
- Thai strings: `` T`…` `` → English in `js/lang-en.js`; run `node extract.mjs` in the test folder. Native strings: `util::tr(th, en)`.
- `PKG_NAME` in main.rs must equal `app/package.json` "name" (`prism-llearn`). Repo: `Pangpond543/prism-llearn` (`app/prism.config.json`). Release: `bash ../tools/release/tauri-release.sh prism-llearn "Prism LLearn" prism-llearn PrismLLearnBuild "" --runtime prism-llearn/tools/stage-runtime.sh` — the translator model is downloaded by the app, never in the release (2 GB limit).
- Testing downloads writes into the user's REAL `Videos\Prism LLearn` (not virtualised) — delete what a test downloaded.
