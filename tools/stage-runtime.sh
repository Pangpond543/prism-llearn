#!/usr/bin/env bash
# Copies app/bin/runtime next to the exe for a release (called by ../tools/release/tauri-release.sh with the target
# folder) — WITHOUT the translator model (models/*.gguf, 2.5 GB: over GitHub's 2 GB per-file limit; the app downloads it
# from Hugging Face when the user presses "โหลดตัวแปล" on Home, see tr::download). Everything else ships:
# yt-dlp, ffmpeg, llama.cpp, Kokoro voices, dictionaries, whisper.cpp + its models.
set -euo pipefail
OUT="$1"
mkdir -p "$OUT"
cp -r app/bin/runtime/. "$OUT/"
rm -f "$OUT"/models/*.gguf "$OUT"/models/*.part "$OUT/whisper/whisper-cli.exe"
du -sh "$OUT"
