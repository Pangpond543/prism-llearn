// YouTube + web pages. yt-dlp (runtime\yt-dlp.exe) reads a video's details and its subtitle tracks; the subtitles are
// fetched as YouTube's json3 (word timings for auto captions). "Keep for offline" downloads the video into
// Videos\Prism LLearn with yt-dlp + ffmpeg. Web pages are fetched with the Windows curl; the page extracts the article.
use crate::util::{self, lock, log};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::Mutex;

static META: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
static JOBS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None); // video id → yt-dlp pid (downloads)

pub fn video_id(url: &str) -> Option<String> {
    let u = url.trim();
    let ok = |s: &str| s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok(u) { return Some(u.to_string()); }
    for key in ["v=", "youtu.be/", "/shorts/", "/embed/", "/live/"] {
        if let Some(i) = u.find(key) {
            let id: String = u[i + key.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            if ok(&id) && (u.contains("youtu") || key == "v=") { return Some(id); }
        }
    }
    None
}

fn ytdlp() -> std::process::Command {
    let mut c = util::hidden(&util::runtime().join("yt-dlp.exe"));
    // --socket-timeout: a stalled connection fails after 20 s instead of leaving the page waiting for ever
    c.current_dir(util::runtime()).env("PYTHONIOENCODING", "utf-8").args(["--no-warnings", "--no-playlist", "--encoding", "utf-8", "--socket-timeout", "20"]);
    c
}
fn have_ytdlp() -> bool { util::runtime().join("yt-dlp.exe").is_file() }
/// YouTube changes often and an old yt-dlp then fails on every video. On the first unexplained failure of a run,
/// let yt-dlp update itself (free, from its GitHub releases) and try once more. → true if it changed.
static UPDATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn self_update() -> bool {
    if UPDATED.swap(true, std::sync::atomic::Ordering::SeqCst) || std::env::var("PRISM_NOYTUPDATE").is_ok() { return false; }
    let o = util::hidden(&util::runtime().join("yt-dlp.exe")).current_dir(util::runtime()).args(["-U", "--no-warnings", "--socket-timeout", "20"]).output();
    let out = o.as_ref().map(|o| format!("{} {}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))).unwrap_or_default();
    let changed = out.contains("Updated yt-dlp to");
    log(&format!("yt: self-update → {}", out.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect::<String>()));
    changed
}
fn meta(id: &str, fresh: bool) -> Result<Value, String> {
    if !fresh { if let Some(v) = lock(&META).as_ref().and_then(|m| m.get(id)).cloned() { return Ok(v); } }
    if !have_ytdlp() { return Err("noruntime".into()); }
    let t0 = std::time::Instant::now();
    let run = || ytdlp().args(["-J", "--skip-download"]).arg(format!("https://www.youtube.com/watch?v={id}")).output().map_err(|e| e.to_string());
    let mut o = run()?;
    if !o.status.success() && generic_fail(&String::from_utf8_lossy(&o.stderr)) && self_update() { o = run()?; }
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr).to_string();
        log(&format!("yt: -J failed {id}: {}", err.chars().take(300).collect::<String>()));
        return Err(if err.contains("Private video") || err.contains("unavailable") { "unavailable".into() } else if err.contains("Sign in") { "signin".into() } else if err.contains("resolve") || err.contains("network") || err.contains("timed out") || err.contains("getaddrinfo") { "network".into() } else { "fail".into() });
    }
    let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
    log(&format!("yt: meta {id} in {} ms", t0.elapsed().as_millis()));
    lock(&META).get_or_insert_with(HashMap::new).insert(id.to_string(), v.clone());
    Ok(v)
}
/// A failure that is not "private / login / no internet" — often an outdated yt-dlp.
fn generic_fail(err: &str) -> bool {
    !(err.contains("Private video") || err.contains("unavailable") || err.contains("Sign in") || err.contains("login") || err.contains("cookies")
      || err.contains("resolve") || err.contains("getaddrinfo") || err.contains("timed out") || err.contains("network") || err.contains("Unsupported URL") || err.contains("No video") || err.contains("no video"))
}
fn learnable(code: &str) -> Option<&'static str> {
    let c = code.to_lowercase();
    if c == "en" || c.starts_with("en-") { Some("en") } else if c == "zh" || c.starts_with("zh-") || c == "yue" { Some("zh") } else { None }
}

/// {url} → {ok, id, title, channel, duration, thumb, lang, chapters, tracks:[{code, lang, auto, name}]}
pub fn info(a: &Value) -> Value {
    let url = a["url"].as_str().unwrap_or("");
    let Some(id) = video_id(url) else { return json!({ "ok": false, "reason": "badurl" }) };
    let m = match meta(&id, false) { Ok(m) => m, Err(r) => return json!({ "ok": false, "reason": r }) };
    let vlang = m["language"].as_str().unwrap_or("").to_lowercase();
    let mut tracks = vec![];
    for (kind, auto) in [("subtitles", false), ("automatic_captions", true)] {
        if let Some(o) = m[kind].as_object() {
            for (code, list) in o {
                let Some(l) = learnable(code) else { continue };
                // auto captions only in the language actually spoken (the others are machine translations of it)
                if auto && !(code.ends_with("-orig") || (!vlang.is_empty() && vlang.starts_with(l)) || (vlang.is_empty() && (code == "en" || code.starts_with("zh")))) { continue; }
                if auto && o.contains_key(&format!("{code}-orig")) { continue; }
                if !list.as_array().map_or(false, |a| a.iter().any(|f| f["ext"] == "json3")) { continue; }
                let name = list[0]["name"].as_str().unwrap_or(code).to_string();
                tracks.push(json!({ "code": code, "lang": l, "auto": auto, "name": name }));
            }
        }
    }
    json!({ "ok": true, "id": id, "title": m["title"], "channel": m["channel"].as_str().or(m["uploader"].as_str()), "duration": m["duration"],
            "thumb": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"), "lang": vlang, "chapters": m["chapters"], "tracks": tracks })
}

/// {id, code, auto} → {ok, json3: "<text>"}
pub fn subs(a: &Value) -> Value {
    let id = a["id"].as_str().unwrap_or("");
    let code = a["code"].as_str().unwrap_or("");
    let auto = a["auto"].as_bool().unwrap_or(false);
    for fresh in [false, true] {
        let m = match meta(id, fresh) { Ok(m) => m, Err(r) => return json!({ "ok": false, "reason": r }) };
        let kind = if auto { "automatic_captions" } else { "subtitles" };
        let Some(u) = m[kind][code].as_array().and_then(|a| a.iter().find(|f| f["ext"] == "json3")).and_then(|f| f["url"].as_str()) else { return json!({ "ok": false, "reason": "notrack" }) };
        let (st, body, _) = util::fetch(u, 20_000_000, 30);
        if st == 200 && !body.is_empty() { return json!({ "ok": true, "json3": String::from_utf8_lossy(&body) }); }
        log(&format!("yt: subs {id} {code} status {st}"));
        if st == 429 { return json!({ "ok": false, "reason": "busy" }); }
        if st == 0 { return json!({ "ok": false, "reason": "network" }); }
    }
    json!({ "ok": false, "reason": "fail" })
}

/// Keep for offline: {id, title} → downloads in the background; events "yt:progress" {id, f, done, path, error}
pub fn download(a: &Value, emit: impl Fn(Value) + Send + 'static) -> Value {
    let id = a["id"].as_str().unwrap_or("").to_string();
    // other sites (Bilibili, TikTok …): {id: "<site>-<video id>", url} — the file is named after the id
    let site_url = a["url"].as_str().filter(|u| u.starts_with("http")).map(String::from);
    if site_url.is_none() && video_id(&id).is_none() { return json!({ "ok": false }); }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return json!({ "ok": false }); }
    if lock(&JOBS).as_ref().map_or(false, |j| j.contains_key(&id)) { return json!({ "ok": true, "already": true }); }
    let dir = util::video_dir();
    let _ = std::fs::create_dir_all(&dir);
    let out = dir.join(format!("{id}.%(ext)s"));
    let mut c = ytdlp();
    c.args(["-f", "bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b", "--merge-output-format", "mp4", "--newline",
        "--progress-template", "download:@@%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s", "--print", "after_move:@@FILE %(filepath)s", "--ffmpeg-location"])
        .arg(util::runtime().join("ffmpeg.exe")).arg("-o").arg(&out).arg(site_url.clone().unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}")))
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    if !have_ytdlp() { return json!({ "ok": false, "reason": "noruntime" }); }
    let mut child = match c.spawn() { Ok(ch) => ch, Err(e) => return json!({ "ok": false, "reason": e.to_string() }) };
    util::kill_with_us(&child);
    lock(&JOBS).get_or_insert_with(HashMap::new).insert(id.clone(), child.id());
    log(&format!("yt: download {id} → {}", dir.display()));
    std::thread::spawn(move || {
        let mut path = String::new();
        let mut part = 0.0f64; // yt-dlp downloads video then audio: show one bar over both
        let mut last = -1.0f64;
        if let Some(so) = child.stdout.take() {
            for line in BufReader::new(so).lines().map_while(Result::ok) {
                if let Some(p) = line.strip_prefix("@@FILE ") { path = p.trim().to_string(); continue; }
                if let Some(p) = line.trim().strip_prefix("@@") {
                    let f = crate::util::dl_frac(p);
                    if f < last - 0.5 { part += 1.0; }
                    last = f;
                    emit(json!({ "id": id, "f": ((part + f) / 2.0).min(0.99) }));
                }
            }
        }
        let err = child.stderr.take().map(|e| { let mut s = String::new(); let _ = std::io::Read::read_to_string(&mut BufReader::new(e), &mut s); s }).unwrap_or_default();
        let ok = child.wait().map(|s| s.success()).unwrap_or(false) && !path.is_empty() && std::path::Path::new(&path).exists();
        lock(&JOBS).as_mut().map(|j| j.remove(&id));
        log(&format!("yt: download {id} ok={ok} {path} {}", if ok { String::new() } else { err.chars().take(300).collect() }));
        emit(json!({ "id": id, "f": 1.0, "done": true, "ok": ok, "path": path, "error": if ok { Value::Null } else { Value::String(err.chars().take(200).collect()) } }));
    });
    json!({ "ok": true })
}
pub fn cancel(id: &str) -> Value {
    if let Some(pid) = lock(&JOBS).as_mut().and_then(|j| j.remove(id)) {
        let _ = util::hidden(std::path::Path::new("taskkill")).args(["/F", "/T", "/PID", &pid.to_string()]).status();
        // remove the half-downloaded pieces
        if let Ok(rd) = std::fs::read_dir(util::video_dir()) { for e in rd.flatten() { let n = e.file_name().to_string_lossy().to_string(); if n.starts_with(id) && (n.ends_with(".part") || n.contains(".f") || n.ends_with(".ytdl")) { let _ = std::fs::remove_file(e.path()); } } }
        return json!({ "ok": true });
    }
    json!({ "ok": false })
}

pub fn b64pub(data: &[u8]) -> String { b64(data) }
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char); s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}
/// {url} → {ok, b64, url (after redirects)} — the page decodes (charset) and extracts the article
pub fn web(a: &Value) -> Value {
    let url = a["url"].as_str().unwrap_or("").trim();
    let url = if url.starts_with("http") { url.to_string() } else { format!("https://{url}") };
    let (st, body, eff) = util::fetch(&url, 8_000_000, 25);
    log(&format!("web: {url} status {st} {} bytes", body.len()));
    if st == 0 { return json!({ "ok": false, "reason": "network" }); }
    if st >= 400 { return json!({ "ok": false, "reason": "status", "status": st }); }
    json!({ "ok": true, "b64": b64(&body), "url": if eff.is_empty() { url } else { eff } })
}

/// Video on another site (anything yt-dlp knows: Bilibili, TikTok, Facebook, X, Vimeo, TED, news sites …)
/// {url} → {ok, id, site, title, channel, duration, thumb, subs:[{code, lang, url, ext, auto}]}
pub fn site_info(a: &Value) -> Value {
    let url = a["url"].as_str().unwrap_or("").trim().to_string();
    if !url.starts_with("http") { return json!({ "ok": false, "reason": "badurl" }); }
    if !have_ytdlp() { return json!({ "ok": false, "reason": "noruntime" }); }
    let t0 = std::time::Instant::now();
    let run = || ytdlp().args(["-J", "--skip-download"]).arg(&url).output();
    let mut o = match run() { Ok(o) => o, Err(e) => return json!({ "ok": false, "reason": e.to_string() }) };
    if !o.status.success() && generic_fail(&String::from_utf8_lossy(&o.stderr)) && self_update() { if let Ok(o2) = run() { o = o2; } }
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr).to_string();
        log(&format!("site: -J failed {url}: {}", err.chars().take(300).collect::<String>()));
        let r = if err.contains("Unsupported URL") || err.contains("No video") || err.contains("no video") { "novideo" } else if err.contains("login") || err.contains("Sign in") || err.contains("cookies") { "signin" } else if err.contains("resolve") || err.contains("getaddrinfo") || err.contains("timed out") { "network" } else { "fail" };
        return json!({ "ok": false, "reason": r });
    }
    let m: Value = match serde_json::from_slice(&o.stdout) { Ok(v) => v, Err(_) => return json!({ "ok": false, "reason": "fail" }) };
    let m = if m["_type"] == "playlist" { m["entries"].as_array().and_then(|e| e.first().cloned()).unwrap_or(Value::Null) } else { m };
    if m.is_null() || m["id"].is_null() { return json!({ "ok": false, "reason": "novideo" }); }
    let site: String = m["extractor_key"].as_str().or(m["extractor"].as_str()).unwrap_or("web").to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    let vid: String = m["id"].as_str().map(String::from).unwrap_or_else(|| m["id"].to_string()).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(40).collect();
    let mut subs = vec![];
    for (kind, auto) in [("subtitles", false), ("automatic_captions", true)] {
        if let Some(o) = m[kind].as_object() {
            for (code, list) in o {
                let Some(l) = learnable(code) else { continue };
                let Some(f) = list.as_array().and_then(|a| a.iter().find(|f| f["ext"] == "vtt" || f["ext"] == "srt").or_else(|| a.iter().find(|f| f["ext"] == "json3"))) else { continue };
                subs.push(json!({ "code": code, "lang": l, "url": f["url"], "ext": f["ext"], "auto": auto, "name": f["name"].as_str().unwrap_or(code) }));
            }
        }
    }
    log(&format!("site: {site} {vid} in {} ms, {} subtitle tracks", t0.elapsed().as_millis(), subs.len()));
    json!({ "ok": true, "id": format!("{site}-{vid}"), "site": site, "title": m["title"], "channel": m["uploader"].as_str().or(m["channel"].as_str()), "duration": m["duration"],
            "thumb": m["thumbnail"], "lang": m["language"], "url": m["webpage_url"].as_str().unwrap_or(&url), "subs": subs })
}
/// {url} → {ok, text} (a subtitle file from another site)
pub fn site_sub(a: &Value) -> Value {
    let (st, body, _) = util::fetch(a["url"].as_str().unwrap_or(""), 20_000_000, 30);
    if st == 200 && !body.is_empty() { json!({ "ok": true, "text": String::from_utf8_lossy(&body) }) } else { json!({ "ok": false, "status": st }) }
}
