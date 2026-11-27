# Prism LLearn — changelog

- 2026-11-27 — **bug hunt (fixes for 1.1.1)** — same pass Rec/Code/VoiceOpen got on 11-20. Found and fixed:
  (1) **Data loss**: `write_safe` copied the CURRENT file to `.bak` before every save — a damaged `state.json` (full disk / power cut)
  overwrote the good `.bak` on the next autosave; and when both were bad the page started empty and saved over everything. Now a
  `.json` becomes the `.bak` only if it still parses; `util::read_json_or_bak` (db_load + src_load) falls back to the .bak and keeps
  the damaged file once as `state.broken.json`; the page treats a non-object as damaged. (2) **Translator download**: curl had no
  `--fail` → an HTTP error page was written into the `.part`, and `-C -` then resumed after it → a corrupt 2.5 GB "model" accepted at
  99.9 % size → translator fails for ever. Now `--fail`, `--proto-redir =https`, stall limit (<1 KB/s for 60 s), exact size + "GGUF"
  magic before the rename, a complete `.part` is finished without curl (416), a too-big `.part` is restarted, free space checked first
  (reason `disk`, curl exit 23 = disk) with its own messages on Home. (3) **yt-dlp**: `--socket-timeout 20` (a stalled connection hung
  the "reading video" spinner for ever); missing `yt-dlp.exe` → reason `noruntime` (was an OS error text → generic message); an
  unexplained `-J` failure runs `yt-dlp -U` once per run and retries (YouTube breaks old yt-dlp every few weeks; `PRISM_NOYTUPDATE=1`
  turns it off for tests). Bundled yt-dlp updated 2026.10.26 → 2026.11.23. (4) A failing save toasted every 5 s → once per problem.
  Tested with `llrun.sh` (own AppData): truncated state.json + good .bak → 1 card / 2 lessons back, .bak untouched, broken copy kept;
  runtime without yt-dlp → the new message; a complete sparse `.part` starting "GGUF" → "model downloaded"; real YouTube link → meta in
  4.8 s; `yt-dlp -U` on a copy printed "Updated yt-dlp to stable@2026.11.23" (the text the code looks for).
  Not tested: a real full disk, an HTTP error mid-download, the self-update inside the app on a real outdated failure.
  `llama_share.rs` unchanged. Release: `bash tools/release/prism-release.sh llearn 1.1.1`.

- 2026-11-26 — **v1.1.0, first GitHub release** (`Pangpond543/prism-llearn`). The translator model (2.5 GB) is over GitHub's 2 GB per-file limit, so it is not in the download: Home → "แปลภาษาในเครื่อง" shows **"โหลดตัวแปล (2.5 GB ฟรี)"** → `tr::download` (curl from Hugging Face, resumable `.part`, progress refreshed every second, toast when done; same file / URL as Prism Shot). Everything else ships (Setup 1.23 GB / Portable 1.32 GB, `tools/stage-runtime.sh` + `../tools/release/tauri-release.sh`). `app/prism.config.json` repo set (updater on). Checked in the packaged exe: the button appears without the model, the download starts (296 MB in ~30 s), closing the app stops curl.

## 2026-11-25 — link with Prism Shot
- What: (1) one translator for both apps — `llama_share.rs` (same file as Prism Shot's): if Prism Shot already runs
  llama-server with the same model, LLearn uses it ("tr: using Prism Shot's translator"), touches `llama.used` while doing
  so, starts its own if Shot closes; LLearn's own server now uses `-c 4096` (was 2048) so Shot can borrow it too; each app
  reads the other's translation cache. (2) Inbox: Prism Shot drops words ("keep in LLearn") and texts ("learn in LLearn")
  into `%APPDATA%\com.prism.llearn\inbox\`; `inbox_take` hands them to the page once (then deletes them) at start, on window
  focus and every 4 s. A word → a card (meaning chosen in Shot, sentence + Thai, reading filled from our dictionary) whose
  source is a text lesson of the whole screenshot text (`addTextSource`, not opened); a text → opened as a lesson.
  (3) Test switch `PRISM_OFFSCREEN=1`: the window shows off-screen and never takes focus.
- Why: the user asked Prism Shot to "sync with Prism LLearn" (2026-11-25).
- Verified: test copy with its own AppData imported a card + a lesson from the inbox (word bank shows the card, status
  learning, source lesson present); borrowed a running test Prism Shot's server ("ready in 42 ms") and translated a lesson.
  Installed to `app\bin\prism-llearn.exe` (LLearn was not running). Not opened by the user yet.

## 2026-11-25 — v1.1.0 (phase 2: AI subtitles)
Phase 2 as planned with the user, plus every extra they picked (they asked for "all of it, stable, as many functions as possible").
- **AI subtitles on the PC** (whisper.cpp v1.9.5 Vulkan, large-v3-turbo on the RX 6600 ≈ 14× real time; CPU fallback): YouTube
  videos / video files / other-site videos with no English or Chinese subtitles get them automatically; lines appear while AI listens.
- Long videos: cut into ~90 s pieces at the quietest moment; every piece is cached → cancel / crash / restart continues where it
  stopped; a video is transcribed only once. Progress + time left on the lesson, a queue card on Home (several videos in a row).
- Language detected automatically (or chosen), Chinese always simplified, learner-sized lines (sentence ends, pauses, about 12 words /
  18 characters, never cut inside a Chinese word), word timings → karaoke, dotted underline on words AI was unsure of.
- Modes: Accurate (large-v3-turbo) / Fast (small). Track switcher: YouTube track ↔ "AI on this PC" ↔ the file's own subtitles.
- **Edit subtitles** (E): fix words, split at the cursor (Ctrl+Enter), join, delete, nudge the start ±0.25 s, undo (Ctrl+Z).
- **Hear again**: one line or Shift+click a range → AI listens to just that part again and replaces it.
- Export .srt / .srt with Thai / .vtt / .txt.
- **Other video sites** (Bilibili, TikTok, Facebook, X, TED, Vimeo … anything yt-dlp knows): their subtitles if any, otherwise AI;
  the video is downloaded into Videos\Prism LLearn to play. A web link with no article is tried as a video.
- **Live subtitles from the PC's sound** (Ctrl+Shift+L / dock ear button): floating always-on-top window over Netflix, games, calls;
  English / Chinese lines + Thai, click a word → meaning, voice, keep as card; the session is kept as a reading lesson.
- Fix: yt-dlp downloads from sites that give no percent (Bilibili) now show progress from byte counts.

## 2026-11-24 — v1.0.0 (phase 1)
New app for learning English and Chinese, at the user's request (no paid services; "LLearn" — the first L = language).
- YouTube lessons (yt-dlp subtitles, auto captions rebuilt into lines + karaoke), web articles (Readability), pasted text, video files with
  sibling / dropped / embedded subtitles (ffmpeg), keep YouTube videos for offline.
- Clickable, colour-coded words; word card with offline dictionaries (Wiktionary + VOLUBILIS + CC-CEDICT + HSK), IPA / pinyin,
  "meaning in this sentence", Kokoro voice, phrase look-up by selection.
- Offline Thai translation of every line (TranslateGemma 4B, llama.cpp Vulkan on the RX 6600, CPU fallback, cached).
- Cards with FSRS review, the source clip on the card, listen-and-type practice, placement test.
- Home: streak, daily goal, GitHub-style learning heatmap with day details; word bank with CSV / Anki export.
- Picked by the user: card plays the clip, listen-and-type, local video + subtitles, export cards; video both embedded and downloadable.
- Brand: gold logo with a speech-bubble "A" (tools/brand/logos.js `llearn`), desktop shortcut `Prism LLearn.lnk`.
