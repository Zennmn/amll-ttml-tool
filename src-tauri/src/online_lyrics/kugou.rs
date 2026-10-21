// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC Kugou provider.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::crypto::{krc_decrypt, md5_hex};
use super::http::{
    MAX_JSON_BYTES, MAX_LYRIC_BYTES, object, optional_scalar_string, optional_u64, parse_json,
    required_array, required_object, required_str, required_u64, scalar_string, send_with_retry,
};
use super::{
    LyricCandidate, LyricChannel, LyricFormat, OnlineLyrics, OnlineSearchPage, OnlineTrack,
};

const SEARCH_URL: &str = "https://complexsearch.kugou.com/v2/search/song";
const LEGACY_SEARCH_URL: &str = "https://mobiles.kugou.com/api/v3/search/song";
const LYRIC_SEARCH_URL: &str = "https://lyrics.kugou.com/v1/search";
const LYRIC_DOWNLOAD_URL: &str = "https://lyrics.kugou.com/download";
const REGISTER_URL: &str = "https://userservice.kugou.com/risk/v1/r_register_dev";
const SIGNATURE_SECRET: &str = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
const PAGE_SIZE: usize = 20;

#[derive(Default)]
struct KugouState {
    dfid: Option<String>,
}

pub(crate) struct KugouProvider {
    client: reqwest::Client,
    state: Mutex<KugouState>,
}

impl KugouProvider {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self {
            client: super::http::build_client()?,
            state: Mutex::new(KugouState::default()),
        })
    }

    pub(crate) async fn search(&self, query: &str, page: u32) -> Result<OnlineSearchPage, String> {
        self.initialize().await;
        let offset = (u64::from(page) - 1) * PAGE_SIZE as u64;
        let primary = self
            .search_primary(query, page)
            .await
            .and_then(|data| parse_primary_search(&data, page, offset));
        match primary {
            Ok(page) => Ok(page),
            Err(primary_error) => self
                .search_legacy(query, page)
                .await
                .and_then(|data| parse_legacy_search(&data, page, offset))
                .map_err(|legacy_error| {
                    format!(
                        "Kugou search failed: primary: {primary_error}; fallback: {legacy_error}"
                    )
                }),
        }
    }

    pub(crate) async fn fetch(
        &self,
        track: &OnlineTrack,
        requested_candidate: Option<&LyricCandidate>,
    ) -> Result<OnlineLyrics, String> {
        self.initialize().await;
        let candidates = self.fetch_candidates(track).await?;
        if candidates.is_empty() {
            return Err("Kugou returned no lyric candidates".into());
        }
        let selected_index = if let Some(requested) = requested_candidate {
            candidates
                .iter()
                .position(|candidate| candidate.id == requested.id)
                .ok_or_else(|| {
                    "selected Kugou lyric candidate was not returned by the server".to_owned()
                })?
        } else {
            0
        };
        let selected = &candidates[selected_index];
        let selected_id = selected.id.clone();
        let data = self
            .signed_value(
                LYRIC_DOWNLOAD_URL,
                "Lyric",
                json!({
                    "accesskey": selected.access_key,
                    "charset": "utf8",
                    "client": "mobi",
                    "fmt": "krc",
                    "id": selected.id,
                    "ver": "1"
                }),
                false,
                None,
            )
            .await?;
        let content_type = data
            .get("contenttype")
            .and_then(super::http::optional_u64_value)
            .ok_or_else(|| "invalid Kugou download response: missing contenttype".to_owned())?;
        let content = required_str(&data, "content", "Kugou download response")?;
        if content.is_empty() || content.len() > MAX_LYRIC_BYTES * 2 {
            return Err("Kugou lyric content has an invalid size".into());
        }
        let decoded = BASE64
            .decode(content)
            .map_err(|_| "Kugou lyric content is not valid base64".to_owned())?;
        if decoded.is_empty() || decoded.len() > MAX_LYRIC_BYTES {
            return Err("Kugou lyric content has an invalid decoded size".into());
        }
        let original = if content_type == 2 {
            LyricChannel {
                format: LyricFormat::Plain,
                content: String::from_utf8(decoded)
                    .map_err(|_| "Kugou plain lyric content is not UTF-8".to_owned())?,
            }
        } else {
            LyricChannel {
                format: LyricFormat::Krc,
                content: krc_decrypt(&decoded)?,
            }
        };

        Ok(OnlineLyrics {
            original,
            translation: None,
            romanization: None,
            original_lrc: None,
            candidates: Some(candidates),
            selected_candidate_id: Some(selected_id),
        })
    }

    async fn fetch_candidates(&self, track: &OnlineTrack) -> Result<Vec<LyricCandidate>, String> {
        let keyword = format!("{} - {}", track.artists.join("、"), track.title);
        let hash = track
            .hash
            .as_deref()
            .ok_or_else(|| "Kugou track is missing its file hash".to_owned())?;
        let data = self
            .signed_value(
                LYRIC_SEARCH_URL,
                "Lyric",
                json!({
                    "album_audio_id": track.id,
                    "duration": track.duration_ms,
                    "hash": hash,
                    "keyword": keyword,
                    "lrctxt": "1",
                    "man": "no"
                }),
                false,
                None,
            )
            .await?;
        parse_candidates(&data)
    }

    async fn search_primary(&self, query: &str, page: u32) -> Result<Value, String> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-router",
            "complexsearch.kugou.com"
                .parse()
                .map_err(|_| "invalid Kugou search header".to_owned())?,
        );
        self.signed_value(
            SEARCH_URL,
            "SearchSong",
            json!({
                "sorttype": "0",
                "keyword": query,
                "pagesize": PAGE_SIZE,
                "page": page
            }),
            false,
            Some(headers),
        )
        .await
    }

    async fn search_legacy(&self, query: &str, page: u32) -> Result<Value, String> {
        let params = vec![
            ("showtype".to_owned(), "14".to_owned()),
            ("highlight".to_owned(), String::new()),
            ("pagesize".to_owned(), PAGE_SIZE.to_string()),
            ("tag_aggr".to_owned(), "1".to_owned()),
            ("plat".to_owned(), "0".to_owned()),
            ("sver".to_owned(), "5".to_owned()),
            ("keyword".to_owned(), query.to_owned()),
            ("correct".to_owned(), "1".to_owned()),
            ("api_ver".to_owned(), "1".to_owned()),
            ("version".to_owned(), "9108".to_owned()),
            ("page".to_owned(), page.to_string()),
        ];
        let response = send_with_retry("Kugou", MAX_JSON_BYTES, || {
            self.client
                .get(LEGACY_SEARCH_URL)
                .query(&params)
                .timeout(super::http::REQUEST_TIMEOUT)
        })
        .await?;
        parse_json(&response.body, "Kugou")
    }

    async fn signed_value(
        &self,
        url: &str,
        module: &str,
        params: Value,
        post: bool,
        extra_headers: Option<HeaderMap>,
    ) -> Result<Value, String> {
        let data = params
            .as_object()
            .cloned()
            .ok_or_else(|| "invalid Kugou request parameters".to_owned())?;
        let mut query = BTreeMap::<String, String>::new();
        let now_ms = unix_millis();
        let mid = md5_hex(now_ms.to_string().as_bytes());
        if module == "Lyric" {
            query.insert("appid".into(), "3116".into());
            query.insert("clientver".into(), "11070".into());
        } else {
            for (key, value) in [
                ("userid", "0"),
                ("appid", "3116"),
                ("token", ""),
                ("uuid", "-"),
                ("dfid", "-"),
                ("clientver", "11070"),
                ("platform", "AndroidFilter"),
            ] {
                query.insert(key.into(), value.into());
            }
            query.insert("clienttime".into(), (now_ms / 1000).to_string());
            query.insert("iscorrection".into(), "1".into());
            query.insert("mid".into(), mid.clone());
        }
        for (key, value) in data {
            query.insert(key, scalar_for_query(&value)?);
        }
        let signature_source = format!(
            "{SIGNATURE_SECRET}{}{SIGNATURE_SECRET}",
            query
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("")
        );
        query.insert("signature".into(), md5_hex(signature_source.as_bytes()));

        let mut headers = extra_headers.unwrap_or_default();
        headers.insert(
            "user-agent",
            format!("Android14-1070-11070-201-0-{module}-wifi")
                .parse()
                .map_err(|_| "invalid Kugou user agent".to_owned())?,
        );
        for (key, value) in [
            ("connection", "Keep-Alive"),
            ("accept-encoding", "gzip, deflate"),
            ("kg-rec", "1"),
            ("kg-rc", "1"),
        ] {
            headers.insert(
                key,
                value
                    .parse()
                    .map_err(|_| "invalid Kugou header".to_owned())?,
            );
        }
        headers.insert(
            "kg-clienttimems",
            now_ms
                .to_string()
                .parse()
                .map_err(|_| "invalid Kugou client time".to_owned())?,
        );
        headers.insert(
            "mid",
            mid.parse()
                .map_err(|_| "invalid Kugou request mid".to_owned())?,
        );
        let pairs: Vec<(String, String)> = query.into_iter().collect();
        let response = send_with_retry("Kugou", MAX_JSON_BYTES, || {
            let builder = if post {
                self.client.post(url)
            } else {
                self.client.get(url)
            };
            builder
                .query(&pairs)
                .headers(headers.clone())
                .timeout(super::http::REQUEST_TIMEOUT)
        })
        .await?;
        let response = parse_json(&response.body, "Kugou")?;
        validate_kugou_code(&response)?;
        Ok(response)
    }

    async fn initialize(&self) {
        let mut state = self.state.lock().await;
        if state.dfid.is_some() {
            return;
        }
        state.dfid = Some(
            register_device(self.client.clone())
                .await
                .unwrap_or_else(|error| {
                    log::warn!("Kugou device registration failed: {error}");
                    "-".into()
                }),
        );
    }
}

async fn register_device(client: reqwest::Client) -> Result<String, String> {
    let now_ms = unix_millis();
    let mid = md5_hex(now_ms.to_string().as_bytes());
    let values = ["1014", "4", mid.as_str()];
    let mut sorted = values;
    sorted.sort_unstable();
    let signature = md5_hex(format!("1014{}{}1014", sorted.concat(), "").as_bytes());
    let params = vec![
        ("appid".to_owned(), "1014".to_owned()),
        ("platid".to_owned(), "4".to_owned()),
        ("mid".to_owned(), mid),
        ("signature".to_owned(), signature),
    ];
    let body = BASE64.encode(br#"{"uuid":""}"#);
    let response = send_with_retry("Kugou device registration", MAX_JSON_BYTES, || {
        client
            .post(REGISTER_URL)
            .query(&params)
            .body(body.clone())
            .timeout(super::http::REQUEST_TIMEOUT)
    })
    .await?;
    let response = parse_json(&response.body, "Kugou device registration")?;
    let dfid = required_object(&response, "data", "Kugou device registration response")?
        .get("dfid")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| "invalid Kugou device registration response: missing dfid".to_owned())?;
    Ok(dfid.to_owned())
}

fn parse_primary_search(data: &Value, page: u32, offset: u64) -> Result<OnlineSearchPage, String> {
    let data = required_object(data, "data", "Kugou search response")?;
    let lists = data
        .get("lists")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid Kugou search response: missing lists".to_owned())?;
    let mut tracks = Vec::with_capacity(lists.len());
    for item in lists {
        let item_object = object(item, "Kugou search item")?;
        let id = item_object
            .get("ID")
            .ok_or_else(|| "invalid Kugou search item: missing ID".to_owned())?;
        let artists = required_array(item, "Singers", "Kugou search item")?
            .iter()
            .map(|singer| required_str(singer, "name", "Kugou singer").map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?;
        let seconds = required_u64(item, "Duration", "Kugou search item")?;
        tracks.push(OnlineTrack {
            provider: "kugou".into(),
            id: scalar_string(id, "Kugou song id")?,
            title: required_str(item, "SongName", "Kugou search item")?.to_owned(),
            artists,
            album: required_str(item, "AlbumName", "Kugou search item")?.to_owned(),
            duration_ms: seconds
                .checked_mul(1000)
                .ok_or_else(|| "invalid Kugou duration".to_owned())?,
            mid: None,
            hash: Some(required_str(item, "FileHash", "Kugou search item")?.to_owned()),
        });
    }
    let total = optional_u64(&Value::Object(data.clone()), "total");
    Ok(OnlineSearchPage {
        page,
        has_more: total.map_or(tracks.len() == PAGE_SIZE, |total| {
            offset + (tracks.len() as u64) < total
        }),
        tracks,
    })
}

fn parse_legacy_search(data: &Value, page: u32, offset: u64) -> Result<OnlineSearchPage, String> {
    let data = required_object(data, "data", "Kugou fallback response")?;
    let items = data
        .get("info")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid Kugou fallback response: missing info".to_owned())?;
    let mut tracks = Vec::with_capacity(items.len());
    for item in items {
        let item_object = object(item, "Kugou fallback item")?;
        let id = item_object
            .get("album_audio_id")
            .ok_or_else(|| "invalid Kugou fallback item: missing album_audio_id".to_owned())?;
        let singers = required_str(item, "singername", "Kugou fallback item")?;
        let seconds = required_u64(item, "duration", "Kugou fallback item")?;
        tracks.push(OnlineTrack {
            provider: "kugou".into(),
            id: scalar_string(id, "Kugou fallback song id")?,
            title: required_str(item, "songname", "Kugou fallback item")?.to_owned(),
            artists: singers
                .split('、')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect(),
            album: required_str(item, "album_name", "Kugou fallback item")?.to_owned(),
            duration_ms: seconds
                .checked_mul(1000)
                .ok_or_else(|| "invalid Kugou fallback duration".to_owned())?,
            mid: None,
            hash: Some(required_str(item, "hash", "Kugou fallback item")?.to_owned()),
        });
    }
    let total = optional_u64(&Value::Object(data.clone()), "total");
    Ok(OnlineSearchPage {
        tracks: tracks.clone(),
        page,
        has_more: total.map_or(tracks.len() == PAGE_SIZE, |total| {
            offset + (tracks.len() as u64) < total
        }),
    })
}

fn parse_candidates(data: &Value) -> Result<Vec<LyricCandidate>, String> {
    let items = required_array(data, "candidates", "Kugou candidate response")?;
    let mut candidates = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let id = item
            .as_object()
            .and_then(|object| object.get("id"))
            .ok_or_else(|| "invalid Kugou candidate: missing id".to_owned())?;
        let id = scalar_string(id, "Kugou candidate id")?;
        let access_key = required_str(item, "accesskey", "Kugou candidate")?.to_owned();
        let label = optional_scalar_string(item, "nickname")?
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| format!("KRC candidate {}", index + 1));
        candidates.push(LyricCandidate {
            id,
            access_key,
            label,
            duration_ms: optional_u64(item, "duration"),
        });
    }
    Ok(candidates)
}

fn validate_kugou_code(data: &Value) -> Result<(), String> {
    let code = data
        .get("error_code")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0);
    if code == 0 || code == 200 {
        return Ok(());
    }
    let message = data
        .get("error_msg")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    Err(format!("Kugou API error ({code}): {message}"))
}

fn scalar_for_query(value: &Value) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        Value::Bool(boolean) => Ok(boolean.to_string()),
        Value::Null => Ok(String::new()),
        Value::Object(_) | Value::Array(_) => serde_json::to_string(value)
            .map_err(|error| format!("failed to serialize Kugou parameter: {error}")),
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_candidates, parse_primary_search};

    #[test]
    fn primary_search_maps_kugou_fields() {
        let data = json!({
            "data": {
                "total": 1,
                "lists": [{
                    "ID": 9,
                    "FileHash": "0123456789abcdef0123456789abcdef",
                    "SongName": "Title",
                    "Singers": [{"name": "Artist"}],
                    "AlbumName": "Album",
                    "Duration": 42
                }]
            }
        });
        let page = parse_primary_search(&data, 1, 0).unwrap();
        assert_eq!(page.tracks[0].id, "9");
        assert_eq!(page.tracks[0].duration_ms, 42_000);
        assert!(!page.has_more);
    }

    #[test]
    fn candidates_and_invalid_shapes() {
        let candidates = parse_candidates(&json!({
            "candidates": [{"id": 3, "accesskey": "key", "nickname": "Lyricist", "duration": 1000}]
        }))
        .unwrap();
        assert_eq!(candidates[0].id, "3");
        assert_eq!(candidates[0].label, "Lyricist");
        assert!(parse_candidates(&json!({})).is_err());
        assert!(parse_primary_search(&json!({"data": {}}), 1, 0).is_err());
    }
}
