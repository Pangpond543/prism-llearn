// Prism — self-update from a GitHub repository ("owner/name"). Same behaviour as Prism Size's updater.js,
// done with the curl.exe / tar.exe that ship with Windows so the app needs no extra network code.
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const HOSTS: [&str; 5] = ["api.github.com", "github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"];
const NO_WINDOW: u32 = 0x0800_0000;

pub fn valid_repo(r: &str) -> bool {
    let mut parts = r.split('/');
    let ok = |s: Option<&str>| s.map_or(false, |s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)));
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}
fn allowed(url: &str) -> bool {
    url.strip_prefix("https://").and_then(|r| r.split('/').next()).map_or(false, |h| HOSTS.contains(&h))
}
fn sys(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let p = PathBuf::from(root).join("System32").join(exe);
    if p.exists() { p } else { PathBuf::from(exe) }
}
/// GET → (http status, body). status 0 = network failure.
fn get(url: &str, file: Option<&Path>) -> (u32, String) {
    if !allowed(url) { return (0, String::new()); }
    let mut c = Command::new(sys("curl.exe"));
    c.args(["-sL", "--proto", "=https", "--proto-redir", "=https", "--max-time", if file.is_some() { "600" } else { "20" }, "-A", "prism-updater", "-w", "\n%{http_code}"]);
    if let Some(f) = file { c.arg("-o").arg(f); }
    c.arg(url).creation_flags(NO_WINDOW);
    match c.output() {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let (body, code) = text.rsplit_once('\n').unwrap_or(("", text.as_str()));
            (code.trim().parse().unwrap_or(0), body.to_string())
        }
        Err(_) => (0, String::new()),
    }
}
fn nums(v: &str) -> [u32; 3] {
    let s = v.trim_start_matches(|c: char| !c.is_ascii_digit());
    let mut out = [0u32; 3];
    for (i, p) in s.split(|c| c == '.' || c == '+' || c == '-').take(3).enumerate() { out[i] = p.parse().unwrap_or(0); }
    out
}
pub fn newer(remote: &str, local: &str) -> bool { nums(remote) > nums(local) }

/// → { ok, latest, current, hasUpdate, zip } | { ok:false, reason }
pub fn check(repo: &str, current: &str) -> Value {
    if !valid_repo(repo) { return json!({ "ok": false, "reason": "norepo" }); }
    let fail = |code: u32| json!({ "ok": false, "reason": if code == 404 { "notfound" } else { "network" } });
    let (code, body) = get(&format!("https://api.github.com/repos/{repo}/releases/latest"), None);
    let (latest, zip);
    let mut assets = Vec::new();
    if code == 200 {
        let rel: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
        for a in rel["assets"].as_array().cloned().unwrap_or_default() {
            assets.push(json!({ "name": a["name"].as_str().unwrap_or(""), "url": a["browser_download_url"].as_str().unwrap_or("") }));
        }
        latest = tag.trim_start_matches(['v', 'V']).to_string();
        zip = format!("https://codeload.github.com/{repo}/zip/refs/tags/{tag}");
    } else if code == 404 {
        // no releases published → compare against package.json on the default branch
        let (mut c2, mut b2) = get(&format!("https://raw.githubusercontent.com/{repo}/HEAD/app/package.json"), None);
        if c2 == 404 { (c2, b2) = get(&format!("https://raw.githubusercontent.com/{repo}/HEAD/package.json"), None); }
        if c2 != 200 { return fail(c2); }
        let pkg: Value = serde_json::from_str(&b2).unwrap_or(Value::Null);
        latest = pkg["version"].as_str().unwrap_or("").to_string();
        zip = format!("https://codeload.github.com/{repo}/zip/HEAD");
    } else { return fail(code); }
    if latest.is_empty() { return json!({ "ok": false, "reason": "noversion" }); }
    json!({ "ok": true, "latest": latest, "current": current, "hasUpdate": newer(&latest, current), "zip": zip, "assets": assets })
}

/* ------------------------------------------------------------ packaged builds */
// The Setup.exe / Portable.zip on the GitHub release replace the program; no Rust needed on the user's PC.
pub const UNINSTALLER: &str = "uninstall.exe"; // written by tools/installer.nsi

/// "setup" when this copy was installed by the Prism LLearn installer, otherwise "portable".
pub fn packaged_kind(exe_dir: &Path) -> &'static str { if exe_dir.join(UNINSTALLER).exists() { "setup" } else { "portable" } }

fn pick_asset(info: &Value, kind: &str) -> Option<(String, String)> {
    let want = |n: &str| {
        let n = n.to_ascii_lowercase();
        if kind == "setup" { n.contains("setup") && n.ends_with(".exe") } else { n.contains("portable") && n.ends_with(".zip") }
    };
    info["assets"].as_array()?.iter().find(|a| want(a["name"].as_str().unwrap_or("")))
        .map(|a| (a["name"].as_str().unwrap_or("").to_string(), a["url"].as_str().unwrap_or("").to_string()))
}
fn safe_name(s: &str) -> String { s.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).take(80).collect() }

// put one file in place even when the old one is in use: a running exe / loaded dll can be renamed, not overwritten
fn replace_file(from: &Path, to: &Path) -> bool {
    if to.exists() && std::fs::remove_file(to).is_err() {
        let old = PathBuf::from(format!("{}.old", to.display()));
        let _ = std::fs::remove_file(&old);
        if std::fs::rename(to, &old).is_err() { return false; }
    }
    std::fs::copy(from, to).is_ok()
}
fn copy_over(src: &Path, dst: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(src) else { return false };
    let mut ok = true;
    for e in rd.flatten() {
        let (from, to) = (e.path(), dst.join(e.file_name()));
        if from.is_dir() { ok &= std::fs::create_dir_all(&to).is_ok() && copy_over(&from, &to); }
        else if e.file_name() == "prism.config.json" && to.exists() { continue; } // keep the user's settings
        else { ok &= replace_file(&from, &to); }
    }
    ok
}
fn find_exe_dir(root: &Path, depth: u32) -> Option<PathBuf> {
    if root.join("prism-llearn.exe").is_file() { return Some(root.to_path_buf()); }
    if depth == 0 { return None; }
    std::fs::read_dir(root).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| find_exe_dir(&e.path(), depth - 1))
}
/// Delete leftovers of the previous update: files that were renamed to *.old while they were in use.
pub fn clean_old(exe_dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(exe_dir) {
        for e in rd.flatten() { if e.file_name().to_string_lossy().ends_with(".old") { let _ = std::fs::remove_file(e.path()); } }
    }
}

/// → (result, installer to run on restart). Installed copy: downloads the new Setup.exe. Portable copy: downloads the
/// Portable.zip and unpacks it over the program folder right away (the new files are used after the restart).
pub fn apply_release(info: &Value, exe_dir: &Path, on_step: &dyn Fn(&str)) -> (Value, Option<PathBuf>) {
    let no = |reason: &str| (json!({ "ok": false, "reason": reason }), None);
    let kind = packaged_kind(exe_dir);
    let Some((name, url)) = pick_asset(info, kind) else { return no("noasset") };
    let tmp = std::env::temp_dir().join(format!("prism-llearn-update-{}", std::process::id()));
    if std::fs::create_dir_all(tmp.join("x")).is_err() { return no("extract"); }
    let version = info["latest"].as_str().unwrap_or("").to_string();
    on_step("download");
    let file = tmp.join(safe_name(&name));
    let (code, _) = get(&url, Some(&file));
    if code != 200 || std::fs::metadata(&file).map(|m| m.len() < 100_000).unwrap_or(true) { return no("network"); }
    if kind == "setup" { return (json!({ "ok": true, "version": version, "kind": kind }), Some(file)); }
    on_step("extract");
    let _ = Command::new(sys("tar.exe")).arg("-xf").arg(&file).arg("-C").arg(tmp.join("x")).creation_flags(NO_WINDOW).status();
    let Some(src) = find_exe_dir(&tmp.join("x"), 2) else { return no("notprism") };
    on_step("copy");
    if !copy_over(&src, exe_dir) { return no("layout"); }
    (json!({ "ok": true, "version": version, "kind": kind }), None)
}

const SKIP: [&str; 4] = ["node_modules", ".git", "prism.config.json", "target"];
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let name = e.file_name();
        if SKIP.iter().any(|s| name == *s) { continue; }
        let (from, to) = (e.path(), dst.join(&name));
        if e.file_type()?.is_dir() { copy_tree(&from, &to)?; } else { std::fs::copy(&from, &to)?; }
    }
    Ok(())
}

/// Download the source zip, unpack it, copy it over `app_dir`, then rebuild the program with cargo.
pub fn apply(zip_url: &str, app_dir: &Path, expect_name: &str, on_step: &dyn Fn(&str)) -> Value {
    let no = |reason: &str| json!({ "ok": false, "reason": reason });
    let tmp = std::env::temp_dir().join(format!("prism-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    if std::fs::create_dir_all(tmp.join("x")).is_err() { return no("extract"); }
    let done = |v: Value| { let _ = std::fs::remove_dir_all(&tmp); v };

    on_step("download");
    let zip = tmp.join("src.zip");
    let (code, _) = get(zip_url, Some(&zip));
    if code != 200 { return done(no("network")); }

    on_step("extract");
    let _ = Command::new(sys("tar.exe")).arg("-xf").arg(&zip).arg("-C").arg(tmp.join("x")).creation_flags(NO_WINDOW).status();
    let tops: Vec<PathBuf> = std::fs::read_dir(tmp.join("x")).map(|d| d.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect()).unwrap_or_default();
    if tops.is_empty() { return done(no("extract")); }
    if tops.len() != 1 { return done(no("layout")); }
    let mut src = tops[0].clone();
    if src.join("app").join("package.json").exists() { src = src.join("app"); } // repo keeps the program in app/
    let pkg: Value = std::fs::read_to_string(src.join("package.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    if pkg["name"].as_str() != Some(expect_name) || !src.join("src-tauri").join("tauri.conf.json").exists() { return done(no("notprism")); }

    on_step("copy");
    if !app_dir.join("src-tauri").exists() { return done(no("layout")); } // not running from a source checkout
    if copy_tree(&src, app_dir).is_err() { return done(no("layout")); }

    on_step("build");
    // a running .exe cannot be overwritten on Windows, but it can be renamed out of the way
    let exe = std::env::current_exe().unwrap_or_default();
    let old = exe.with_extension("old.exe");
    let _ = std::fs::remove_file(&old);
    let renamed = std::fs::rename(&exe, &old).is_ok();
    let mut cargo = Command::new("cargo");
    cargo.args(["build", "--release", "--manifest-path"]).arg(app_dir.join("src-tauri").join("Cargo.toml")).creation_flags(NO_WINDOW);
    if let Some(target) = exe.parent().and_then(|p| p.parent()) { cargo.env("CARGO_TARGET_DIR", target); }
    let built = cargo.status().map(|s| s.success()).unwrap_or(false) && exe.exists();
    if !built {
        if renamed && !exe.exists() { let _ = std::fs::rename(&old, &exe); }
        return done(no("build"));
    }
    done(json!({ "ok": true, "version": pkg["version"].as_str().unwrap_or("") }))
}
