//! Apple webpage login and a private, bounded gamdl child process.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const AUTH_WINDOW: &str = "apple-music-login";
const MAX_AUDIO: u64 = 64 * 1024 * 1024;
static IDS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    authenticated: bool,
    login_open: bool,
    runtime_ready: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    id: String,
    state: String,
    progress: Option<f64>,
    bytes_received: Option<u64>,
    total_bytes: Option<u64>,
    file_name: Option<String>,
    error_code: Option<String>,
}

struct Job {
    snapshot: Mutex<JobSnapshot>,
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
    directory: PathBuf,
}

#[derive(Default)]
struct Inner {
    token: Option<String>,
    generation: u64,
    signed_out: bool,
    jobs: HashMap<String, Arc<Job>>,
    session: Option<PathBuf>,
    lease: Option<File>,
}

#[derive(Clone, Default)]
pub struct AppleMusicAudioService {
    inner: Arc<Mutex<Inner>>,
}

fn unique_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        IDS.fetch_add(1, Ordering::Relaxed)
    )
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("unavailable".into())
    }
}

fn apple_navigation(url: &reqwest::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some(
                "music.apple.com"
                    | "auth.music.apple.com"
                    | "authorize.music.apple.com"
                    | "idmsa.apple.com"
                    | "appleid.apple.com"
                    | "account.apple.com"
                    | "id.apple.com"
                    | "buy.music.apple.com"
            )
        )
}

fn canonical_song(raw: &str) -> Result<String, String> {
    if raw.len() > 2048 {
        return Err("invalidLink".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "invalidLink")?;
    if url.scheme() != "https"
        || url.host_str() != Some("music.apple.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("invalidLink".into());
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if !(3..=4).contains(&parts.len())
        || parts[0].len() != 2
        || !parts[0].bytes().all(|c| c.is_ascii_alphabetic())
    {
        return Err("invalidLink".into());
    }
    let ids: Vec<String> = match parts[1] {
        "song" => vec![parts[parts.len() - 1].to_string()],
        "album" => url
            .query_pairs()
            .filter(|(key, _)| key == "i")
            .map(|(_, value)| value.into_owned())
            .collect(),
        _ => return Err("invalidLink".into()),
    };
    if ids.len() != 1 {
        return Err("invalidLink".into());
    }
    let id = &ids[0];
    if id.is_empty()
        || id.len() > 16
        || id.starts_with('0')
        || !id.bytes().all(|c| c.is_ascii_digit())
        || id
            .parse::<u64>()
            .map_or(true, |n| n > 9_007_199_254_740_991)
    {
        return Err("invalidLink".into());
    }
    Ok(format!(
        "https://music.apple.com/{}/song/{id}",
        parts[0].to_ascii_lowercase()
    ))
}

fn profile(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("apple-music-web-profile"))
        .map_err(|_| "failed".into())
}

fn logout_marker(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("apple-music-signed-out"))
        .map_err(|_| "failed".into())
}

fn auth_window(
    app: &AppHandle,
    label: &str,
    url: reqwest::Url,
    features: Option<tauri::webview::NewWindowFeatures>,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Apple Music · 网页登录")
        .inner_size(1040.0, 760.0)
        .visible(visible)
        .on_navigation(apple_navigation);
    if let Some(features) = features {
        builder = builder.window_features(features);
    } else {
        builder = builder.data_directory(profile(app)?);
    }
    let handle = app.clone();
    builder
        .on_new_window(move |url, features| {
            if !apple_navigation(&url) {
                return tauri::webview::NewWindowResponse::Deny;
            }
            let label = format!("{AUTH_WINDOW}-{}", unique_id());
            match auth_window(
                &handle,
                &label,
                "about:blank".parse().expect("static URL"),
                Some(features),
                true,
            ) {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(_) => tauri::webview::NewWindowResponse::Deny,
            }
        })
        .build()
        .map_err(|_| "failed".into())
}

fn ensure_auth(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    let window = if let Some(window) = app.get_webview_window(AUTH_WINDOW) {
        window
    } else {
        auth_window(
            app,
            AUTH_WINDOW,
            "https://music.apple.com/".parse().expect("static URL"),
            None,
            visible,
        )?
    };
    if visible {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(window)
}

fn runtime(app: &AppHandle) -> Option<PathBuf> {
    let packaged = app.path().resource_dir().ok()?.join("apple-music-helper");
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/apple-music-helper");
    [packaged, dev].into_iter().find(|p| {
        p.join("python/python.exe").is_file()
            && p.join("worker.py").is_file()
            && p.join("manifest.json").is_file()
    })
}

fn is_reparse(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return true;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn remove_owned(path: &Path, root: &Path) {
    if path.parent() != Some(root) || is_reparse(path) {
        return;
    }
    let _ = fs::remove_dir_all(path);
}

fn exclusive_lease(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options.open(path)
}

impl AppleMusicAudioService {
    pub fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|_| "failed")?
            .join("apple-music-audio-v1");
        fs::create_dir_all(&cache).map_err(|_| "failed")?;
        if is_reparse(&cache) {
            return Err("failed".into());
        }
        for entry in fs::read_dir(&cache).map_err(|_| "failed")?.flatten() {
            let path = entry.path();
            if !entry.file_name().to_string_lossy().starts_with("session-")
                || !path.is_dir()
                || is_reparse(&path)
            {
                continue;
            }
            #[cfg(windows)]
            if path.join("lease").is_file()
                && let Ok(lease) = exclusive_lease(&path.join("lease"))
            {
                drop(lease);
                remove_owned(&path, &cache);
            }
            #[cfg(not(windows))]
            if entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86_400)
            {
                remove_owned(&path, &cache);
            }
        }
        let session = cache.join(format!("session-{}", unique_id()));
        fs::create_dir(&session).map_err(|_| "failed")?;
        let lease = exclusive_lease(&session.join("lease")).map_err(|_| "failed")?;
        let mut inner = self.inner.lock().map_err(|_| "failed")?;
        inner.signed_out = logout_marker(app)?.exists();
        inner.lease = Some(lease);
        inner.session = Some(session);
        Ok(())
    }

    fn status(&self, app: &AppHandle) -> Result<AuthStatus, String> {
        let (generation, signed_out, was_authenticated) = {
            let inner = self.inner.lock().map_err(|_| "failed")?;
            (inner.generation, inner.signed_out, inner.token.is_some())
        };
        if !signed_out {
            let window = ensure_auth(app, false)?;
            let cookies = window
                .cookies_for_url("https://music.apple.com/".parse().expect("static URL"))
                .map_err(|_| "failed")?;
            let token = cookies
                .iter()
                .find(|c| {
                    c.name() == "media-user-token"
                        && matches!(c.domain(), Some("music.apple.com" | ".music.apple.com"))
                        && valid_token(c.value())
                })
                .map(|c| c.value().to_string());
            let mut inner = self.inner.lock().map_err(|_| "failed")?;
            if inner.generation == generation && !inner.signed_out {
                inner.token = token;
            }
        }
        let authenticated = self.inner.lock().map_err(|_| "failed")?.token.is_some();
        if authenticated && !was_authenticated {
            for (label, window) in app.webview_windows() {
                if label == AUTH_WINDOW {
                    let _ = window.hide();
                } else if label.starts_with(&format!("{AUTH_WINDOW}-")) {
                    let _ = window.close();
                }
            }
        }
        let login_open = app.webview_windows().iter().any(|(label, window)| {
            label.starts_with(AUTH_WINDOW) && window.is_visible().unwrap_or(false)
        });
        Ok(AuthStatus {
            authenticated,
            login_open,
            runtime_ready: runtime(app).is_some(),
        })
    }

    fn job(&self, id: &str) -> Result<Arc<Job>, String> {
        self.inner
            .lock()
            .map_err(|_| "failed")?
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "cancelled".into())
    }

    pub fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            for job in inner.jobs.values() {
                stop_job(job);
            }
            inner.jobs.clear();
            inner.token = None;
            inner.lease = None;
            if let Some(session) = inner.session.take() {
                if let Some(root) = session.parent() {
                    remove_owned(&session, root);
                }
            }
        }
    }
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 16384 && !token.chars().any(char::is_control)
}
fn snapshot(job: &Job) -> Result<JobSnapshot, String> {
    job.snapshot
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "failed".into())
}
fn terminal(state: &str) -> bool {
    matches!(state, "ready" | "cancelled" | "error")
}
fn finish(job: &Job, state: &str, error: Option<&str>) {
    if let Ok(mut current) = job.snapshot.lock() {
        if job.cancelled.load(Ordering::Acquire) {
            current.state = "cancelled".into();
            current.error_code = None;
            current.file_name = None;
            return;
        }
        current.state = state.into();
        current.error_code = error.map(str::to_string);
        if state == "ready" {
            current.file_name = Some("audio.m4a".into());
            current.progress = Some(1.0);
        }
    }
}
fn stop_job(job: &Job) {
    job.cancelled.store(true, Ordering::Release);
    if let Ok(mut child) = job.child.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    finish(job, "cancelled", None);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    state: String,
    progress: Option<f64>,
    bytes_received: Option<u64>,
    total_bytes: Option<u64>,
    file_name: Option<String>,
    error_code: Option<String>,
}
fn clean_error(code: Option<&str>) -> &'static str {
    match code {
        Some("notAuthenticated") => "notAuthenticated",
        Some("subscriptionRequired") => "subscriptionRequired",
        Some("network") => "network",
        Some("timeout") => "timeout",
        Some("unavailable") => "unavailable",
        Some("invalidAudio") => "invalidAudio",
        _ => "failed",
    }
}
fn apply_progress(job: &Job, line: &str) -> Result<Option<bool>, String> {
    let message: Progress = serde_json::from_str(line).map_err(|_| "failed")?;
    match message.state.as_str() {
        "ready" => {
            if message.file_name.as_deref() != Some("audio.m4a") {
                return Err("invalidAudio".into());
            }
            Ok(Some(true))
        }
        "error" => {
            finish(
                job,
                "error",
                Some(clean_error(message.error_code.as_deref())),
            );
            Ok(Some(false))
        }
        "authenticating" | "downloading" | "processing" => {
            let mut current = job.snapshot.lock().map_err(|_| "failed")?;
            if !job.cancelled.load(Ordering::Acquire) {
                current.state = message.state;
                current.progress = message
                    .progress
                    .filter(|p| p.is_finite() && (0.0..=1.0).contains(p));
                current.bytes_received = message.bytes_received.filter(|n| *n <= MAX_AUDIO * 3);
                current.total_bytes = message.total_bytes.filter(|n| *n <= MAX_AUDIO * 3);
            }
            Ok(None)
        }
        _ => Err("failed".into()),
    }
}

fn read_audio(path: &Path) -> Result<Vec<u8>, String> {
    if is_reparse(path) {
        return Err("invalidAudio".into());
    }
    let length = fs::metadata(path).map_err(|_| "invalidAudio")?.len();
    if !(32..=MAX_AUDIO).contains(&length) {
        return Err("invalidAudio".into());
    }
    let mut data = Vec::new();
    File::open(path)
        .map_err(|_| "invalidAudio")?
        .take(MAX_AUDIO + 1)
        .read_to_end(&mut data)
        .map_err(|_| "invalidAudio")?;
    if data.len() as u64 > MAX_AUDIO || data.get(4..8) != Some(b"ftyp") {
        return Err("invalidAudio".into());
    }
    Ok(data)
}

fn cache_size(path: &Path, depth: usize) -> Result<u64, String> {
    if depth > 8 || is_reparse(path) {
        return Err("invalidAudio".into());
    }
    let metadata = fs::metadata(path).map_err(|_| "failed")?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    let mut total = 0_u64;
    for (count, entry) in fs::read_dir(path).map_err(|_| "failed")?.enumerate() {
        if count > 2048 {
            return Err("invalidAudio".into());
        }
        total = total.saturating_add(cache_size(&entry.map_err(|_| "failed")?.path(), depth + 1)?);
        if total > MAX_AUDIO * 3 {
            return Err("invalidAudio".into());
        }
    }
    Ok(total)
}

fn run_job(job: Arc<Job>, helper: PathBuf, url: String, token: String) {
    run_process(
        job,
        helper.join("python/python.exe"),
        helper.join("worker.py"),
        url,
        token,
    );
}

fn run_process(job: Arc<Job>, python: PathBuf, script: PathBuf, url: String, token: String) {
    let result = (|| -> Result<(), String> {
        if job.cancelled.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        let mut command = Command::new(python);
        command
            .args(["-I", "-u"])
            .arg(script)
            .current_dir(&job.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().map_err(|_| "runtimeMissing")?;
        let stdout = child.stdout.take().ok_or("failed")?;
        let mut stdin = child.stdin.take().ok_or("failed")?;
        *job.child.lock().map_err(|_| "failed")? = Some(child);
        if job.cancelled.load(Ordering::Acquire) {
            stop_job(&job);
            return Err("cancelled".into());
        }
        serde_json::to_writer(
            &mut stdin,
            &serde_json::json!({"url":url,"outputDir":job.directory,"mediaUserToken":token}),
        )
        .map_err(|_| "failed")?;
        stdin.write_all(b"\n").map_err(|_| "failed")?;
        drop(stdin);
        let (tx, rx) = mpsc::sync_channel(16);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match reader.by_ref().take(8193).read_until(b'\n', &mut bytes) {
                    Ok(0) => break,
                    Ok(_) if bytes.len() <= 8192 => {
                        if tx.send(String::from_utf8(bytes).map_err(|_| ())).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = tx.send(Err(()));
                        break;
                    }
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(600);
        let mut reported_ready = false;
        let mut next_size_check = Instant::now();
        loop {
            if job.cancelled.load(Ordering::Acquire) {
                return Err("cancelled".into());
            }
            if Instant::now() >= deadline {
                return Err("timeout".into());
            }
            if Instant::now() >= next_size_check {
                cache_size(&job.directory, 0)?;
                next_size_check = Instant::now() + Duration::from_secs(1);
            }
            while let Ok(line) = rx.try_recv() {
                if let Some(ready) = apply_progress(&job, &line.map_err(|_| "failed")?)? {
                    if !ready {
                        return Err(snapshot(&job)?
                            .error_code
                            .unwrap_or_else(|| "failed".into()));
                    }
                    reported_ready = true;
                }
            }
            let exited = job
                .child
                .lock()
                .map_err(|_| "failed")?
                .as_mut()
                .ok_or("failed")?
                .try_wait()
                .map_err(|_| "failed")?;
            if let Some(status) = exited {
                // Drain the reader after exit; ready must precede a clean exit.
                for line in rx.iter() {
                    if let Some(ready) = apply_progress(&job, &line.map_err(|_| "failed")?)? {
                        reported_ready = ready;
                    }
                }
                if !status.success() || !reported_ready {
                    return Err("failed".into());
                }
                read_audio(&job.directory.join("audio.m4a"))?;
                finish(&job, "ready", None);
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
    })();
    if let Err(error) = result {
        if let Ok(mut child) = job.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        finish(&job, "error", Some(clean_error(Some(&error))));
        if let Some(root) = job.directory.parent() {
            remove_owned(&job.directory, root);
        }
    }
}

#[tauri::command]
pub async fn apple_music_audio_status(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppleMusicAudioService>,
) -> Result<AuthStatus, String> {
    main_only(&window)?;
    state.status(&app)
}

#[tauri::command]
pub async fn apple_music_audio_login(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppleMusicAudioService>,
) -> Result<AuthStatus, String> {
    main_only(&window)?;
    {
        let mut inner = state.inner.lock().map_err(|_| "failed")?;
        inner.signed_out = false;
        inner.generation += 1;
    }
    if let Ok(marker) = logout_marker(&app) {
        let _ = fs::remove_file(marker);
    }
    ensure_auth(&app, true)?;
    state.status(&app)
}

#[tauri::command]
pub async fn apple_music_audio_logout(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppleMusicAudioService>,
) -> Result<AuthStatus, String> {
    main_only(&window)?;
    {
        let mut inner = state.inner.lock().map_err(|_| "failed")?;
        inner.signed_out = true;
        inner.generation += 1;
        inner.token = None;
        for job in inner.jobs.values() {
            stop_job(job);
        }
    }
    let marker = logout_marker(&app)?;
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).map_err(|_| "failed")?;
    }
    fs::write(marker, b"signed out").map_err(|_| "failed")?;
    let auth = ensure_auth(&app, false)?;
    for cookie in auth.cookies().map_err(|_| "failed")? {
        auth.delete_cookie(cookie).map_err(|_| "failed")?;
    }
    auth.clear_all_browsing_data().map_err(|_| "failed")?;
    for (label, auth) in app.webview_windows() {
        if label.starts_with(AUTH_WINDOW) {
            let _ = auth.close();
        }
    }
    state.status(&app)
}

#[tauri::command]
pub async fn apple_music_audio_start(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, AppleMusicAudioService>,
    url: String,
) -> Result<JobSnapshot, String> {
    main_only(&window)?;
    let url = canonical_song(url.trim())?;
    state.status(&app)?;
    let helper = runtime(&app).ok_or("runtimeMissing")?;
    let mut inner = state.inner.lock().map_err(|_| "failed")?;
    if inner
        .jobs
        .values()
        .any(|job| job.snapshot.lock().map_or(true, |s| !terminal(&s.state)))
    {
        return Err("busy".into());
    }
    let token = inner.token.clone().ok_or("notAuthenticated")?;
    let id = unique_id();
    let directory = inner
        .session
        .as_ref()
        .ok_or("failed")?
        .join(format!("job-{id}"));
    fs::create_dir(&directory).map_err(|_| "failed")?;
    let initial = JobSnapshot {
        id: id.clone(),
        state: "queued".into(),
        progress: None,
        bytes_received: None,
        total_bytes: None,
        file_name: None,
        error_code: None,
    };
    let job = Arc::new(Job {
        snapshot: Mutex::new(initial.clone()),
        child: Mutex::new(None),
        cancelled: AtomicBool::new(false),
        directory,
    });
    inner.jobs.insert(id, job.clone());
    drop(inner);
    thread::spawn(move || run_job(job, helper, url, token));
    Ok(initial)
}

#[tauri::command]
pub async fn apple_music_audio_job(
    window: WebviewWindow,
    state: tauri::State<'_, AppleMusicAudioService>,
    job_id: String,
) -> Result<JobSnapshot, String> {
    main_only(&window)?;
    let job = state.job(&job_id)?;
    snapshot(&job)
}
#[tauri::command]
pub async fn apple_music_audio_cancel(
    window: WebviewWindow,
    state: tauri::State<'_, AppleMusicAudioService>,
    job_id: String,
) -> Result<JobSnapshot, String> {
    main_only(&window)?;
    let job = state.job(&job_id)?;
    stop_job(&job);
    snapshot(&job)
}
#[tauri::command]
pub async fn apple_music_audio_release(
    window: WebviewWindow,
    state: tauri::State<'_, AppleMusicAudioService>,
    job_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    let job = state
        .inner
        .lock()
        .map_err(|_| "failed")?
        .jobs
        .remove(&job_id);
    if let Some(job) = job {
        stop_job(&job);
        if let Some(root) = job.directory.parent() {
            remove_owned(&job.directory, root);
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn apple_music_audio_read(
    window: WebviewWindow,
    state: tauri::State<'_, AppleMusicAudioService>,
    job_id: String,
) -> Result<tauri::ipc::Response, String> {
    main_only(&window)?;
    let job = state.job(&job_id)?;
    if snapshot(&job)?.state != "ready" || job.cancelled.load(Ordering::Acquire) {
        return Err("cancelled".into());
    }
    Ok(tauri::ipc::Response::new(read_audio(
        &job.directory.join("audio.m4a"),
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_song_validation() {
        assert_eq!(
            canonical_song("https://music.apple.com/TR/album/a/1?i=1555193620").unwrap(),
            "https://music.apple.com/tr/song/1555193620"
        );
        for url in [
            "https://music.apple.com/tr/album/a/1",
            "https://music.apple.com/tr/album/a/1?i=2&i=3",
            "https://evil.com/tr/song/1",
            "http://music.apple.com/tr/song/1",
            "https://music.apple.com/tr/song/0",
            "https://music.apple.com/tr/song/9007199254740992",
            "https://music.apple.com/tr/playlist/a/1",
            "https://user@music.apple.com/tr/song/1",
        ] {
            assert!(canonical_song(url).is_err(), "{url}");
        }
    }
    #[test]
    fn auth_navigation_is_exact_https_host() {
        for url in [
            "https://music.apple.com/",
            "https://authorize.music.apple.com/auth",
            "https://idmsa.apple.com/appleauth/auth",
            "https://appleid.apple.com/auth/authorize",
            "about:blank",
        ] {
            assert!(apple_navigation(&url.parse().unwrap()));
        }
        for url in [
            "https://apple.com.evil.com",
            "https://evil.com",
            "http://music.apple.com/",
            "https://user@music.apple.com/",
        ] {
            assert!(!apple_navigation(&url.parse().unwrap()));
        }
    }
    #[test]
    fn credentials_never_allow_control_characters() {
        assert!(valid_token("fixture"));
        assert!(!valid_token(""));
        assert!(!valid_token("abc\nsecret"));
        assert!(!valid_token(&"a".repeat(16385)));
    }
    #[test]
    fn provider_errors_are_allowlisted() {
        assert_eq!(clean_error(Some("https://private?token=secret")), "failed");
        assert_eq!(clean_error(Some("notAuthenticated")), "notAuthenticated");
    }
    #[test]
    fn terminal_states() {
        assert!(terminal("ready"));
        assert!(terminal("cancelled"));
        assert!(!terminal("downloading"));
    }

    fn fixture_job(root: &Path) -> Arc<Job> {
        let directory = root.join("job-fixture");
        fs::create_dir(&directory).unwrap();
        Arc::new(Job {
            snapshot: Mutex::new(JobSnapshot {
                id: "fixture".into(),
                state: "queued".into(),
                progress: None,
                bytes_received: None,
                total_bytes: None,
                file_name: None,
                error_code: None,
            }),
            child: Mutex::new(None),
            cancelled: AtomicBool::new(false),
            directory,
        })
    }
    #[test]
    fn progress_messages_cannot_choose_output_paths_or_leak_errors() {
        let root = std::env::temp_dir().join(format!("amll-audio-test-{}", unique_id()));
        fs::create_dir(&root).unwrap();
        let job = fixture_job(&root);
        assert!(apply_progress(&job, r#"{"state":"ready","fileName":"../other.m4a"}"#).is_err());
        assert!(apply_progress(&job, r#"{"state":"unknown"}"#).is_err());
        apply_progress(
            &job,
            r#"{"state":"downloading","progress":4,"bytesReceived":42}"#,
        )
        .unwrap();
        assert_eq!(snapshot(&job).unwrap().progress, None);
        assert_eq!(snapshot(&job).unwrap().bytes_received, Some(42));
        apply_progress(&job, r#"{"state":"error","errorCode":"private token"}"#).unwrap();
        assert_eq!(
            snapshot(&job).unwrap().error_code.as_deref(),
            Some("failed")
        );
        remove_owned(&root, &std::env::temp_dir());
    }
    #[test]
    fn invalid_audio_and_nested_cleanup_are_bounded() {
        let root = std::env::temp_dir().join(format!("amll-audio-test-{}", unique_id()));
        fs::create_dir(&root).unwrap();
        let job = fixture_job(&root);
        let audio = job.directory.join("audio.m4a");
        fs::write(&audio, [0_u8; 40]).unwrap();
        assert!(read_audio(&audio).is_err());
        let mut bytes = vec![0_u8; 40];
        bytes[4..8].copy_from_slice(b"ftyp");
        fs::write(&audio, &bytes).unwrap();
        assert_eq!(read_audio(&audio).unwrap(), bytes);
        remove_owned(&job.directory, &std::env::temp_dir());
        assert!(job.directory.exists());
        remove_owned(&job.directory, &root);
        assert!(!job.directory.exists());
        remove_owned(&root, &std::env::temp_dir());
    }
    #[test]
    fn actual_hidden_helper_process_protocol_and_cancellation() {
        let python = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/apple-music-helper/python/python.exe");
        if !python.is_file() {
            return;
        }
        let root = std::env::temp_dir().join(format!("amll-audio-test-{}", unique_id()));
        fs::create_dir(&root).unwrap();
        let script = root.join("fixture.py");
        fs::write(&script, "import json,sys,pathlib\nr=json.loads(sys.stdin.readline())\np=pathlib.Path(r['outputDir'])/'audio.m4a'\np.write_bytes(bytes(4)+b'ftyp'+bytes(32))\nprint(json.dumps({'state':'ready','fileName':'audio.m4a'}),flush=True)\n").unwrap();
        let job = fixture_job(&root);
        run_process(
            job.clone(),
            python.clone(),
            script.clone(),
            "https://music.apple.com/tr/song/1".into(),
            "offline-fixture".into(),
        );
        assert_eq!(snapshot(&job).unwrap().state, "ready");
        assert_eq!(
            read_audio(&job.directory.join("audio.m4a")).unwrap().len(),
            40
        );
        remove_owned(&job.directory, &root);
        fs::write(&script, "import json,sys,time\njson.loads(sys.stdin.readline())\nprint(json.dumps({'state':'downloading'}),flush=True)\ntime.sleep(60)\n").unwrap();
        let job = fixture_job(&root);
        let running = job.clone();
        let thread = thread::spawn(move || {
            run_process(
                running,
                python,
                script,
                "https://music.apple.com/tr/song/1".into(),
                "offline-fixture".into(),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while job.child.lock().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(job.child.lock().unwrap().is_some());
        stop_job(&job);
        thread.join().unwrap();
        assert_eq!(snapshot(&job).unwrap().state, "cancelled");
        assert!(!job.directory.exists());
        remove_owned(&root, &std::env::temp_dir());
    }
}
