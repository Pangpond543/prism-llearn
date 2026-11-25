#!/usr/bin/env bash
# Build Prism LLearn and put the exe where the desktop shortcut points (app/bin). Dev helper — not for the user.
# The page (app/renderer) is embedded in the exe; the tools and models live in app/bin/runtime (not rebuilt here).
set -e
cd "$(dirname "$0")/.."
W=$(cygpath -u "$(ls -d "$LOCALAPPDATA/Microsoft/WinGet/Packages/"*WinLibs*/mingw64/bin | head -1)")
export PATH="$W:$HOME/.cargo/bin:$HOME/.rustup/toolchains/stable-x86_64-pc-windows-gnu/bin:$PATH"
export CARGO_TARGET_DIR="$USERPROFILE/PrismLLearnBuild/target"      # NEVER under AppData
touch app/src-tauri/build.rs   # tauri-build misses a changed icon.ico otherwise (docs/brand.md)
cargo build --release --manifest-path app/src-tauri/Cargo.toml
taskkill //F //IM prism-llearn.exe 2>/dev/null || true
sleep 1
mkdir -p app/bin
cp "$CARGO_TARGET_DIR/release/prism-llearn.exe" app/bin/
[ -f "$CARGO_TARGET_DIR/release/WebView2Loader.dll" ] && cp "$CARGO_TARGET_DIR/release/WebView2Loader.dll" app/bin/ || true
ls -l app/bin/prism-llearn.exe
