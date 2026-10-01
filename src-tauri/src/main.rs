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
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

mod media_server;

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
/* window                                                              */
/* ------------------------------------------------------------------ */

/* Fullscreen, at the OS level rather than through the page.

   WebKitGTK has no HTML Fullscreen API: `requestFullscreen` is absent, so on
   Linux the desktop build had a fullscreen button that could not work and a
   keyboard shortcut that reported a failure nobody could see. The window
   itself can still go fullscreen, so the page asks for that instead.

   The state is tracked here as well as read back, because a window can also
   leave fullscreen without the page asking - a window manager shortcut, or the
   user dragging it to another monitor - and the button has to follow. */
static FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
async fn set_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|e| format!("the window refused to go fullscreen: {e}"))?;
    FULLSCREEN.store(fullscreen, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn is_fullscreen(window: WebviewWindow) -> bool {
    /* The window's own answer is the truth; the flag only covers the moment
       between a request and the event it produces. */
    let live = window.is_fullscreen().unwrap_or(false);
    FULLSCREEN.store(live, std::sync::atomic::Ordering::Relaxed);
    live
}

/* Resizes the window from the page, so the layout can be measured at the sizes
   a person actually uses.

   Diagnostic and walkthrough only. A layout that clips its own controls at one
   window size is invisible to a unit test, because jsdom reports every element
   as visible whatever the viewport - the only way to see it is to size a real
   window and measure where the controls ended up. */
#[tauri::command]
async fn diagnostic_set_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let size = tauri::LogicalSize::new(width, height);
    window
        .set_size(tauri::PhysicalSize::new(
            (size.width * window.scale_factor().unwrap_or(1.0)) as u32,
            (size.height * window.scale_factor().unwrap_or(1.0)) as u32,
        ))
        .map_err(|e| format!("cannot resize the window: {e}"))
}

/* Diagnostic only, and deliberately so.

   A drag that a user starts is delivered by the toolkit, and nothing here can
   stand in for that - no toolkit will invent a pointer drag. What can be
   checked is everything the app owns: that the event arrives on the page, that
   js/source-tauri.js subscribes to the right name, that the paths become
   items, and that each item arrives with a URL it can actually play. That is
   the part that had never been run.

   Emitting the same event the toolkit emits, from this side, covers exactly
   that and stops at the toolkit's own boundary. */
#[tauri::command]
fn diagnostic_simulate_drop(window: WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    let payload = serde_json::json!({ "type": "drop", "paths": paths });
    window
        .emit("tauri://drag-drop", payload.clone())
        .map_err(|e| format!("could not deliver the drop: {e}"))?;
    /* A second name, to tell "the emit did not reach the page" apart from "the
       page filters this particular name". */
    window
        .emit("mt-diag-drop", payload)
        .map_err(|e| format!("could not deliver the control drop: {e}"))?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* local media                                                         */
/* ------------------------------------------------------------------ */

/* The URL a local file can actually be played from.

   Not `convertFileSrc`. On Linux the asset URL that returns is unusable: the
   webview decodes through GStreamer, GStreamer has no URI handler for the
   `asset://` scheme Tauri registers with the network layer, and the load fails
   before a single byte is read. See src/media_server.rs for the full account
   and for the alternatives that were tried and ruled out.

   An Err here is not a shrug: it means the loopback server could not start,
   which is the one situation in which nothing local can play, and the webview
   is told rather than left to time out. */
#[tauri::command]
fn media_url(path: String) -> Result<String, String> {
    media_server::register(&path).ok_or_else(|| {
        "this shell could not open a local port, so local files cannot be played".to_string()
    })
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
    let walkthrough = std::env::args().any(|a| a == "--walkthrough");

    /* Before anything WebKit-related exists. WebKitGTK keeps a hardcoded list
       of schemes its media stack will open - blob, data, file, http, https -
       and refuses everything else with no message the page can see. The app's
       own origin and Tauri's asset scheme are both on neither list, so this
       has to be in place before the webview starts or no local file loads. */
    std::env::set_var("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", "asset,tauri");

    /* Also before the webview: the loopback port has to exist by the time the
       first item asks for a URL. */
    media_server::start();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        /* on_page_load, not setup: the window declared in tauri.conf.json does
           not exist yet when setup runs, so a lookup there finds nothing and
           the diagnostic silently never happens. */
        .on_page_load(move |window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            /* The walkthrough script lives with the tests, not in the shell:
               both desktop shells run the same one, so a journey is written once
               and cannot drift between them. */
            /* Two ways in, and they measure different things. `--diagnose`
               answers whether this machine can play at all. `--walkthrough`
               drives the journeys a person drives, in the real window, at real
               sizes - the only way to see a control clipped off the edge, since
               jsdom reports every element as visible whatever the viewport. */
            if walkthrough {
                let probe = std::env::var("MT_PROBE_FILE").unwrap_or_default();
                let preamble = format!(
                    "window.__PROBE_FILE__ = {};",
                    serde_json::to_string(&probe).unwrap_or_else(|_| "\"\"".into())
                );
                let script = format!("{preamble}\n{}", include_str!("../../tests/e2e/walkthrough.js"));
                window.eval(&script).ok();
                let window = window.clone();
                std::thread::spawn(move || {
                    /* Long on purpose. The journeys resize the window five
                       times, drop a file and wait for real playback; cutting
                       the wait short reports a timeout as a failure. */
                    std::thread::sleep(std::time::Duration::from_millis(30000));
                    let _ = window.close();
                });
                return;
            }
            if diagnose {
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
                /* Opt-in, because simulating a drop adds a row to the real
                   playlist and the app saves it afterwards. A diagnostic that
                   rewrites what the user left behind is not a diagnostic. */
                let drop = std::env::var("MT_PROBE_DROP").is_ok_and(|v| v != "0");
                let preamble = format!(
                    "window.__PROBE_FILE__ = {}; window.__PROBE_MP3__ = {}; window.__PROBE_DROP__ = {drop};",
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
            media_url,
            set_fullscreen,
            is_fullscreen,
            diagnostic_simulate_drop,
            diagnostic_set_size,
            list_folder,
            file_exists,
            print_diagnostic,
        ])
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}

#[cfg(test)]
mod tests;
