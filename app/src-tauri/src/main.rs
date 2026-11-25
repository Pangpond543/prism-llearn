// Prism LLearn — learn English and Chinese from YouTube videos, web pages and video files you like.
// The page (app/renderer, embedded in the exe) does the lessons; Rust provides the Prism shell (window buttons,
// About/update), saving, the offline dictionaries (dict.rs), translation (tr.rs, TranslateGemma in llama-server),
// the voice (tts.rs, Kokoro via sherpa-onnx), YouTube / web (yt.rs, yt-dlp + curl) and video files (media.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(non_snake_case)]

mod asr;
mod dict;
mod llama_share;
mod live;
mod media;
mod tr;
mod tts;
mod update;
mod util;
mod whisper;
mod yt;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use util::log;

const PKG_NAME: &str = "prism-llearn"; // app/package.json "name" — the updater refuses anything else
static APP: OnceLock<AppHandle> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
fn app_dir() -> PathBuf {
    let exe_dir = util::exe_dir();
    if exe_dir.join("prism.config.json").exists() { return exe_dir; }
    if let Some(up) = exe_dir.parent() { if up.join("prism.config.json").exists() { return up.to_path_buf(); } }
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(|p| p.to_path_buf()).unwrap_or_default();
    if src.join("prism.config.json").exists() { src } else { exe_dir }
}
fn repo() -> String {
    let cfg: Value = std::fs::read_to_string(app_dir().join("prism.config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let r = cfg["repo"].as_str().unwrap_or("").trim();
    let r = r.trim_start_matches("https://github.com/").trim_end_matches(".git").trim_matches('/');
    if update::valid_repo(r) { r.to_string() } else { String::new() }
}
fn main_win() -> Option<WebviewWindow> { APP.get().and_then(|a| a.get_webview_window("main")) }
fn emit(ev: &str, v: Value) { if let Some(a) = APP.get() { let _ = a.emit(ev, v); } }

/* ------------------------------------------------------------ shell */
#[tauri::command]
fn app_log(a: String) { log(&a.chars().take(600).collect::<String>()); }
#[tauri::command]
fn win_min(window: WebviewWindow) { let _ = window.minimize(); }
#[tauri::command]
fn win_max(window: WebviewWindow) { let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() }; }
#[tauri::command]
fn win_close(app: AppHandle) { log("quit"); tr::stop(); live::stop(); whisper::stop_all(); app.exit(0); }
#[tauri::command]
fn win_full(window: WebviewWindow, a: bool) { let _ = window.set_fullscreen(a); }
#[tauri::command]
fn app_ready(window: WebviewWindow) {
    // test runs (PRISM_OFFSCREEN=1): the window lives off-screen and never takes the focus from the user
    if std::env::var("PRISM_OFFSCREEN").is_ok() { let _ = window.set_position(tauri::PhysicalPosition::new(-32000, 0)); let _ = window.show(); log("page ready (off-screen test)"); return; }
    let _ = window.show(); let _ = window.set_focus(); log("page ready");
}
#[tauri::command]
fn app_relaunch(app: AppHandle) {
    tr::stop();
    if let Some(setup) = PENDING_SETUP.lock().ok().and_then(|mut p| p.take()) {
        if setup.exists() && std::process::Command::new(&setup).arg("/S").arg("/RELAUNCH").spawn().is_ok() { app.exit(0); return; }
    }
    app.restart();
}
static PENDING_SETUP: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
#[tauri::command]
fn app_args() -> Value { Value::Array(std::env::args().skip(1).filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file()).map(Value::String).collect()) }
#[tauri::command]
fn app_lang(a: String) { util::LANG_EN.store(a == "en", std::sync::atomic::Ordering::Relaxed); }
#[tauri::command]
fn about_info() -> Value {
    json!({ "version": env!("CARGO_PKG_VERSION"), "repo": repo(), "tauri": tauri::VERSION, "test": std::env::var("PRISM_ACT").unwrap_or_default(),
            "data": util::data_dir(), "videos": util::video_dir() })
}
#[tauri::command]
fn about_openRepo() { let r = repo(); if !r.is_empty() { let _ = std::process::Command::new("explorer").arg(format!("https://github.com/{r}")).spawn(); } }
#[tauri::command(async)]
fn update_check() -> Value { update::check(&repo(), env!("CARGO_PKG_VERSION")) }
#[tauri::command(async)]
fn update_apply(app: AppHandle) -> Value {
    let c = update::check(&repo(), env!("CARGO_PKG_VERSION"));
    if c["ok"] != true { return c; }
    if c["hasUpdate"] != true { return json!({ "ok": false, "reason": "uptodate" }); }
    if !app_dir().join("src-tauri").exists() {
        let (r, setup) = update::apply_release(&c, &util::exe_dir(), &|step| { let _ = app.emit("update:step", json!({ "step": step, "f": 0 })); });
        if let (Some(s), Ok(mut p)) = (setup, PENDING_SETUP.lock()) { *p = Some(s); }
        return r;
    }
    update::apply(c["zip"].as_str().unwrap_or(""), &app_dir(), PKG_NAME, &|step| { let _ = app.emit("update:step", json!({ "step": step, "f": 0 })); })
}
/// Opens a web link in the user's browser (YouTube page, dictionary sources). Only http(s).
#[tauri::command]
fn open_url(a: String) { if a.starts_with("https://") || a.starts_with("http://") { let _ = std::process::Command::new("explorer").arg(a).spawn(); } }
#[tauri::command]
fn reveal(a: String) { let p = PathBuf::from(&a); if p.exists() { let _ = std::process::Command::new("explorer").arg(if p.is_dir() { a } else { format!("/select,{a}") }).spawn(); } }

/* ------------------------------------------------------------ saving */
// state.json = words, cards, activity, settings (the page's whole state); src\<id>.json = one lesson (subtitles,
// translations). Written through a temp file with a .bak of the last good copy.
#[tauri::command(async)]
fn db_load() -> String {
    let p = util::data_dir().join("state.json");
    match std::fs::read_to_string(&p) {
        Ok(s) if serde_json::from_str::<Value>(&s).is_ok() => s,
        Ok(_) => { log("state.json broken — using state.bak"); std::fs::read_to_string(p.with_extension("bak")).unwrap_or_default() }
        Err(_) => String::new(),
    }
}
#[tauri::command(async)]
fn db_save(a: String) -> bool { util::write_safe(&util::data_dir().join("state.json"), a.as_bytes()) }
fn src_path(id: &str) -> Option<PathBuf> {
    let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if id.is_empty() { return None; }
    let d = util::data_dir().join("src");
    let _ = std::fs::create_dir_all(&d);
    Some(d.join(format!("{id}.json")))
}
#[tauri::command(async)]
fn src_save(a: Value) -> bool { src_path(a["id"].as_str().unwrap_or("")).map_or(false, |p| util::write_safe(&p, a["data"].as_str().unwrap_or("").as_bytes())) }
#[tauri::command(async)]
fn src_load(a: String) -> String { src_path(&a).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default() }
#[tauri::command(async)]
fn src_del(a: Value) -> bool {
    // a video kept for offline goes to the Recycle Bin-free delete only when it lives in our Videos folder
    if let Some(v) = a["video"].as_str() { let p = PathBuf::from(v); if p.starts_with(util::video_dir()) { let _ = std::fs::remove_file(p); } }
    src_path(a["id"].as_str().unwrap_or("")).map_or(false, |p| { let _ = std::fs::remove_file(p.with_extension("bak")); std::fs::remove_file(p).is_ok() })
}

/* ------------------------------------------------------------ dictionary / translation / voice */
#[tauri::command(async)]
fn dict_en(a: String) -> Value { dict::lookup_en(&a) }
#[tauri::command(async)]
fn dict_zh(a: String) -> Value { dict::lookup_zh(&a) }
#[tauri::command(async)]
fn dict_zhwords() -> String { dict::zh_words() }
#[tauri::command(async)]
fn dict_top(a: Value) -> Value { dict::top(a["lang"].as_str().unwrap_or("en"), a["n"].as_u64().unwrap_or(5000) as usize) }
#[tauri::command(async)]
fn dict_enmany(a: Vec<String>) -> Value { dict::en_many(&a) }
#[tauri::command(async)]
fn dict_zhmany(a: Vec<String>) -> Value { dict::zh_many(&a) }
#[tauri::command(async)]
fn tr_text(a: Value) -> Value { tr::translate(&a) }
#[tauri::command]
fn tr_warm() { tr::warm(); }
#[tauri::command]
fn tr_state() -> Value { tr::state() }
#[tauri::command]
fn tr_download() -> Value { tr::download() }
/// Words / texts handed over by Prism Shot (%APPDATA%\com.prism.llearn\inbox\*.json) — read once, then removed.
#[tauri::command]
fn inbox_take() -> Value {
    let d = util::data_dir().join("inbox");
    let Ok(rd) = std::fs::read_dir(&d) else { return json!([]) };
    let mut files: Vec<std::path::PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map_or(false, |x| x == "json")).collect();
    files.sort();
    let mut out = Vec::new();
    for p in files.into_iter().take(200) {
        if let Some(v) = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) { out.push(v); }
        let _ = std::fs::remove_file(&p);
    }
    if !out.is_empty() { log(&format!("inbox: {} item(s) from Prism Shot", out.len())); }
    Value::Array(out)
}
#[tauri::command(async)]
fn tts_say(a: Value) -> Value { tts::say(&a) }
#[tauri::command]
fn tts_warm() { tts::warm(); }

/* ------------------------------------------------------------ youtube / web / files */
#[tauri::command(async)]
fn yt_info(a: Value) -> Value { yt::info(&a) }
#[tauri::command(async)]
fn yt_subs(a: Value) -> Value { yt::subs(&a) }
#[tauri::command(async)]
fn yt_download(a: Value) -> Value { yt::download(&a, |v| emit("yt:progress", v)) }
#[tauri::command(async)]
fn yt_cancel(a: String) -> Value { yt::cancel(&a) }
#[tauri::command(async)]
fn web_get(a: Value) -> Value { yt::web(&a) }
#[tauri::command(async)]
fn media_open(a: Value) -> Value { media::open(&a) }
#[tauri::command(async)]
fn media_sub(a: Value) -> Value { media::sub(&a) }
#[tauri::command(async)]
fn media_convert(a: Value) -> Value { media::convert(&a, |v| emit("media:progress", v)) }
#[tauri::command]
fn media_url(a: String) -> Value { let p = PathBuf::from(&a); if p.is_file() { json!({ "ok": true, "url": media::register(&p) }) } else { json!({ "ok": false }) } }

#[tauri::command(async)]
fn site_info(a: Value) -> Value { yt::site_info(&a) }
#[tauri::command(async)]
fn site_sub(a: Value) -> Value { yt::site_sub(&a) }

/* ------------------------------------------------------------ AI subtitles (whisper) + live subtitles */
#[tauri::command(async)]
fn asr_add(a: Value) -> Value { asr::add(&a) }
#[tauri::command(async)]
fn asr_cancel(a: String) -> Value { asr::cancel(&a) }
#[tauri::command]
fn asr_state() -> Value { asr::state() }
#[tauri::command(async)]
fn asr_result(a: String) -> Value { asr::result(&a) }
#[tauri::command(async)]
fn asr_save(a: Value) -> Value { asr::save(&a) }
#[tauri::command(async)]
fn asr_drop(a: String) -> Value { asr::drop_cache(&a) }
#[tauri::command(async)]
fn live_start(a: Value) -> Value { live::start(&a) }
#[tauri::command]
fn live_set(a: Value) { live::set(&a); }
#[tauri::command]
fn live_stop() -> Value { live::stop() }
#[tauri::command]
fn live_state() -> Value { json!({ "on": live::on(), "device": whisper::device() }) }
/// the floating live-subtitle window (bottom centre of the screen, always on top)
#[tauri::command(async)] // a window built inside a synchronous command deadlocks on Windows
fn live_open(app: AppHandle) -> Value {
    if let Some(w) = app.get_webview_window("live") { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); return json!({ "ok": true }); }
    let (mut x, mut y, sw) = (200.0f64, 700.0f64, 1100.0f64);
    if let Ok(Some(m)) = app.primary_monitor() {
        let sc = m.scale_factor(); let sz = m.size(); let pos = m.position();
        let (w, h) = (sz.width as f64 / sc, sz.height as f64 / sc);
        x = pos.x as f64 / sc + (w - sw.min(w - 40.0)) / 2.0; y = pos.y as f64 / sc + h - 260.0;
    }
    match tauri::WebviewWindowBuilder::new(&app, "live", tauri::WebviewUrl::App("live.html".into()))
        .title("Prism LLearn — Live").inner_size(sw, 190.0).min_inner_size(420.0, 120.0).position(x, y)
        .decorations(false).transparent(true).shadow(false).always_on_top(true).skip_taskbar(false).resizable(true).focused(true).build() {
        Ok(_) => json!({ "ok": true }),
        Err(e) => { log(&format!("live window: {e}")); json!({ "ok": false }) }
    }
}
/// the live window asks the main window to do something with the learner's data (keep a card, open the session)
#[tauri::command]
fn live_tell(a: Value) { emit("live:tell", a); }
#[tauri::command]
fn live_close(app: AppHandle) { live::stop(); if let Some(w) = app.get_webview_window("live") { let _ = w.close(); } }

#[tauri::command(async)]
fn fs_write(a: Value) -> Value {
    let path = a["path"].as_str().unwrap_or("");
    if path.is_empty() { return json!({ "ok": false }); }
    let mut bytes = if a["bom"].as_bool().unwrap_or(false) { vec![0xEF, 0xBB, 0xBF] } else { vec![] };
    bytes.extend_from_slice(a["text"].as_str().unwrap_or("").as_bytes());
    let ok = std::fs::write(path, bytes).is_ok();
    log(&format!("write {path} ok={ok}"));
    json!({ "ok": ok })
}

/* ------------------------------------------------------------ dialogs */
unsafe fn dialog(save: bool, kind: &str, name: &str) -> Option<String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::*;
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let t = util::tr;
    let filters: Vec<(String, String)> = match kind {
        "media" => vec![(t("วิดีโอ / เสียง", "Video / audio").into(), media::VIDEO.iter().map(|e| format!("*.{e}")).collect::<Vec<_>>().join(";")), (t("ทุกไฟล์", "All files").into(), "*.*".into())],
        "sub" => vec![(t("ไฟล์ซับไตเติล", "Subtitle files").into(), "*.srt;*.vtt;*.ass;*.ssa".into()), (t("ทุกไฟล์", "All files").into(), "*.*".into())],
        "csv" => vec![("CSV".into(), "*.csv".into()), (t("ทุกไฟล์", "All files").into(), "*.*".into())],
        "txt" => vec![(t("ไฟล์ข้อความ (นำเข้า Anki)", "Text file (Anki import)").into(), "*.txt".into()), (t("ทุกไฟล์", "All files").into(), "*.*".into())],
        "json" => vec![("JSON".into(), "*.json".into()), (t("ทุกไฟล์", "All files").into(), "*.*".into())],
        _ => vec![(t("ทุกไฟล์", "All files").into(), "*.*".into())],
    };
    let names: Vec<Vec<u16>> = filters.iter().map(|(n, _)| wide(n)).collect();
    let specs: Vec<Vec<u16>> = filters.iter().map(|(_, s)| wide(s)).collect();
    let f: Vec<COMDLG_FILTERSPEC> = names.iter().zip(&specs).map(|(n, s)| COMDLG_FILTERSPEC { pszName: PCWSTR(n.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) }).collect();
    let owner = main_win().and_then(|w| w.hwnd().ok()).map(|h| windows::Win32::Foundation::HWND(h.0 as _));
    let d: IFileDialog = if save {
        let d: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        d.cast().ok()?
    } else {
        let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        d.cast().ok()?
    };
    let o = d.GetOptions().ok()?;
    d.SetOptions(o | FOS_FORCEFILESYSTEM | if save { FOS_OVERWRITEPROMPT } else { FOS_FILEMUSTEXIST }).ok()?;
    let _ = d.SetFileTypes(&f);
    if save {
        let n = wide(name);
        let _ = d.SetFileName(PCWSTR(n.as_ptr()));
        let ext = std::path::Path::new(name).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "txt".into());
        let e = wide(&ext);
        let _ = d.SetDefaultExtension(PCWSTR(e.as_ptr()));
    }
    d.Show(owner).ok()?;
    let it = d.GetResult().ok()?;
    let p = it.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
    let s = p.to_string().ok();
    CoTaskMemFree(Some(p.0 as _));
    s
}
#[tauri::command(async)]
fn pick_open(a: String) -> Value { match unsafe { dialog(false, &a, "") } { Some(p) => Value::String(p), None => Value::Null } }
#[tauri::command(async)]
fn pick_save(a: Value) -> Value { match unsafe { dialog(true, a["kind"].as_str().unwrap_or(""), a["name"].as_str().unwrap_or("export.txt")) } { Some(p) => Value::String(p), None => Value::Null } }

/* ------------------------------------------------------------ single instance */
fn single_instance() -> bool {
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let name = wide("Local\\PrismLLearn.single");
        let m = CreateMutexW(None, true, windows::core::PCWSTR(name.as_ptr()));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let t = wide("Prism LLearn");
            if let Ok(h) = FindWindowW(windows::core::PCWSTR::null(), windows::core::PCWSTR(t.as_ptr())) { let _ = ShowWindow(h, SW_RESTORE); let _ = SetForegroundWindow(h); }
            return false;
        }
        std::mem::forget(m);
    }
    true
}

/* ------------------------------------------------------------ white-page recovery */
fn watch_page(w: &WebviewWindow) {
    let _ = w.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = webview2_com::ProcessFailedEventHandler::create(Box::new(|sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            log(&format!("WEBVIEW FAILED kind={} (#{n})", kind.0));
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                if let Some(a) = APP.get() { a.restart(); }
            } else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE) && n <= 5 {
                if let Some(s) = sender { let _ = s.Reload(); }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

fn main() {
    if std::env::var("PRISM_MULTI").is_err() && !single_instance() { return; }
    std::panic::set_hook(Box::new(|i| log(&format!("PANIC {i}"))));
    update::clean_old(&util::exe_dir());
    {
        let exe = std::env::current_exe().unwrap_or_default();
        let mt = std::fs::metadata(&exe).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        log(&format!("START v{} exe={} exe_mtime={} runtime={} act={:?}", env!("CARGO_PKG_VERSION"), exe.display(), mt, util::runtime().display(), std::env::var("PRISM_ACT").ok()));
    }
    dict::warm();
    tr::idle_watch();
    asr::init(Box::new(|ev, v| emit(ev, v)));
    live::init(Box::new(|ev, v| emit(ev, v)));
    whisper::idle_watch(|slot| if slot == "live" { live::on() } else { asr::busy() });
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_log, win_min, win_max, win_close, win_full, app_ready, app_relaunch, app_args, app_lang, about_info, about_openRepo, update_check, update_apply,
            open_url, reveal, db_load, db_save, src_save, src_load, src_del,
            dict_en, dict_zh, dict_zhwords, dict_top, dict_enmany, dict_zhmany, tr_text, tr_warm, tr_state, tr_download, inbox_take, tts_say, tts_warm,
            yt_info, yt_subs, yt_download, yt_cancel, web_get, media_open, media_sub, media_convert, media_url, fs_write, pick_open, pick_save,
            site_info, site_sub, asr_add, asr_cancel, asr_state, asr_result, asr_save, asr_drop, live_start, live_set, live_stop, live_state, live_open, live_tell, live_close
        ])
        .register_asynchronous_uri_scheme_protocol("llearn", |_ctx, req, responder| { std::thread::spawn(move || responder.respond(media::serve(&req))); })
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            if let Some(w) = app.get_webview_window("main") { watch_page(&w); }
            std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_secs(6)); if let Some(w) = main_win() { if !w.is_visible().unwrap_or(true) { log("page not ready after 6 s — showing window"); let _ = w.show(); } } });
            Ok(())
        })
        .on_window_event(|w, e| {
            match e {
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    let _ = w.app_handle().emit("app:dragover", false);
                    let _ = w.app_handle().emit("app:drop", json!({ "paths": paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>() }));
                }
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { .. }) => { let _ = w.app_handle().emit("app:dragover", true); }
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => { let _ = w.app_handle().emit("app:dragover", false); }
                tauri::WindowEvent::Destroyed if w.label() == "main" => { tr::stop(); live::stop(); whisper::stop_all(); }
                tauri::WindowEvent::Destroyed if w.label() == "live" => { live::stop(); emit("live:state", json!({ "on": false, "closed": true })); }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Prism LLearn");
}
