# Prism LLearn — pitfalls

- **YouTube in the app**: don't load YouTube's iframe_api script (CSP is `script-src 'self'`). The embed is driven with the
  postMessage protocol it uses internally: send `{"event":"listening","id":1,"channel":"widget"}` until `onReady`, then
  `{"event":"command","func":"playVideo"|"seekTo"|…}`; time comes from `infoDelivery` (interpolate between messages).
  `cc_load_policy=0` is not enough when the viewer's YouTube setting turns captions on → `unloadModule captions` + `cc` on ready / first play.
- YouTube auto-translated caption tracks (e.g. `th`) return HTTP 429 quickly — don't use them; translate with TranslateGemma.
  `yt.rs info()` hides auto tracks that are machine translations of the spoken language.
- yt-dlp warns "No supported JavaScript runtime" (deno) — metadata, subtitles and the ≤720p mp4 download still work (tested 2026-11-24).
  If YouTube breaks downloads later, bundling deno is the fix.
- **TranslateGemma prompt**: the GGUF chat template needs `content` as a list with `source_lang_code` / `target_lang_code`; llama-server's
  OpenAI endpoint won't pass those. Send the template's text raw to `/completion` (see `tr.rs`). Marking a word with [brackets] to get
  its translation inside a sentence is unreliable (kept 2 of 7) — the word card matches dictionary meanings against the sentence's translation instead.
- Translating each subtitle line alone loses context ("long trunks" → shorts). Accepted for now (ideas: translate groups).
- **sherpa-onnx C API**: the `#[repr(C)]` structs in `tts.rs` must match `c-api.h` of the bundled version (v2.0.3: vits, num_threads, debug,
  provider, matcha, kokoro{…, lang}, kitten, zipvoice, pocket, supertonic). Upgrading the DLL without updating them = crash / garbage.
  Load `onnxruntime.dll` by full path first. "kokoro-data-dir is deprecated" on stderr is harmless.
- `sherpa-onnx-offline-tts.exe` takes ~4.5 s per call (model load) and mangles Chinese in argv → use the C API, keep the model loaded.
- Kokoro v1.1 speaker ids: 0 af_maple, 1 af_sol, 2 bf_vale (English), 3+ Chinese voices (`VOICES` in words.js).
- **Dictionary forms**: Wiktionary has a page for some forms ("ran" = yarn) → `lookup_en` shows the lemma when the form's own page has no Thai.
- Readability is a classic script (`vendor/Readability.js` defines global `Readability`) — load it with a plain `<script>` before the module.
- Inline `onerror=` handlers are blocked by the CSP — attach listeners in JS (thumbnails).
- ffmpeg stream lines: the language is in `Stream #0:2(eng):` — parse only the part before the first `": "`, or "(srt)" becomes the language.
- Synthetic `KeyboardEvent` passed straight to a handler has `target = null` (`.closest` throws) — the `key:` test hook dispatches on `document.body`.
- `util::video_dir()` must not create the folder (about_info calls it every start → an empty `Videos\Prism LLearn` for users who never download).
- Downloads from my shell land in the user's real Videos folder (only AppData is virtualised) — clean up after tests.
- The page autosaves activity every 5 s while learning (state.json is small; keep it that way: lesson data goes to src\<id>.json).
- **whisper-server is shared by name with Prism VoiceOpen** — never `taskkill /IM whisper-server.exe` in tests; stop only processes under `prism-llearn` (PowerShell `Get-Process | ? Path -like '*prism-llearn*'`).
- whisper on the RX 6600: turbo ≈ 8× realtime; small is NOT faster; DTW (needs -nfa) and built-in VAD (CPU) are both slow — details in phase2-plan.md.
- **whisper speed on the RX 6600 (2026-11-25)**: turbo q5_0 ≈ 8–14× real time, small is NOT faster on the card (per-window cost
  dominates; turbo has only 4 decoder layers). DTW timestamps need flash-attn off → 3× slower; built-in silero VAD runs on the CPU
  (+8 s per 120 s); beam 5 = same speed but lost punctuation. → greedy, flash-attn on, our own loudness check skips quiet pieces.
  CPU (-ng): turbo ≈ 1× real time (the dialog says so; Fast mode ~3× quicker).
- whisper-server `verbose_json` "words" are BPE tokens, not words: a token starting with a space starts a new English word; Chinese
  tokens start a word at a CJK character. Token timestamps of the first word after music are often the piece start (no DTW).
- Server default `no_context=true` → pass the previous lines as `prompt` (Chinese: "以下是普通话的句子。" + previous → simplified).
- Live: `audio_ctx = seconds×50 + 96` makes an 8 s phrase ~0.5 s instead of ~2 s (whisper pads to 30 s otherwise).
- **Creating a WebviewWindow inside a synchronous Tauri command deadlocks on Windows** → `live_open` is `#[tauri::command(async)]`.
- A transparent window captured with PrintWindow shows black where it is see-through (test screenshots only).
- **Testing live subtitles must not listen to what the user plays**: `PRISM_LIVE_WAV=<16 kHz wav>` feeds a file instead (the speaker
  device is only opened and closed). Never play test sound through the speakers.
- **Never `taskkill /IM whisper-server.exe`**: Prism VoiceOpen runs one too. Our servers die with us (job object).
- yt-dlp `progress._percent_str` is "N/A" on Bilibili → the template also prints downloaded/total bytes (`util::dl_frac`).
- Bilibili downloads are slow (rate-limited); search (`bilisearch`) returns HTTP 412; some old BV links are geo-blocked.
- Bilibili thumbnails are `http://` → turned into https (CSP `img-src https:`).
- Opening a lesson before the queue resumed (2.5 s after start) showed saved partial AI lines + the re-sent pieces twice → the page
  asks Rust (`asr:result`) whenever a job is unfinished (`S.asrQ`) and resyncs if it doesn't know which piece comes next.
- **Don't patch JS regexes with sed**: a sed edit produced `/^http:///i` → the `//` became a comment and the whole page stopped
  loading. Use the Edit tool / Python, then `node --check` every file.

## Prism Shot link (2026-11-25)
- `src-tauri/src/llama_share.rs` is the same file in prism-shot — change both. Keep `-c` = `share::CTX` (a server with a
  smaller context is never borrowed).
- Testing: `PrismLLearnBuild\test\llrun.sh` (test copy in `app\bin-test\`, own AppData under `test\tenv\`,
  `PRISM_OFFSCREEN=1`). The old `run.sh` uses the real AppData path (virtualised in Claude's shell) and shows the window on
  the user's screen — prefer llrun.sh. `LL_LOCAL=<dir>` shares LOCALAPPDATA with Prism Shot's test env (shared-translator test).

- **GitHub Releases refuse files over 2 GB** → the translator GGUF (2.5 GB) is never in the release; `tools/stage-runtime.sh` drops `models/*.gguf` and the app downloads it (`tr::download`). Keep each release file under 2 GB (now ~1.3 GB).

## Bug hunt 2026-11-27
- **Never copy the current file to .bak blindly** before a save: if it is damaged, the good backup is gone after one autosave.
  `util::write_safe` only keeps a `.json` as .bak when it parses; loads go through `util::read_json_or_bak`.
- **curl downloads need `--fail`**, or a 4xx/5xx page is saved as the file — with `-C -` resume it becomes the first bytes of a
  "model". Check exact size + magic (`GGUF`) before accepting a model. (Prism Shot downloads the same model — check its code too.)
- **yt-dlp goes stale**: YouTube changes break old versions within weeks. `yt.rs` runs `yt-dlp -U` once per run on an unexplained
  failure; a successful update prints "Updated yt-dlp to …". Tests: `PRISM_NOYTUPDATE=1` so a test never changes the user's runtime.
- yt-dlp without `--socket-timeout` can wait for ever on a stalled connection (the page spinner never ends).
- `llrun.sh` needs `app/bin-test/` (exe + WebView2Loader.dll copied from app/bin) — it is NOT in .gitignore: delete it after tests.
