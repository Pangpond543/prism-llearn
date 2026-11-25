// Offline voice: Kokoro 82M v1.1 (English + Mandarin) through sherpa-onnx's C library (runtime\tts). The model is
// loaded once (~2 s) and kept, so a word then takes ~0.1–0.3 s; every clip is cached as a WAV (cache\tts) and served
// to the page at http://llearn.localhost/tts/<name>.wav.
use crate::util::{self, lock, log};
use serde_json::{json, Value};
use std::ffi::{c_char, CString};
use std::sync::Mutex;

#[repr(C)] struct Vits { model: *const c_char, lexicon: *const c_char, tokens: *const c_char, data_dir: *const c_char, noise_scale: f32, noise_scale_w: f32, length_scale: f32, dict_dir: *const c_char }
#[repr(C)] struct Matcha { acoustic_model: *const c_char, vocoder: *const c_char, lexicon: *const c_char, tokens: *const c_char, data_dir: *const c_char, noise_scale: f32, length_scale: f32, dict_dir: *const c_char }
#[repr(C)] struct Kokoro { model: *const c_char, voices: *const c_char, tokens: *const c_char, data_dir: *const c_char, length_scale: f32, dict_dir: *const c_char, lexicon: *const c_char, lang: *const c_char }
#[repr(C)] struct Kitten { model: *const c_char, voices: *const c_char, tokens: *const c_char, data_dir: *const c_char, length_scale: f32, lexicon: *const c_char }
#[repr(C)] struct Zipvoice { tokens: *const c_char, encoder: *const c_char, decoder: *const c_char, vocoder: *const c_char, data_dir: *const c_char, lexicon: *const c_char, feat_scale: f32, t_shift: f32, target_rms: f32, guidance_scale: f32 }
#[repr(C)] struct Pocket { lm_flow: *const c_char, lm_main: *const c_char, encoder: *const c_char, decoder: *const c_char, text_conditioner: *const c_char, vocab_json: *const c_char, token_scores_json: *const c_char, cache: i32 }
#[repr(C)] struct Supertonic { duration_predictor: *const c_char, text_encoder: *const c_char, vector_estimator: *const c_char, vocoder: *const c_char, tts_json: *const c_char, unicode_indexer: *const c_char, voice_style: *const c_char }
#[repr(C)] struct ModelCfg { vits: Vits, num_threads: i32, debug: i32, provider: *const c_char, matcha: Matcha, kokoro: Kokoro, kitten: Kitten, zipvoice: Zipvoice, pocket: Pocket, supertonic: Supertonic }
#[repr(C)] struct Cfg { model: ModelCfg, rule_fsts: *const c_char, max_num_sentences: i32, rule_fars: *const c_char, silence_scale: f32 }
#[repr(C)] struct Audio { samples: *const f32, n: i32, sample_rate: i32 }

type Create = unsafe extern "C" fn(*const Cfg) -> *const std::ffi::c_void;
type Generate = unsafe extern "C" fn(*const std::ffi::c_void, *const c_char, i32, f32) -> *const Audio;
type Free = unsafe extern "C" fn(*const Audio);

struct Engine { _libs: Vec<libloading::Library>, tts: usize, gen: Generate, free: Free }
unsafe impl Send for Engine {}
static ENG: Mutex<Option<Engine>> = Mutex::new(None);
static FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn open() -> Option<Engine> {
    let d = util::runtime().join("tts");
    let k = d.join("kokoro");
    if !k.join("model.onnx").exists() { log("tts: no model"); return None; }
    let t0 = std::time::Instant::now();
    unsafe {
        // load the onnxruntime next to it first, by full path, so Windows never picks another copy
        let ort = libloading::Library::new(d.join("onnxruntime.dll")).map_err(|e| log(&format!("tts: onnxruntime {e}"))).ok()?;
        let lib = libloading::Library::new(d.join("sherpa-onnx-c-api.dll")).map_err(|e| log(&format!("tts: sherpa {e}"))).ok()?;
        let create: Create = *lib.get(b"SherpaOnnxCreateOfflineTts\0").ok()?;
        let gen: Generate = *lib.get(b"SherpaOnnxOfflineTtsGenerate\0").ok()?;
        let free: Free = *lib.get(b"SherpaOnnxDestroyOfflineTtsGeneratedAudio\0").ok()?;
        let s = |p: std::path::PathBuf| CString::new(p.to_string_lossy().as_bytes()).unwrap_or_default();
        let model = s(k.join("model.onnx")); let voices = s(k.join("voices.bin")); let tokens = s(k.join("tokens.txt"));
        let data = s(k.join("espeak-ng-data")); let dict = s(k.join("dict"));
        let lex = CString::new(format!("{},{}", k.join("lexicon-us-en.txt").display(), k.join("lexicon-zh.txt").display())).unwrap_or_default();
        let fsts = CString::new(format!("{},{},{}", k.join("phone-zh.fst").display(), k.join("date-zh.fst").display(), k.join("number-zh.fst").display())).unwrap_or_default();
        let cpu = CString::new("cpu").unwrap();
        let empty = CString::new("").unwrap();
        let mut c: Cfg = std::mem::zeroed();
        c.model.kokoro = Kokoro { model: model.as_ptr(), voices: voices.as_ptr(), tokens: tokens.as_ptr(), data_dir: data.as_ptr(), length_scale: 1.0, dict_dir: dict.as_ptr(), lexicon: lex.as_ptr(), lang: empty.as_ptr() };
        c.model.num_threads = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4).clamp(2, 4);
        c.model.provider = cpu.as_ptr();
        c.rule_fsts = fsts.as_ptr();
        c.max_num_sentences = 1;
        c.silence_scale = 0.2;
        let tts = create(&c);
        if tts.is_null() { log("tts: create failed"); return None; }
        log(&format!("tts: ready in {} ms", t0.elapsed().as_millis()));
        Some(Engine { _libs: vec![lib, ort], tts: tts as usize, gen, free })
    }
}
pub fn warm() { std::thread::spawn(|| { let _ = with(|_| ()); }); }
fn with<R>(f: impl FnOnce(&Engine) -> R) -> Option<R> {
    if FAILED.load(std::sync::atomic::Ordering::Relaxed) { return None; }
    let mut g = lock(&ENG);
    if g.is_none() { *g = open(); if g.is_none() { FAILED.store(true, std::sync::atomic::Ordering::Relaxed); } }
    g.as_ref().map(f)
}

fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let mut b = Vec::with_capacity(44 + samples.len() * 2);
    let data = (samples.len() * 2) as u32;
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + data).to_le_bytes()); b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes()); b.extend_from_slice(&(rate * 2).to_le_bytes()); b.extend_from_slice(&2u16.to_le_bytes()); b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data"); b.extend_from_slice(&data.to_le_bytes());
    for s in samples { b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()); }
    b
}

/// {text, sid, speed} → {ok, url}
pub fn say(a: &Value) -> Value {
    let text = a["text"].as_str().unwrap_or("").trim().chars().take(600).collect::<String>();
    if text.is_empty() { return json!({ "ok": false }); }
    let sid = a["sid"].as_i64().unwrap_or(0) as i32;
    let speed = a["speed"].as_f64().unwrap_or(1.0).clamp(0.5, 1.6) as f32;
    let name = util::hash(&format!("k11|{sid}|{speed:.2}|{text}"));
    let dir = util::cache_dir().join("tts");
    let f = dir.join(format!("{name}.wav"));
    let url = format!("http://llearn.localhost/tts/{name}.wav");
    if f.exists() { return json!({ "ok": true, "url": url, "cached": true }); }
    let t0 = std::time::Instant::now();
    let Ok(ct) = CString::new(text.clone()) else { return json!({ "ok": false }) };
    let r = with(|e| unsafe {
        let a = (e.gen)(e.tts as *const _, ct.as_ptr(), sid, speed);
        if a.is_null() { return None; }
        let au = &*a;
        let s = std::slice::from_raw_parts(au.samples, au.n.max(0) as usize).to_vec();
        let rate = au.sample_rate as u32;
        (e.free)(a);
        Some((s, rate))
    }).flatten();
    match r {
        Some((s, rate)) if !s.is_empty() => {
            let _ = std::fs::create_dir_all(&dir);
            let ok = std::fs::write(&f, wav(&s, rate)).is_ok();
            log(&format!("tts: {} chars sid={sid} in {} ms", text.chars().count(), t0.elapsed().as_millis()));
            json!({ "ok": ok, "url": url })
        }
        _ => json!({ "ok": false, "reason": if FAILED.load(std::sync::atomic::Ordering::Relaxed) { "noengine" } else { "fail" } }),
    }
}
