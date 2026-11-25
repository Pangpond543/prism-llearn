// Offline dictionaries (runtime\dict\en.json, zh.json — built by tools/dict/build.py from Wiktionary, VOLUBILIS,
// CC-CEDICT, HSK lists). Entries stay as raw JSON text (≈ file size in memory) and go to the page as they are.
//  en: w{word: [ipa, [[pos,[gloss…]]…], [thai (wiktionary)…], [[thai,pos] (volubilis)…], freq rank]}, f{form: lemma}, top[…]
//  zh: w{simplified: [[[pinyin,[english…]]…], [thai…], hsk level, freq rank]}, t{traditional: simplified}, top[…]
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Deserialize)]
pub struct Dict { w: HashMap<String, Box<RawValue>>, #[serde(default)] f: HashMap<String, String>, #[serde(default)] t: HashMap<String, String>, #[serde(default)] top: Vec<String> }

static EN: OnceLock<Option<Dict>> = OnceLock::new();
static ZH: OnceLock<Option<Dict>> = OnceLock::new();

fn load(name: &str) -> Option<Dict> {
    let t0 = std::time::Instant::now();
    let p = crate::util::runtime().join("dict").join(name);
    let r = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Dict>(&b).map_err(|e| crate::util::log(&format!("dict {name}: {e}"))).ok());
    crate::util::log(&format!("dict {name} loaded={} words={} in {} ms", r.is_some(), r.as_ref().map(|d| d.w.len()).unwrap_or(0), t0.elapsed().as_millis()));
    r
}
pub fn en() -> Option<&'static Dict> { EN.get_or_init(|| load("en.json")).as_ref() }
pub fn zh() -> Option<&'static Dict> { ZH.get_or_init(|| load("zh.json")).as_ref() }
pub fn warm() { std::thread::spawn(|| { let _ = en(); }); std::thread::spawn(|| { let _ = zh(); }); }

fn raw(v: &RawValue) -> Value { serde_json::from_str(v.get()).unwrap_or(Value::Null) }
fn has_thai(v: &Value) -> bool { v.get(2).and_then(|a| a.as_array()).map_or(false, |a| !a.is_empty()) || v.get(3).and_then(|a| a.as_array()).map_or(false, |a| !a.is_empty()) }

/// Guesses a base form when the word is not in the list of forms ("cats" → "cat", "stopped" → "stop").
fn guesses(w: &str) -> Vec<String> {
    let mut g = vec![];
    let strip = |s: &str, suf: &str| s.strip_suffix(suf).map(|x| x.to_string());
    if let Some(x) = strip(w, "'s").or_else(|| strip(w, "’s")) { g.push(x); }
    if let Some(x) = strip(w, "ies") { g.push(format!("{x}y")); }
    for suf in ["es", "s", "ed", "d", "ing", "ly", "er", "est"] {
        if let Some(x) = strip(w, suf) {
            if x.len() < 2 { continue; }
            g.push(x.clone());
            if suf == "ing" || suf == "ed" || suf == "er" || suf == "est" {
                g.push(format!("{x}e"));
                let b = x.as_bytes();
                if b.len() > 2 && b[b.len() - 1] == b[b.len() - 2] { g.push(x[..x.len() - 1].to_string()); }
            }
            if suf == "ied" { g.push(format!("{x}y")); }
        }
    }
    if let Some(x) = strip(w, "ied") { g.push(format!("{x}y")); }
    g
}

pub fn lookup_en(q: &str) -> Value {
    let Some(d) = en() else { return json!({ "ok": false, "reason": "nodict" }) };
    let w = q.trim().to_lowercase().replace('’', "'");
    let w = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-' && c != ' ').to_string();
    if w.is_empty() { return json!({ "ok": false }); }
    let get = |k: &str| d.w.get(k).map(|v| raw(v));
    let own = get(&w);
    // a form ("ran", "children") → its lemma first, unless the form's own page has Thai meanings
    let mut head = w.clone();
    let mut main = own.clone();
    let mut also: Option<(String, Value)> = None;
    let lemma = d.f.get(&w).cloned().or_else(|| {
        // phrase: lemmatise the first word ("ran into" → "run into")
        let (first, rest) = w.split_once(' ')?;
        let l = d.f.get(first)?;
        let k = format!("{l} {rest}");
        d.w.contains_key(&k).then_some(k)
    });
    if let Some(l) = lemma {
        if let Some(le) = get(&l) {
            if own.as_ref().map_or(true, |o| !has_thai(o)) {
                if let Some(o) = own.clone() { also = Some((w.clone(), o)); }
                head = l; main = Some(le);
            } else { also = Some((l, le)); }
        }
    }
    if main.is_none() {
        for g in guesses(&w) { if let Some(e) = get(&g) { head = g; main = Some(e); break; } }
    }
    match main {
        Some(e) => json!({ "ok": true, "lang": "en", "q": q, "head": head, "e": e, "also": also.map(|(h, e)| json!({ "head": h, "e": e })) }),
        None => json!({ "ok": false, "lang": "en", "q": q, "head": w }),
    }
}

pub fn lookup_zh(q: &str) -> Value {
    let Some(d) = zh() else { return json!({ "ok": false, "reason": "nodict" }) };
    let w = q.trim();
    let s = d.t.get(w).cloned().unwrap_or_else(|| w.to_string());
    match d.w.get(&s) {
        Some(e) => json!({ "ok": true, "lang": "zh", "q": q, "head": s, "e": raw(e) }),
        None => json!({ "ok": false, "lang": "zh", "q": q, "head": s }),
    }
}

/// Word list for splitting Chinese text into words on the page (simplified + traditional spellings) — one string, \n-separated.
pub fn zh_words() -> String {
    let Some(d) = zh() else { return String::new() };
    let mut s = String::with_capacity(d.w.len() * 8);
    for k in d.w.keys().chain(d.t.keys()) { if k.chars().count() <= 8 { s.push_str(k); s.push('\n'); } }
    s
}
/// Most frequent words first (placement test, "common word" hints).
pub fn top(lang: &str, n: usize) -> Value {
    let d = if lang == "zh" { zh() } else { en() };
    Value::Array(d.map(|d| d.top.iter().take(n).map(|w| Value::String(w.clone())).collect()).unwrap_or_default())
}
/// Pinyin + Thai for many Chinese words at once (ruby text over a whole page).
pub fn zh_many(words: &[String]) -> Value {
    let Some(d) = zh() else { return json!({}) };
    let mut out = serde_json::Map::new();
    for w in words {
        let s = d.t.get(w).cloned().unwrap_or_else(|| w.clone());
        if let Some(e) = d.w.get(&s) {
            let v = raw(e);
            let py = v[0][0][0].as_str().unwrap_or("").to_string();
            out.insert(w.clone(), json!([py, v[2], v[3]]));
        }
    }
    Value::Object(out)
}
/// Frequency rank of many English words (0 = not in the list) and their lemma — used to colour and count new words.
pub fn en_many(words: &[String]) -> Value {
    let Some(d) = en() else { return json!({}) };
    let mut out = serde_json::Map::new();
    for w in words {
        let lw = w.to_lowercase().replace('’', "'");
        let lemma = d.f.get(&lw).cloned().filter(|_l| d.w.get(&lw).map_or(true, |o| !has_thai(&raw(o)))).unwrap_or_else(|| {
            if d.w.contains_key(&lw) { lw.clone() } else { guesses(&lw).into_iter().find(|g| d.w.contains_key(g)).unwrap_or(lw.clone()) }
        });
        let rank = d.w.get(&lemma).map(|v| raw(v)[4].as_u64().unwrap_or(0)).unwrap_or(0);
        out.insert(w.clone(), json!([lemma, rank]));
    }
    Value::Object(out)
}

/// Traditional → simplified Chinese (CC-CEDICT spellings, longest match first) — whisper sometimes writes traditional.
pub fn to_simplified(s: &str) -> String {
    let Some(d) = zh() else { return s.to_string() };
    if d.t.is_empty() { return s.to_string(); }
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    'o: while i < c.len() {
        for n in (1..=4.min(c.len() - i)).rev() {
            let k: String = c[i..i + n].iter().collect();
            if let Some(x) = d.t.get(&k) { out.push_str(x); i += n; continue 'o; }
        }
        out.push(c[i]); i += 1;
    }
    out
}

/// is this Chinese string a dictionary word (simplified or traditional)? — keeps AI line breaks out of words
pub fn zh_has(w: &str) -> bool { zh().map_or(false, |d| d.w.contains_key(w) || d.t.contains_key(w)) }
