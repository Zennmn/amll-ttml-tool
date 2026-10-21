// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC QQ Music provider.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use super::crypto::qrc_decrypt_hex;
use super::http::{
    MAX_JSON_BYTES, object, optional_i64, optional_scalar_string, optional_u64, parse_json,
    required_array, required_object, required_str, required_u64, scalar_string, send_with_retry,
};
use super::{OnlineLyrics, OnlineSearchPage, OnlineTrack, detect_channel};

const API_URL: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const PAGE_SIZE: usize = 20;

struct QqState {
    comm: Map<String, Value>,
    inited: bool,
}

pub(crate) struct QqProvider {
    client: reqwest::Client,
    state: Mutex<QqState>,
}

impl QqProvider {
    pub(crate) fn new() -> Result<Self, String> {
        let comm = json!({
            "ct": 11,
            "cv": "1003006",
            "v": "1003006",
            "os_ver": "15",
            "phonetype": "24122RKC7C",
            "rom": "Redmi/miro/miro:15/AE3A.240806.005/OS2.0.102.0.VOMCNXM:user/release-keys",
            "tmeAppID": "qqmusiclight",
            "nettype": "NETWORK_WIFI",
            "udid": "0"
        })
        .as_object()
        .cloned()
        .ok_or_else(|| "failed to construct QQ Music session parameters".to_owned())?;
        Ok(Self {
            client: super::http::build_client()?,
            state: Mutex::new(QqState {
                comm,
                inited: false,
            }),
        })
    }

    pub(crate) async fn search(&self, query: &str, page: u32) -> Result<OnlineSearchPage, String> {
        let param = json!({
            "search_id": search_id(),
            "remoteplace": "search.android.keyboard",
            "query": query,
            "search_type": 0,
            "num_per_page": PAGE_SIZE,
            "page_num": page,
            "highlight": 0,
            "nqc_flag": 0,
            "page_id": 1,
            "grp": 1
        });
        let data = self
            .request(
                "DoSearchForQQMusicLite",
                "music.search.SearchCgiService",
                param,
            )
            .await?;
        parse_search_response(&data, page, (u64::from(page) - 1) * PAGE_SIZE as u64)
    }

    pub(crate) async fn fetch(&self, track: &OnlineTrack) -> Result<OnlineLyrics, String> {
        let song_id = track
            .id
            .parse::<u64>()
            .map_err(|_| "QQ Music track id must be numeric".to_owned())?;
        let artist = track.artists.join("/");
        let param = json!({
            "albumName": BASE64.encode(track.album.as_bytes()),
            "crypt": 1,
            "ct": 19,
            "cv": 2111,
            "interval": track.duration_ms / 1000,
            "lrc_t": 0,
            "qrc": 1,
            "qrc_t": 0,
            "roma": 1,
            "roma_t": 0,
            "singerName": BASE64.encode(artist.as_bytes()),
            "songID": song_id,
            "songName": BASE64.encode(track.title.as_bytes()),
            "trans": 1,
            "trans_t": 0,
            "type": 0
        });
        let response = self
            .request(
                "GetPlayLyricInfo",
                "music.musichallSong.PlayLyricInfo",
                param,
            )
            .await?;

        let original = decrypt_channel(&response, "lyric", "qrc_t", "lrc_t")?
            .ok_or_else(|| "QQ Music returned no original lyric channel".to_owned())?;
        let translation = decrypt_channel(&response, "trans", "trans_t", "trans_t")?;
        let romanization = decrypt_channel(&response, "roma", "roma_t", "roma_t")?;

        Ok(OnlineLyrics {
            original,
            translation,
            romanization,
            original_lrc: None,
            candidates: None,
            selected_candidate_id: None,
        })
    }

    async fn request(&self, method: &str, module: &str, param: Value) -> Result<Value, String> {
        self.ensure_initialized().await?;
        let comm = self.state.lock().await.comm.clone();
        send_request(&self.client, &comm, method, module, param)
            .await
            .map_err(|error| format!("QQ Music {method} request failed: {error}"))
    }

    async fn ensure_initialized(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if state.inited {
            return Ok(());
        }
        let data = send_request(
            &self.client,
            &state.comm,
            "GetSession",
            "music.getSession.session",
            json!({"caller": 0, "uid": "0", "vkey": 0}),
        )
        .await
        .map_err(|error| format!("QQ Music session initialization failed: {error}"))?;
        apply_session_response(&mut state, &data)?;
        Ok(())
    }
}

async fn send_request(
    client: &reqwest::Client,
    comm: &Map<String, Value>,
    method: &str,
    module: &str,
    param: Value,
) -> Result<Value, String> {
    let payload = serde_json::to_vec(&json!({
        "comm": comm,
        "request": {
            "method": method,
            "module": module,
            "param": param
        }
    }))
    .map_err(|error| format!("failed to serialize QQ Music request: {error}"))?;
    let response = send_with_retry("QQ Music", MAX_JSON_BYTES, || {
        client
            .post(API_URL)
            .header("cookie", "tmeLoginType=-1;")
            .header("content-type", "application/json")
            .header("accept-encoding", "gzip")
            .header("user-agent", "okhttp/3.14.9")
            .body(payload.clone())
    })
    .await?;
    let response = parse_json(&response.body, "QQ Music")?;
    let envelope = object(&response, "QQ Music response")?;
    let code = envelope
        .get("code")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| "invalid QQ Music response: missing code".to_owned())?;
    let request = envelope
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| "invalid QQ Music response: missing request".to_owned())?;
    let request_code = request
        .get("code")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| "invalid QQ Music response: missing request code".to_owned())?;
    if code != 0 || request_code != 0 {
        let failed_code = if code != 0 { code } else { request_code };
        return Err(format!("QQ Music API error: {failed_code}"));
    }
    request
        .get("data")
        .cloned()
        .ok_or_else(|| "invalid QQ Music response: missing request data".to_owned())
}

fn apply_session_response(state: &mut QqState, data: &Value) -> Result<(), String> {
    let session = required_object(data, "session", "QQ Music session response")?;
    for field in ["uid", "sid", "userip"] {
        let value = session
            .get(field)
            .ok_or_else(|| format!("invalid QQ Music session response: missing {field}"))?;
        if !matches!(value, Value::String(_) | Value::Number(_)) {
            return Err(format!("invalid QQ Music session field: {field}"));
        }
        state.comm.insert(field.into(), value.clone());
    }
    // LDDC's original init omitted this assignment and initialized on every request.
    state.inited = true;
    Ok(())
}

fn parse_search_response(data: &Value, page: u32, offset: u64) -> Result<OnlineSearchPage, String> {
    let body = required_object(data, "body", "QQ Music search response")?;
    let items = body
        .get("item_song")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid QQ Music search response: missing item_song".to_owned())?;
    let mut tracks = Vec::with_capacity(items.len());
    for item in items {
        let id_value = item
            .as_object()
            .and_then(|object| object.get("id"))
            .ok_or_else(|| "invalid QQ Music search item: missing id".to_owned())?;
        let singers = required_array(item, "singer", "QQ Music search item")?;
        let artists = singers
            .iter()
            .map(|singer| required_str(singer, "name", "QQ Music singer").map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()?;
        let album = required_object(item, "album", "QQ Music search item")?;
        let album = album
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "invalid QQ Music search item: missing album name".to_owned())?;
        let seconds = required_u64(item, "interval", "QQ Music search item")?;
        tracks.push(OnlineTrack {
            provider: "qq".into(),
            id: scalar_string(id_value, "QQ Music song id")?,
            title: required_str(item, "title", "QQ Music search item")?.to_owned(),
            artists,
            album: album.to_owned(),
            duration_ms: seconds
                .checked_mul(1000)
                .ok_or_else(|| "invalid QQ Music track duration".to_owned())?,
            mid: optional_scalar_string(item, "mid")?,
            hash: None,
        });
    }
    let total = data
        .get("meta")
        .and_then(Value::as_object)
        .and_then(|meta| optional_u64(&Value::Object(meta.clone()), "sum"));
    Ok(OnlineSearchPage {
        tracks: tracks.clone(),
        page,
        has_more: total.map_or(tracks.len() == PAGE_SIZE, |total| {
            offset + (tracks.len() as u64) < total
        }),
    })
}

fn decrypt_channel(
    response: &Value,
    value_key: &str,
    qrc_time_key: &str,
    lrc_time_key: &str,
) -> Result<Option<super::LyricChannel>, String> {
    let Some(encrypted) = optional_scalar_string(response, value_key)? else {
        return Ok(None);
    };
    let timestamp = optional_i64(response, qrc_time_key)
        .filter(|value| *value != 0)
        .or_else(|| optional_i64(response, lrc_time_key).filter(|value| *value != 0));
    if timestamp.is_none() {
        return Err(format!("invalid QQ Music {value_key} lyric timestamp"));
    }
    let decrypted = qrc_decrypt_hex(&encrypted)?;
    detect_channel(decrypted).map(Some)
}

fn search_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let group = (now % 20) as u128;
    let low = now % 4_194_304;
    let within_day = now % 86_400_000;
    (group * 18_014_398_509_481_984 + low * 4_294_967_296 + within_day).to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{QqState, apply_session_response, parse_search_response};

    #[test]
    fn qq_session_sets_inited_after_success() {
        let mut state = QqState {
            comm: json!({"udid": "0"}).as_object().unwrap().clone(),
            inited: false,
        };
        apply_session_response(
            &mut state,
            &json!({"session": {"uid": "1", "sid": "2", "userip": "127.0.0.1"}}),
        )
        .unwrap();
        assert!(state.inited);
        assert_eq!(state.comm.get("sid").and_then(|v| v.as_str()), Some("2"));
    }

    #[test]
    fn qq_search_response_and_invalid_shape() {
        let data = json!({
            "body": {"item_song": [{
                "id": 7,
                "mid": "mid",
                "title": "Title",
                "singer": [{"name": "Artist"}],
                "album": {"name": "Album"},
                "interval": 30
            }]},
            "meta": {"sum": 1}
        });
        let page = parse_search_response(&data, 1, 0).unwrap();
        assert_eq!(page.tracks[0].duration_ms, 30_000);
        assert!(!page.has_more);
        assert!(parse_search_response(&json!({}), 1, 0).is_err());
    }
}
