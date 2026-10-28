use std::time::Duration;

use reqwest::{Client, StatusCode, Url};

const LOOKUP_URL: &str = "https://itunes.apple.com/lookup";
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_ATTEMPTS: usize = 2;
const RETRY_DELAY: Duration = Duration::from_millis(200);
const MAX_SAFE_SONG_ID: u64 = 9_007_199_254_740_991;

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

struct AttemptError {
    error: LookupError,
    retryable: bool,
}

impl AttemptError {
    fn permanent(error: LookupError) -> Self {
        Self {
            error,
            retryable: false,
        }
    }

    fn transient(error: LookupError) -> Self {
        Self {
            error,
            retryable: true,
        }
    }
}

/// Looks up one track at Apple's fixed iTunes endpoint.
#[tauri::command]
pub async fn apple_music_metadata_lookup(
    song_id: String,
    storefront: String,
) -> Result<LookupResponse, LookupError> {
    let song_id = validate_song_id(&song_id)?;
    let storefront = validate_storefront(&storefront)?;
    let url = lookup_url(song_id, &storefront);
    let client = build_client().map_err(|_| LookupError::network())?;
    lookup_with_client(&client, url).await
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

fn lookup_url(song_id: &str, storefront: &str) -> Url {
    let mut url = Url::parse(LOOKUP_URL).expect("the iTunes lookup URL is a valid constant");
    url.query_pairs_mut()
        .append_pair("id", song_id)
        .append_pair("country", storefront);
    url
}

fn build_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
}

async fn lookup_with_client(client: &Client, url: Url) -> Result<LookupResponse, LookupError> {
    for attempt in 0..MAX_ATTEMPTS {
        let response = match client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let failure = AttemptError::transient(request_error_code(&error));
                if failure.retryable && attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(RETRY_DELAY).await;
                    continue;
                }
                return Err(failure.error);
            }
        };

        let status = response.status();
        if !status.is_success() {
            let transient = retryable_status(status);
            if transient && attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
            return Ok(LookupResponse {
                status: status.as_u16(),
                body: String::new(),
            });
        }

        match read_body(response).await {
            Ok(body) => {
                return Ok(LookupResponse {
                    status: status.as_u16(),
                    body,
                });
            }
            Err(failure) => {
                if failure.retryable && attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(RETRY_DELAY).await;
                    continue;
                }
                return Err(failure.error);
            }
        }
    }

    Err(LookupError::network())
}

fn request_error_code(error: &reqwest::Error) -> LookupError {
    if error.is_timeout() {
        LookupError::timeout()
    } else {
        LookupError::network()
    }
}

fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

async fn read_body(mut response: reqwest::Response) -> Result<String, AttemptError> {
    let max_body_bytes = u64::try_from(MAX_BODY_BYTES).unwrap_or(u64::MAX);
    if response
        .content_length()
        .is_some_and(|length| length > max_body_bytes)
    {
        return Err(AttemptError::permanent(LookupError::invalid_response()));
    }

    let initial_capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0)
        .min(MAX_BODY_BYTES);
    let mut body = Vec::with_capacity(initial_capacity);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| AttemptError::transient(request_error_code(&error)))?
    {
        if !extend_bounded(&mut body, &chunk) {
            return Err(AttemptError::permanent(LookupError::invalid_response()));
        }
    }

    String::from_utf8(body).map_err(|_| AttemptError::permanent(LookupError::invalid_response()))
}

fn extend_bounded(target: &mut Vec<u8>, bytes: &[u8]) -> bool {
    let Some(new_length) = target.len().checked_add(bytes.len()) else {
        return false;
    };
    if new_length > MAX_BODY_BYTES {
        return false;
    }
    target.extend_from_slice(bytes);
    true
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use reqwest::{Client, StatusCode, Url};

    use super::{
        LookupError, LookupResponse, MAX_BODY_BYTES, MAX_SAFE_SONG_ID, build_client, lookup_url,
        lookup_with_client, retryable_status, validate_song_id, validate_storefront,
    };

    struct TestServer {
        endpoint: String,
        requests: Arc<AtomicUsize>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn new(responses: Vec<Vec<u8>>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
            listener
                .set_nonblocking(true)
                .expect("configure test listener");
            let address = listener.local_addr().expect("read test listener address");
            let requests = Arc::new(AtomicUsize::new(0));
            let request_counter = Arc::clone(&requests);
            let handle = thread::spawn(move || {
                for response in responses {
                    let deadline = Instant::now() + Duration::from_secs(2);
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
                    request_counter.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    read_request_headers(&mut stream);
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                    let _ = stream.shutdown(Shutdown::Both);
                }
            });

            Self {
                endpoint: format!("http://{address}/lookup"),
                requests,
                handle: Some(handle),
            }
        }

        fn url(&self) -> Url {
            Url::parse(&self.endpoint).expect("parse test endpoint")
        }

        fn finish(self) -> usize {
            let Self {
                requests, handle, ..
            } = self;
            handle
                .expect("test server handle")
                .join()
                .expect("join test server");
            requests.load(Ordering::SeqCst)
        }
    }

    fn read_request_headers(stream: &mut std::net::TcpStream) {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => request.extend_from_slice(&buffer[..read]),
            }
        }
    }

    fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
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
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .build()
            .expect("create test HTTP client")
    }

    #[test]
    fn validates_safe_positive_decimal_song_ids() {
        assert!(validate_song_id("1").is_ok());
        assert!(validate_song_id("1538283049").is_ok());
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
            "12345678901234567",
        ] {
            assert_eq!(
                validate_song_id(invalid),
                Err(LookupError::invalid_link()),
                "{invalid:?} should be rejected"
            );
        }
    }

    #[test]
    fn validates_and_normalizes_ascii_storefronts() {
        assert_eq!(validate_storefront("tr").as_deref(), Ok("tr"));
        assert_eq!(validate_storefront("US").as_deref(), Ok("us"));

        for invalid in ["", "u", "usa", "u1", "éé"] {
            assert_eq!(
                validate_storefront(invalid),
                Err(LookupError::invalid_link()),
                "{invalid:?} should be rejected"
            );
        }
    }

    #[test]
    fn builds_only_the_fixed_https_itunes_lookup_url() {
        let url = lookup_url("1538283049", "tr");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("itunes.apple.com"));
        assert_eq!(url.path(), "/lookup");
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![
                ("id".into(), "1538283049".into()),
                ("country".into(), "tr".into())
            ]
        );
    }

    #[test]
    fn command_contract_uses_status_and_code_envelopes() {
        let response = LookupResponse {
            status: 503,
            body: String::new(),
        };
        assert_eq!(
            serde_json::to_value(response).expect("serialize lookup response"),
            serde_json::json!({ "status": 503, "body": "" })
        );
        assert_eq!(
            serde_json::to_value(LookupError::invalid_response()).expect("serialize lookup error"),
            serde_json::json!({ "code": "invalidResponse" })
        );
    }

    #[test]
    fn retries_only_transient_http_statuses() {
        for status in [
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert!(retryable_status(status), "{status} should be retryable");
        }
        for status in [
            StatusCode::MOVED_PERMANENTLY,
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::NOT_FOUND,
            StatusCode::CONFLICT,
        ] {
            assert!(
                !retryable_status(status),
                "{status} should not be retryable"
            );
        }
    }

    #[test]
    fn retries_a_transient_status_once_then_returns_the_success_body() {
        let server = TestServer::new(vec![
            http_response("503 Service Unavailable", b"busy"),
            http_response("200 OK", br#"{"resultCount":1}"#),
        ]);
        let result = block_on(lookup_with_client(&test_client(), server.url()));

        assert_eq!(
            result,
            Ok(LookupResponse {
                status: 200,
                body: r#"{"resultCount":1}"#.to_owned(),
            })
        );
        assert_eq!(server.finish(), 2);
    }

    #[test]
    fn returns_the_last_transient_status_after_two_attempts() {
        let server = TestServer::new(vec![
            http_response("429 Too Many Requests", b"busy"),
            http_response("502 Bad Gateway", b"still busy"),
        ]);
        let result = block_on(lookup_with_client(&test_client(), server.url()));

        assert_eq!(
            result,
            Ok(LookupResponse {
                status: 502,
                body: String::new(),
            })
        );
        assert_eq!(server.finish(), 2);
    }

    #[test]
    fn returns_permanent_client_errors_without_downloading_their_body() {
        let server = TestServer::new(vec![http_response("404 Not Found", b"missing")]);
        let result = block_on(lookup_with_client(&test_client(), server.url()));

        assert_eq!(
            result,
            Ok(LookupResponse {
                status: 404,
                body: String::new(),
            })
        );
        assert_eq!(server.finish(), 1);
    }

    #[test]
    fn rejects_an_oversized_streamed_body_without_retrying() {
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.resize(response.len() + MAX_BODY_BYTES + 1, b'x');
        let server = TestServer::new(vec![response]);
        let result = block_on(lookup_with_client(&test_client(), server.url()));

        assert_eq!(result, Err(LookupError::invalid_response()));
        assert_eq!(server.finish(), 1);
    }

    #[test]
    fn rejects_an_oversized_content_length_without_reading_or_retrying() {
        let server = TestServer::new(vec![response_with_declared_length(
            "200 OK",
            MAX_BODY_BYTES + 1,
        )]);
        let result = block_on(lookup_with_client(&test_client(), server.url()));

        assert_eq!(result, Err(LookupError::invalid_response()));
        assert_eq!(server.finish(), 1);
    }

    #[test]
    fn accepts_a_body_at_the_exact_size_limit() {
        let body = "x".repeat(MAX_BODY_BYTES);
        let server = TestServer::new(vec![http_response("200 OK", body.as_bytes())]);
        let result = block_on(lookup_with_client(&test_client(), server.url()));

        assert!(matches!(result, Ok(response) if response.body.len() == MAX_BODY_BYTES));
        assert_eq!(server.finish(), 1);
    }

    #[test]
    fn transport_construction_does_not_panic() {
        assert!(build_client().is_ok());
    }

    /// Run the reported live case explicitly with:
    /// `cargo test --manifest-path src-tauri/Cargo.toml --lib
    /// apple_music_metadata::tests::live_lookup_for_reported_song_id -- --ignored --nocapture`
    #[test]
    #[ignore = "live iTunes network smoke test"]
    fn live_lookup_for_reported_song_id() {
        let response = block_on(super::apple_music_metadata_lookup(
            "1538283049".to_owned(),
            "tr".to_owned(),
        ))
        .expect("native Apple Music lookup should succeed");

        assert_eq!(response.status, 200);
        let json: serde_json::Value =
            serde_json::from_str(&response.body).expect("lookup body should be JSON");
        assert_eq!(json["resultCount"], 1);
        assert_eq!(json["results"][0]["trackId"], 1_538_283_049);
    }
}
