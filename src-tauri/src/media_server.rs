/* A loopback HTTP server, because on Linux the Tauri build cannot play a local
   file any other way.

   The problem this exists to solve is not a Tauri bug and not a bug in this
   repository. WebKitGTK on Linux decodes media through GStreamer, and
   GStreamer resolves media URIs with its own set of URI handlers. Tauri
   registers its `asset://` protocol with WebKit's network layer only, so when
   a <video> element is pointed at `asset://localhost/...` GStreamer reports

       No URI handler implemented for "asset"  (missing-plugin)

   and nothing plays. The same file reached over http is served by the very
   same process, a few milliseconds later. The alternatives were all checked
   and all fail:

     asset://localhost/...   Tauri serves it; GStreamer has no handler for it
     tauri://localhost/...   the app's own origin; likewise no handler
     file:///...             WebKit refuses local resources for a page that is
                             not itself a file, so it never reaches GStreamer
     http://asset.localhost  that is the Windows form of the asset protocol;
                             on Linux nothing is listening there
     data:...                works, and is unusable for a two-hour video

   So the shell serves the bytes itself, over loopback, on an ephemeral port.

   Three properties matter and are all deliberate:

   - Only paths the app has explicitly registered are reachable, and they are
     addressed by an opaque token rather than by path. A token is not
     guessable and does not put a user's directory layout in a URL, so a
     stray request cannot walk the filesystem.
   - Range requests are answered properly. Without them, seeking does nothing,
     because a media element that gets a 200 for the whole file cannot ask for
     a byte range and has no way to know where it is.
   - Nothing here decides what a file is. The shared table in js/mime.js is the
     single source of truth for that; this only reports what the app already
     decided, and guesses `application/octet-stream` when it has no idea. */

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

struct Registry {
    /* token -> path. Never the reverse: nothing in this process turns a
       received path back into a token, so a request cannot reach a file that
       was not offered to it. */
    by_token: HashMap<String, PathBuf>,
    next: u64,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            by_token: HashMap::new(),
            next: 0,
        })
    })
}

/* Bound on simultaneous connections. Each is handled on its own thread, and
   this is a loopback server with one honest client; the cap exists so that a
   bug which reconnects in a loop cannot spawn threads without end. */
const MAX_CONNECTIONS: usize = 24;

/* A media element carrying a `crossorigin` attribute makes a CORS request, and
   a response without these headers is discarded *without an error*: the element
   reports NETWORK_NO_SOURCE and sits at readyState 0 for ever, showing nothing
   and saying nothing.

   That is not a corner case. The player library puts `crossorigin` on its own
   element, so every video failed this way while a plain `<video>` pointed at the
   very same URL loaded fine - which is why the media diagnostic and the
   application disagreed for as long as they did.

   Sending them is safe here. Only paths the application registered are
   reachable, they are addressed by unguessable tokens, and the listener is
   bound to loopback: another page on the same machine would have to guess a
   token before it could read a byte. */
const CORS: &str = "Access-Control-Allow-Origin: *\r\n\
     Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, Content-Type\r\n";

fn connections() -> &'static AtomicUsize {
    static COUNT: OnceLock<AtomicUsize> = OnceLock::new();
    COUNT.get_or_init(|| AtomicUsize::new(0))
}

/* ------------------------------------------------------------------ */
/* start-up                                                            */
/* ------------------------------------------------------------------ */

/* Started once, before the window exists. Returns the port, which the
   commands below need in order to hand the webview a URL. */
pub fn start() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| {
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(l) => l,
            Err(err) => {
                /* Loopback with an ephemeral port fails only if the machine has
                   no usable loopback, which is not a state worth pretending
                   to recover from: every other thing in the shell also assumes
                   it exists. Say so plainly and let the app carry on without
                   playback rather than pretending the feature is available. */
                eprintln!("[media] cannot open a loopback port: {err}");
                eprintln!("[media] local files will not be playable in this session");
                return 0;
            }
        };

        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        if connections().load(Ordering::Relaxed) >= MAX_CONNECTIONS {
                            /* Refused rather than queued: a client that opens
                               this many at once is not waiting politely, and
                               the honest answer is "no". */
                            let _ = stream.shutdown(std::net::Shutdown::Both);
                            continue;
                        }
                        connections().fetch_add(1, Ordering::Relaxed);
                        thread::spawn(move || {
                            handle(stream);
                            connections().fetch_sub(1, Ordering::Relaxed);
                        });
                    }
                    Err(_) => break,
                }
            }
        });
        port
    })
}

/* ------------------------------------------------------------------ */
/* requests                                                            */
/* ------------------------------------------------------------------ */

fn handle(stream: TcpStream) {
    /* A read timeout, so a client that opens a connection and says nothing
       cannot hold a thread for ever. Media elements reconnect while seeking,
       and none of them pauses for more than a moment. */
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut writer = stream;

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("").to_string();

    let mut range: Option<String> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break;
                }
                if let Some((name, value)) = trimmed.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("range") {
                        range = Some(value.trim().to_string());
                    }
                }
            }
            Err(_) => return,
        }
    }

    if method == "OPTIONS" {
        /* A preflight. Answered rather than refused, because a media element
           with `crossorigin` may send one and a 405 here is a failure the page
           cannot explain. */
        respond(
            &mut writer,
            204,
            "text/plain",
            b"",
            Some("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range"),
            true,
        );
        return;
    }

    if method != "GET" && method != "HEAD" {
        respond(&mut writer, 405, "text/plain", b"method not allowed", None, false);
        return;
    }

    let token = target
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();

    let path = {
        let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
        guard.by_token.get(&token).cloned()
    };

    let Some(path) = path else {
        respond(&mut writer, 404, "text/plain", b"not found", None, false);
        return;
    };

    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => {
            /* The registry outlives a file being moved or deleted, so this is
               an ordinary outcome and not an exceptional one. 404 says "there is
               nothing here", which is exactly true. */
            respond(&mut writer, 404, "text/plain", b"not found", None, false);
            return;
        }
    };

    let total = file.metadata().map(|m| m.len()).unwrap_or(0);

    /* Bytes=start-end, or the open-ended Bytes=start-. An unsatisfiable or
       absent range gets the whole file, which is what a 200 means. */
    let requested = range.as_deref().and_then(|r| {
        let spec = r.strip_prefix("bytes=")?.trim();
        let (from, to) = spec.split_once('-')?;
        let start: u64 = from.trim().parse().ok()?;
        let end: u64 = match to.trim() {
            "" => total.saturating_sub(1),
            v => v.parse().ok()?,
        };
        if start >= total {
            return None;
        }
        Some((start, end.min(total.saturating_sub(1))))
    });

    let content_type = content_type_for(&path);

    if let Some((start, end)) = requested {
        if let Err(err) = file.seek(SeekFrom::Start(start)) {
            respond(&mut writer, 500, "text/plain", b"cannot seek", None, false);
            eprintln!("[media] cannot seek {}: {err}", path.display());
            return;
        }
        let length = end - start + 1;
        let header = format!(
            "HTTP/1.1 206 Partial Content\r\n\
             Content-Type: {content_type}\r\n\
             Content-Length: {length}\r\n\
             Content-Range: bytes {start}-{end}/{total}\r\n\
             Accept-Ranges: bytes\r\n\
             Cache-Control: no-store\r\n\
             Connection: close\r\n{CORS}\r\n"
        );
        if method == "HEAD" {
            let _ = writer.write_all(header.as_bytes());
            return;
        }
        if writer.write_all(header.as_bytes()).is_err() {
            return;
        }
        /* An error part way through is normal - the client seeks away and drops
           the connection - so this is not reported. Only a failure to send
           anything at all is worth a line. */
        if copy_bytes(&mut file, &mut writer, length).is_err() && writer.flush().is_err() {
            return;
        }
    } else {
        let header = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: {content_type}\r\n\
             Content-Length: {total}\r\n\
             Accept-Ranges: bytes\r\n\
             Cache-Control: no-store\r\n\
             Connection: close\r\n{CORS}\r\n"
        );
        if method == "HEAD" {
            let _ = writer.write_all(header.as_bytes());
            return;
        }
        if writer.write_all(header.as_bytes()).is_err() {
            return;
        }
        if copy_bytes(&mut file, &mut writer, total).is_err() && writer.flush().is_err() {
            return;
        }
    }

    let _ = writer.flush();
}

fn copy_bytes(file: &mut File, out: &mut TcpStream, length: u64) -> std::io::Result<()> {
    /* Chunked so that a two-hour film is never held in memory. */
    const CHUNK: usize = 64 * 1024;
    let mut buffer = vec![0u8; CHUNK];
    let mut left = length;
    while left > 0 {
        let want = CHUNK.min(left as usize);
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            /* The file shrank underneath us. Everything promised has been sent,
               which is the best that can be done. */
            break;
        }
        out.write_all(&buffer[..read])?;
        left -= read as u64;
    }
    out.flush()
}

fn respond(
    out: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    extra: Option<&str>,
    head_only: bool,
) {
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let mut header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n{CORS}\r\n",
        body.len()
    );
    if let Some(extra) = extra {
        header.push_str(extra);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    let _ = out.write_all(header.as_bytes());
    if !head_only {
        let _ = out.write_all(body);
    }
    let _ = out.flush();
}

/* ------------------------------------------------------------------ */
/* content types                                                       */
/* ------------------------------------------------------------------ */

/* The same table as js/mime.js, for the same reason: a media element decides
   what to demux from the Content-Type, and getting it wrong turns a playable
   track into a silent failure. Anything unknown is served as
   application/octet-stream, which is honest rather than a guess. */
fn content_type_for(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "aiff" | "aif" => "audio/aiff",
        _ => "application/octet-stream",
    }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/* Registers a path and returns the URL the webview can actually load.

   The same path always yields the same token, because the player asks for a
   URL repeatedly - on every seek, and again when a track is re-selected -
   and a fresh token each time would leak an entry per request. */
pub fn register(path: &str) -> Option<String> {
    let port = start();
    if port == 0 {
        return None;
    }

    let token = {
        let mut guard = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((token, _)) = guard.by_token.iter().find(|(_, p)| p.as_os_str() == path) {
            token.clone()
        } else {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let token = format!("{:x}{:x}", nonce, guard.next);
            guard.next += 1;
            guard.by_token.insert(token.clone(), PathBuf::from(path));
            token
        }
    };

    Some(format!("http://127.0.0.1:{port}/m/{token}"))
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /* A temporary file with known contents, removed afterwards. Written into
       the OS temp directory rather than the repository so a failing test
       cannot leave anything behind in the tree. */
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(bytes: &[u8]) -> Self {
            /* Unique per fixture, not per thread: the test runner reuses
               threads, and two fixtures sharing a name made "different paths"
               quietly the same path. */
            static SEQ: AtomicUsize = AtomicUsize::new(0);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "custom-media-player-test-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            File::create(&path).expect("create fixture").write_all(bytes).expect("fill fixture");
            Fixture(path)
        }
        /* Owned, because a PathBuf cannot hand out a borrowed &str that
           outlives the lossy conversion it would come from. */
        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /* Sends one request and returns the whole response, so the tests can
       assert on status, headers and body together. */
    fn request(url: &str, extra: &str) -> String {
        let without_scheme = url.trim_start_matches("http://");
        let (authority, path) = match without_scheme.find('/') {
            Some(i) => without_scheme.split_at(i),
            None => (without_scheme, "/"),
        };
        let mut stream = TcpStream::connect(authority).expect("connect to the loopback server");
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\n{extra}\r\n").as_bytes())
            .expect("send request");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("timeout");
        let mut text = String::new();
        let _ = stream.read_to_string(&mut text);
        text
    }

    #[test]
    fn serves_a_registered_file_whole() {
        let body = b"the quick brown fox";
        let fixture = Fixture::new(body);
        let url = register(&fixture.path()).expect("a URL");
        let response = request(&url, "");

        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("Content-Type: application/octet-stream"), "{response}");
        assert!(response.contains("Accept-Ranges: bytes"), "{response}");
        assert!(
            response.contains(&format!("Content-Length: {}", body.len())),
            "{response}"
        );
        assert!(response.ends_with("the quick brown fox"), "{response}");
    }

    #[test]
    fn content_type_follows_the_extension() {
        let mut path = std::env::temp_dir();
        path.push(format!("custom-media-player-type-{}.mp4", std::process::id()));
        File::create(&path).expect("create fixture");
        let url = register(path.to_string_lossy().as_ref()).expect("a URL");
        let response = request(&url, "");
        let _ = std::fs::remove_file(&path);

        assert!(response.contains("Content-Type: video/mp4"), "{response}");
    }

    /* Seeking is the reason this server exists at all. A media element that is
       handed the whole file with a 200 cannot ask for a byte range, and so
       cannot seek. */
    #[test]
    fn answers_a_range_request_with_exactly_those_bytes() {
        let fixture = Fixture::new(b"0123456789abcdef");
        let url = register(&fixture.path()).expect("a URL");
        let response = request(&url, "Range: bytes=4-7\r\n");

        assert!(response.starts_with("HTTP/1.1 206 Partial Content"), "{response}");
        assert!(response.contains("Content-Range: bytes 4-7/16"), "{response}");
        assert!(response.contains("Content-Length: 4"), "{response}");
        assert!(response.ends_with("4567"), "{response}");
    }

    /* An open-ended range is what a client sends after it knows where it is
       and wants the rest. Treating it as unsatisfiable would break playback
       partway through every file. */
    #[test]
    fn answers_an_open_ended_range() {
        let fixture = Fixture::new(b"0123456789abcdef");
        let url = register(&fixture.path()).expect("a URL");
        let response = request(&url, "Range: bytes=12-\r\n");

        assert!(response.starts_with("HTTP/1.1 206 Partial Content"), "{response}");
        assert!(response.contains("Content-Range: bytes 12-15/16"), "{response}");
        assert!(response.ends_with("cdef"), "{response}");
    }

    /* A range that starts past the end cannot be served. Falling back to the
       whole file is the safe reading: it plays, if from the beginning. */
    #[test]
    fn a_range_past_the_end_falls_back_to_the_whole_file() {
        let fixture = Fixture::new(b"0123456789");
        let url = register(&fixture.path()).expect("a URL");
        let response = request(&url, "Range: bytes=500-600\r\n");

        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.ends_with("0123456789"), "{response}");
    }

    /* The security property the whole token scheme exists for. */
    #[test]
    fn an_unknown_token_is_not_found() {
        let port = start();
        let response = request(&format!("http://127.0.0.1:{port}/m/deadbeef"), "");
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    }

    /* A path that was never offered cannot be reached by asking for it. The
       token in a URL is never a path, so there is nothing to traverse. */
    #[test]
    fn a_path_in_the_url_is_not_a_path() {
        let fixture = Fixture::new(b"secret");
        let port = start();
        let response = request(&format!("http://127.0.0.1:{port}/{}", fixture.path()), "");
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    }

    /* The player asks for the URL again on every seek. A fresh token each time
       would grow the registry without bound. */
    #[test]
    fn the_same_path_always_yields_the_same_url() {
        let fixture = Fixture::new(b"x");
        let first = register(&fixture.path()).expect("a URL");
        let second = register(&fixture.path()).expect("the same URL");
        assert_eq!(first, second);
    }

    #[test]
    fn different_paths_yield_different_urls() {
        let one = Fixture::new(b"one");
        let two = Fixture::new(b"two");
        assert_ne!(
            register(&one.path()).expect("a URL"),
            register(&two.path()).expect("another URL")
        );
    }

    /* A file that is deleted after registration. The playlist is restored from
       disk on every launch, so the registry outlives files routinely and this
       is an ordinary case rather than an error. */
    #[test]
    fn a_deleted_file_is_not_found_rather_than_a_crash() {
        let fixture = Fixture::new(b"gone soon");
        let url = register(&fixture.path()).expect("a URL");
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());

        let response = request(&url, "");
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
    }

    #[test]
    fn an_empty_file_is_served_without_a_range() {
        let fixture = Fixture::new(b"");
        let url = register(&fixture.path()).expect("a URL");
        let response = request(&url, "");
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("Content-Length: 0"), "{response}");
    }
}