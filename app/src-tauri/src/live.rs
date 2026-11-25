// Live subtitles: whatever the PC is playing (Netflix, a game, a live stream, a call) → English / Chinese lines on a
// floating window, offline. The sound is taken with WASAPI loopback from the default speakers (nothing is recorded to
// disk), cut into phrases at pauses, and each phrase goes to whisper's "live" server. While a phrase is still being
// spoken a quick draft is shown (reduced audio window = fast), then replaced by the final line.
use crate::util::{lock, log};
use crate::whisper;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static ON: AtomicBool = AtomicBool::new(false);
static GEN: AtomicU32 = AtomicU32::new(0); // a new start ends the old threads
static OPTS: Mutex<Option<Value>> = Mutex::new(None); // {lang: auto|en|zh, mode: best|fast}
type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;
static EMIT: std::sync::OnceLock<Emit> = std::sync::OnceLock::new();
pub fn init(f: Emit) { let _ = EMIT.set(f); }
fn emit(ev: &str, v: Value) { if let Some(f) = EMIT.get() { f(ev, v); } }
pub fn on() -> bool { ON.load(Ordering::Relaxed) }

pub fn start(a: &Value) -> Value {
    if !whisper::installed() || whisper::model("best").is_none() { return json!({ "ok": false, "reason": "nomodel" }); }
    *lock(&OPTS) = Some(json!({ "lang": a["lang"].as_str().unwrap_or("auto"), "mode": a["mode"].as_str().unwrap_or("best") }));
    if ON.swap(true, Ordering::SeqCst) { return json!({ "ok": true, "already": true }); }
    let g = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let q: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::with_capacity(16000 * 4)));
    let q2 = q.clone();
    std::thread::spawn(move || {
        // capture, restarted when the output device changes (headphones plugged in …)
        // test hook: PRISM_LIVE_WAV=<16 kHz mono wav> plays that file into the pipeline in real time instead of the
        // speakers (testing must not listen to what the user is playing); the speaker capture is only opened and closed
        if let Ok(w) = std::env::var("PRISM_LIVE_WAV") {
            unsafe { let _ = capture(&q2, u32::MAX); }
            if let Some((off, n)) = whisper::wav_data(std::path::Path::new(&w)) {
                let bytes = std::fs::read(&w).unwrap_or_default();
                let s: Vec<f32> = bytes[off as usize..(off as usize + n * 2).min(bytes.len())].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
                for part in s.chunks(160) {
                    if !(ON.load(Ordering::Relaxed) && GEN.load(Ordering::Relaxed) == g) { break; }
                    lock(&q2).extend(part.iter().copied());
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            return;
        }
        while ON.load(Ordering::Relaxed) && GEN.load(Ordering::Relaxed) == g {
            if let Err(e) = unsafe { capture(&q2, g) } { log(&format!("live: capture stopped: {e}")); emit("live:state", json!({ "on": true, "warn": "device" })); }
            std::thread::sleep(Duration::from_millis(800));
        }
    });
    std::thread::spawn(move || work(q, g));
    log("live: start");
    emit("live:state", json!({ "on": true }));
    json!({ "ok": true })
}
pub fn set(a: &Value) { if let Some(o) = lock(&OPTS).as_mut() { for k in ["lang", "mode"] { if let Some(v) = a.get(k) { o[k] = v.clone(); } } } }
pub fn stop() -> Value {
    if ON.swap(false, Ordering::SeqCst) { log("live: stop"); GEN.fetch_add(1, Ordering::SeqCst); emit("live:state", json!({ "on": false })); }
    json!({ "ok": true })
}

fn db(s: &[f32]) -> f32 { let sq: f64 = s.iter().map(|v| (*v as f64) * (*v as f64)).sum(); (10.0 * (sq / s.len().max(1) as f64 + 1e-10).log10()) as f32 }

fn work(q: Arc<Mutex<VecDeque<f32>>>, g: u32) {
    let alive = || ON.load(Ordering::Relaxed) && GEN.load(Ordering::Relaxed) == g;
    let cancel = AtomicBool::new(false);
    let mut port: Option<(u16, String)> = None;
    let mut buf: Vec<f32> = Vec::with_capacity(16000 * 12);
    let mut pre: VecDeque<f32> = VecDeque::with_capacity(8000);
    let (mut speech, mut quiet_ms, mut floor) = (false, 0u32, -60f32);
    let mut last_part = Instant::now();
    let mut last_level = Instant::now();
    let mut lang_lock = String::new();
    let mut context = String::new();
    let mut warned_lang = false;
    let mut last_want = String::new();
    while alive() {
        std::thread::sleep(Duration::from_millis(60));
        let got: Vec<f32> = lock(&q).drain(..).collect();
        if got.is_empty() { continue; }
        let opts = lock(&OPTS).clone().unwrap_or(Value::Null);
        let mode = opts["mode"].as_str().unwrap_or("best").to_string();
        let want = opts["lang"].as_str().unwrap_or("auto").to_string();
        if want != last_want { lang_lock = if want == "auto" { String::new() } else { want.clone() }; last_want = want.clone(); warned_lang = false; }
        for fr in got.chunks(320) {
            let d = db(fr);
            // the noise floor follows quiet moments quickly and loud ones slowly
            floor = if d < floor { floor * 0.9 + d * 0.1 } else { floor + 0.02 };
            let loud = d > (floor + 9.0).max(-55.0);
            if speech {
                buf.extend_from_slice(fr);
                if loud { quiet_ms = 0; } else { quiet_ms += 20; }
            } else {
                pre.extend(fr.iter().copied());
                while pre.len() > 6400 { pre.pop_front(); }
                if loud { speech = true; quiet_ms = 0; buf.clear(); buf.extend(pre.drain(..)); }
            }
        }
        if last_level.elapsed() > Duration::from_millis(150) { last_level = Instant::now(); emit("live:level", json!({ "v": ((db(&got) + 60.0) / 50.0).clamp(0.0, 1.0), "speech": speech })); }
        if !speech { continue; }
        let secs = buf.len() as f32 / 16000.0;
        // a phrase ends at a pause; long talk with no pause is cut at its quietest moment of the last 3 s (not mid-word)
        let mut carry: Vec<f32> = vec![];
        let long = quiet_ms < 650 && secs >= 9.0;
        if long {
            let (lo, hi) = (buf.len().saturating_sub(48000), buf.len().saturating_sub(4800));
            let mut best = (f32::MAX, hi);
            let mut i = lo;
            while i + 3200 <= hi { let d = db(&buf[i..i + 3200]); if d < best.0 { best = (d, i + 1600); } i += 800; }
            carry = buf.split_off(best.1);
        }
        let fin = quiet_ms >= 650 || long;
        if !fin && (secs < 1.2 || last_part.elapsed() < Duration::from_millis(700)) { continue; }
        // a server for this mode (started on the first phrase; a mode change restarts it)
        if port.as_ref().map_or(true, |p| p.1 != mode) {
            emit("live:state", json!({ "on": true, "loading": true }));
            match whisper::port("live", &mode) { Ok(p) => { port = Some((p, mode.clone())); emit("live:state", json!({ "on": true, "device": whisper::device() })); } Err(e) => { emit("live:state", json!({ "on": true, "err": e })); std::thread::sleep(Duration::from_secs(2)); continue; } }
        }
        let p = port.as_ref().unwrap().0;
        let audio: Vec<f32> = if fin && quiet_ms > 300 { buf[..buf.len().saturating_sub(((quiet_ms - 300) as usize) * 16)].to_vec() } else { buf.clone() };
        if audio.len() < 8000 { if fin { speech = !carry.is_empty(); buf = carry; } continue; }
        let actx = ((audio.len() as f32 / 16000.0 * 50.0) as usize + 96).min(1500);
        let mut f: Vec<(&str, String)> = vec![("response_format", if fin { "verbose_json".into() } else { "json".to_string() }), ("temperature", "0.0".into()),
            ("language", if lang_lock.is_empty() { "auto".into() } else { lang_lock.clone() }), ("audio_ctx", actx.to_string()), ("no_speech_thold", "0.6".into())];
        let pr = if lang_lock == "zh" { format!("以下是普通话的句子。{context}") } else { context.clone() };
        if !pr.trim().is_empty() { f.push(("prompt", pr)); }
        let t0 = Instant::now();
        let r = whisper::infer(p, &whisper::wav_f32(&audio), &f, &cancel, Duration::from_secs(30));
        whisper::touch("live");
        last_part = Instant::now();
        let Ok(body) = r else { log(&format!("live: infer failed {:?}", r.err())); if fin { speech = !carry.is_empty(); buf = carry; } port = None; continue; };
        let j: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if !fin {
            let t = j["text"].as_str().unwrap_or("").trim().to_string();
            if !t.is_empty() { emit("live:partial", json!({ "text": if lang_lock == "zh" { crate::dict::to_simplified(&t) } else { t } })); }
            continue;
        }
        speech = !carry.is_empty();
        buf = carry;
        quiet_ms = 0;
        let name = j["language"].as_str().unwrap_or("");
        let code = match name { "english" => "en", "chinese" | "cantonese" => "zh", _ => "" };
        if lang_lock.is_empty() && !code.is_empty() { lang_lock = code.to_string(); }
        if code.is_empty() && !name.is_empty() && lang_lock.is_empty() { if !warned_lang { warned_lang = true; emit("live:state", json!({ "on": true, "other": name })); } emit("live:partial", json!({ "text": "" })); continue; }
        let lang = if lang_lock.is_empty() { "en" } else { lang_lock.as_str() };
        let words = crate::asr::parse(&j, 0, lang == "zh");
        let text: String = words.iter().map(|w| w.t.as_str()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() { emit("live:partial", json!({ "text": "" })); continue; }
        context = text.chars().rev().take(120).collect::<Vec<_>>().into_iter().rev().collect();
        log(&format!("live: {} ms {} chars", t0.elapsed().as_millis(), text.chars().count()));
        emit("live:final", json!({ "text": text, "lang": lang, "t": crate::util::now_ms() as u64, "low": words.iter().filter(|w| w.p < 0.45).map(|w| w.t.trim().to_string()).collect::<Vec<_>>() }));
    }
    whisper::stop("live");
}

/* ------------------------------------------------------------ WASAPI loopback (default speakers) → 16 kHz mono */
#[repr(C)]
#[derive(Clone, Copy)]
struct WaveExt { fmt: windows::Win32::Media::Audio::WAVEFORMATEX, valid_bits: u16, mask: u32, sub: windows::core::GUID }
const FLOAT_SUB: windows::core::GUID = windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
const PCM_SUB: windows::core::GUID = windows::core::GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);

unsafe fn capture(q: &Arc<Mutex<VecDeque<f32>>>, g: u32) -> windows::core::Result<()> {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
    let mix = client.GetMixFormat()?;
    let m = *mix;
    let float = m.wFormatTag == 3 || (m.wFormatTag == 0xFFFE && (*(mix as *const WaveExt)).sub == FLOAT_SUB);
    let pcm16 = m.wBitsPerSample == 16 && (m.wFormatTag == 1 || (m.wFormatTag == 0xFFFE && (*(mix as *const WaveExt)).sub == PCM_SUB));
    let kind = if float && m.wBitsPerSample == 32 { 'f' } else if pcm16 { 's' } else { 'x' };
    client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1_000_000, 0, mix, None)?;
    CoTaskMemFree(Some(mix as _));
    if kind == 'x' { log("live: unsupported speaker format"); return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1))); }
    let (ch, rate) = (m.nChannels as usize, m.nSamplesPerSec);
    let cap: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    log(&format!("live: loopback {ch} ch {rate} Hz {kind}"));
    if g == u32::MAX { let _ = client.Stop(); return Ok(()); } // test: device check only
    let step = rate as f64 / 16000.0;
    let (mut pos, mut acc, mut acc_n) = (0f64, 0f32, 0usize);
    while ON.load(Ordering::Relaxed) && GEN.load(Ordering::Relaxed) == g {
        std::thread::sleep(Duration::from_millis(10));
        loop {
            let n = cap.GetNextPacketSize()?;
            if n == 0 { break; }
            let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
            cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let silent = flags & 2 != 0;
            let mut out: Vec<f32> = Vec::with_capacity(frames as usize / step.max(1.0) as usize + 2);
            for i in 0..frames as usize {
                let mut v = 0f32;
                if !silent {
                    for c in 0..ch { v += if kind == 'f' { *(data as *const f32).add(i * ch + c) } else { *(data as *const i16).add(i * ch + c) as f32 / 32768.0 }; }
                    v /= ch as f32;
                }
                acc += v; acc_n += 1; pos += 1.0;
                if pos >= step { out.push(if acc.is_finite() { (acc / acc_n as f32).clamp(-1.0, 1.0) } else { 0.0 }); pos -= step; acc = 0.0; acc_n = 0; }
            }
            let _ = cap.ReleaseBuffer(frames);
            let mut l = lock(q);
            l.extend(out);
            while l.len() > 16000 * 20 { l.pop_front(); }
        }
    }
    let _ = client.Stop();
    Ok(())
}
