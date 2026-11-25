// One translator for the Prism suite (Prism Shot ↔ Prism LLearn). THE SAME FILE lives in both apps — keep them equal.
// Whoever starts llama-server (TranslateGemma) writes %LOCALAPPDATA%\Prism\llama.json; the other app sends its text to
// that server instead of loading the same 2.5 GB model into the graphics card a second time, and touches llama.used
// while it does, so the owner does not stop the server as idle. Each app keeps its own translation cache and also reads
// the other's (same key: hash of "tg4|src|tgt|text", same prompt).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Context size both apps start llama-server with (a borrowed server must fit the longest text either app sends).
pub const CTX: u32 = 4096;

fn local() -> PathBuf { PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()) }
fn dir() -> PathBuf { local().join("Prism") }
fn reg() -> Option<Value> { std::fs::read_to_string(dir().join("llama.json")).ok().and_then(|s| serde_json::from_str(&s).ok()) }
fn file_name(p: &Path) -> String { p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default() }

/// We started a server: tell the other app.
pub fn publish(app: &str, pid: u32, port: u16, model: &Path, gpu: bool) {
    let _ = std::fs::create_dir_all(dir());
    let v = json!({ "app": app, "pid": pid, "port": port, "model": file_name(model), "ctx": CTX, "gpu": gpu });
    let _ = std::fs::write(dir().join("llama.json"), v.to_string());
}
/// Our server stopped: remove the note (only if it is still ours).
pub fn unpublish(pid: u32) {
    if reg().map_or(false, |v| v["pid"].as_u64() == Some(pid as u64)) { let _ = std::fs::remove_file(dir().join("llama.json")); }
}
/// The other app's server, if it runs the same model and answers → (port, on the graphics card).
pub fn borrow(app: &str, model: &Path) -> Option<(u16, bool)> {
    let v = reg()?;
    if v["app"].as_str() == Some(app) { return None; } // our own (from a run that ended) — it died with us
    if v["model"].as_str() != Some(file_name(model).as_str()) || v["ctx"].as_u64().unwrap_or(0) < CTX as u64 { return None; }
    let port = v["port"].as_u64().filter(|p| *p > 0 && *p < 65536)? as u16;
    let ok = crate::util::local_post(port, "/tokenize", r#"{"content":"a"}"#, Duration::from_secs(2)).map_or(false, |b| b.contains("tokens"));
    ok.then(|| (port, v["gpu"].as_bool().unwrap_or(true)))
}
/// We just used the other app's server.
pub fn touch() { let _ = std::fs::create_dir_all(dir()); let _ = std::fs::write(dir().join("llama.used"), b"1"); }
/// Did the other app use our server within `d`?
pub fn used_within(d: Duration) -> bool {
    std::fs::metadata(dir().join("llama.used")).and_then(|m| m.modified()).ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok()).map_or(false, |e| e < d)
}
/// A translation the other app already made ("com.prism.llearn" / "com.prism.shot").
pub fn other_cache(other: &str, key: &str) -> Option<String> {
    std::fs::read_to_string(local().join(other).join("tr").join(format!("{key}.txt"))).ok().filter(|s| !s.trim().is_empty())
}
