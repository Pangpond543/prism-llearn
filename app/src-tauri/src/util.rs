// Small shared helpers: folders, the log, hidden child processes that die with us, curl (ships with Windows) for web
// pages / subtitles, and a tiny HTTP client for the local translation server.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

pub const NO_WINDOW: u32 = 0x0800_0000;

pub fn now_ms() -> u128 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) }
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }

fn env_dir(k: &str) -> PathBuf { PathBuf::from(std::env::var(k).unwrap_or_default()) }
/// Settings, cards, sources (small, worth keeping): %APPDATA%\com.prism.llearn
pub fn data_dir() -> PathBuf { let d = env_dir("APPDATA").join("com.prism.llearn"); let _ = std::fs::create_dir_all(&d); d }
/// Re-creatable things (voice clips, translations, the log): %LOCALAPPDATA%\com.prism.llearn
pub fn cache_dir() -> PathBuf { let d = env_dir("LOCALAPPDATA").join("com.prism.llearn"); let _ = std::fs::create_dir_all(&d); d }
/// Videos kept for offline watching — a folder the user can see: Videos\Prism LLearn
pub fn video_dir() -> PathBuf { env_dir("USERPROFILE").join("Videos").join("Prism LLearn") } // created on the first download
pub fn exe_dir() -> PathBuf { std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default() }
/// app\bin\runtime (tools + models). PRISM_RUNTIME overrides it for tests.
pub fn runtime() -> PathBuf {
    if let Ok(p) = std::env::var("PRISM_RUNTIME") { return PathBuf::from(p); }
    let r = exe_dir().join("runtime");
    if r.exists() { return r; }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("bin").join("runtime")
}

pub fn log(s: &str) {
    let p = cache_dir().join("prism.log");
    if std::fs::metadata(&p).map(|m| m.len() > 600_000).unwrap_or(false) { let _ = std::fs::rename(&p, cache_dir().join("prism.old.log")); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) { let _ = writeln!(f, "[{}] {s}", now_ms()); }
}

/// The page tells us its language so native text (dialogs, errors) follows it.
pub static LANG_EN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn tr<'a>(th: &'a str, en: &'a str) -> &'a str { if LANG_EN.load(std::sync::atomic::Ordering::Relaxed) { en } else { th } }

pub fn hidden(exe: &std::path::Path) -> Command {
    let mut c = Command::new(exe);
    c.creation_flags(NO_WINDOW).stdin(std::process::Stdio::null());
    c
}
/// Child processes are put in a job that Windows closes when we exit, so no server is left behind.
pub fn kill_with_us(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::*;
    static JOB: OnceLock<isize> = OnceLock::new();
    unsafe {
        let job = *JOB.get_or_init(|| {
            let j = CreateJobObjectW(None, None).unwrap_or_default();
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(j, JobObjectExtendedLimitInformation, &info as *const _ as _, std::mem::size_of_val(&info) as u32);
            j.0 as isize
        });
        let _ = AssignProcessToJobObject(HANDLE(job as _), HANDLE(child.as_raw_handle() as _));
    }
}

fn curl() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let p = PathBuf::from(root).join("System32").join("curl.exe");
    if p.exists() { p } else { PathBuf::from("curl.exe") }
}
/// GET with the Windows curl → (status, body bytes, final url). Only http(s); 0 = network failure.
pub fn fetch(url: &str, max_bytes: u64, timeout_s: u32) -> (u32, Vec<u8>, String) {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return (0, vec![], String::new()); }
    let mut c = hidden(&curl());
    c.args(["-sL", "--compressed", "--proto", "=http,https", "--max-redirs", "8", "--max-time", &timeout_s.to_string(), "--max-filesize", &max_bytes.to_string(),
        "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        "-H", "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,th;q=0.7", "-w", "\n@@%{http_code} %{url_effective}"]);
    c.arg(url);
    match c.output() {
        Ok(o) => {
            let b = o.stdout;
            let cut = b.windows(3).rposition(|w| w == b"\n@@").unwrap_or(b.len());
            let tail = String::from_utf8_lossy(&b[(cut + 3).min(b.len())..]).to_string();
            let (code, eff) = tail.split_once(' ').unwrap_or((tail.as_str(), ""));
            (code.trim().parse().unwrap_or(0), b[..cut].to_vec(), eff.trim().to_string())
        }
        Err(_) => (0, vec![], String::new()),
    }
}

/// POST JSON to 127.0.0.1:<port><path> → body text. Handles Content-Length and chunked replies.
pub fn local_post(port: u16, path: &str, body: &str, timeout: Duration) -> Result<String, String> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(800)).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(timeout));
    let req = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad reply")?;
    let head = String::from_utf8_lossy(&buf[..split]).to_lowercase();
    let mut rest = buf[split + 4..].to_vec();
    if !head.starts_with("http/1.1 200") && !head.starts_with("http/1.0 200") { return Err(head.lines().next().unwrap_or("").to_string()); }
    if head.contains("transfer-encoding: chunked") {
        let mut out = Vec::new();
        loop {
            let Some(p) = rest.windows(2).position(|w| w == b"\r\n") else { break };
            let n = usize::from_str_radix(String::from_utf8_lossy(&rest[..p]).trim(), 16).unwrap_or(0);
            if n == 0 || rest.len() < p + 2 + n { break; }
            out.extend_from_slice(&rest[p + 2..p + 2 + n]);
            rest = rest[(p + 4 + n).min(rest.len())..].to_vec();
        }
        rest = out;
    }
    Ok(String::from_utf8_lossy(&rest).to_string())
}
#[allow(dead_code)]
pub fn port_open(port: u16) -> bool { TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(150)).is_ok() }
pub fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").ok().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(18431) }

/// Short stable hash for cache file names (FNV-1a 64).
pub fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}
/// Write via a temp file + rename, keeping the previous copy as .bak (a crash mid-write never loses the cards).
pub fn write_safe(p: &std::path::Path, data: &[u8]) -> bool {
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, data).is_err() { return false; }
    if p.exists() { let _ = std::fs::copy(p, p.with_extension("bak")); }
    std::fs::rename(&tmp, p).is_ok()
}

/// yt-dlp progress line "<percent>|<downloaded bytes>|<total or estimate>" → 0..1 (sites like Bilibili give no percent)
pub fn dl_frac(p: &str) -> f64 {
    let mut it = p.split('|');
    let pct = it.next().unwrap_or("").trim().trim_end_matches('%').trim().parse::<f64>().ok().map(|v| v / 100.0);
    let done = it.next().and_then(|x| x.trim().parse::<f64>().ok());
    let total = it.next().and_then(|x| x.trim().parse::<f64>().ok()).filter(|t| *t > 0.0);
    pct.or_else(|| Some(done? / total?)).unwrap_or(0.0).clamp(0.0, 1.0)
}
