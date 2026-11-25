// AI subtitles: a video's sound → timed English / Chinese lines with word timings, fully offline (whisper.rs).
// One job runs at a time (the queue lives here, the page mirrors it so it survives a restart). A job:
//   1. sound → cache\asr\<key>\audio.wav (16 kHz mono) with ffmpeg; YouTube / other sites: yt-dlp fetches only the audio
//   2. the sound is cut into ~90 s pieces at the quietest moment (no word is cut in half); quiet pieces are skipped
//   3. each piece goes to whisper-server; its words are cached in c<n>.json → cancel / crash / restart resumes there,
//      and a video is transcribed only once (result.json)
//   4. words → learner-sized lines (sentence ends, pauses, ~12 words / ~18 characters), sent to the page as they come
// "Redo this part" (range job) listens to a few lines again and replaces them.
use crate::util::{self, lock, log};
use crate::whisper::{self, RATE};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Job { key: String, kind: String, src: String, lang: String, mode: String, title: String, range: Option<(i64, i64)>, prompt: String }

static Q: Mutex<VecDeque<Job>> = Mutex::new(VecDeque::new());
static CUR: Mutex<Option<Value>> = Mutex::new(None); // status of the running job {key, title, phase, f, eta, done, total}
static CUR_KEY: Mutex<String> = Mutex::new(String::new());
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static CHILD: Mutex<Option<u32>> = Mutex::new(None); // yt-dlp / ffmpeg while the sound is prepared
type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;
static EMIT: OnceLock<Emit> = OnceLock::new();

pub fn init(f: Emit) { let _ = EMIT.set(f); }
fn emit(ev: &str, v: Value) { if let Some(f) = EMIT.get() { f(ev, v); } }
pub fn busy() -> bool { RUNNING.load(Ordering::Relaxed) }

fn safe(k: &str) -> String { k.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(80).collect() }
fn dir(key: &str) -> PathBuf { util::cache_dir().join("asr").join(safe(key)) }
fn rd(p: &Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }
fn wr(p: &Path, v: &Value) -> bool { util::write_safe(p, v.to_string().as_bytes()) }

/* ------------------------------------------------------------ commands */
/// {key, kind: file|yt, src: path|url, lang?: en|zh, mode?: best|fast, title, front?, fresh?, range?: [s, e] ms, prompt?}
pub fn add(a: &Value) -> Value {
    let key = a["key"].as_str().unwrap_or("").to_string();
    if safe(&key).is_empty() { return json!({ "ok": false, "reason": "badkey" }); }
    if !whisper::installed() || whisper::model("best").is_none() { return json!({ "ok": false, "reason": "nomodel" }); }
    let range = a["range"].as_array().and_then(|r| Some((r.first()?.as_i64()?, r.get(1)?.as_i64()?)));
    let job = Job {
        key: key.clone(), kind: a["kind"].as_str().unwrap_or("file").to_string(), src: a["src"].as_str().unwrap_or("").to_string(),
        lang: a["lang"].as_str().filter(|l| *l == "en" || *l == "zh").unwrap_or("").to_string(),
        mode: if a["mode"] == "fast" { "fast".into() } else { "best".into() }, title: a["title"].as_str().unwrap_or("").chars().take(200).collect(), range,
        prompt: a["prompt"].as_str().unwrap_or("").chars().take(300).collect(),
    };
    if job.src.is_empty() { return json!({ "ok": false, "reason": "nosrc" }); }
    {
        let mut q = lock(&Q);
        if range.is_none() {
            if *lock(&CUR_KEY) == key && busy() { return json!({ "ok": true, "already": true }); }
            if q.iter().any(|j| j.key == key && j.range.is_none()) { return json!({ "ok": true, "already": true }); }
            if a["fresh"].as_bool().unwrap_or(false) { let _ = std::fs::remove_dir_all(dir(&key)); }
        }
        if range.is_some() || a["front"].as_bool().unwrap_or(false) { q.push_front(job); } else { q.push_back(job); }
    }
    log(&format!("asr: add {key} range={range:?}"));
    if !RUNNING.swap(true, Ordering::SeqCst) { std::thread::spawn(worker); }
    emit("asr:queue", state());
    json!({ "ok": true })
}
pub fn cancel(key: &str) -> Value {
    let removed = { let mut q = lock(&Q); let n = q.len(); q.retain(|j| j.key != key); n != q.len() };
    if removed { emit("asr:done", json!({ "key": key, "ok": false, "reason": "cancel" })); }
    if *lock(&CUR_KEY) == key && busy() {
        CANCEL.store(true, Ordering::SeqCst);
        if let Some(pid) = *lock(&CHILD) { let _ = util::hidden(Path::new("taskkill")).args(["/F", "/T", "/PID", &pid.to_string()]).status(); }
    }
    emit("asr:queue", state());
    json!({ "ok": true })
}
pub fn state() -> Value {
    let mut jobs = vec![];
    if busy() { if let Some(c) = lock(&CUR).clone() { jobs.push(c); } }
    for j in lock(&Q).iter() { if j.range.is_none() { jobs.push(json!({ "key": j.key, "title": j.title, "phase": "wait", "f": 0 })); } }
    json!({ "jobs": jobs, "device": whisper::device(), "installed": whisper::installed(), "best": whisper::model("best").map_or(false, |p| p.to_string_lossy().contains("turbo")),
            "fast": whisper::model("fast").map_or(false, |p| p.to_string_lossy().contains("small")) })
}
/// {key} → {ok, cues, lang, mode} when finished; else what is already done {ok:false, partial, done, total}
pub fn result(key: &str) -> Value {
    let d = dir(key);
    if let Some(r) = rd(&d.join("result.json")) { return json!({ "ok": true, "cues": r["cues"], "lang": r["lang"], "mode": r["mode"] }); }
    let Some(plan) = rd(&d.join("plan.json")) else { return json!({ "ok": false }) };
    let total = plan["bounds"].as_array().map_or(0, |b| b.len().saturating_sub(1));
    let lang = plan["lang"].as_str().unwrap_or("en").to_string();
    let mut cues = vec![];
    let mut done = 0;
    for i in 0..total {
        let Some(c) = rd(&d.join(format!("c{i}.json"))) else { break };
        done += 1;
        cues.extend(build_cues(&words_of(&c), &lang));
    }
    json!({ "ok": false, "partial": cues, "done": done, "total": total, "lang": lang })
}
/// the learner edited the AI lines: keep the edited version as the result
pub fn save(a: &Value) -> Value {
    let key = a["key"].as_str().unwrap_or("");
    let d = dir(key);
    let mut r = rd(&d.join("result.json")).unwrap_or_else(|| json!({ "mode": "best" }));
    r["cues"] = a["cues"].clone();
    if let Some(l) = a["lang"].as_str() { r["lang"] = json!(l); }
    r["edited"] = json!(true);
    let _ = std::fs::create_dir_all(&d);
    json!({ "ok": wr(&d.join("result.json"), &r) })
}
pub fn drop_cache(key: &str) -> Value {
    if *lock(&CUR_KEY) == key && busy() { return json!({ "ok": false, "reason": "busy" }); }
    lock(&Q).retain(|j| j.key != key);
    json!({ "ok": std::fs::remove_dir_all(dir(key)).is_ok() })
}

/* ------------------------------------------------------------ the worker */
fn worker() {
    loop {
        let job = {
            let mut q = lock(&Q);
            match q.pop_front() { Some(j) => j, None => { RUNNING.store(false, Ordering::SeqCst); break; } }
        };
        CANCEL.store(false, Ordering::SeqCst);
        *lock(&CUR_KEY) = job.key.clone();
        set_status(&job, "prep", 0.0, None, 0, 0);
        let t0 = Instant::now();
        let r = if job.range.is_some() { run_range(&job) } else { run(&job) };
        log(&format!("asr: {} finished in {} s → {}", job.key, t0.elapsed().as_secs(), r.as_ref().err().map(|s| s.as_str()).unwrap_or("ok")));
        if let Err(reason) = r {
            let (reason, name) = reason.split_once(':').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((reason, String::new()));
            emit(if job.range.is_some() { "asr:range" } else { "asr:done" }, json!({ "key": job.key, "ok": false, "reason": reason, "name": name, "s": job.range.map(|r| r.0), "e": job.range.map(|r| r.1) }));
        }
        *lock(&CUR) = None;
        lock(&CUR_KEY).clear();
        emit("asr:queue", state());
    }
    emit("asr:queue", state());
    cleanup();
}
fn set_status(job: &Job, phase: &str, f: f64, eta: Option<f64>, done: usize, total: usize) {
    let v = json!({ "key": job.key, "title": job.title, "phase": phase, "f": (f * 1000.0).round() / 1000.0, "eta": eta.map(|e| e.round()), "done": done, "total": total, "range": job.range.is_some() });
    *lock(&CUR) = Some(v.clone());
    if job.range.is_none() { emit("asr:progress", v); }
}
fn cancelled() -> bool { CANCEL.load(Ordering::SeqCst) }

/// the sound of the job as 16 kHz mono WAV (made once, kept for "redo this part")
fn ensure_audio(job: &Job, d: &Path) -> Result<PathBuf, String> {
    let a = d.join("audio.wav");
    if whisper::wav_data(&a).map_or(false, |(_, n)| n > 0) { return Ok(a); }
    let _ = std::fs::create_dir_all(d);
    let mut src = PathBuf::from(&job.src);
    let mut tmp_src = None;
    if job.kind == "yt" {
        // only the audio track: small and quick (a 1 h video ≈ 50 MB)
        set_status(job, "download", 0.0, None, 0, 0);
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() { if e.file_name().to_string_lossy().starts_with("src.") { let _ = std::fs::remove_file(e.path()); } }
        let mut c = util::hidden(&util::runtime().join("yt-dlp.exe"));
        c.current_dir(util::runtime()).env("PYTHONIOENCODING", "utf-8").args(["--no-warnings", "--no-playlist", "--encoding", "utf-8", "-f", "ba[ext=m4a]/ba/b[height<=480]/b", "--newline",
            "--progress-template", "download:@@%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s", "--print", "after_move:@@FILE %(filepath)s", "-o"]).arg(d.join("src.%(ext)s")).arg(&job.src)
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut ch = c.spawn().map_err(|_| "download".to_string())?;
        util::kill_with_us(&ch);
        *lock(&CHILD) = Some(ch.id());
        let mut path = String::new();
        if let Some(so) = ch.stdout.take() {
            for l in BufReader::new(so).lines().map_while(Result::ok) {
                if let Some(p) = l.strip_prefix("@@FILE ") { path = p.trim().to_string(); continue; }
                if let Some(p) = l.trim().strip_prefix("@@") { let f = crate::util::dl_frac(p); set_status(job, "download", f.min(0.99), None, 0, 0); }
            }
        }
        let err = ch.stderr.take().map(|e| { let mut s = String::new(); let _ = BufReader::new(e).read_to_string(&mut s); s }).unwrap_or_default();
        let ok = ch.wait().map(|s| s.success()).unwrap_or(false);
        *lock(&CHILD) = None;
        if cancelled() { return Err("cancel".into()); }
        if !ok || path.is_empty() || !Path::new(&path).exists() {
            log(&format!("asr: audio download failed {}: {}", job.src, err.chars().take(300).collect::<String>()));
            return Err(if err.contains("resolve") || err.contains("getaddrinfo") || err.contains("timed out") { "network".into() } else { "download".into() });
        }
        src = PathBuf::from(&path);
        tmp_src = Some(src.clone());
    }
    if !src.is_file() { return Err("missing".into()); }
    set_status(job, "audio", 0.0, None, 0, 0);
    let dur = crate::media::duration(&src);
    let tmp = d.join("audio.tmp.wav");
    let mut c = util::hidden(&util::runtime().join("ffmpeg.exe"));
    c.args(["-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-i"]).arg(&src)
        .args(["-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-bitexact"]).arg(&tmp).stdout(std::process::Stdio::piped());
    let mut ch = c.spawn().map_err(|_| "noaudio".to_string())?;
    util::kill_with_us(&ch);
    *lock(&CHILD) = Some(ch.id());
    if let Some(so) = ch.stdout.take() {
        for l in BufReader::new(so).lines().map_while(Result::ok) {
            if let (Some(us), Some(d)) = (l.strip_prefix("out_time_us="), dur) { if let Ok(us) = us.trim().parse::<f64>() { set_status(job, "audio", (us / 1e6 / d).clamp(0.0, 0.99), None, 0, 0); } }
        }
    }
    let ok = ch.wait().map(|s| s.success()).unwrap_or(false);
    *lock(&CHILD) = None;
    if let Some(t) = tmp_src { let _ = std::fs::remove_file(t); }
    if cancelled() { let _ = std::fs::remove_file(&tmp); return Err("cancel".into()); }
    if !ok || whisper::wav_data(&tmp).map_or(true, |(_, n)| n < RATE / 2) { let _ = std::fs::remove_file(&tmp); return Err("noaudio".into()); }
    std::fs::rename(&tmp, &a).map_err(|_| "disk".to_string())?;
    Ok(a)
}

/// loudness of every 20 ms (dBFS)
fn frame_db(wav: &Path, off: u64, n: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(n / 320 + 1);
    let Ok(f) = std::fs::File::open(wav) else { return out };
    let mut r = BufReader::with_capacity(1 << 20, f);
    if r.seek(SeekFrom::Start(off)).is_err() { return out; }
    let mut buf = vec![0u8; 640];
    let mut left = n;
    while left >= 320 {
        if r.read_exact(&mut buf).is_err() { break; }
        let mut sq = 0f64;
        for c in buf.chunks_exact(2) { let v = i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0; sq += v * v; }
        out.push((10.0 * ((sq / 320.0) + 1e-10).log10()) as f32);
        left -= 320;
    }
    out
}
fn read_samples(wav: &Path, off: u64, a: usize, b: usize) -> Vec<u8> {
    let mut v = vec![0u8; (b - a) * 2];
    if let Ok(mut f) = std::fs::File::open(wav) { if f.seek(SeekFrom::Start(off + a as u64 * 2)).is_ok() { let _ = f.read_exact(&mut v); } }
    let mut w = whisper::wav_header(b - a);
    w.extend_from_slice(&v);
    w
}
/// piece borders (samples): every ~90 s, at the quietest 0.4 s within ±15 s
fn plan(db: &[f32], n: usize) -> Vec<usize> {
    const FPS: usize = 50;
    let (target, win, smooth) = (90 * FPS, 15 * FPS, 20);
    let mut b = vec![0usize];
    let mut at = 0usize;
    while db.len() > at + target + 20 * FPS {
        let (lo, hi) = (at + target - win, (at + target + win).min(db.len() - smooth));
        let mut best = (f32::MAX, at + target);
        let mut sum: f32 = db[lo..lo + smooth].iter().sum();
        for i in lo..hi {
            if sum < best.0 { best = (sum, i + smooth / 2); }
            sum += db[i + smooth] - db[i];
        }
        at = best.1;
        b.push(at * 320);
    }
    b.push(n);
    b
}
fn speech_thr(db: &[f32]) -> f32 {
    if db.is_empty() { return -45.0; }
    let mut s: Vec<f32> = db.iter().copied().filter(|v| *v > -95.0).collect();
    if s.is_empty() { return 0.0; }
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    (s[s.len() / 10] + 14.0).clamp(-52.0, -28.0)
}

fn lang_code(name: &str) -> Option<&'static str> {
    match name.to_lowercase().as_str() { "english" | "en" => Some("en"), "chinese" | "zh" | "cantonese" | "yue" => Some("zh"), _ => None }
}
fn fields(lang: &str, prompt: &str) -> Vec<(&'static str, String)> {
    let mut f = vec![("response_format", "verbose_json".to_string()), ("token_timestamps", "true".into()), ("temperature", "0.0".into()),
        ("language", if lang.is_empty() { "auto".into() } else { lang.to_string() }), ("no_speech_thold", "0.6".into())];
    let p = if lang == "zh" { format!("以下是普通话的句子。{prompt}") } else { prompt.to_string() };
    if !p.trim().is_empty() { f.push(("prompt", p)); }
    f
}

pub struct W { pub s: i64, pub e: i64, pub t: String, pub p: f32 }
const HALLU: [&str; 16] = ["thank you for watching", "thanks for watching", "please subscribe", "subtitles by", "amara.org", "transcribed by", "字幕由", "字幕志愿者",
    "请不吝点赞", "点赞 订阅", "订阅我的频道", "谢谢观看", "感谢观看", "明镜与点点", "中文字幕", "优优独播剧场"];
fn is_cjk(c: char) -> bool { ('\u{3400}'..='\u{9fff}').contains(&c) || ('\u{f900}'..='\u{faff}').contains(&c) }
/// whisper's verbose_json → words (tokens glued into words; absolute ms; low-confidence p)
pub fn parse(j: &Value, off_ms: i64, zh: bool) -> Vec<W> {
    let mut out: Vec<W> = vec![];
    let mut last_txt = String::new();
    let mut rep = 0;
    for seg in j["segments"].as_array().into_iter().flatten() {
        let text = seg["text"].as_str().unwrap_or("").trim().to_string();
        let low = text.to_lowercase();
        if text.is_empty() || text.chars().all(|c| !c.is_alphanumeric()) { continue; }
        let nsp = seg["no_speech_prob"].as_f64().unwrap_or(0.0);
        let lp = seg["avg_logprob"].as_f64().unwrap_or(0.0);
        if nsp > 0.6 && lp < -0.8 { continue; }
        if HALLU.iter().any(|h| low.contains(h)) && text.chars().count() < 60 { continue; }
        if low == last_txt { rep += 1; if rep >= 1 { continue; } } else { rep = 0; }
        last_txt = low;
        let mut seg_words: Vec<W> = vec![];
        for tok in seg["words"].as_array().into_iter().flatten() {
            let raw = tok["word"].as_str().unwrap_or("");
            if raw.starts_with("[_") || raw.starts_with("<|") || raw.is_empty() { continue; }
            let raw = if zh { crate::dict::to_simplified(raw) } else { raw.to_string() };
            let s = off_ms + (tok["start"].as_f64().unwrap_or(0.0) * 1000.0) as i64;
            let e = off_ms + (tok["end"].as_f64().unwrap_or(0.0) * 1000.0) as i64;
            let p = tok["probability"].as_f64().unwrap_or(1.0) as f32;
            let first = raw.chars().next().unwrap_or(' ');
            let new = seg_words.is_empty() || first.is_whitespace() || (is_cjk(first) && zh);
            if new { seg_words.push(W { s, e: e.max(s), t: raw, p }); } else if let Some(w) = seg_words.last_mut() { w.t.push_str(&raw); w.e = w.e.max(e); w.p = w.p.min(p); }
        }
        // a word repeated in a loop ("the the the the …") = whisper got stuck: keep the first few
        let mut keep: Vec<W> = vec![];
        for w in seg_words {
            let same = keep.iter().rev().take(4).filter(|k| k.t.trim().eq_ignore_ascii_case(w.t.trim())).count();
            if same < 3 { keep.push(w); }
        }
        for mut w in keep {
            if let Some(prev) = out.last() { if w.s < prev.s { w.s = prev.s; } if w.e < w.s { w.e = w.s; } }
            out.push(w);
        }
    }
    out
}
fn words_of(c: &Value) -> Vec<W> {
    c["w"].as_array().into_iter().flatten().filter_map(|x| Some(W { s: x[0].as_i64()?, e: x[1].as_i64()?, t: x[2].as_str()?.to_string(), p: x[3].as_f64().unwrap_or(1.0) as f32 })).collect()
}
fn words_json(w: &[W]) -> Value { Value::Array(w.iter().map(|x| json!([x.s, x.e, x.t, (x.p * 100.0).round() / 100.0])).collect()) }

/// words → lines a learner can read in one look: break at sentence ends, pauses, commas when long; a line that grows
/// too long is cut at its biggest pause (or comma) instead of mid-phrase
pub fn build_cues(words: &[W], lang: &str) -> Vec<Value> {
    let zh = lang == "zh";
    let (soft, hard, min) = if zh { (14, 22, 4) } else { (10, 16, 3) };
    let size = |ws: &[&W]| if zh { ws.iter().map(|x| x.t.chars().filter(|c| is_cjk(*c)).count()).sum::<usize>() } else { ws.len() };
    let ends = |t: &str| { let t = t.trim_end(); (t.ends_with(['.', '?', '!', '。', '？', '！', '…']) && !t.ends_with("...")) || t.ends_with("。”") || t.ends_with("?\"") };
    let commas = |t: &str| t.trim_end().ends_with([',', ';', ':', '，', '、', '；', '：']);
    let mut out = vec![];
    let mut emit = |cur: &[&W], next: Option<&W>| {
        if cur.is_empty() { return; }
        let mut text = String::new();
        for x in cur {
            let t = x.t.trim();
            if t.is_empty() { continue; }
            // Chinese: no spaces between characters; English (and Latin words inside Chinese): one space
            let glue = !text.is_empty() && !(zh && (text.chars().last().map_or(false, |c| is_cjk(c) || "，。！？、；：".contains(c)) || t.chars().next().map_or(false, |c| is_cjk(c) || "，。！？、；：".contains(c))));
            if glue && !t.starts_with([',', '.', '?', '!', ';', ':']) { text.push(' '); }
            text.push_str(t);
        }
        if text.is_empty() { return; }
        let s = cur[0].s;
        let last = cur.last().map_or(s, |x| x.e);
        let e = next.map_or(last + 600, |n| n.s.min(last + 600).max(last)).max(s + 300);
        out.push(json!({ "s": s, "e": e, "t": text, "ai": 1, "w": cur.iter().map(|x| json!([x.s, x.t.trim(), (x.p * 100.0).round() / 100.0])).collect::<Vec<_>>() }));
    };
    let mut cur: Vec<&W> = vec![];
    for (i, w) in words.iter().enumerate() {
        cur.push(w);
        let nx = words.get(i + 1);
        let gap = nx.map_or(i64::MAX, |n| n.s - w.e);
        let n = size(&cur);
        let in_word = zh && nx.map_or(false, |x| { let a: String = w.t.trim().chars().rev().take(1).collect(); let b: String = x.t.trim().chars().take(1).collect(); crate::dict::zh_has(&format!("{a}{b}")) });
        if nx.is_none() || gap > 700 || (ends(&w.t) && (n >= min || gap > 300)) || (commas(&w.t) && n >= soft) || (n >= soft && gap > 250 && !in_word) {
            emit(&cur, nx); cur.clear(); continue;
        }
        if n >= hard {
            // too long without a natural end: cut after the word with the biggest pause / a comma (in the later half)
            let from = (cur.len() / 3).max(1);
            let mut best = (i64::MIN, cur.len() - 1);
            for k in from..cur.len() - 1 {
                let mut g = cur[k + 1].s - cur[k].e + if commas(&cur[k].t) { 400 } else { 0 };
                if zh {
                    // never between two characters that make one word ("访|问", "当|中")
                    let a: Vec<char> = cur[k].t.trim().chars().collect();
                    let b: Vec<char> = cur[k + 1].t.trim().chars().collect();
                    let joined = |x: usize, y: usize| -> bool { (1..=x.min(a.len())).any(|i| (1..=y.min(b.len())).any(|j| { let w: String = a[a.len() - i..].iter().chain(b[..j].iter()).collect(); w.chars().count() >= 2 && crate::dict::zh_has(&w) })) };
                    if joined(2, 2) { g -= 5000; }
                }
                if g > best.0 { best = (g, k); }
            }
            let rest = cur.split_off(best.1 + 1);
            emit(&cur, rest.first().copied().or(nx));
            cur = rest;
        }
    }
    emit(&cur, None);
    out
}

fn run(job: &Job) -> Result<(), String> {
    let d = dir(&job.key);
    let wav = ensure_audio(job, &d)?;
    let (off, n) = whisper::wav_data(&wav).ok_or("noaudio")?;
    let mut plan_v = rd(&d.join("plan.json")).filter(|p| p["n"].as_u64() == Some(n as u64) && p["mode"] == job.mode.as_str());
    let db = frame_db(&wav, off, n);
    if plan_v.is_none() {
        // a new plan (or another mode): old pieces don't belong to it
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() { let f = e.file_name().to_string_lossy().to_string(); if f.starts_with('c') && f.ends_with(".json") { let _ = std::fs::remove_file(e.path()); } }
        let _ = std::fs::remove_file(d.join("result.json"));
        let p = json!({ "n": n, "mode": job.mode, "bounds": plan(&db, n), "lang": job.lang, "src": job.src, "kind": job.kind, "title": job.title });
        wr(&d.join("plan.json"), &p);
        plan_v = Some(p);
    }
    let mut plan_v = plan_v.unwrap();
    let bounds: Vec<usize> = plan_v["bounds"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|v| v as usize)).collect()).unwrap_or_default();
    let total = bounds.len().saturating_sub(1);
    let mut lang = plan_v["lang"].as_str().unwrap_or("").to_string();
    if lang.is_empty() { lang = job.lang.clone(); }
    let thr = speech_thr(&db);
    let mut port: Option<u16> = None;
    let mut prev = String::new();
    let mut all: Vec<Value> = vec![];
    let (mut work_audio, mut work_ms) = (0f64, 0f64); // for the time-left estimate (pieces done in this run)
    let left_audio = |i: usize| (n - bounds[i]) as f64 / RATE as f64;
    for i in 0..total {
        if cancelled() { return Err("cancel".into()); }
        let (a, b) = (bounds[i], bounds[i + 1]);
        let cache = d.join(format!("c{i}.json"));
        let eta = if work_ms > 0.0 { Some(left_audio(i) * work_ms / work_audio / 1000.0) } else { None };
        set_status(job, "asr", i as f64 / total as f64, eta, i, total);
        let words = if let Some(c) = rd(&cache) { words_of(&c) } else {
            let fa = a / 320; let fb = (b / 320).min(db.len());
            let loud = db[fa.min(fb)..fb].iter().filter(|v| **v > thr).count() as f64 / (fb - fa).max(1) as f64;
            let w = if loud < 0.02 { vec![] } else {
                let t0 = Instant::now();
                let p = match port { Some(p) => p, None => { let p = whisper::port("batch", &job.mode)?; port = Some(p); p } };
                let audio = read_samples(&wav, off, a, b);
                let dur = (b - a) as f64 / RATE as f64;
                let timeout = Duration::from_secs_f64((dur * 8.0).max(180.0));
                let mut r = whisper::infer(p, &audio, &fields(&lang, &prev), &CANCEL, timeout);
                if let Err(e) = &r {
                    if e == "cancel" { return Err("cancel".into()); }
                    log(&format!("asr: piece {i} failed ({e}) — retrying"));
                    if whisper::device() == "gpu" { whisper::gpu_failed("batch"); }
                    let p2 = whisper::port("batch", &job.mode)?; port = Some(p2);
                    r = whisper::infer(p2, &audio, &fields(&lang, &prev), &CANCEL, timeout);
                    if let Err(e) = &r { if e == "cancel" { return Err("cancel".into()); } return Err("engine".into()); }
                }
                let j: Value = serde_json::from_str(&r.unwrap()).map_err(|_| "engine".to_string())?;
                if lang.is_empty() {
                    let name = j["language"].as_str().unwrap_or("");
                    match lang_code(name) { Some(l) => { lang = l.into(); plan_v["lang"] = json!(l); wr(&d.join("plan.json"), &plan_v); } None => { log(&format!("asr: spoken language {name}")); return Err(format!("otherlang:{name}")); } }
                }
                work_audio += dur; work_ms += t0.elapsed().as_millis() as f64;
                whisper::touch("batch");
                parse(&j, (a as f64 / RATE as f64 * 1000.0) as i64, lang == "zh")
            };
            wr(&cache, &json!({ "w": words_json(&w) }));
            w
        };
        let cues = build_cues(&words, if lang.is_empty() { "en" } else { &lang });
        prev = cues.iter().rev().take(2).rev().filter_map(|c| c["t"].as_str()).collect::<Vec<_>>().join(" ").chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
        emit("asr:progress", json!({ "key": job.key, "phase": "asr", "f": (i + 1) as f64 / total as f64, "done": i + 1, "total": total, "cues": cues, "lang": lang, "piece": i,
            "eta": if work_ms > 0.0 && i + 1 < total { Some((left_audio(i + 1) * work_ms / work_audio / 1000.0).round()) } else { None } }));
        all.extend(cues);
    }
    if lang.is_empty() { lang = "en".into(); }
    let r = json!({ "lang": lang, "mode": job.mode, "cues": all, "at": util::now_ms() as u64, "device": whisper::device() });
    wr(&d.join("result.json"), &r);
    emit("asr:done", json!({ "key": job.key, "ok": true, "cues": r["cues"], "lang": lang, "empty": all.is_empty() }));
    Ok(())
}

/// listen to [s, e] again (a few lines the learner marked) and send back new lines for that part
fn run_range(job: &Job) -> Result<(), String> {
    let (s, e) = job.range.unwrap();
    let d = dir(&job.key);
    let wav = ensure_audio(job, &d)?;
    let (off, n) = whisper::wav_data(&wav).ok_or("noaudio")?;
    let lang = rd(&d.join("plan.json")).and_then(|p| p["lang"].as_str().map(String::from)).filter(|l| !l.is_empty()).unwrap_or_else(|| job.lang.clone());
    let a = (((s - 400).max(0) as f64 / 1000.0 * RATE as f64) as usize).min(n);
    let b = (((e + 400) as f64 / 1000.0 * RATE as f64) as usize).min(n);
    if b <= a + RATE / 4 { return Err("short".into()); }
    set_status(job, "asr", 0.0, None, 0, 1);
    let p = whisper::port("batch", "best")?;
    let audio = read_samples(&wav, off, a, b);
    let r = whisper::infer(p, &audio, &fields(&lang, &job.prompt), &CANCEL, Duration::from_secs(300))?;
    let j: Value = serde_json::from_str(&r).map_err(|_| "engine".to_string())?;
    let lang = if lang.is_empty() { lang_code(j["language"].as_str().unwrap_or("")).unwrap_or("en").to_string() } else { lang };
    let words: Vec<W> = parse(&j, (a as f64 / RATE as f64 * 1000.0) as i64, lang == "zh");
    let cues = build_cues(&words, &lang);
    emit("asr:range", json!({ "key": job.key, "ok": true, "s": s, "e": e, "cues": cues, "lang": lang }));
    Ok(())
}

/// keep the sound of the 8 newest jobs (for "redo this part"); older ones keep only their lines
fn cleanup() {
    let root = util::cache_dir().join("asr");
    let mut v: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&root).into_iter().flatten().flatten()
        .filter_map(|e| { let a = e.path().join("audio.wav"); let t = std::fs::metadata(&a).and_then(|m| m.modified()).ok()?; Some((t, a)) }).collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in v.into_iter().skip(8) { let _ = std::fs::remove_file(p); }
}
