# Prism LLearn — features

## Home (หน้าแรก)
- Paste box: YouTube link / video id, web link, or plain English / Chinese text → Enter starts a lesson. Ctrl+V anywhere (outside a text box) does the same; links / text dragged from a browser too.
- Streak card (flame lights up), daily goal ring (minutes, click to change 5–60), cards to review, learning, known words (click → page).
- **Learning heatmap** (GitHub contribution graph): 53 weeks × 7 days, Sunday first, month / weekday labels, squares grow with the window (11–20 px).
  Level from a day score = minutes + 0.35·reviews + 0.8·new cards + 0.5·dictation lines + 0.15·look-ups; a day counts when score ≥ 1;
  levels 1–4 relative to the goal. Hover = date + numbers; click = day detail (minutes, reviews, new, typed lines, look-ups, the words added, the lessons opened).
- Recent lessons (YouTube thumbnail / icon, offline badge, progress bar, delete with confirm — also deletes a kept video file).
- Settings: translator status (no model → "โหลดตัวแปล (2.5 GB ฟรี)" button, % while downloading, resumes a cut download), English / Chinese voice (+ try), voice speed, new cards per day, say the word on click, vocabulary check (en / zh).
- First run: welcome + vocabulary check (5 levels × 8 words from frequency bands) → marks the common words up to that level as known.

## Learn (เรียน)
- YouTube: yt-dlp reads the details; picks the best English / Chinese track (manual > auto, the language spoken); track switcher.
  Auto captions are rebuilt into lines from word timings (pause > 1.3 s, sentence end, ~11 words) and show karaoke (spoken words coloured).
  Played in YouTube's embed (no YouTube script in our page; YouTube's own captions are unloaded).
- Keep for offline: downloads ≤720p mp4 into `Videos\Prism LLearn` with progress; then plays from the file (toggle file / YouTube).
- Web page: Readability article → paragraphs → sentences (wiki references [1] removed); read aloud sentence by sentence (Space) with the offline voice.
- Video files: open (Ctrl+O / dock / drop) mp4 mkv webm mov avi ts mp3 m4a; subtitles next to it (`name.srt`, `name.en.srt` …), dropped with it,
  dropped later, picked with the button, or inside the file (mkv); files the web view can't play are remuxed, then converted to h264.
- Lines list (right): time / speaker button, words coloured (new = gold, learning = blue, known = plain), Thai under each line, ✓ "I know every word in this line".
  Current line highlighted and followed (pauses following while the user scrolls). Big current line under the video.
- Thai translation of every line by TranslateGemma 4B on the graphics card (CPU fallback), current line first, cached forever; progress "translated n/m".
- Controls: prev / play / next, repeat line (R), pause after each line (A), listen-and-type (D), speed 0.5–1.5×, Thai on/off (T), pinyin on/off (zh), text size ±.
- Listen and type: plays one line and stops; type, Enter = word-level (Chinese: character) check with % score, missing words red; Tab replay, 0.7× replay, hint (first letters), Ctrl+←/→.
- Chinese: words split with the CC-CEDICT word list (max match), pinyin above (ruby), traditional characters looked up as simplified.
- Select several words with the mouse → look up the phrase ("ran into" → run into).

## Word card (คลิกคำ)
- Word, voice (Kokoro offline; Windows voice as fallback), play the sentence from the video (P).
- Reading: IPA (Wiktionary) / pinyin; base form ("ran" → run); frequency rank (en) / HSK 3.0 level (zh).
- Thai meanings: VOLUBILIS + Wiktionary (en), VOLUBILIS (zh); the one that appears in the sentence's Thai translation is marked "in this sentence" and goes first;
  no Thai in the dictionary → the word is translated by the offline model. English definitions per part of speech.
- Sentence + its Thai. Keep as card (S) (click a meaning chip to keep with that meaning), Known (K), Skip (X), delete card.
- The 120 commonest English / 60 commonest Chinese words are never highlighted unless kept.

## Review (ทบทวน)
- Due cards (learning first, then reviews mixed with new cards, new per day limit), language filter, "review more" when nothing is due.
- Card: word, reading, sentence with the word marked; Space shows meaning (editable), English, sentence Thai, source (opens the lesson at that line).
- Listen (V), play the clip where the word was found (P — YouTube embed or the file, plays that line and stops), read the sentence.
- Grades 1–4 with the next interval shown (FSRS-4.5, learning steps 1 / 6 / 10 min); learning cards come back in the same session.
- Cards with an interval ≥ 120 days become "known" words (no more highlight).

## Words (คลังคำ)
- All cards: search, language filter, all / due / not reviewed / added today / known / skipped; edit meaning inline; play; open source; delete (confirm).
- Known / skipped words as chips (click = back to new). Export CSV (UTF-8 BOM for Excel) or Anki import file (tab separated, HTML, tags).

## Shell
- Prism suite shell: title bar (logo gold "A" bubble, by 543, streak chip), TH / EN, appearance menu, About + updater (repo not set), F1 shortcuts page.
- Ctrl+1–4 pages, Ctrl+L paste link, Ctrl+O open video. Active learning time counted every 5 s while a video plays or the user works on Learn / Review (input in the last minute).

## AI subtitles (ซับด้วย AI) — v1.1.0
- When a YouTube video, a video file or another site's video has no English / Chinese subtitles, the lesson opens and AI on the PC
  (whisper large-v3-turbo, graphics card; CPU if the card fails) writes them. Setting "ทำซับเองเมื่อคลิปไม่มีซับ" (on by default).
- Panel while working: phase (getting the sound / taking out the sound / listening n/total parts), bar, time left, cancel.
  Lines appear piece by piece (~90 s each) and get translated / coloured like any subtitles. Stats line: "AI กำลังฟัง …" chip with ×.
- Resume: cancelled / closed / crashed jobs keep the pieces already heard; reopening continues (AI menu "ทำซับต่อจากที่ค้างไว้";
  unfinished jobs restart by themselves 2.5 s after the app starts). Finished = cached forever (switching tracks costs nothing).
- Home: "คิวทำซับด้วย AI" card (title → open lesson, progress, ×). Lessons with AI lines show a ✨ badge.
- AI button in the lesson bar (menu): use AI subtitles / redo all (dialog: Accurate | Fast, language Auto | English | Chinese),
  edit (E), hear this line again, Shift+click range help, undo, export .srt / .srt + Thai / .vtt / .txt, live subtitles.
- Track list: YouTube tracks + "✨ AI ในเครื่อง"; files / sites: their own subtitles ("ซับเดิม") ↔ AI.
- Lines: sentence ends, pauses > 0.7 s, commas when long; too long → cut at the biggest pause, never inside a Chinese dictionary word.
  Chinese simplified (prompt + CC-CEDICT traditional→simplified). Karaoke from word timings for every timed lesson.
  Words whisper was unsure of (p < 0.45) have a dotted orange underline.
- Edit mode (E or AI menu): click a line → text box + bar: save (Enter), cancel (Esc), play, split at cursor (Ctrl+Enter), join with
  next, start −/+0.25 s, delete, "ให้ AI ฟังใหม่". Ctrl+Z undoes (40 steps). AI-line edits are saved to the AI result too.
- Hear again: Shift+click the times of the first and last line → "เลือก n บรรทัด · ให้ AI ฟังใหม่"; the part (±0.4 s) is heard again
  with the accurate model and replaces those lines (undo with Ctrl+Z).

## Other video sites — v1.1.0
- Links from Bilibili, b23.tv, TikTok, Douyin, Facebook watch/reel, Instagram reels, X/Twitter status, TED talks, Vimeo, Dailymotion,
  Twitch, Youku, iQiyi, v.qq, Weibo tv, NicoNico, SoundCloud, Apple Podcasts, archive.org, direct .mp4/.mp3/.m3u8 links → video lesson.
  Any other link whose page has no article (or is a video page) is tried as a video too.
- The site's English / Chinese subtitles are used when it has them; otherwise AI. The video (≤720p) downloads into
  Videos\Prism LLearn with progress (byte-based for sites without percent); AI listens to the sound at the same time.

## Live subtitles (ซับสด) — v1.1.0
- Ctrl+Shift+L, dock ear button, Home setting "ซับสดจากเสียงในคอม", AI menu. A frosted strip at the bottom of the screen, always on top,
  movable (drag the bar), resizable. Hears whatever the default speakers play (WASAPI loopback; nothing is recorded to disk).
- Draft text while a phrase is spoken (italic), final line at a pause (or at the quietest moment after ~9 s of talk), Thai under it.
  Bar: state + level meter, language Auto / EN / 中文, Thai on/off, text size, background opacity, pause, close.
- Click a word → small card: Thai meanings, reading, voice, "เก็บเป็นบัตรคำ" (the card is saved by the main window).
- When it stops, a session of 3 or more lines is kept as a reading lesson "ซับสด <date time>" (setting "เก็บซับสดเป็นบทเรียน").

## From Prism Shot — 2026-11-25
- Words kept in Prism Shot (click a word in a screenshot's text → "เก็บเข้า LLearn") arrive as cards with the sentence, its
  Thai and the screenshot text as their source lesson; toast "รับคำจาก Prism Shot". "เรียนใน LLearn" in Prism Shot opens the
  captured text here as a lesson. Works when LLearn was closed (they wait in the inbox).
- One translator for both apps: whichever app loaded TranslateGemma first, the other uses it (no second model in the graphics card).
