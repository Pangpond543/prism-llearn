// Speech → text, offline: whisper.cpp's whisper-server (runtime\whisper\, Vulkan build = the graphics card, ggml falls
// back to the CPU by itself) as hidden child processes that keep a model loaded. Two slots: "batch" (AI subtitles for
// whole videos, one chunk at a time) and "live" (live subtitles from the PC's sound — its own server so it never waits
// behind a 90-second chunk). Both are killed with us (job object) and unloaded after a few idle minutes.
use crate::util::{self, lock, log};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Srv { child: std::process::Child, port: u16, model: PathBuf, gpu: bool, last: Instant }
static SRV: Mutex<Option<HashMap<&'static str, Srv>>> = Mutex::new(None);
/// set when the graphics-card server failed this run (driver problem): the rest of the run uses the CPU. PRISM_CPU=1 = test switch.
static NO_GPU: AtomicBool = AtomicBool::new(false);
const IDLE: Duration = Duration::from_secs(5 * 60);

pub fn dir() -> PathBuf { util::runtime().join("whisper") }
pub fn installed() -> bool { dir().join("whisper-server.exe").exists() }
fn no_gpu() -> bool { NO_GPU.load(Ordering::Relaxed) || std::env::var("PRISM_CPU").map_or(false, |v| v == "1") }
/// "best" = large-v3-turbo (accurate), "fast" = small (lighter; the better pick without a graphics card).
/// A missing file falls back to the other model.
pub fn model(mode: &str) -> Option<PathBuf> {
    let d = dir().join("models");
    let ok = |n: &str| { let p = d.join(n); (std::fs::metadata(&p).map(|m| m.len() > 20_000_000).unwrap_or(false)).then_some(p) };
    let best = || ok("ggml-large-v3-turbo-q5_0.bin").or_else(|| ok("ggml-large-v3-turbo-q8_0.bin")).or_else(|| ok("ggml-large-v3-turbo.bin"));
    let fast = || ok("ggml-small-q8_0.bin").or_else(|| ok("ggml-small.bin"));
    if mode == "fast" { fast().or_else(best) } else { best().or_else(fast) }
}
pub fn device() -> &'static str {
    let g = lock(&SRV).as_ref().and_then(|m| m.values().next().map(|s| s.gpu));
    if g.unwrap_or(!no_gpu()) { "gpu" } else { "cpu" }
}

fn get_ok(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut b = [0u8; 16];
    s.read(&mut b).map(|n| n >= 12 && &b[9..12] == b"200").unwrap_or(false)
}

/// Port of a ready server in `slot` with `mode`'s model (starts / swaps it; CPU retry if the card fails).
pub fn port(slot: &'static str, mode: &str) -> Result<u16, String> {
    let Some(m) = model(mode) else { return Err("nomodel".into()) };
    {
        let mut g = lock(&SRV);
        let map = g.get_or_insert_with(HashMap::new);
        if let Some(s) = map.get_mut(slot) {
            if s.model == m && s.child.try_wait().ok().flatten().is_none() { s.last = Instant::now(); return Ok(s.port); }
            let _ = s.child.kill();
            map.remove(slot);
        }
    }
    for attempt in 0..2 {
        let gpu = !no_gpu();
        let port = util::free_port();
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8).to_string();
        // a child exe with a missing DLL would show a Windows error box and hang (Prism VoiceOpen pitfall)
        unsafe { use windows::Win32::System::Diagnostics::Debug::*; SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX); }
        let mut c = util::hidden(&dir().join("whisper-server.exe"));
        c.current_dir(dir()).arg("-m").arg(&m).args(["--host", "127.0.0.1", "--port", &port.to_string(), "-t", &threads, "-nlp"]);
        if !gpu { c.arg("-ng"); }
        c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        util::kill_with_us(&child);
        log(&format!("whisper: {slot} pid={} port={port} gpu={gpu} model={}", child.id(), m.display()));
        let t0 = Instant::now();
        let mut ready = false;
        while t0.elapsed() < Duration::from_secs(if gpu { 60 } else { 90 }) {
            if child.try_wait().ok().flatten().is_some() { break; }
            if get_ok(port) { ready = true; break; }
            std::thread::sleep(Duration::from_millis(250));
        }
        if ready {
            log(&format!("whisper: {slot} ready in {} ms", t0.elapsed().as_millis()));
            lock(&SRV).get_or_insert_with(HashMap::new).insert(slot, Srv { child, port, model: m.clone(), gpu, last: Instant::now() });
            return Ok(port);
        }
        let _ = child.kill();
        log(&format!("whisper: {slot} never ready (gpu={gpu}, attempt {attempt})"));
        if !gpu { break; }
        NO_GPU.store(true, Ordering::Relaxed);
    }
    Err("engine".into())
}
/// The card crashed in the middle of a job: restart that slot on the CPU.
pub fn gpu_failed(slot: &'static str) {
    if no_gpu() { return; }
    log("whisper: request failed on the graphics card — switching to the CPU");
    NO_GPU.store(true, Ordering::Relaxed);
    stop(slot);
}
pub fn stop(slot: &str) { if let Some(mut s) = lock(&SRV).as_mut().and_then(|m| m.remove(slot)) { let _ = s.child.kill(); log(&format!("whisper: {slot} stopped")); } }
pub fn stop_all() { if let Some(m) = lock(&SRV).as_mut() { for (_, mut s) in m.drain() { let _ = s.child.kill(); } } }
pub fn touch(slot: &str) { if let Some(s) = lock(&SRV).as_mut().and_then(|m| m.get_mut(slot)) { s.last = Instant::now(); } }
/// Unload servers nobody used for IDLE (the graphics memory is shared with the translator).
pub fn idle_watch(busy: fn(&str) -> bool) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let idle: Vec<&'static str> = lock(&SRV).as_ref().map(|m| m.iter().filter(|(k, s)| s.last.elapsed() > IDLE && !busy(k)).map(|(k, _)| *k).collect()).unwrap_or_default();
        for k in idle { stop(k); }
    });
}

/// POST one WAV to /inference. `cancel` closes the connection (the server then aborts the job). → JSON text
pub fn infer(port: u16, wav: &[u8], fields: &[(&str, String)], cancel: &AtomicBool, timeout: Duration) -> Result<String, String> {
    let boundary = format!("----prismllearn{}", util::now_ms());
    let mut body = Vec::with_capacity(wav.len() + 2048);
    for (k, v) in fields { body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes()); }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let head = format!("POST /inference HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    s.write_all(head.as_bytes()).and_then(|_| s.write_all(&body)).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(250)));
    let t0 = Instant::now();
    let mut buf = Vec::new();
    let mut tmp = [0u8; 65536];
    loop {
        if cancel.load(Ordering::Relaxed) { let _ = s.shutdown(std::net::Shutdown::Both); return Err("cancel".into()); }
        if t0.elapsed() > timeout { return Err("timeout".into()); }
        match s.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad reply")?;
    let h = String::from_utf8_lossy(&buf[..split]).to_lowercase();
    let body = String::from_utf8_lossy(&buf[split + 4..]).to_string();
    if !h.starts_with("http/1.1 200") { return Err(format!("status {}", h.lines().next().unwrap_or(""))); }
    Ok(body)
}

/* ------------------------------------------------------------ WAV helpers (16 kHz mono 16-bit) */
pub const RATE: usize = 16000;
pub fn wav_header(n_samples: usize) -> Vec<u8> {
    let data = (n_samples * 2) as u32;
    let mut b = Vec::with_capacity(44);
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + data).to_le_bytes()); b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&(RATE as u32).to_le_bytes()); b.extend_from_slice(&(RATE as u32 * 2).to_le_bytes()); b.extend_from_slice(&2u16.to_le_bytes()); b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data"); b.extend_from_slice(&data.to_le_bytes());
    b
}
pub fn wav_f32(s: &[f32]) -> Vec<u8> {
    let mut b = wav_header(s.len());
    for v in s { b.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()); }
    b
}
/// (offset of the sample data, number of samples) of a 16-bit mono WAV written by ffmpeg (skips LIST chunks)
pub fn wav_data(p: &std::path::Path) -> Option<(u64, usize)> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut head = vec![0u8; 4096];
    let n = f.read(&mut head).ok()?;
    head.truncate(n);
    if head.len() < 12 || &head[0..4] != b"RIFF" { return None; }
    let mut i = 12;
    while i + 8 <= head.len() {
        let len = u32::from_le_bytes(head[i + 4..i + 8].try_into().ok()?) as usize;
        if &head[i..i + 4] == b"data" {
            let total = std::fs::metadata(p).ok()?.len();
            let len = if len == 0 || len as u64 > total { (total - (i as u64 + 8)) as usize } else { len }; // ffmpeg piping may leave 0 / max
            return Some((i as u64 + 8, len / 2));
        }
        i += 8 + len + (len & 1);
    }
    None
}
