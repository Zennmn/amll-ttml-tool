use std::{
    ffi::OsString,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CONTENT_TYPE, HOST, ORIGIN},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::net::TcpListener;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

#[path = "../../src-tauri/src/online_lyrics/mod.rs"]
pub mod online_lyrics;

pub use online_lyrics::{
    LyricCandidate, LyricChannel, LyricFormat, OnlineLyrics, OnlineLyricsError,
    OnlineLyricsService, OnlineSearchPage, OnlineTrack,
};

pub const DEFAULT_PORT: u16 = 5173;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const MAX_API_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    service: Arc<OnlineLyricsService>,
}

#[derive(Clone, Copy)]
struct OriginPolicy {
    port: u16,
}

#[derive(Debug)]
struct SearchRequest {
    provider: String,
    query: String,
    page: u32,
}

#[derive(Debug)]
struct FetchRequest {
    track: OnlineTrack,
    candidate: Option<LyricCandidate>,
}

impl<'de> serde::Deserialize<'de> for SearchRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            provider: String,
            query: String,
            page: u32,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            provider: wire.provider,
            query: wire.query,
            page: wire.page,
        })
    }
}

impl<'de> serde::Deserialize<'de> for FetchRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        struct Wire {
            track: OnlineTrack,
            #[serde(default)]
            candidate: Option<LyricCandidate>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            track: wire.track,
            candidate: wire.candidate,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    service: &'static str,
    protocol_version: u8,
    providers: [&'static str; 4],
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    pub port: u16,
    pub assets: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliAction {
    Run(CliOptions),
    Help,
}

pub fn parse_cli<I, S>(arguments: I) -> Result<CliAction, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut arguments = arguments.into_iter().map(Into::into);
    let mut port = DEFAULT_PORT;
    let mut assets = None;

    while let Some(argument) = arguments.next() {
        let argument = argument.to_string_lossy();
        if argument == "--help" || argument == "-h" {
            return Ok(CliAction::Help);
        }
        if argument == "--port" {
            let value = arguments
                .next()
                .ok_or_else(|| "--port requires a number".to_owned())?;
            port = parse_port(&value.to_string_lossy())?;
            continue;
        }
        if let Some(value) = argument.strip_prefix("--port=") {
            port = parse_port(value)?;
            continue;
        }
        if argument == "--assets" {
            assets = Some(
                arguments
                    .next()
                    .ok_or_else(|| "--assets requires a directory".to_owned())?,
            );
            continue;
        }
        if let Some(value) = argument.strip_prefix("--assets=") {
            if value.is_empty() {
                return Err("--assets requires a directory".into());
            }
            assets = Some(OsString::from(value));
            continue;
        }
        return Err(format!("unknown argument: {argument}"));
    }

    let assets = assets.ok_or_else(|| "--assets <dist-dir> is required".to_owned())?;
    Ok(CliAction::Run(CliOptions {
        port,
        assets: PathBuf::from(assets),
    }))
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("invalid port: {value}"))?;
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    Ok(port)
}

pub async fn run_cli<I, S>(arguments: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    match parse_cli(arguments)? {
        CliAction::Help => {
            println!(
                "amll-lyrics-service [--port <n>] --assets <dist-dir>\n\n\
                 Binds only to http://127.0.0.1 (default port {DEFAULT_PORT})."
            );
            Ok(())
        }
        CliAction::Run(options) => serve(options).await,
    }
}

async fn serve(options: CliOptions) -> Result<(), String> {
    let assets = tokio::fs::canonicalize(&options.assets)
        .await
        .map_err(|error| {
            format!(
                "unable to access assets directory {}: {error}",
                options.assets.display()
            )
        })?;
    if !tokio::fs::metadata(&assets)
        .await
        .map_err(|error| format!("unable to read assets directory: {error}"))?
        .is_dir()
    {
        return Err(format!(
            "assets path is not a directory: {}",
            assets.display()
        ));
    }
    let index = assets.join("index.html");
    if !tokio::fs::metadata(&index)
        .await
        .map_err(|error| format!("unable to read {}: {error}", index.display()))?
        .is_file()
    {
        return Err(format!("assets index is missing: {}", index.display()));
    }

    let service = Arc::new(OnlineLyricsService::default());
    let app = build_router(service, &assets, options.port);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, options.port))
        .await
        .map_err(|error| format!("unable to bind 127.0.0.1:{}: {error}", options.port))?;
    println!(
        "amll-lyrics-service listening at http://127.0.0.1:{} (assets: {})",
        options.port,
        assets.display()
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("lyrics service failed: {error}"))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

pub fn build_router(
    service: Arc<OnlineLyricsService>,
    assets: impl AsRef<Path>,
    port: u16,
) -> Router {
    let assets = assets.as_ref();
    let api = Router::new()
        .route(
            "/online-lyrics/health",
            get(health).fallback(method_not_allowed),
        )
        .route(
            "/online-lyrics/search",
            post(search_lyrics).fallback(method_not_allowed),
        )
        .route(
            "/online-lyrics/fetch",
            post(fetch_lyrics).fallback(method_not_allowed),
        )
        .fallback(api_not_found)
        .with_state(AppState { service });

    let static_files = ServeDir::new(assets)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(assets.join("index.html")));

    Router::new()
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(middleware::from_fn_with_state(
            OriginPolicy { port },
            same_origin_guard,
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
}

async fn health() -> Response {
    json_response(
        StatusCode::OK,
        &HealthResponse {
            service: "amll-lyrics-service",
            protocol_version: 1,
            providers: ["netease", "qq", "kugou", "lrclib"],
        },
    )
}

async fn search_lyrics(State(state): State<AppState>, request: Request) -> Response {
    let request: SearchRequest = match json_body(request).await {
        Ok(request) => request,
        Err(response) => return response,
    };
    match state
        .service
        .search(request.provider, request.query, request.page)
        .await
    {
        Ok(page) => json_response(StatusCode::OK, &page),
        Err(error) => service_error(error),
    }
}

async fn fetch_lyrics(State(state): State<AppState>, request: Request) -> Response {
    let request: FetchRequest = match json_body(request).await {
        Ok(request) => request,
        Err(response) => return response,
    };
    match state.service.fetch(request.track, request.candidate).await {
        Ok(lyrics) => json_response(StatusCode::OK, &lyrics),
        Err(error) => service_error(error),
    }
}

async fn json_body<T: DeserializeOwned>(request: Request) -> Result<T, Response> {
    if !is_json_content_type(request.headers()) {
        return Err(api_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content-type must be application/json",
        ));
    }
    let body = to_bytes(request.into_body(), MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body exceeds the service limit",
            )
        })?;
    serde_json::from_slice(&body).map_err(|error| {
        api_error(
            StatusCode::BAD_REQUEST,
            format!("invalid JSON request: {error}"),
        )
    })
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(CONTENT_TYPE).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    value
        .to_str()
        .ok()
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn service_error(error: OnlineLyricsError) -> Response {
    api_error(status_for_error(&error), error.to_string())
}

fn status_for_error(error: &OnlineLyricsError) -> StatusCode {
    match error {
        OnlineLyricsError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        OnlineLyricsError::Provider(_) => StatusCode::BAD_GATEWAY,
        OnlineLyricsError::Timeout(_) => StatusCode::GATEWAY_TIMEOUT,
    }
}

async fn same_origin_guard(
    State(policy): State<OriginPolicy>,
    request: Request,
    next: Next,
) -> Response {
    let host = match allowed_request_host(request.headers(), policy.port) {
        Ok(host) => host,
        Err(response) => return response,
    };
    if let Err(response) = allowed_origin(request.headers(), &host, policy.port) {
        return response;
    }
    next.run(request).await
}

fn allowed_request_host(headers: &HeaderMap, port: u16) -> Result<String, Response> {
    let mut values = headers.get_all(HOST).iter();
    let Some(value) = values.next() else {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "request is missing the local Host header",
        ));
    };
    if values.next().is_some() {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "request has multiple Host headers",
        ));
    }
    let host = value
        .to_str()
        .ok()
        .and_then(|value| normalize_allowed_host(value, port))
        .ok_or_else(|| api_error(StatusCode::FORBIDDEN, "unexpected Host header"))?;
    Ok(host)
}

fn allowed_origin(headers: &HeaderMap, request_host: &str, port: u16) -> Result<(), Response> {
    let mut values = headers.get_all(ORIGIN).iter();
    let Some(value) = values.next() else {
        return Ok(());
    };
    if values.next().is_some() {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "request has multiple Origin headers",
        ));
    }
    let origin = value
        .to_str()
        .map_err(|_| api_error(StatusCode::FORBIDDEN, "foreign Origin rejected"))?;
    let authority = origin
        .strip_prefix("http://")
        .filter(|authority| !authority.contains('/'))
        .and_then(|authority| normalize_allowed_host(authority, port));
    if authority.as_deref() != Some(request_host) {
        return Err(api_error(StatusCode::FORBIDDEN, "foreign Origin rejected"));
    }
    Ok(())
}

fn normalize_allowed_host(value: &str, port: u16) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let (host, explicit_port) = match value.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() => (host, Some(port)),
        _ => (value.as_str(), None),
    };
    if !matches!(host, "127.0.0.1" | "localhost") {
        return None;
    }
    let selected_port = match explicit_port {
        Some(value) => value.parse::<u16>().ok()?,
        None if port == 80 => 80,
        None => return None,
    };
    if selected_port != port {
        return None;
    }
    if port == 80 {
        Some(host.to_owned())
    } else {
        Some(format!("{host}:{port}"))
    }
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = match serde_json::to_vec(value) {
        Ok(body) if body.len() <= MAX_API_RESPONSE_BYTES => body,
        Ok(_) => {
            return api_error(
                StatusCode::BAD_GATEWAY,
                "provider response exceeds the service limit",
            );
        }
        Err(_) => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "unable to serialize response",
            );
        }
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    let mut response = Json(ErrorResponse {
        error: message.into(),
    })
    .into_response();
    *response.status_mut() = status;
    response
}

async fn api_not_found() -> Response {
    api_error(StatusCode::NOT_FOUND, "API route not found")
}

async fn method_not_allowed() -> Response {
    api_error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed")
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        body::Body,
        http::{Method, Request, StatusCode, header},
    };
    use tower::ServiceExt;

    use super::{
        OnlineLyricsError, OnlineLyricsService, build_router, parse_cli, status_for_error,
    };
    use crate::CliAction;

    static TEST_DIRECTORY_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestAssets(PathBuf);

    impl TestAssets {
        fn new() -> Self {
            let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "amll-lyrics-service-test-{}-{id}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(
                path.join("index.html"),
                b"<!doctype html><title>SPA</title>",
            )
            .unwrap();
            std::fs::write(path.join("asset.js"), b"console.log('asset')").unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestAssets {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_router(assets: &Path) -> axum::Router {
        build_router(
            std::sync::Arc::new(OnlineLyricsService::default()),
            assets,
            5173,
        )
    }

    fn request(
        method: Method,
        uri: &str,
        host: &str,
        origin: Option<&str>,
        body: &str,
    ) -> Request<Body> {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, host)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.body(Body::from(body.to_owned())).unwrap()
    }

    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn health_has_protocol_and_cross_origin_isolation_headers() {
        let assets = TestAssets::new();
        let response = test_router(assets.path())
            .oneshot(request(
                Method::GET,
                "/api/online-lyrics/health",
                "127.0.0.1:5173",
                Some("http://127.0.0.1:5173"),
                "",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("cross-origin-opener-policy")
                .unwrap(),
            "same-origin"
        );
        assert_eq!(
            response
                .headers()
                .get("cross-origin-embedder-policy")
                .unwrap(),
            "require-corp"
        );
        let body = response_json(response).await;
        assert_eq!(body["service"], "amll-lyrics-service");
        assert_eq!(body["protocolVersion"], 1);
        assert_eq!(body["providers"].as_array().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn malformed_search_request_returns_json_bad_request() {
        let assets = TestAssets::new();
        let response = test_router(assets.path())
            .oneshot(request(
                Method::POST,
                "/api/online-lyrics/search",
                "127.0.0.1:5173",
                None,
                "{",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert!(body["error"].as_str().unwrap().contains("invalid JSON"));
    }

    #[tokio::test]
    async fn foreign_origin_and_unexpected_host_are_rejected() {
        let assets = TestAssets::new();
        let foreign = test_router(assets.path())
            .oneshot(request(
                Method::GET,
                "/api/online-lyrics/health",
                "127.0.0.1:5173",
                Some("http://evil.example:5173"),
                "",
            ))
            .await
            .unwrap();
        assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response_json(foreign).await["error"],
            "foreign Origin rejected"
        );

        let host = test_router(assets.path())
            .oneshot(request(
                Method::GET,
                "/api/online-lyrics/health",
                "evil.example:5173",
                None,
                "",
            ))
            .await
            .unwrap();
        assert_eq!(host.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn spa_fallback_serves_index_for_client_routes() {
        let assets = TestAssets::new();
        let response = test_router(assets.path())
            .oneshot(request(
                Method::GET,
                "/editor/project",
                "localhost:5173",
                None,
                "",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(body.windows(7).any(|window| window == b"<title>"));
    }

    #[tokio::test]
    async fn oversized_json_body_is_rejected_before_provider_access() {
        let assets = TestAssets::new();
        let oversized = "x".repeat(70 * 1024);
        let response = test_router(assets.path())
            .oneshot(request(
                Method::POST,
                "/api/online-lyrics/search",
                "127.0.0.1:5173",
                None,
                &oversized,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn provider_errors_and_timeouts_have_gateway_statuses() {
        assert_eq!(
            status_for_error(&OnlineLyricsError::InvalidInput("bad input".into())),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status_for_error(&OnlineLyricsError::Provider("source down".into())),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            status_for_error(&OnlineLyricsError::Timeout("timed out")),
            StatusCode::GATEWAY_TIMEOUT
        );
    }

    #[test]
    fn cli_defaults_to_port_5173_and_requires_assets() {
        let action = parse_cli(["--assets", "dist"]).unwrap();
        let CliAction::Run(options) = action else {
            panic!("expected run action");
        };
        assert_eq!(options.port, 5173);
        assert_eq!(options.assets, PathBuf::from("dist"));
        assert!(parse_cli(Vec::<&str>::new()).is_err());
        assert!(parse_cli(["--port", "0", "--assets", "dist"]).is_err());
    }
}
