// Video files on the PC (and videos kept for offline): served to the page at http://llearn.localhost/file/<token>
// with Range support (seeking). Only files the user opened are served. Subtitles next to the video (.srt/.vtt/.ass)
// and inside it (mkv) are found; a file the web view can't play is remuxed / converted with ffmpeg into the cache.
use crate::util::{self, lock, log};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static FILES: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);
pub const VIDEO: [&str; 9] = ["mp4", "m4v", "webm", "mkv", "mov", "avi", "ts", "mp3", "m4a"];
pub const SUBS: [&str; 5] = ["srt", "vtt", "ass", "ssa", "txt"];

pub fn register(p: &Path) -> String {
    let t = util::hash(&p.to_string_lossy());
    lock(&FILES).get_or_insert_with(HashMap::new).insert(t.clone(), p.to_path_buf());
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    format!("http://llearn.localhost/file/{t}.{ext}")
}
fn ext(p: &Path) -> String { p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default() }
fn ffmpeg() -> PathBuf { util::runtime().join("ffmpeg.exe") }

/// {path} → {ok, url, name, size, subs:[{name, path}], tracks:[{index, lang, title, codec}]}
pub fn open(a: &Value) -> Value {
    let p = PathBuf::from(a["path"].as_str().unwrap_or(""));
    if !p.is_file() { return json!({ "ok": false, "reason": "missing" }); }
    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut subs = vec![];
    if let Some(dir) = p.parent() {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let q = e.path();
                if !SUBS.contains(&ext(&q).as_str()) || ext(&q) == "txt" { continue; }
                let qs = q.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
                if qs == stem || qs.starts_with(&format!("{stem}.")) || qs.starts_with(&format!("{stem}_")) || qs.starts_with(&format!("{stem} ")) {
                    subs.push(json!({ "name": q.file_name().map(|n| n.to_string_lossy().to_string()), "path": q.to_string_lossy() }));
                }
            }
        }
    }
    json!({ "ok": true, "url": register(&p), "name": p.file_name().map(|n| n.to_string_lossy().to_string()), "size": size, "subs": subs, "tracks": probe(&p) })
}
/// Subtitle streams inside the file (ffmpeg -i lists them on stderr)
fn probe(p: &Path) -> Vec<Value> {
    let Ok(o) = util::hidden(&ffmpeg()).arg("-hide_banner").arg("-i").arg(p).output() else { return vec![] };
    let err = String::from_utf8_lossy(&o.stderr).to_string();
    let mut out = vec![];
    let mut n = 0;
    let lines: Vec<&str> = err.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.starts_with("Stream #") && t.contains(": Subtitle:") {
            // "Stream #0:2(eng): Subtitle: subrip" — the language sits right after the stream number
            let head = t.split(": ").next().unwrap_or("");
            let lang = head.split('(').nth(1).and_then(|s| s.split(')').next()).unwrap_or("").to_string();
            let codec = t.split(": Subtitle:").nth(1).unwrap_or("").trim().split([' ', ',']).next().unwrap_or("").to_string();
            let title = lines.iter().skip(i + 1).take(4).find(|x| x.trim().starts_with("title")).and_then(|x| x.split_once(':')).map(|x| x.1.trim().to_string()).unwrap_or_default();
            if !["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"].contains(&codec.as_str()) { out.push(json!({ "index": n, "lang": lang, "title": title, "codec": codec })); }
            n += 1;
        }
    }
    out
}
/// {path} or {path, index} (stream inside a video) → {ok, b64}
pub fn sub(a: &Value) -> Value {
    let p = PathBuf::from(a["path"].as_str().unwrap_or(""));
    if let Some(i) = a["index"].as_u64() {
        let o = util::hidden(&ffmpeg()).args(["-hide_banner", "-loglevel", "error", "-i"]).arg(&p).args(["-map", &format!("0:s:{i}"), "-f", "srt", "-"]).output();
        return match o { Ok(o) if !o.stdout.is_empty() => json!({ "ok": true, "b64": crate::yt::b64pub(&o.stdout), "ext": "srt" }), _ => json!({ "ok": false }) };
    }
    if std::fs::metadata(&p).map(|m| m.len() > 10_000_000).unwrap_or(true) { return json!({ "ok": false, "reason": "big" }); }
    match std::fs::read(&p) { Ok(b) => json!({ "ok": true, "b64": crate::yt::b64pub(&b), "ext": ext(&p) }), Err(_) => json!({ "ok": false }) }
}

/// The web view can't play this file (codec / container): make a playable mp4 in the cache. {path, full} → {ok, url}
pub fn convert(a: &Value, emit: impl Fn(Value) + Send + 'static) -> Value {
    let p = PathBuf::from(a["path"].as_str().unwrap_or(""));
    let full = a["full"].as_bool().unwrap_or(false); // false = copy the picture (fast), true = re-encode it (any codec)
    if !p.is_file() { return json!({ "ok": false }); }
    let dir = util::cache_dir().join("play");
    let _ = std::fs::create_dir_all(&dir);
    let out = dir.join(format!("{}{}.mp4", util::hash(&p.to_string_lossy()), if full { "-h264" } else { "" }));
    if out.exists() { return json!({ "ok": true, "url": register(&out), "path": out }); }
    let tmp = out.with_extension("tmp.mp4");
    let src = p.clone();
    std::thread::spawn(move || {
        let mut c = util::hidden(&ffmpeg());
        c.args(["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-i"]).arg(&src).args(["-map", "0:v:0", "-map", "0:a:0?"]);
        if full { c.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]); } else { c.args(["-c:v", "copy"]); }
        c.args(["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]).arg(&tmp).stdout(std::process::Stdio::piped());
        let dur = duration(&src);
        let ok = match c.spawn() {
            Ok(mut ch) => {
                util::kill_with_us(&ch);
                if let Some(so) = ch.stdout.take() {
                    use std::io::BufRead;
                    for l in std::io::BufReader::new(so).lines().map_while(Result::ok) {
                        if let Some(us) = l.strip_prefix("out_time_us=") { if let (Ok(us), Some(d)) = (us.trim().parse::<f64>(), dur) { emit(json!({ "f": (us / 1e6 / d).clamp(0.0, 0.99) })); } }
                    }
                }
                ch.wait().map(|s| s.success()).unwrap_or(false)
            }
            Err(_) => false,
        };
        let ok = ok && std::fs::rename(&tmp, &out).is_ok();
        log(&format!("media: convert full={full} ok={ok} {}", src.display()));
        emit(json!({ "done": true, "ok": ok, "url": if ok { Value::String(register(&out)) } else { Value::Null } }));
    });
    json!({ "ok": true, "started": true })
}
pub fn duration(p: &Path) -> Option<f64> {
    let o = util::hidden(&ffmpeg()).arg("-hide_banner").arg("-i").arg(p).output().ok()?;
    let e = String::from_utf8_lossy(&o.stderr).to_string();
    let d = e.split("Duration: ").nth(1)?.split(',').next()?;
    let v: Vec<f64> = d.split(':').filter_map(|x| x.trim().parse().ok()).collect();
    (v.len() == 3).then(|| v[0] * 3600.0 + v[1] * 60.0 + v[2])
}

/// http://llearn.localhost/tts/<n>.wav and /file/<token>.<ext> (Range requests for video seeking)
pub fn serve(req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Response, StatusCode};
    let fail = |c: StatusCode| Response::builder().status(c).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    let path = req.uri().path().to_string();
    let (file, mime) = if let Some(n) = path.strip_prefix("/tts/") {
        let n: String = n.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
        (util::cache_dir().join("tts").join(n), "audio/wav")
    } else if let Some(t) = path.strip_prefix("/file/") {
        let tok = t.split('.').next().unwrap_or("");
        let Some(p) = lock(&FILES).as_ref().and_then(|m| m.get(tok).cloned()) else { return fail(StatusCode::NOT_FOUND) };
        let m = match ext(&p).as_str() { "mp4" | "m4v" | "mov" => "video/mp4", "webm" => "video/webm", "mkv" => "video/x-matroska", "mp3" => "audio/mpeg", "m4a" => "audio/mp4", _ => "application/octet-stream" };
        (p, m)
    } else { return fail(StatusCode::NOT_FOUND) };
    let Ok(mut f) = std::fs::File::open(&file) else { return fail(StatusCode::NOT_FOUND) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).and_then(|r| r.strip_prefix("bytes=")).map(|r| {
        let (a, b) = r.split_once('-').unwrap_or((r, ""));
        let s = a.trim().parse::<u64>().unwrap_or(0);
        let e = b.trim().parse::<u64>().unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1));
        (s, e)
    });
    const CHUNK: u64 = 4 * 1024 * 1024;
    match range {
        Some((s, e)) if s < len => {
            let e = e.min(s + CHUNK - 1);
            let mut buf = vec![0u8; (e - s + 1) as usize];
            if f.seek(SeekFrom::Start(s)).is_err() || f.read_exact(&mut buf).is_err() { return fail(StatusCode::INTERNAL_SERVER_ERROR); }
            Response::builder().status(StatusCode::PARTIAL_CONTENT).header("Content-Type", mime).header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {s}-{e}/{len}")).header("Content-Length", buf.len().to_string()).header("Access-Control-Allow-Origin", "*").body(buf).unwrap()
        }
        Some(_) => fail(StatusCode::RANGE_NOT_SATISFIABLE),
        None => {
            if len > 64 * 1024 * 1024 {
                // big file without Range: send the first piece; the player then asks with Range
                let mut buf = vec![0u8; CHUNK as usize];
                let n = f.read(&mut buf).unwrap_or(0); buf.truncate(n);
                return Response::builder().status(StatusCode::PARTIAL_CONTENT).header("Content-Type", mime).header("Accept-Ranges", "bytes")
                    .header("Content-Range", format!("bytes 0-{}/{len}", n.saturating_sub(1))).header("Access-Control-Allow-Origin", "*").body(buf).unwrap();
            }
            let mut buf = Vec::with_capacity(len as usize);
            let _ = f.read_to_end(&mut buf);
            Response::builder().header("Content-Type", mime).header("Accept-Ranges", "bytes").header("Access-Control-Allow-Origin", "*").header("Cache-Control", "max-age=3600").body(buf).unwrap()
        }
    }
}
