// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC NetEase provider.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::crypto::{anonymous_username, eapi_params_encrypt, eapi_response_decrypt, md5_hex};
use super::http::{
    MAX_JSON_BYTES, object, optional_scalar_string, optional_u64, required_array, required_object,
    required_str, required_u64, scalar_string, send_with_retry,
};
use super::{
    LyricChannel, LyricFormat, OnlineLyrics, OnlineSearchPage, OnlineTrack, detect_channel,
};

const BASE_URL: &str = "https://interface.music.163.com";
const PAGE_SIZE: usize = 20;
const DEVICE_ID: &str = "AA9955F5FE37BA7EAF48F8EF0C9966B28293CC8D6415CCD93549";
const APP_VERSION: &str = "3.1.3.203419";
const OS_VERSION: &str = "Microsoft-Windows-10--build-22631-64bit";
const SESSION_LIFETIME_SECONDS: u64 = 864_000;
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct NetEaseSession {
    device_id: String,
    client_sign: String,
    os_version: String,
    mode: String,
    cookies: Vec<(String, String)>,
    expires_at: u64,
}

pub(crate) struct NetEaseProvider {
    client: reqwest::Client,
    session: Mutex<Option<NetEaseSession>>,
}

impl NetEaseProvider {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self {
            client: super::http::build_client()?,
            session: Mutex::new(None),
        })
    }

    pub(crate) async fn search(&self, query: &str, page: u32) -> Result<OnlineSearchPage, String> {
        let offset = (u64::from(page) - 1) * PAGE_SIZE as u64;
        let response = self
            .request_value(
                "/eapi/search/song/list/page",
                json!({
                    "limit": PAGE_SIZE.to_string(),
                    "offset": offset.to_string(),
                    "keyword": query,
                    "scene": "NORMAL",
                    "needCorrect": "true"
                }),
            )
            .await?;
        parse_search_response(&response, page, offset)
    }

    pub(crate) async fn fetch(&self, track: &OnlineTrack) -> Result<OnlineLyrics, String> {
        let id = track
            .id
            .parse::<u64>()
            .map_err(|_| "NetEase track id must be numeric".to_owned())?;
        let response = self
            .request_value(
                "/eapi/song/lyric/v1",
                json!({
                    "id": id,
                    "lv": "-1",
                    "tv": "-1",
                    "rv": "-1",
                    "yv": "-1"
                }),
            )
            .await?;

        let yrc = lyric_text(&response, "yrc")?;
        let lrc = lyric_text(&response, "lrc")?;
        let translation = lyric_text(&response, "tlyric")?
            .map(detect_channel)
            .transpose()?;
        let romanization = lyric_text(&response, "romalrc")?
            .map(detect_channel)
            .transpose()?;

        let (original, original_lrc) = if let Some(yrc) = yrc {
            (
                LyricChannel {
                    format: LyricFormat::Yrc,
                    content: yrc,
                },
                lrc,
            )
        } else if let Some(lrc) = lrc {
            (detect_channel(lrc)?, None)
        } else {
            return Err("NetEase returned no lyric channel".into());
        };

        Ok(OnlineLyrics {
            original,
            translation,
            romanization,
            original_lrc,
            candidates: None,
            selected_candidate_id: None,
        })
    }

    async fn request_value(&self, path: &str, params: Value) -> Result<Value, String> {
        let session = self.ensure_session().await?;
        let mut params = object(&params, "NetEase request parameters")?.clone();
        params.insert("e_r".into(), Value::Bool(true));
        params.insert("header".into(), Value::String(parameters_header(&session)));
        let encrypted =
            eapi_params_encrypt(&path.replacen("eapi", "api", 1), &Value::Object(params))?;
        let headers = request_headers(&session.cookies)?;
        let url = format!("{BASE_URL}{path}");
        let body = encrypted.into_bytes();
        let response = send_with_retry("NetEase", MAX_JSON_BYTES, || {
            self.client
                .post(&url)
                .headers(headers.clone())
                .body(body.clone())
        })
        .await?;
        let data = eapi_response_decrypt(&response.body)?;
        validate_eapi_code(&data)?;
        Ok(data)
    }

    async fn ensure_session(&self) -> Result<NetEaseSession, String> {
        let now = unix_timestamp();
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_ref() {
            if session.expires_at > now + 60 {
                return Ok(session.clone());
            }
        }
        let session = self.create_session(now).await?;
        *guard = Some(session.clone());
        Ok(session)
    }

    async fn create_session(&self, now: u64) -> Result<NetEaseSession, String> {
        let client_sign = format!(
            "{}@@@{}@@@@@@{}",
            random_mac(),
            random_uppercase(8),
            nonce_hex()
        );
        let pre_cookies = vec![
            ("os".into(), "pc".into()),
            ("deviceId".into(), DEVICE_ID.into()),
            ("osver".into(), OS_VERSION.into()),
            ("clientSign".into(), client_sign.clone()),
            ("channel".into(), "netease".into()),
            ("mode".into(), "ASUS ROG STRIX Z790".into()),
            ("appver".into(), APP_VERSION.into()),
        ];
        let temporary = NetEaseSession {
            device_id: DEVICE_ID.into(),
            client_sign,
            os_version: OS_VERSION.into(),
            mode: "ASUS ROG STRIX Z790".into(),
            cookies: pre_cookies,
            expires_at: now,
        };

        let path = "/eapi/register/anonimous";
        let params = json!({
            "username": anonymous_username(&temporary.device_id),
            "e_r": true,
            "header": parameters_header(&temporary)
        });
        let encrypted = eapi_params_encrypt("/api/register/anonimous", &params)?;
        let headers = request_headers(&temporary.cookies)?;
        let url = format!("{BASE_URL}{path}");
        let body = encrypted.into_bytes();
        let response = send_with_retry("NetEase", MAX_JSON_BYTES, || {
            self.client
                .post(&url)
                .headers(headers.clone())
                .body(body.clone())
        })
        .await?;
        let data = eapi_response_decrypt(&response.body)?;
        const GUEST_LOGIN_OK: i64 = 200;
        let code = data
            .get("code")
            .and_then(Value::as_i64)
            .ok_or_else(|| "invalid NetEase guest login response: missing code".to_owned())?;
        if code != GUEST_LOGIN_OK {
            let message = data
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("NetEase guest login failed ({code}): {message}"));
        }
        if data
            .get("userId")
            .and_then(|id| {
                id.as_i64()
                    .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
            })
            .is_none()
        {
            return Err("invalid NetEase guest login response: missing userId".into());
        }

        let response_cookies = parse_set_cookies(&response.headers);
        let mut cookies = vec![
            ("WEVNSM".into(), "1.0.0".into()),
            ("os".into(), "pc".into()),
            ("deviceId".into(), DEVICE_ID.into()),
            ("osver".into(), OS_VERSION.into()),
            ("clientSign".into(), temporary.client_sign.clone()),
            ("channel".into(), "netease".into()),
            ("mode".into(), temporary.mode.clone()),
        ];
        for key in ["NMTID", "MUSIC_A", "__csrf"] {
            if let Some(value) = response_cookies.get(key) {
                if !value.is_empty() {
                    cookies.push((key.into(), value.clone()));
                }
            }
        }
        cookies.push(("appver".into(), APP_VERSION.into()));
        cookies.push((
            "WNMCID".into(),
            format!("{}.{}.01.0", random_lowercase(6), now * 1000),
        ));

        Ok(NetEaseSession {
            device_id: temporary.device_id,
            client_sign: temporary.client_sign,
            os_version: temporary.os_version,
            mode: temporary.mode,
            cookies,
            expires_at: now + SESSION_LIFETIME_SECONDS,
        })
    }
}

fn parse_search_response(
    response: &Value,
    page: u32,
    offset: u64,
) -> Result<OnlineSearchPage, String> {
    let data = required_object(response, "data", "NetEase search response")?;
    let resources = match data.get("resources") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return Err("invalid NetEase search response: resources is not an array".into()),
    };
    let mut tracks = Vec::with_capacity(resources.len());
    for resource in resources {
        let base_info = required_object(resource, "baseInfo", "NetEase search item")?;
        let simple = base_info
            .get("simpleSongData")
            .ok_or_else(|| "invalid NetEase search item: missing simpleSongData".to_owned())?;
        let song = object(simple, "NetEase song")?;
        let id_value = song
            .get("id")
            .ok_or_else(|| "invalid NetEase song: missing id".to_owned())?;
        let artists = required_array(simple, "ar", "NetEase song")?
            .iter()
            .map(|artist| required_str(artist, "name", "NetEase artist").map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?;
        let album = required_object(simple, "al", "NetEase song")?;
        let album = album
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "invalid NetEase song: missing album name".to_owned())?;
        tracks.push(OnlineTrack {
            provider: "netease".into(),
            id: scalar_string(id_value, "NetEase song id")?,
            title: required_str(simple, "name", "NetEase song")?.to_owned(),
            artists,
            album: album.to_owned(),
            duration_ms: required_u64(simple, "dt", "NetEase song")?,
            mid: None,
            hash: None,
        });
    }
    let has_more = optional_u64(&Value::Object(data.clone()), "totalCount")
        .map_or(tracks.len() == PAGE_SIZE, |total| {
            offset + (tracks.len() as u64) < total
        });
    Ok(OnlineSearchPage {
        tracks,
        page,
        has_more,
    })
}

fn lyric_text(response: &Value, key: &str) -> Result<Option<String>, String> {
    let Some(value) = response.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let text = required_str(value, "lyric", &format!("NetEase {key} channel"))?;
    Ok((!text.trim().is_empty()).then(|| text.to_owned()))
}

fn validate_eapi_code(data: &Value) -> Result<(), String> {
    let code = data
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| "invalid NetEase EAPI response: missing code".to_owned())?;
    const SUCCESS: i64 = 200;
    if code != SUCCESS {
        let message =
            optional_scalar_string(data, "message")?.unwrap_or_else(|| "unknown error".into());
        return Err(format!("NetEase API error ({code}): {message}"));
    }
    Ok(())
}

fn parameters_header(session: &NetEaseSession) -> String {
    json!({
        "clientSign": session.client_sign,
        "os": "pc",
        "appver": APP_VERSION,
        "deviceId": session.device_id,
        "requestId": 0,
        "osver": session.os_version
    })
    .to_string()
}

fn request_headers(cookies: &[(String, String)]) -> Result<HeaderMap, String> {
    let cookie = cookies
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    let mut headers = HeaderMap::new();
    const STATIC_HEADERS: &[(&str, &str)] = &[
        ("accept", "*/*"),
        ("content-type", "application/x-www-form-urlencoded"),
        (
            "mconfig-info",
            r#"{"IuRPVVmc3WWul9fT":{"version":733184,"appver":"3.1.3.203419"}}"#,
        ),
        ("origin", "orpheus://orpheus"),
        (
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.3.203419",
        ),
        ("sec-ch-ua", r#""Chromium";v="91""#),
        ("sec-ch-ua-mobile", "?0"),
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-mode", "cors"),
        ("sec-fetch-dest", "empty"),
        ("accept-encoding", "gzip, deflate, br"),
        ("accept-language", "en-US,en;q=0.9"),
    ];
    for (name, value) in STATIC_HEADERS {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "invalid static NetEase header name".to_owned())?,
            HeaderValue::from_str(value)
                .map_err(|_| "invalid static NetEase header value".to_owned())?,
        );
    }
    headers.insert(
        reqwest::header::COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| "invalid NetEase cookie value".to_owned())?,
    );
    Ok(headers)
}

fn parse_set_cookies(headers: &HeaderMap) -> BTreeMap<String, String> {
    let mut cookies = BTreeMap::new();
    for value in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(value) = value.to_str() else {
            continue;
        };
        let Some((pair, _)) = value.split_once(';') else {
            continue;
        };
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            && !value.chars().any(char::is_control)
        {
            cookies.insert(name.into(), value.trim().to_owned());
        }
    }
    cookies
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn nonce_hex() -> String {
    let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    md5_hex(format!("{}:{}:{counter}", unix_timestamp(), std::process::id()).as_bytes())
}

fn random_mac() -> String {
    let token = nonce_hex();
    (0..6)
        .map(|index| token[index * 2..index * 2 + 2].to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(":")
}

fn random_uppercase(length: usize) -> String {
    derive_ascii(length, b'A', 26, true)
}

fn random_lowercase(length: usize) -> String {
    derive_ascii(length, b'a', 26, false)
}

fn derive_ascii(length: usize, base: u8, modulo: u8, upper: bool) -> String {
    let token = nonce_hex();
    token
        .bytes()
        .take(length)
        .map(|byte| {
            let nibble = if byte.is_ascii_digit() {
                byte - b'0'
            } else {
                (byte.to_ascii_lowercase() - b'a' + 10) % 16
            };
            let character = base + nibble % modulo;
            if upper {
                character.to_ascii_uppercase() as char
            } else {
                character.to_ascii_lowercase() as char
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_search_response, validate_eapi_code};

    #[test]
    fn search_response_maps_the_shared_contract() {
        let response = json!({
            "code": 200,
            "data": {
                "totalCount": 1,
                "resources": [{
                    "baseInfo": {
                        "simpleSongData": {
                            "id": 42,
                            "name": "Title",
                            "ar": [{"name": "Artist"}],
                            "al": {"name": "Album"},
                            "dt": 123000
                        }
                    }
                }]
            }
        });
        let page = parse_search_response(&response, 1, 0).unwrap();
        assert_eq!(page.tracks[0].id, "42");
        assert_eq!(page.tracks[0].duration_ms, 123000);
        assert!(!page.has_more);
    }

    #[test]
    fn invalid_search_and_api_responses_are_errors() {
        assert!(parse_search_response(&json!({"code": 200}), 1, 0).is_err());
        assert!(parse_search_response(&json!({"data": {"resources": "bad"}}), 1, 0).is_err());
        assert!(validate_eapi_code(&json!({"code": 301, "message": "login"})).is_err());
    }
}
