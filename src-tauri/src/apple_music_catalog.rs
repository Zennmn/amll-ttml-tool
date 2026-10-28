use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::{Client, StatusCode, Url, header};
use tokio::sync::Mutex;

const PAGE_ORIGIN: &str = "https://music.apple.com";
const CATALOG_ORIGIN: &str = "https://amp-api.music.apple.com";
const PAGE_MAX_BYTES: usize = 1024 * 1024;
const SCRIPT_MAX_BYTES: usize = 12 * 1024 * 1024;
const CATALOG_MAX_BYTES: usize = 512 * 1024;
const MAX_SAFE_SONG_ID: u64 = 9_007_199_254_740_991;
const MAX_ASSETS: usize = 8;
const MAX_PAGE_REDIRECTS: usize = 2;
const MAX_TOKENS: usize = 12;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const TOKEN_EXPIRY_MARGIN_SECONDS: u64 = 60;
const TOKEN_CACHE_SECONDS: u64 = 12 * 60 * 60;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const OVERALL_TIMEOUT: Duration = Duration::from_secs(12);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LookupResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LookupError {
    pub code: &'static str,
}

impl LookupError {
    const fn invalid_link() -> Self {
        Self {
            code: "invalidLink",
        }
    }

    const fn network() -> Self {
        Self { code: "network" }
    }

    const fn timeout() -> Self {
        Self { code: "timeout" }
    }

    const fn invalid_response() -> Self {
        Self {
            code: "invalidResponse",
        }
    }
}

#[derive(Clone)]
struct Endpoints {
    page: Url,
    assets: Url,
    catalog: Url,
    https_only: bool,
}

impl Endpoints {
    fn production() -> Self {
        Self {
            page: Url::parse(PAGE_ORIGIN).expect("Apple page origin is a valid URL"),
            assets: Url::parse(PAGE_ORIGIN).expect("Apple asset origin is a valid URL"),
            catalog: Url::parse(CATALOG_ORIGIN).expect("Apple catalog origin is a valid URL"),
            https_only: true,
        }
    }

    fn page_url(&self, storefront: &str, song_id: &str) -> Result<Url, LookupError> {
        self.page
            .join(&format!("/{storefront}/song/{song_id}"))
            .map_err(|_| LookupError::invalid_response())
    }

    fn catalog_url(&self, storefront: &str, song_id: &str) -> Result<Url, LookupError> {
        self.catalog
            .join(&format!("/v1/catalog/{storefront}/songs/{song_id}"))
            .map_err(|_| LookupError::invalid_response())
    }
}

#[derive(Clone)]
struct CachedToken {
    value: String,
    usable_until: u64,
}

#[derive(Default)]
struct TokenState {
    token: Option<CachedToken>,
}

struct CatalogSession {
    tokens: Mutex<TokenState>,
    discovery: Mutex<()>,
}

static SESSION: OnceLock<CatalogSession> = OnceLock::new();

fn shared_session() -> &'static CatalogSession {
    SESSION.get_or_init(|| CatalogSession {
        tokens: Mutex::new(TokenState::default()),
        discovery: Mutex::new(()),
    })
}

/// Looks up one song through Apple's anonymous public web-player catalog route.
#[tauri::command]
pub async fn apple_music_catalog_lookup(
    song_id: String,
    storefront: String,
) -> Result<LookupResponse, LookupError> {
    let song_id = validate_song_id(&song_id)?;
    let storefront = validate_storefront(&storefront)?;
    let endpoints = Endpoints::production();
    let client = build_client(endpoints.https_only).map_err(|_| LookupError::network())?;
    let now = current_unix_seconds().ok_or_else(LookupError::invalid_response)?;

    tokio::time::timeout(
        OVERALL_TIMEOUT,
        lookup_with_session(
            &client,
            &endpoints,
            shared_session(),
            song_id,
            &storefront,
            now,
        ),
    )
    .await
    .map_err(|_| LookupError::timeout())?
}

fn validate_song_id(song_id: &str) -> Result<&str, LookupError> {
    let bytes = song_id.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 16
        || bytes[0] == b'0'
        || !bytes.iter().all(u8::is_ascii_digit)
    {
        return Err(LookupError::invalid_link());
    }
    let value = song_id
        .parse::<u64>()
        .map_err(|_| LookupError::invalid_link())?;
    if value == 0 || value > MAX_SAFE_SONG_ID {
        return Err(LookupError::invalid_link());
    }
    Ok(song_id)
}

fn validate_storefront(storefront: &str) -> Result<String, LookupError> {
    let bytes = storefront.as_bytes();
    if bytes.len() != 2 || !bytes.iter().all(u8::is_ascii_alphabetic) {
        return Err(LookupError::invalid_link());
    }
    Ok(storefront.to_ascii_lowercase())
}

fn build_client(https_only: bool) -> Result<Client, reqwest::Error> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT);
    if https_only {
        builder = builder.https_only(true);
    }
    builder.build()
}

async fn lookup_with_session(
    client: &Client,
    endpoints: &Endpoints,
    session: &CatalogSession,
    song_id: &str,
    storefront: &str,
    now: u64,
) -> Result<LookupResponse, LookupError> {
    let mut rejected_token = None;
    if let Some(cached) = take_usable_cached_token(session, now).await {
        let response =
            request_catalog(client, endpoints, storefront, song_id, &cached.value).await?;
        if response.status == StatusCode::OK.as_u16() {
            return Ok(response);
        }
        if !is_auth_status(response.status) {
            return Ok(response);
        }
        invalidate_if_current(session, &cached.value).await;
        rejected_token = Some(cached.value);
    }

    refresh_token_and_query(
        client,
        endpoints,
        session,
        song_id,
        storefront,
        now,
        rejected_token.as_deref(),
    )
    .await
}

async fn take_usable_cached_token(session: &CatalogSession, now: u64) -> Option<CachedToken> {
    let mut state = session.tokens.lock().await;
    match state.token.take() {
        Some(token) if token.usable_until > now => {
            state.token = Some(token.clone());
            Some(token)
        }
        _ => None,
    }
}

async fn invalidate_if_current(session: &CatalogSession, rejected: &str) {
    let mut state = session.tokens.lock().await;
    if state
        .token
        .as_ref()
        .is_some_and(|cached| cached.value == rejected)
    {
        state.token = None;
    }
}

async fn refresh_token_and_query(
    client: &Client,
    endpoints: &Endpoints,
    session: &CatalogSession,
    song_id: &str,
    storefront: &str,
    now: u64,
    rejected: Option<&str>,
) -> Result<LookupResponse, LookupError> {
    let _discovery_guard = session.discovery.lock().await;

    if let Some(cached) = take_usable_cached_token(session, now).await {
        if rejected.is_none_or(|token| token != cached.value) {
            let response =
                request_catalog(client, endpoints, storefront, song_id, &cached.value).await?;
            if response.status == StatusCode::OK.as_u16() {
                return Ok(response);
            }
            if !is_auth_status(response.status) {
                return Ok(response);
            }
            invalidate_if_current(session, &cached.value).await;
        }
    }

    let candidates = discover_tokens(client, endpoints, song_id, storefront, now).await?;
    for candidate in candidates {
        if rejected.is_some_and(|token| token == candidate.token) {
            continue;
        }
        let response =
            request_catalog(client, endpoints, storefront, song_id, &candidate.token).await?;
        if response.status == StatusCode::OK.as_u16() {
            if catalog_contains_exact_song(&response.body, song_id) {
                let mut state = session.tokens.lock().await;
                state.token = Some(CachedToken {
                    value: candidate.token,
                    usable_until: candidate.usable_until,
                });
            }
            return Ok(response);
        }
        if !is_auth_status(response.status) {
            return Ok(response);
        }
    }

    Err(LookupError::invalid_response())
}

async fn discover_tokens(
    client: &Client,
    endpoints: &Endpoints,
    song_id: &str,
    storefront: &str,
    now: u64,
) -> Result<Vec<TokenCandidate>, LookupError> {
    let page_url = endpoints.page_url(storefront, song_id)?;
    let page = fetch_public_song_page(client, page_url).await?;
    let assets = resolve_entry_assets(&page, &endpoints.assets);
    if assets.is_empty() {
        return Err(LookupError::invalid_response());
    }

    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for asset in assets.into_iter().take(MAX_ASSETS) {
        let script = fetch_required_text(
            client,
            asset,
            SCRIPT_MAX_BYTES,
            "text/javascript,application/javascript;q=0.9,*/*;q=0.1",
        )
        .await?;
        for candidate in extract_public_tokens(&script, now) {
            if seen.insert(candidate.token.clone()) {
                candidates.push(candidate);
                if candidates.len() == MAX_TOKENS {
                    return Ok(candidates);
                }
            }
        }
    }

    if candidates.is_empty() {
        Err(LookupError::invalid_response())
    } else {
        Ok(candidates)
    }
}

async fn fetch_required_text(
    client: &Client,
    url: Url,
    maximum: usize,
    accept: &'static str,
) -> Result<String, LookupError> {
    let response = client
        .get(url)
        .header(header::ACCEPT, accept)
        .send()
        .await
        .map_err(request_error_code)?;
    if !response.status().is_success() {
        return Err(LookupError::invalid_response());
    }
    read_body_bounded(response, maximum).await
}

/// Apple canonicalizes an ID-only song URL to its slug URL before serving HTML.
/// Follow only bounded redirects for that same song on the same page origin.
async fn fetch_public_song_page(client: &Client, mut url: Url) -> Result<String, LookupError> {
    for redirects in 0..=MAX_PAGE_REDIRECTS {
        let response = client
            .get(url.clone())
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(request_error_code)?;
        if response.status().is_success() {
            return read_body_bounded(response, PAGE_MAX_BYTES).await;
        }
        if !response.status().is_redirection() || redirects == MAX_PAGE_REDIRECTS {
            return Err(LookupError::invalid_response());
        }
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(LookupError::invalid_response)?;
        url = safe_song_redirect(&url, location).ok_or_else(LookupError::invalid_response)?;
    }
    Err(LookupError::invalid_response())
}

fn safe_song_redirect(current: &Url, location: &str) -> Option<Url> {
    let target = current.join(location).ok()?;
    if !same_origin(current, &target)
        || !target.username().is_empty()
        || target.password().is_some()
        || target.query().is_some()
        || target.fragment().is_some()
    {
        return None;
    }
    let current_parts: Vec<_> = current.path_segments()?.collect();
    let target_parts: Vec<_> = target.path_segments()?.collect();
    if !(3..=4).contains(&current_parts.len())
        || !(3..=4).contains(&target_parts.len())
        || current_parts.get(1) != Some(&"song")
        || current_parts.first() != target_parts.first()
        || target_parts.get(1) != Some(&"song")
        || current_parts.last() != target_parts.last()
    {
        return None;
    }
    Some(target)
}

async fn request_catalog(
    client: &Client,
    endpoints: &Endpoints,
    storefront: &str,
    song_id: &str,
    token: &str,
) -> Result<LookupResponse, LookupError> {
    let url = endpoints.catalog_url(storefront, song_id)?;
    let response = client
        .get(url)
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::ORIGIN, PAGE_ORIGIN)
        .send()
        .await
        .map_err(request_error_code)?;
    let status = response.status();
    if !status.is_success() {
        return Ok(LookupResponse {
            status: status.as_u16(),
            body: String::new(),
        });
    }
    Ok(LookupResponse {
        status: status.as_u16(),
        body: read_body_bounded(response, CATALOG_MAX_BYTES).await?,
    })
}

async fn read_body_bounded(
    mut response: reqwest::Response,
    maximum: usize,
) -> Result<String, LookupError> {
    if response
        .content_length()
        .is_some_and(|length| length > u64::try_from(maximum).unwrap_or(u64::MAX))
    {
        return Err(LookupError::invalid_response());
    }

    let capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0)
        .min(maximum);
    let mut body = Vec::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await.map_err(request_error_code)? {
        if !extend_bounded(&mut body, &chunk, maximum) {
            return Err(LookupError::invalid_response());
        }
    }
    String::from_utf8(body).map_err(|_| LookupError::invalid_response())
}

fn extend_bounded(target: &mut Vec<u8>, bytes: &[u8], maximum: usize) -> bool {
    let Some(new_length) = target.len().checked_add(bytes.len()) else {
        return false;
    };
    if new_length > maximum {
        return false;
    }
    target.extend_from_slice(bytes);
    true
}

fn request_error_code(error: reqwest::Error) -> LookupError {
    if error.is_timeout() {
        LookupError::timeout()
    } else {
        LookupError::network()
    }
}

fn is_auth_status(status: u16) -> bool {
    status == StatusCode::UNAUTHORIZED.as_u16() || status == StatusCode::FORBIDDEN.as_u16()
}

fn catalog_contains_exact_song(body: &str, song_id: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| json.get("data")?.as_array().cloned())
        .is_some_and(|data| {
            data.iter().any(|item| {
                item.get("id").and_then(serde_json::Value::as_str) == Some(song_id)
                    && item.get("type").and_then(serde_json::Value::as_str) == Some("songs")
            })
        })
}

fn current_unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TokenCandidate {
    token: String,
    usable_until: u64,
}

fn extract_public_tokens(script: &str, now: u64) -> Vec<TokenCandidate> {
    let bytes = script.as_bytes();
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut index = 0;

    while index + 3 <= bytes.len() {
        if &bytes[index..index + 3] != b"eyJ"
            || index
                .checked_sub(1)
                .is_some_and(|previous| is_base64url_byte(bytes[previous]))
        {
            index += 1;
            continue;
        }

        let Some(end) = jwt_end(bytes, index) else {
            index += 1;
            continue;
        };
        let token = &script[index..end];
        if token.len() <= MAX_TOKEN_BYTES {
            if let Some(usable_until) = token_cache_deadline(token, now) {
                if seen.insert(token.to_owned()) {
                    result.push(TokenCandidate {
                        token: token.to_owned(),
                        usable_until,
                    });
                    if result.len() == MAX_TOKENS {
                        break;
                    }
                }
            }
        }
        index = end;
    }
    result
}

fn jwt_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start;
    for segment in 0..3 {
        let segment_start = index;
        while index < bytes.len() && is_base64url_byte(bytes[index]) {
            index += 1;
        }
        if index == segment_start {
            return None;
        }
        if segment < 2 {
            if bytes.get(index) != Some(&b'.') {
                return None;
            }
            index += 1;
        }
    }
    if bytes
        .get(index)
        .is_some_and(|byte| is_base64url_byte(*byte) || *byte == b'.')
    {
        return None;
    }
    Some(index)
}

fn token_cache_deadline(token: &str, now: u64) -> Option<u64> {
    let mut segments = token.split('.');
    let header = segments.next()?;
    let payload = segments.next()?;
    let signature = segments.next()?;
    if header.is_empty() || payload.is_empty() || signature.is_empty() || segments.next().is_some()
    {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let expires_at = claims.get("exp")?.as_u64()?;
    let expires_before_margin = expires_at.checked_sub(TOKEN_EXPIRY_MARGIN_SECONDS)?;
    if expires_before_margin <= now {
        return None;
    }
    let cache_limit = now.saturating_add(TOKEN_CACHE_SECONDS);
    Some(expires_before_margin.min(cache_limit))
}

fn is_base64url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

fn resolve_entry_assets(html: &str, origin: &Url) -> Vec<Url> {
    let mut assets = Vec::new();
    let mut seen = HashSet::new();
    for source in extract_script_sources(html) {
        if let Some(url) = safe_entry_asset(source, origin) {
            if seen.insert(url.as_str().to_owned()) {
                assets.push(url);
                if assets.len() == MAX_ASSETS {
                    break;
                }
            }
        }
    }
    assets
}

fn extract_script_sources(html: &str) -> Vec<&str> {
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let lower_bytes = lower.as_bytes();
    let mut sources = Vec::new();
    let mut index = 0;
    while index + 7 <= bytes.len() {
        if bytes[index] == b'<'
            && lower_bytes.get(index + 1..index + 7) == Some(b"script")
            && bytes
                .get(index + 7)
                .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
        {
            if let Some(tag_end) = find_tag_end(bytes, index + 7) {
                if let Some(source) = attribute_value(&bytes[index + 7..tag_end], b"src") {
                    sources.push(source);
                }
                index = tag_end + 1;
                continue;
            }
        }
        index += 1;
    }
    sources
}

fn find_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in bytes.iter().enumerate().skip(start) {
        match (quote, *byte) {
            (Some(current), value) if value == current => quote = None,
            (None, b'\'' | b'"') => quote = Some(*byte),
            (None, b'>') => return Some(offset),
            _ => {}
        }
    }
    None
}

fn attribute_value<'a>(tag: &'a [u8], wanted: &[u8]) -> Option<&'a str> {
    let mut index = 0;
    while index < tag.len() {
        while index < tag.len() && (tag[index].is_ascii_whitespace() || tag[index] == b'/') {
            index += 1;
        }
        let name_start = index;
        while index < tag.len()
            && !tag[index].is_ascii_whitespace()
            && !matches!(tag[index], b'=' | b'/' | b'>')
        {
            index += 1;
        }
        if index == name_start {
            index += 1;
            continue;
        }
        let name = &tag[name_start..index];
        while index < tag.len() && tag[index].is_ascii_whitespace() {
            index += 1;
        }
        if tag.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while index < tag.len() && tag[index].is_ascii_whitespace() {
            index += 1;
        }
        let (value_start, value_end) = match tag.get(index).copied() {
            Some(quote @ (b'\'' | b'"')) => {
                index += 1;
                let start = index;
                while index < tag.len() && tag[index] != quote {
                    index += 1;
                }
                (start, index)
            }
            Some(_) => {
                let start = index;
                while index < tag.len()
                    && !tag[index].is_ascii_whitespace()
                    && !matches!(tag[index], b'/' | b'>')
                {
                    index += 1;
                }
                (start, index)
            }
            None => break,
        };
        if name.eq_ignore_ascii_case(wanted) {
            return std::str::from_utf8(&tag[value_start..value_end]).ok();
        }
    }
    None
}

fn safe_entry_asset(source: &str, origin: &Url) -> Option<Url> {
    let source = source.trim();
    let url = if source.starts_with("/assets/index") {
        origin.join(source).ok()?
    } else if source.starts_with("https://") {
        Url::parse(source).ok()?
    } else {
        return None;
    };
    if !same_origin(&url, origin)
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url.path();
    let file_name = path.rsplit('/').next()?;
    if !path.starts_with("/assets/index")
        || !file_name.ends_with(".js")
        || !path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-' | b'~')
        })
        || path.contains("//")
        || path.contains("..")
    {
        return None;
    }
    Some(url)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use std::thread;
    use std::time::{Duration, Instant};

    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use reqwest::{Client, StatusCode, Url};

    use super::{
        CachedToken, CatalogSession, Endpoints, LookupError, MAX_SAFE_SONG_ID, TOKEN_CACHE_SECONDS,
        TokenState, catalog_contains_exact_song, current_unix_seconds, extend_bounded,
        extract_public_tokens, invalidate_if_current, lookup_with_session, resolve_entry_assets,
        safe_entry_asset, take_usable_cached_token, token_cache_deadline, validate_song_id,
        validate_storefront,
    };

    struct TestServer {
        base: Url,
        requests: Arc<StdMutex<Vec<String>>>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn new(responses: Vec<Vec<u8>>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
            listener
                .set_nonblocking(true)
                .expect("configure test listener");
            let address = listener.local_addr().expect("read test listener address");
            let requests = Arc::new(StdMutex::new(Vec::new()));
            let request_log = Arc::clone(&requests);
            let handle = thread::spawn(move || {
                for response in responses {
                    let deadline = Instant::now() + Duration::from_secs(3);
                    let (mut stream, _) = loop {
                        match listener.accept() {
                            Ok(connection) => break connection,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                if Instant::now() >= deadline {
                                    return;
                                }
                                thread::sleep(Duration::from_millis(2));
                            }
                            Err(_) => return,
                        }
                    };
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    let request = read_request_headers(&mut stream);
                    request_log
                        .lock()
                        .expect("lock test request log")
                        .push(String::from_utf8_lossy(&request).into_owned());
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                    let _ = stream.shutdown(Shutdown::Both);
                }
            });
            Self {
                base: Url::parse(&format!("http://{address}")).expect("parse test base URL"),
                requests,
                handle: Some(handle),
            }
        }

        fn endpoints(&self) -> Endpoints {
            Endpoints {
                page: self.base.clone(),
                assets: self.base.clone(),
                catalog: self.base.clone(),
                https_only: false,
            }
        }

        fn finish(self) -> Vec<String> {
            let Self {
                requests, handle, ..
            } = self;
            handle
                .expect("test server handle")
                .join()
                .expect("join test server");
            Arc::try_unwrap(requests)
                .expect("release request log")
                .into_inner()
                .expect("read request log")
        }
    }

    fn read_request_headers(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => request.extend_from_slice(&buffer[..read]),
            }
        }
        request
    }

    fn response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn response_with_declared_length(status: &str, length: usize) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n")
            .into_bytes()
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("create test runtime")
            .block_on(future)
    }

    fn test_client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(3))
            .build()
            .expect("create test HTTP client")
    }

    fn jwt(expires_at: u64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({ "exp": expires_at }))
                .expect("serialize token payload"),
        );
        format!("{header}.{payload}.{signature}", signature = "c2ln")
    }

    #[test]
    fn validates_safe_song_ids_and_ascii_storefronts() {
        assert!(validate_song_id("1").is_ok());
        assert!(validate_song_id("1555193620").is_ok());
        assert!(validate_song_id(&MAX_SAFE_SONG_ID.to_string()).is_ok());
        for invalid in [
            "",
            "0",
            "0001",
            "-1",
            "+1",
            " 1",
            "1 ",
            "1.0",
            "１２",
            "9007199254740992",
        ] {
            assert_eq!(validate_song_id(invalid), Err(LookupError::invalid_link()));
        }

        assert_eq!(validate_storefront("US").as_deref(), Ok("us"));
        for invalid in ["", "u", "usa", "u1", "éé"] {
            assert_eq!(
                validate_storefront(invalid),
                Err(LookupError::invalid_link())
            );
        }
    }

    #[test]
    fn command_contract_serializes_status_and_error_envelopes() {
        assert_eq!(
            serde_json::to_value(LookupError::invalid_response()).expect("serialize lookup error"),
            serde_json::json!({ "code": "invalidResponse" })
        );
        assert_eq!(
            serde_json::to_value(super::LookupResponse {
                status: 200,
                body: "{\"data\":[]}".to_owned(),
            })
            .expect("serialize lookup response"),
            serde_json::json!({ "status": 200, "body": "{\"data\":[]}" })
        );
    }

    #[test]
    fn resolves_only_entry_assets_on_the_configured_origin() {
        let origin = Url::parse("https://music.apple.com").expect("parse Apple origin");
        let html = r#"
            <script src="/assets/index~cc245af156.js"></script>
            <script data-src="/assets/index-ignored.js"></script>
            <script src="https://evil.example/assets/index-evil.js"></script>
            <script src="//music.apple.com/assets/index-protocol-relative.js"></script>
            <script src="http://music.apple.com/assets/index-http.js"></script>
            <script src="/assets/index-ok.js?cache=1"></script>
            <script src="/assets/../index-escape.js"></script>
            <script src="/assets/index-backslash\\escape.js"></script>
        "#;
        let assets = resolve_entry_assets(html, &origin);
        assert_eq!(assets.len(), 1);
        assert_eq!(
            assets[0].as_str(),
            "https://music.apple.com/assets/index~cc245af156.js"
        );

        assert!(safe_entry_asset("//music.apple.com/assets/index.js", &origin).is_none());
        assert!(safe_entry_asset("assets/index.js", &origin).is_none());
        assert!(safe_entry_asset("/styles/index.js", &origin).is_none());
        assert!(safe_entry_asset("/assets/index.js/extra", &origin).is_none());
        let module_html =
            r#"<script type="module" crossorigin src="/assets/index~real.js"></script>"#;
        assert_eq!(resolve_entry_assets(module_html, &origin).len(), 1);
    }

    #[test]
    fn song_page_redirects_preserve_origin_region_and_exact_song_identity() {
        let current = Url::parse("https://music.apple.com/tr/song/1555193620").unwrap();
        let canonical =
            super::safe_song_redirect(&current, "/tr/song/wake-atte/1555193620").unwrap();
        assert_eq!(canonical.path(), "/tr/song/wake-atte/1555193620");
        for location in [
            "https://evil.example/tr/song/wake-atte/1555193620",
            "http://music.apple.com/tr/song/wake-atte/1555193620",
            "https://name@music.apple.com/tr/song/wake-atte/1555193620",
            "/us/song/wake-atte/1555193620",
            "/tr/song/another/1555193621",
            "/tr/album/still/1555193620",
            "/tr/song/wake-atte/1555193620?token=x",
        ] {
            assert!(
                super::safe_song_redirect(&current, location).is_none(),
                "{location}"
            );
        }
    }

    #[test]
    fn follows_canonical_song_page_redirect_before_reading_the_entry_script() {
        let server = TestServer::new(vec![
            b"HTTP/1.1 301 Moved Permanently\r\nLocation: /tr/song/wake-atte/1555193620\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            response("200 OK", "text/html", b"<script src=\"/assets/index-live.js\"></script>"),
        ]);
        let page_url = server.base.join("/tr/song/1555193620").unwrap();
        let html = block_on(super::fetch_public_song_page(&test_client(), page_url)).unwrap();
        assert!(html.contains("index-live.js"));
        let requests = server.finish();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].starts_with("GET /tr/song/wake-atte/1555193620 "));
    }

    #[test]
    fn extracts_only_nonexpired_public_jwts_and_caps_cache_lifetime() {
        let now = 1_000_000;
        let expired = jwt(now + 30);
        let valid = jwt(now + 600);
        let long_lived = jwt(now + TOKEN_CACHE_SECONDS * 2);
        let script =
            format!("prefix {expired} middle {valid} duplicate {valid} long {long_lived} suffix");
        let tokens = extract_public_tokens(&script, now);

        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].token, valid);
        assert_eq!(tokens[0].usable_until, now + 600 - 60);
        assert_eq!(tokens[1].token, long_lived);
        assert_eq!(tokens[1].usable_until, now + TOKEN_CACHE_SECONDS);
        assert_eq!(token_cache_deadline(&valid, now), Some(now + 600 - 60));
        assert_eq!(token_cache_deadline(&expired, now), None);
    }

    #[test]
    fn body_accumulator_enforces_exact_limits_without_partial_writes() {
        let mut body = Vec::new();
        assert!(extend_bounded(&mut body, b"abc", 4));
        assert!(!extend_bounded(&mut body, b"de", 4));
        assert_eq!(body, b"abc");
        assert!(extend_bounded(&mut body, b"d", 4));
        assert_eq!(body, b"abcd");
    }

    #[test]
    fn caches_success_only_for_the_exact_requested_song() {
        let exact = r#"{"data":[{"id":"1555193620","type":"songs"}]}"#;
        assert!(catalog_contains_exact_song(exact, "1555193620"));
        assert!(!catalog_contains_exact_song(exact, "1555193621"));
        assert!(!catalog_contains_exact_song(
            r#"{"data":[{"id":"1555193620","type":"albums"}]}"#,
            "1555193620"
        ));
        assert!(!catalog_contains_exact_song(r#"{"data":[]}"#, "1555193620"));
        assert!(!catalog_contains_exact_song("not json", "1555193620"));
    }

    #[test]
    fn contents_length_above_cap_is_rejected_before_body_read() {
        let server = TestServer::new(vec![response_with_declared_length(
            "200 OK",
            16 * 1024 * 1024 + 1,
        )]);
        let maximum = 16 * 1024 * 1024;
        let result = block_on(async {
            let response = test_client()
                .get(server.base.join("/oversized").expect("build test URL"))
                .send()
                .await
                .expect("send oversized request");
            super::read_body_bounded(response, maximum).await
        });
        assert_eq!(result, Err(LookupError::invalid_response()));
        assert_eq!(server.finish().len(), 1);
    }

    #[test]
    fn cached_token_expiry_and_invalidation_are_checked_against_current_time() {
        let session = CatalogSession {
            tokens: tokio::sync::Mutex::new(TokenState {
                token: Some(CachedToken {
                    value: "cached".to_owned(),
                    usable_until: 101,
                }),
            }),
            discovery: tokio::sync::Mutex::new(()),
        };

        let usable = block_on(take_usable_cached_token(&session, 100)).expect("usable cache");
        assert_eq!(usable.value, "cached");
        block_on(invalidate_if_current(&session, "other"));
        assert!(block_on(take_usable_cached_token(&session, 100)).is_some());
        block_on(invalidate_if_current(&session, "cached"));
        assert!(block_on(take_usable_cached_token(&session, 100)).is_none());
        assert!(block_on(take_usable_cached_token(&session, 102)).is_none());
    }

    #[test]
    fn cached_token_401_rediscovers_and_never_retries_the_rejected_candidate() {
        let now = current_unix_seconds().expect("clock after Unix epoch");
        let rejected = jwt(now + 3600);
        let replacement = jwt(now + 7200);
        let page = format!("<html><script src=\"/assets/index-test.js\"></script></html>");
        let script = format!("window.token='{rejected}';window.next='{replacement}';");
        let server = TestServer::new(vec![
            response("401 Unauthorized", "application/json", b""),
            response("200 OK", "text/html", page.as_bytes()),
            response("200 OK", "text/javascript", script.as_bytes()),
            response(
                "200 OK",
                "application/json",
                br#"{"data":[{"id":"1555193620","type":"songs","attributes":{"isrc":"JPU902100426","composerName":"Shinya Ishihara"}}]}"#,
            ),
        ]);
        let session = CatalogSession {
            tokens: tokio::sync::Mutex::new(TokenState {
                token: Some(CachedToken {
                    value: rejected.clone(),
                    usable_until: now + 3000,
                }),
            }),
            discovery: tokio::sync::Mutex::new(()),
        };
        let result = block_on(lookup_with_session(
            &test_client(),
            &server.endpoints(),
            &session,
            "1555193620",
            "tr",
            now,
        ))
        .expect("authentication refresh should succeed");
        assert_eq!(result.status, StatusCode::OK.as_u16());
        assert!(result.body.contains("JPU902100426"));

        let requests = server.finish();
        assert_eq!(requests.len(), 4);
        assert!(requests[0].to_ascii_lowercase().contains(&format!(
            "authorization: bearer {}",
            rejected.to_ascii_lowercase()
        )));
        assert!(!requests[3].to_ascii_lowercase().contains(&format!(
            "authorization: bearer {}",
            rejected.to_ascii_lowercase()
        )));
        assert!(requests[3].to_ascii_lowercase().contains(&format!(
            "authorization: bearer {}",
            replacement.to_ascii_lowercase()
        )));
        let cached = block_on(take_usable_cached_token(&session, now)).expect("refreshed cache");
        assert_eq!(cached.value, replacement);
    }

    /// Run explicitly with:
    /// `cargo test --manifest-path src-tauri/Cargo.toml --lib
    /// apple_music_catalog::tests::live_public_catalog_lookup -- --ignored --nocapture`
    #[test]
    #[ignore = "live anonymous Apple public catalog smoke test"]
    fn live_public_catalog_lookup() {
        let response = block_on(super::apple_music_catalog_lookup(
            "1555193620".to_owned(),
            "tr".to_owned(),
        ))
        .expect("public Apple catalog lookup should succeed without account credentials");
        assert_eq!(response.status, 200);
        let json: serde_json::Value =
            serde_json::from_str(&response.body).expect("catalog response should be JSON");
        assert_eq!(json["data"][0]["id"], "1555193620");
        assert_eq!(json["data"][0]["type"], "songs");
        assert_eq!(json["data"][0]["attributes"]["isrc"], "JPU902100426");
        assert!(
            json["data"][0]["attributes"]["composerName"]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
        );
    }
}
