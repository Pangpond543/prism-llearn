// Offline sentence translation: TranslateGemma 4B (runtime\models\*.gguf) in llama.cpp's llama-server (Vulkan → the
// graphics card; CPU if the card can't). The server starts on first use, stays warm while the user is learning and is
// unloaded after IDLE of no work. Every result is cached on disk (cache\tr\*.txt) so a line is translated only once.
use crate::util::{self, lock, log};
use serde_json::{json, Value};
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Srv { child: Child, port: u16, gpu: bool }
static SRV: Mutex<Option<Srv>> = Mutex::new(None);
static LAST: Mutex<Option<Instant>> = Mutex::new(None);
static BUSY: Mutex<()> = Mutex::new(()); // one translation at a time — the queue lives in the page
static STATE: Mutex<&'static str> = Mutex::new("off"); // off | loading | ready | fail | nomodel
static NO_GPU: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// Prism Shot's server we are using instead of our own (port, gpu) — see llama_share.rs
static BORROW: Mutex<Option<(u16, bool)>> = Mutex::new(None);
static NO_BORROW: Mutex<Option<Instant>> = Mutex::new(None);
use crate::llama_share as share;
fn share_on() -> bool { std::env::var("PRISM_NOSHARE").is_err() }
const IDLE: Duration = Duration::from_secs(15 * 60);

fn model() -> Option<std::path::PathBuf> {
    let d = util::runtime().join("models");
    let mut v: Vec<_> = std::fs::read_dir(&d).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().map_or(false, |x| x == "gguf") && p.file_name().map_or(false, |n| n.to_string_lossy().to_lowercase().contains("translategemma"))).collect();
    v.sort();
    v.pop()
}
/* --------------------------------------------------------- model download */
// The model (2.5 GB) is not in the GitHub download (2 GB per-file limit, and updates stay small): the first time,
// the user presses "download" on Home and it comes from Hugging Face (free) — same file and code as Prism Shot.
static DL: Mutex<Option<Value>> = Mutex::new(None);
const MODEL_FILE: &str = "translategemma-4b-it-Q4_K_M.gguf";
const MODEL_URL: &str = "https://huggingface.co/bullerwins/translategemma-4b-it-GGUF/resolve/main/translategemma-4b-it-Q4_K_M.gguf";
const MODEL_SIZE: f64 = 2_489_909_312.0;
pub fn download() -> Value {
    if model().is_some() { return json!({ "ok": true, "have": true }); }
    if lock(&DL).as_ref().map_or(false, |v| v.get("error").is_none()) { return json!({ "ok": true, "already": true }); }
    *lock(&DL) = Some(json!({ "f": 0.0 }));
    std::thread::spawn(|| {
        let dir = util::runtime().join("models");
        let _ = std::fs::create_dir_all(&dir);
        let part = dir.join(format!("{MODEL_FILE}.part"));
        let fin = dir.join(MODEL_FILE);
        let curl = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32").join("curl.exe");
        let mut c = util::hidden(&curl);
        // -C - resumes a half-finished download (closed app, lost Wi-Fi)
        c.args(["-sL", "--proto", "=https", "-C", "-", "--retry", "3", "-o"]).arg(&part).arg(MODEL_URL);
        let mut child = match c.spawn() { Ok(ch) => ch, Err(e) => { log(&format!("tr: download spawn failed: {e}")); *lock(&DL) = Some(json!({ "error": "spawn" })); return; } };
        util::kill_with_us(&child);
        log("tr: model download started");
        loop {
            if let Ok(Some(st)) = child.try_wait() {
                let len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                if st.success() && len as f64 >= MODEL_SIZE * 0.999 {
                    match std::fs::rename(&part, &fin) {
                        Ok(_) => { *lock(&DL) = None; *lock(&STATE) = "off"; log("tr: model downloaded"); }
                        Err(e) => { log(&format!("tr: rename failed: {e}")); *lock(&DL) = Some(json!({ "error": "disk" })); }
                    }
                } else {
                    log(&format!("tr: download stopped ({st}) at {len} bytes"));
                    *lock(&DL) = Some(json!({ "error": "network", "f": len as f64 / MODEL_SIZE }));
                }
                return;
            }
            let f = std::fs::metadata(&part).map(|m| m.len() as f64 / MODEL_SIZE).unwrap_or(0.0);
            *lock(&DL) = Some(json!({ "f": f.min(1.0) }));
            std::thread::sleep(Duration::from_millis(700));
        }
    });
    json!({ "ok": true })
}

pub fn state() -> Value {
    let s = *lock(&STATE);
    if model().is_none() {
        if let Some(d) = lock(&DL).clone() {
            let f = d["f"].as_f64().unwrap_or(0.0);
            return json!({ "state": if d.get("error").is_some() { "dlfail" } else { "downloading" }, "f": f, "error": d["error"], "size": MODEL_SIZE });
        }
        // a .part file = a download that was interrupted last time
        let part = util::runtime().join("models").join(format!("{MODEL_FILE}.part"));
        let f = std::fs::metadata(&part).map(|m| m.len() as f64 / MODEL_SIZE).unwrap_or(0.0);
        return json!({ "state": "nomodel", "f": f, "size": MODEL_SIZE });
    }
    json!({ "state": if s == "off" && model().is_none() { "nomodel" } else { s }, "gpu": lock(&SRV).as_ref().map(|s| s.gpu).or_else(|| lock(&BORROW).map(|b| b.1)), "borrowed": lock(&BORROW).is_some() })
}

fn start() -> Option<u16> {
    let mut g = lock(&SRV);
    if let Some(s) = g.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() { return Some(s.port); }
        log("tr: server had exited");
        *g = None;
    }
    let Some(m) = model() else { *lock(&STATE) = "nomodel"; return None };
    // Prism Shot already has the model loaded → use its server (one model in the graphics card, no reload)
    if share_on() && lock(&NO_BORROW).map_or(true, |t| Instant::now() > t) {
        if let Some((p, gpu)) = share::borrow("llearn", &m) {
            if lock(&BORROW).map(|b| b.0) != Some(p) { log(&format!("tr: using Prism Shot's translator (port {p})")); }
            *lock(&BORROW) = Some((p, gpu));
            *lock(&STATE) = "ready";
            return Some(p);
        }
    }
    *lock(&BORROW) = None;
    let dir = util::runtime().join("llama");
    let port = util::free_port();
    let gpu = !NO_GPU.load(std::sync::atomic::Ordering::Relaxed);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8).to_string();
    let mut c = util::hidden(&dir.join("llama-server.exe"));
    c.current_dir(&dir).arg("-m").arg(&m)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", &share::CTX.to_string(), "-np", "1", "-t", &threads, "--no-webui"])
        .args(if gpu { ["-ngl", "99"] } else { ["-ngl", "0"] })
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match c.spawn() {
        Ok(child) => {
            util::kill_with_us(&child);
            log(&format!("tr: llama-server pid={} port={port} gpu={gpu} model={}", child.id(), m.display()));
            share::publish("llearn", child.id(), port, &m, gpu);
            *g = Some(Srv { child, port, gpu });
            *lock(&STATE) = "loading";
            Some(port)
        }
        Err(e) => { log(&format!("tr: spawn failed {e}")); *lock(&STATE) = "fail"; None }
    }
}
fn wait_ready(port: u16) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(90) {
        if let Ok(b) = util::local_post(port, "/completion", r#"{"prompt":"hi","n_predict":1}"#, Duration::from_secs(30)) {
            if b.contains("content") { *lock(&STATE) = "ready"; log(&format!("tr: ready in {} ms", t0.elapsed().as_millis())); return true; }
        }
        // server died (card driver problem…) → try once more on the CPU
        if lock(&SRV).as_mut().map_or(true, |s| s.child.try_wait().ok().flatten().is_some()) { return false; }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}
/// Start the server in the background (the page calls this when a lesson opens, so the first line is quick).
pub fn warm() {
    std::thread::spawn(|| {
        let _b = lock(&BUSY);
        if let Some(p) = start() {
            if !wait_ready(p) { restart_cpu(); }
        }
    });
}
fn restart_cpu() {
    if NO_GPU.swap(true, std::sync::atomic::Ordering::Relaxed) { *lock(&STATE) = "fail"; return; }
    log("tr: GPU server failed — trying the CPU");
    stop();
    if let Some(p) = start() { if !wait_ready(p) { *lock(&STATE) = "fail"; } }
}
pub fn stop() {
    if let Some(mut s) = lock(&SRV).take() { share::unpublish(s.child.id()); let _ = s.child.kill(); let _ = s.child.wait(); log("tr: server stopped"); }
    *lock(&BORROW) = None;
    *lock(&STATE) = "off";
}
pub fn idle_watch() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        // idle = we did not use it, and Prism Shot (borrowing it) did not either
        let idle = lock(&LAST).map_or(false, |t| t.elapsed() > IDLE) && !share::used_within(IDLE);
        if idle && lock(&SRV).is_some() { if let Ok(_b) = BUSY.try_lock() { stop(); *lock(&LAST) = None; } }
    });
}

const NAMES: [(&str, &str); 4] = [("en", "English"), ("zh", "Chinese"), ("th", "Thai"), ("zh-Hant", "Chinese")];
fn name(code: &str) -> &'static str { NAMES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n).unwrap_or("English") }

/// {text, src: en|zh, tgt: th} → {ok, text, cached, ms}
pub fn translate(a: &Value) -> Value {
    let text = a["text"].as_str().unwrap_or("").trim().to_string();
    let src = a["src"].as_str().unwrap_or("en");
    let tgt = a["tgt"].as_str().unwrap_or("th");
    if text.is_empty() { return json!({ "ok": true, "text": "" }); }
    if text.chars().count() > 1500 { return json!({ "ok": false, "reason": "long" }); }
    let key = util::hash(&format!("tg4|{src}|{tgt}|{text}"));
    let cdir = util::cache_dir().join("tr");
    let cf = cdir.join(format!("{key}.txt"));
    if let Ok(s) = std::fs::read_to_string(&cf) { return json!({ "ok": true, "text": s, "cached": true }); }
    // Prism Shot translated this exact text already
    if share_on() { if let Some(s) = share::other_cache("com.prism.shot", &key) { let _ = std::fs::create_dir_all(&cdir); let _ = std::fs::write(&cf, &s); return json!({ "ok": true, "text": s, "cached": true }); } }
    *lock(&LAST) = Some(Instant::now());
    let _b = lock(&BUSY);
    let t0 = Instant::now();
    let Some(mut port) = start() else { return json!({ "ok": false, "reason": *lock(&STATE) }) };
    if *lock(&STATE) != "ready" && !wait_ready(port) {
        restart_cpu();
        match lock(&SRV).as_ref() { Some(s) if *lock(&STATE) == "ready" => port = s.port, _ => return json!({ "ok": false, "reason": "fail" }) }
    }
    let (s, t) = (name(src), name(tgt));
    // TranslateGemma's own prompt (from its chat template), sent raw so the language pair is exact
    let prompt = format!("<start_of_turn>user\nYou are a professional {s} ({src}) to {t} ({tgt}) translator. Your goal is to accurately convey the meaning and nuances of the original {s} text while adhering to {t} grammar, vocabulary, and cultural sensitivities.\nProduce only the {t} translation, without any additional explanations or commentary. Please translate the following {s} text into {t}:\n\n\n{text}<end_of_turn>\n<start_of_turn>model\n");
    let n = (text.chars().count() * 4).clamp(48, 1024);
    let body = json!({ "prompt": prompt, "n_predict": n, "temperature": 0, "cache_prompt": true, "stop": ["<end_of_turn>"] }).to_string();
    let r = util::local_post(port, "/completion", &body, Duration::from_secs(60));
    *lock(&LAST) = Some(Instant::now());
    if lock(&BORROW).map_or(false, |b| b.0 == port) {
        share::touch();
        if r.is_err() {
            // Prism Shot closed (its server went with it) → start our own and try once more
            log("tr: Prism Shot's translator went away — starting our own");
            *lock(&BORROW) = None;
            *lock(&NO_BORROW) = Some(Instant::now() + Duration::from_secs(120));
            *lock(&STATE) = "off";
            drop(_b);
            return translate(a);
        }
    }
    match r.ok().and_then(|b| serde_json::from_str::<Value>(&b).ok()) {
        Some(v) => {
            let out = v["content"].as_str().unwrap_or("").trim().to_string();
            if !out.is_empty() { let _ = std::fs::create_dir_all(&cdir); let _ = std::fs::write(&cf, &out); }
            json!({ "ok": true, "text": out, "ms": t0.elapsed().as_millis() as u64 })
        }
        None => { log("tr: request failed"); json!({ "ok": false, "reason": "fail" }) }
    }
}
