// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC provider implementation.

use serde::{Deserialize, Serialize};

const MAX_QUERY_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 512;
const MAX_ID_BYTES: usize = 128;
const MAX_TRACK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Provider {
    Netease,
    Qq,
    Kugou,
    Lrclib,
}

impl Provider {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "netease" => Ok(Self::Netease),
            "qq" => Ok(Self::Qq),
            "kugou" => Ok(Self::Kugou),
            "lrclib" => Ok(Self::Lrclib),
            _ => Err(format!("unsupported lyric provider: {value}")),
        }
    }
}

/// Provider identifiers stay attached until the raw lyric channels are fetched.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineTrack {
    pub provider: String,
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSearchPage {
    pub tracks: Vec<OnlineTrack>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LyricCandidate {
    pub id: String,
    pub access_key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LyricFormat {
    Lrc,
    Qrc,
    Yrc,
    Krc,
    Plain,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LyricChannel {
    pub format: LyricFormat,
    pub content: String,
}

/// Channels remain separate so equal timestamps do not imply translation.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineLyrics {
    pub original: LyricChannel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<LyricChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub romanization: Option<LyricChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_lrc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<LyricCandidate>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_candidate_id: Option<String>,
}

pub(crate) fn validate_search(query: &str, page: u32) -> Result<String, String> {
    let query = query.trim();
    let chars = query.chars().count();
    if !(1..=MAX_QUERY_CHARS).contains(&chars) {
        return Err(format!(
            "query must contain 1 to {MAX_QUERY_CHARS} characters"
        ));
    }
    if query.chars().any(char::is_control) {
        return Err("query contains control characters".into());
    }
    if !(1..=100).contains(&page) {
        return Err("page must be between 1 and 100".into());
    }
    Ok(query.to_owned())
}

pub(crate) fn validate_track(track: &OnlineTrack) -> Result<(), String> {
    if track.id.is_empty()
        || track.id.len() > MAX_ID_BYTES
        || !track.id.chars().all(is_safe_id_char)
    {
        return Err("track id is invalid".into());
    }
    if track.title.trim().is_empty()
        || track.title.chars().count() > MAX_TEXT_CHARS
        || track.title.chars().any(char::is_control)
    {
        return Err("track title is invalid".into());
    }
    if track.album.chars().count() > MAX_TEXT_CHARS || track.album.chars().any(char::is_control) {
        return Err("track metadata is invalid".into());
    }
    if track.artists.len() > 32
        || track.artists.iter().any(|artist| {
            artist.chars().count() > MAX_TEXT_CHARS || artist.chars().any(char::is_control)
        })
    {
        return Err("track artists are invalid".into());
    }
    if track.duration_ms == 0 || track.duration_ms > MAX_TRACK_MS {
        return Err("track duration is invalid".into());
    }
    if let Some(mid) = &track.mid {
        if mid.len() > MAX_ID_BYTES || !mid.chars().all(is_safe_id_char) {
            return Err("track mid is invalid".into());
        }
    }
    if let Some(hash) = &track.hash {
        if hash.is_empty()
            || hash.len() > MAX_ID_BYTES
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("track hash is invalid".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_candidate(candidate: &LyricCandidate) -> Result<(), String> {
    if candidate.id.is_empty()
        || candidate.id.len() > MAX_ID_BYTES
        || !candidate.id.chars().all(is_safe_id_char)
    {
        return Err("lyric candidate id is invalid".into());
    }
    if candidate.access_key.is_empty()
        || candidate.access_key.len() > 1024
        || candidate.access_key.chars().any(char::is_control)
    {
        return Err("lyric candidate access key is invalid".into());
    }
    if candidate.label.trim().is_empty()
        || candidate.label.chars().count() > MAX_TEXT_CHARS
        || candidate.label.chars().any(char::is_control)
    {
        return Err("lyric candidate label is invalid".into());
    }
    if candidate
        .duration_ms
        .is_some_and(|duration| duration > MAX_TRACK_MS)
    {
        return Err("lyric candidate duration is invalid".into());
    }
    Ok(())
}

fn is_safe_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':')
}

#[cfg(test)]
mod tests {
    use super::{OnlineTrack, Provider, validate_search, validate_track};

    fn track() -> OnlineTrack {
        OnlineTrack {
            provider: "netease".into(),
            id: "123".into(),
            title: "Song".into(),
            artists: vec!["Artist".into()],
            album: "Album".into(),
            duration_ms: 200_000,
            mid: None,
            hash: None,
        }
    }

    #[test]
    fn search_input_is_bounded() {
        assert!(validate_search("song", 1).is_ok());
        assert!(validate_search("   ", 1).is_err());
        assert!(validate_search(&"a".repeat(201), 1).is_err());
        assert!(validate_search("song", 0).is_err());
        assert!(validate_search("song", 101).is_err());
        assert!(validate_search("line\nbreak", 1).is_err());
    }

    #[test]
    fn track_input_rejects_invalid_ids_and_metadata() {
        assert!(validate_track(&track()).is_ok());
        let mut invalid = track();
        invalid.id = "1/../../x".into();
        assert!(validate_track(&invalid).is_err());
        let mut invalid = track();
        invalid.title.clear();
        assert!(validate_track(&invalid).is_err());
    }

    #[test]
    fn all_shared_providers_are_recognized() {
        for provider in ["netease", "qq", "kugou", "lrclib"] {
            assert!(Provider::parse(provider).is_ok());
        }
        assert!(Provider::parse("unknown").is_err());
    }
}
