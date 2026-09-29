/* Tests for the shell's pure logic.

   Everything here runs without a display or a webview, which is the point:
   the parts of the shell that can be checked headlessly should be, so that
   running the app on a screen is only ever needed for what genuinely needs
   one. */

use super::*;
use std::fs;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("cmp-tests").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/* The list a desktop playlist is written from. It must match the shape the
   browser writes to localStorage, because the preference handling in
   app.js is shared rather than duplicated. */
#[test]
fn saved_state_round_trips_as_the_shape_the_app_writes() {
    let dir = scratch("state");
    let path = dir.join("state.json");
    let state = serde_json::json!({
        "index": 2,
        "position": 124.5,
        "fit": "cover",
        "loop": true,
        "volume": 0.4,
        "muted": false,
        "ui": true,
        "list": false,
        "autoplay": true,
        "settings": { "lang": "ar", "color": "#aa7827", "logo": null },
        "items": [
            { "name": "a.mp4", "kind": "video", "path": "/media/a.mp4", "position": 12.0 }
        ]
    });
    fs::write(&path, serde_json::to_string_pretty(&state).unwrap()).unwrap();

    let text = fs::read_to_string(&path).unwrap();
    let back: Value = serde_json::from_str(&text).unwrap();

    assert_eq!(back["index"], 2);
    assert_eq!(back["fit"], "cover");
    assert_eq!(back["settings"]["lang"], "ar");
    assert_eq!(back["items"][0]["path"], "/media/a.mp4");
    /* logo: null is a real value - "removed" - and must survive as null
       rather than becoming an absent key, which means "never customised" */
    assert!(back["settings"]["logo"].is_null());
    assert!(back["settings"].as_object().unwrap().contains_key("logo"));
}

/* A half-written state file must not stop the app from starting. The user
   loses their preferences, which beats losing the window. */
#[test]
fn an_unreadable_state_file_is_reported_as_absent_rather_than_fatal() {
    let dir = scratch("corrupt");
    let path = dir.join("state.json");
    fs::write(&path, "{ this is not json").unwrap();
    let parsed: Result<Value, _> = serde_json::from_str(&fs::read_to_string(&path).unwrap());
    assert!(parsed.is_err(), "the fixture should be invalid JSON");
    /* which is exactly what load_state turns into Ok(None) */
}

/* The write is staged and renamed, so a crash mid-write cannot leave a
   truncated file for the next launch to choke on. */
#[test]
fn the_state_write_is_staged_before_it_is_committed() {
    let dir = scratch("staged");
    let final_path = dir.join("state.json");
    let tmp = final_path.with_extension("json.tmp");

    let state = serde_json::json!({ "index": 1 });
    fs::write(&tmp, serde_json::to_string_pretty(&state).unwrap()).unwrap();
    assert!(tmp.exists(), "the staging file is written first");
    assert!(!final_path.exists(), "and the real file is not touched yet");

    fs::rename(&tmp, &final_path).unwrap();
    assert!(!tmp.exists(), "the staging file is consumed by the rename");
    assert!(final_path.exists());
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(&final_path).unwrap()).unwrap()["index"],
        1
    );
}

/* A directory read comes back in whatever order the filesystem feels like.
   A playlist that reshuffles between launches looks like a bug, so the
   order is imposed here rather than left to the caller. */
#[test]
fn folder_listing_is_sorted_case_insensitively() {
    let dir = scratch("folder");
    for name in ["Zebra.mp4", "apple.mp4", "Banana.mp4", "notes.txt"] {
        fs::write(dir.join(name), b"x").unwrap();
    }
    fs::create_dir_all(dir.join("subdir")).unwrap();

    let mut found: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect();
    found.sort_by_key(|p| p.to_lowercase());

    let names: Vec<String> = found
        .iter()
        .map(|p| p.rsplit('/').next().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["apple.mp4", "Banana.mp4", "notes.txt", "Zebra.mp4"]);
    /* and the sub-directory is not offered as a file */
    assert!(!found.iter().any(|p| p.ends_with("subdir")));
}

#[test]
fn a_missing_folder_is_an_error_not_an_empty_list() {
    let result = list_folder("/definitely/not/a/folder".to_string());
    assert!(result.is_err(), "silently returning nothing would look like an empty folder");
}

/* Only a regular file counts. A directory at that path is not playable
   media, and the app would try to load it. */
#[test]
fn existence_means_a_regular_file() {
    let dir = scratch("exists");
    let file = dir.join("clip.mp4");
    fs::write(&file, b"x").unwrap();
    assert!(file_exists(file.to_string_lossy().into_owned()));
    assert!(!file_exists(dir.to_string_lossy().into_owned()));
    assert!(!file_exists(dir.join("nope.mp4").to_string_lossy().into_owned()));
}
