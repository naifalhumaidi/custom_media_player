/* The desktop shell.

   Deliberately thin. Everything the app can do, it already does in the
   browser; this process supplies the three things a browser tab cannot:

     1. a native file and folder dialog
     2. real filesystem paths, so a playlist survives a restart
     3. somewhere to keep the saved state that is not localStorage

   No playback logic lives here. The media library in the webview is still the
   only thing that plays anything, and it decodes through the platform's own
   media stack.

   Notably absent: a codec check. It is tempting to put one here, and it would
   be the wrong place - this process never decodes anything. The authoritative
   question ("can THIS machine play H.264?") is answered by the webview trying
   to play a real clip, which is the same code path as real playback. See
   js/source-tauri.js, which does exactly that at startup. */

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/* ------------------------------------------------------------------ */
/* saved state                                                        */
/* ------------------------------------------------------------------ */

/* One JSON file in the OS config directory. The web version keeps the same
   shape in localStorage, so the two write a structurally identical blob and
   the preference handling in app.js is shared rather than duplicated. */
fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("cannot read state: {e}"))?;
    /* A corrupt file must not stop the app from starting. The user loses their
       preferences, which is far better than losing the window. */
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => Ok(Some(value)),
        Err(err) => {
            eprintln!("[state] ignoring an unreadable {}: {err}", path.display());
            Ok(None)
        }
    }
}

#[tauri::command]
fn save_state(app: tauri::AppHandle, state: Value) -> Result<(), String> {
    let path = state_path(&app)?;
    /* Write to a sibling and rename, so a crash mid-write cannot leave a
       half-written file that the next launch would have to discard. */
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&state).map_err(|e| format!("cannot encode: {e}"))?;
    fs::write(&tmp, text).map_err(|e| format!("cannot write state: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("cannot commit state: {e}"))
}

/* ------------------------------------------------------------------ */
/* dialogs                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Open media")
        .add_filter(
            "Media",
            &[
                "mp4", "m4v", "webm", "ogv", "mov", "png", "jpg", "jpeg", "gif", "webp",
                "avif", "bmp", "svg", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus",
                "flac", "aiff", "aif",
            ],
        )
        .pick_files(move |chosen| {
            let _ = tx.send(chosen);
        });

    let chosen = rx
        .recv()
        .map_err(|e| format!("the file dialog failed: {e}"))?
        .unwrap_or_default();

    /* into_path() is fallible - a path the shell cannot express as a real
       filesystem path. Such an entry is dropped rather than panicking the
       whole dialog, which would take the app down for one odd file. */
    Ok(chosen
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Open a folder")
        .pick_folder(move |chosen| {
            let _ = tx.send(chosen);
        });

    let chosen = rx
        .recv()
        .map_err(|e| format!("the folder dialog failed: {e}"))?;

    Ok(chosen
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/* One level only, and no filtering by type: the caller already knows how to
   decide what is playable, and one source of truth for that decision is the
   whole point of js/mime.js. A recursive walk is a different feature with a
   progress state attached to it. */
#[tauri::command]
fn list_folder(dir: String) -> Result<Vec<String>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("not a folder: {dir}"));
    }
    let mut out: Vec<String> = fs::read_dir(root)
        .map_err(|e| format!("cannot read {dir}: {e}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect();
    /* Sorted, because a directory read comes back in whatever order the
       filesystem feels like, and a playlist that reshuffles between launches
       looks like a bug. */
    out.sort_by_key(|p| p.to_lowercase());
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* filesystem facts                                                   */
/* ------------------------------------------------------------------ */

/* Asked once per item, rather than letting the media element discover a moved
   file by failing to load it. That failure costs a 2.5s probe timeout per row
   and produces no message; this returns immediately and says which. */
#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/* ------------------------------------------------------------------ */
/* diagnostic                                                         */
/* ------------------------------------------------------------------ */

/* Used by `--diagnose`, which prints a report and exits. It answers the two
   questions that are otherwise invisible from outside the process: is the
   shell's API actually reachable from the page, and can this machine decode
   H.264. The second is decided by the platform media stack, not by anything
   in this repository, and on Linux it is the most common reason a desktop
   build of a video player appears to do nothing at all. */
#[tauri::command]
fn print_diagnostic(app: AppHandle, window: WebviewWindow, report: Value, done: bool) {
    println!("--- custom media player: diagnostic ---");
    if let Some(map) = report.as_object() {
        for (key, value) in map {
            let rendered = match value {
                Value::String(ref s) => s.clone(),
                other => other.to_string(),
            };
            println!("  {key:<28} {rendered}");
        }
    }
    if !done {
        /* The first report proves the page can talk to the shell. The codec
           verdict arrives a moment later and is the reason the app is still
           running. */
        println!("--- (waiting for the codec probe) ---");
        return;
    }
    println!("--- end diagnostic ---");

    /* Mirrored to a file, because the answer matters more than the terminal it
       happened to be started from - a user reporting a broken install will not
       have a shell open. */
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(text) = serde_json::to_string_pretty(&report) {
            let _ = std::fs::write(dir.join("diagnostic.json"), text);
        }
    }

    let _ = window.close();
    app.exit(0);
}

fn main() {
    let diagnose = std::env::args().any(|a| a == "--diagnose");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        /* on_page_load, not setup: the window declared in tauri.conf.json does
           not exist yet when setup runs, so a lookup there finds nothing and
           the diagnostic silently never happens. */
        .on_page_load(move |window, payload| {
            if diagnose && payload.event() == tauri::webview::PageLoadEvent::Finished {
                /* The page records what it finds on window.__DIAG__ and this
                   thread collects it. The page's own timers are not used for
                   the wait: WebKit throttles timers in a page it considers
                   hidden, and a diagnostic that silently never finishes is
                   worse than none. A Rust thread is not throttled. */
                /* The probe needs a real file on disk, because "can this app
                   play a video" is only answered by loading one the way the app
                   loads a user's file. Supplied by the caller as an absolute
                   path; the probe reports clearly when it is absent rather than
                   quietly testing something else. */
                let probe = std::env::var("MT_PROBE_FILE").unwrap_or_default();
                let audio = std::env::var("MT_PROBE_AUDIO").unwrap_or_default();
                let preamble = format!(
                    "window.__PROBE_FILE__ = {}; window.__PROBE_MP3__ = {};",
                    serde_json::to_string(&probe).unwrap_or_else(|_| "\"\"".into()),
                    serde_json::to_string(&audio).unwrap_or_else(|_| "\"\"".into())
                );
                let script = format!("{preamble}\n{}", include_str!("diagnostic.js"));
                window.eval(&script).ok();
                let collect = include_str!("diagnostic-collect.js").to_string();
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(15000));
                    window.eval(&collect).ok();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            pick_files,
            pick_folder,
            list_folder,
            file_exists,
            print_diagnostic,
        ])
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}

#[cfg(test)]
mod tests;
