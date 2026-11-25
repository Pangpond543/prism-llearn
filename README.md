# Prism LLearn

**TH** — เรียนภาษาอังกฤษ / จีน จากคลิปและเว็บที่คุณชอบดู: วางลิงก์ YouTube, Bilibili, TikTok หรือเว็บบทความ (หรือเปิดไฟล์วิดีโอในเครื่อง)
แล้วได้บทเรียนพร้อมซับและ **คำแปลไทยทุกบรรทัด** คลิกคำไหนก็ดูความหมาย คำอ่าน ฟังเสียง แล้วเก็บเป็นบัตรคำทบทวนแบบ FSRS
คลิปไม่มีซับ **AI ในเครื่องเขียนซับให้** ฝึกฟังแล้วพิมพ์ ซับสดจากเสียงในคอม และตารางการเรียนทั้งปี — **ฟรีและทำงานในเครื่องทั้งหมด**
(ใช้เน็ตแค่ตอนเปิดคลิป/เว็บ)

**EN** — Learn English / Chinese from the clips and pages you already enjoy: paste a YouTube, Bilibili, TikTok or article link
(or open a video file) and get a lesson with subtitles and **Thai under every line**. Click any word for its meaning, reading
and voice, keep it as a card and review it with FSRS. No subtitles? **AI on your PC writes them.** Listen-and-type practice,
live subtitles from your PC's sound and a year heatmap — **free and fully offline** (internet only to open clips and pages).

คู่มือแบบชี้แล้วรู้ / Point-and-learn guide: https://pangpond543.github.io/prism/llearn.html

## ดาวน์โหลด / Download

ไปที่หน้า **[Releases](../../releases/latest)** แล้วเลือกไฟล์ใดไฟล์หนึ่ง (Windows 10/11, 64-bit, ~1.4 GB) /
Go to the **[Releases page](../../releases/latest)** and pick one (~1.4 GB):

| ไฟล์ / File | ใช้เมื่อ / For |
| --- | --- |
| `Prism-LLearn-x.y.z-Setup.exe` | **แนะนำ** — ตัวติดตั้ง มีไอคอนบนเดสก์ท็อปและเมนู Start · **Recommended** — installer with shortcuts |
| `Prism-LLearn-x.y.z-Portable.zip` | ไม่ต้องติดตั้ง — แตกไฟล์แล้วดับเบิลคลิก `prism-llearn.exe` · No install — unzip and run |

**ครั้งแรกที่เปิด / First run:** ตัวแปลภาษา (TranslateGemma 4B, 2.5 GB) ไม่ได้อยู่ในไฟล์ดาวน์โหลด เพราะ GitHub จำกัดไฟล์ละ 2 GB —
กดปุ่ม **"โหลดตัวแปล (2.5 GB ฟรี)"** ในหน้าแรก โปรแกรมโหลดจาก Hugging Face ให้ครั้งเดียว (หยุดแล้วโหลดต่อได้) ·
The translator model (TranslateGemma 4B, 2.5 GB) is not in the download (GitHub's 2 GB file limit) — press **"Get translator
(2.5 GB, free)"** on Home and the app fetches it once from Hugging Face (resumable).

> **Windows เตือน "ไม่ทราบผู้เผยแพร่" / SmartScreen warning** — กด **ข้อมูลเพิ่มเติม → เรียกใช้อยู่ดี** · Click **More info → Run anyway**.

การ์ดจอที่รองรับ Vulkan จะแปลและทำซับได้เร็วที่สุด ไม่มีก็ใช้ CPU ได้ (ช้ากว่า) ·
A Vulkan graphics card is fastest for translation and AI subtitles; it falls back to the CPU otherwise.

## Build from source
Tauri 2 + Rust (GNU toolchain + WinLibs). `bash tools/build.sh` (exe → `app/bin`); the AI runtime (`app/bin/runtime`:
yt-dlp, ffmpeg, llama.cpp, sherpa-onnx + Kokoro, whisper.cpp, dictionaries from `tools/dict/build.py`) is described in
`CLAUDE.md`. Release: `bash ../tools/release/tauri-release.sh prism-llearn "Prism LLearn" prism-llearn PrismLLearnBuild "" --runtime prism-llearn/tools/stage-runtime.sh`.

## Licenses
MIT — © 2026 Thanakorn Damrikitjaroen. Made with Claude AI.
Bundled: llama.cpp & whisper.cpp (MIT), Whisper models (MIT), sherpa-onnx (Apache-2.0), Kokoro voices (Apache-2.0),
yt-dlp (Unlicense), FFmpeg (LGPL/GPL, see ffmpeg.org), Readability.js (Apache-2.0); dictionaries from Wiktionary (via kaikki.org),
VOLUBILIS, CC-CEDICT (CC BY-SA — see `runtime/dict/LICENSES.txt`). Downloaded on first use: TranslateGemma (Gemma Terms of Use).
