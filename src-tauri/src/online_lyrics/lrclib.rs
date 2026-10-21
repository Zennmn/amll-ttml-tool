// SPDX-License-Identifier: GPL-3.0-only

use reqwest::header::USER_AGENT;
use serde_json::Value;

use super::{
    LyricChannel, LyricFormat, OnlineLyrics, OnlineSearchPage, OnlineTrack, detect_channel,
    http::{self, MAX_JSON_BYTES, MAX_LYRIC_BYTES},
    types::validate_track,
};

const SEARCH_URL: &str = "https://lrclib.net/api/search";
const GET_URL: &str = "https://lrclib.net/api/get";
const PAGE_SIZE: usize = 20;
const USER_AGENT_VALUE: &str = "amll-lyrics-service/1";

pub(crate) struct LrclibProvider {
    client: reqwest::Client,
}

impl LrclibProvider {
    pub(crate) fn new() -> Result<Self, String> {
        Ok(Self {
            client: http::build_client()?,
        })
    }

    pub(crate) async fn search(&self, query: &str, page: u32) -> Result<OnlineSearchPage, String> {
        let response = http::send_with_retry("LRCLIB", MAX_JSON_BYTES, || {
            self.client
                .get(SEARCH_URL)
                .query(&[("q", query)])
                .header(USER_AGENT, USER_AGENT_VALUE)
        })
        .await?;
        let value = http::parse_json(&response.body, "LRCLIB")?;
        parse_search_response(&value, page)
    }

    pub(crate) async fn fetch(&self, track: &OnlineTrack) -> Result<OnlineLyrics, String> {
        let id = track
            .id
            .parse::<u64>()
            .map_err(|_| "LRCLIB track id must be numeric".to_owned())?;
        let url = format!("{GET_URL}/{id}");
        let response = http::send_with_retry("LRCLIB", MAX_LYRIC_BYTES, || {
            self.client.get(&url).header(USER_AGENT, USER_AGENT_VALUE)
        })
        .await?;
        let value = http::parse_json(&response.body, "LRCLIB")?;
        parse_fetch_response(&value)
    }
}

fn parse_search_response(value: &Value, page: u32) -> Result<OnlineSearchPage, String> {
    let values = value
        .as_array()
        .ok_or_else(|| "invalid LRCLIB search response: expected an array".to_owned())?;
    let start = usize::try_from(page)
        .ok()
        .and_then(|page| page.checked_sub(1))
        .and_then(|page| page.checked_mul(PAGE_SIZE))
        .ok_or_else(|| "LRCLIB search page is invalid".to_owned())?;
    let tracks = values
        .iter()
        .skip(start)
        .take(PAGE_SIZE)
        .map(parse_search_track)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(OnlineSearchPage {
        has_more: start.saturating_add(PAGE_SIZE) < values.len(),
        tracks,
        page,
    })
}

fn parse_search_track(value: &Value) -> Result<OnlineTrack, String> {
    let object = http::object(value, "LRCLIB search result")?;
    let id = object
        .get("id")
        .and_then(http::optional_u64_value)
        .ok_or_else(|| "invalid LRCLIB search result: missing numeric id".to_owned())?;
    let title = object
        .get("trackName")
        .filter(|value| value.as_str().is_some_and(|text| !text.trim().is_empty()))
        .or_else(|| object.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "invalid LRCLIB search result: missing track name".to_owned())?;
    let artist = object
        .get("artistName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "invalid LRCLIB search result: missing artist name".to_owned())?;
    let album = object
        .get("albumName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let duration_ms = parse_duration_ms(object.get("duration"))?;
    let track = OnlineTrack {
        provider: "lrclib".into(),
        id: id.to_string(),
        title: title.into(),
        artists: vec![artist.into()],
        album: album.into(),
        duration_ms,
        mid: None,
        hash: None,
    };
    validate_track(&track)?;
    Ok(track)
}

fn parse_duration_ms(value: Option<&Value>) -> Result<u64, String> {
    let seconds = value
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .ok_or_else(|| "invalid LRCLIB search result: missing duration".to_owned())?;
    let milliseconds = (seconds * 1000.0).round();
    if milliseconds > u64::MAX as f64 {
        return Err("invalid LRCLIB search result: duration is too large".into());
    }
    Ok(milliseconds as u64)
}

fn parse_fetch_response(value: &Value) -> Result<OnlineLyrics, String> {
    let object = http::object(value, "LRCLIB lyric response")?;
    let synced = object
        .get("syncedLyrics")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty());
    let plain = object
        .get("plainLyrics")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty());
    let original = if let Some(synced) = synced {
        detect_channel(synced.to_owned())?
    } else if let Some(plain) = plain {
        LyricChannel {
            format: LyricFormat::Plain,
            content: plain.to_owned(),
        }
    } else {
        return Err("LRCLIB returned no lyric channel".into());
    };

    Ok(OnlineLyrics {
        original,
        translation: None,
        romanization: None,
        original_lrc: None,
        candidates: None,
        selected_candidate_id: None,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_fetch_response, parse_search_response};
    use crate::online_lyrics::LyricFormat;

    fn result(id: u64) -> serde_json::Value {
        json!({
            "id": id,
            "trackName": format!("Track {id}"),
            "artistName": "Artist",
            "albumName": "Album",
            "duration": 213.5
        })
    }

    #[test]
    fn search_is_paged_in_twenty_track_slices() {
        let values = serde_json::Value::Array((0..45).map(result).collect());
        let first = parse_search_response(&values, 1).unwrap();
        let last = parse_search_response(&values, 3).unwrap();
        assert_eq!(first.tracks.len(), 20);
        assert_eq!(first.tracks[0].duration_ms, 213_500);
        assert!(first.has_more);
        assert_eq!(last.tracks.len(), 5);
        assert!(!last.has_more);
    }

    #[test]
    fn synced_lyrics_take_precedence_over_plain_text() {
        let value = json!({
            "syncedLyrics": "[00:01.00]timed",
            "plainLyrics": "plain"
        });
        let lyrics = parse_fetch_response(&value).unwrap();
        assert_eq!(lyrics.original.format, LyricFormat::Lrc);
        assert_eq!(lyrics.original.content, "[00:01.00]timed");
    }

    #[test]
    fn empty_fetch_result_is_an_error() {
        assert!(parse_fetch_response(&json!({ "syncedLyrics": null })).is_err());
    }
}
