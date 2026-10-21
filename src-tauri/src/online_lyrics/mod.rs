// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC online lyric providers.

mod crypto;
mod http;
mod kugou;
mod lrclib;
mod netease;
mod qq;
mod types;

use std::sync::{Arc, Mutex};
use std::{fmt, time::Duration};

pub use types::{
    LyricCandidate, LyricChannel, LyricFormat, OnlineLyrics, OnlineSearchPage, OnlineTrack,
};
use types::{Provider, validate_candidate, validate_search, validate_track};

const SEARCH_TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
const FETCH_TOTAL_TIMEOUT: Duration = Duration::from_secs(32);
const MAX_CHANNEL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OnlineLyricsError {
    InvalidInput(String),
    Timeout(&'static str),
    Provider(String),
}

impl fmt::Display for OnlineLyricsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::Provider(message) => formatter.write_str(message),
            Self::Timeout(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for OnlineLyricsError {}

#[derive(Default)]
pub struct OnlineLyricsService {
    netease: Mutex<Option<Arc<netease::NetEaseProvider>>>,
    qq: Mutex<Option<Arc<qq::QqProvider>>>,
    kugou: Mutex<Option<Arc<kugou::KugouProvider>>>,
    lrclib: Mutex<Option<Arc<lrclib::LrclibProvider>>>,
}

impl OnlineLyricsService {
    /// Search one known source with input validation and the shared 20-second ceiling.
    pub async fn search(
        &self,
        provider: String,
        query: String,
        page: u32,
    ) -> Result<OnlineSearchPage, OnlineLyricsError> {
        let provider = Provider::parse(&provider).map_err(OnlineLyricsError::InvalidInput)?;
        let query = validate_search(&query, page).map_err(OnlineLyricsError::InvalidInput)?;
        tokio::time::timeout(
            SEARCH_TOTAL_TIMEOUT,
            self.search_provider(provider, &query, page),
        )
        .await
        .map_err(|_| OnlineLyricsError::Timeout("online lyric search timed out"))?
        .map_err(OnlineLyricsError::Provider)
    }

    /// Fetch one known source's lyric bundle with the shared 32-second ceiling.
    pub async fn fetch(
        &self,
        track: OnlineTrack,
        candidate: Option<LyricCandidate>,
    ) -> Result<OnlineLyrics, OnlineLyricsError> {
        let provider = Provider::parse(&track.provider).map_err(OnlineLyricsError::InvalidInput)?;
        validate_track(&track).map_err(OnlineLyricsError::InvalidInput)?;
        match (provider, candidate.as_ref()) {
            (Provider::Kugou, Some(candidate)) => {
                validate_candidate(candidate).map_err(OnlineLyricsError::InvalidInput)?;
            }
            (Provider::Kugou, None) => {}
            (_, Some(_)) => {
                return Err(OnlineLyricsError::InvalidInput(
                    "lyric candidate selection is only supported by Kugou".into(),
                ));
            }
            (_, None) => {}
        }
        tokio::time::timeout(
            FETCH_TOTAL_TIMEOUT,
            self.fetch_provider(provider, &track, candidate.as_ref()),
        )
        .await
        .map_err(|_| OnlineLyricsError::Timeout("online lyric fetch timed out"))?
        .map_err(OnlineLyricsError::Provider)
    }

    async fn search_provider(
        &self,
        provider: Provider,
        query: &str,
        page: u32,
    ) -> Result<OnlineSearchPage, String> {
        match provider {
            Provider::Netease => self.netease_provider()?.search(query, page).await,
            Provider::Qq => self.qq_provider()?.search(query, page).await,
            Provider::Kugou => self.kugou_provider()?.search(query, page).await,
            Provider::Lrclib => self.lrclib_provider()?.search(query, page).await,
        }
    }

    async fn fetch_provider(
        &self,
        provider: Provider,
        track: &OnlineTrack,
        candidate: Option<&LyricCandidate>,
    ) -> Result<OnlineLyrics, String> {
        match provider {
            Provider::Netease => self.netease_provider()?.fetch(track).await,
            Provider::Qq => self.qq_provider()?.fetch(track).await,
            Provider::Kugou => self.kugou_provider()?.fetch(track, candidate).await,
            Provider::Lrclib => self.lrclib_provider()?.fetch(track).await,
        }
    }

    fn netease_provider(&self) -> Result<Arc<netease::NetEaseProvider>, String> {
        let mut slot = self
            .netease
            .lock()
            .map_err(|_| "NetEase provider state is unavailable".to_owned())?;
        if let Some(provider) = slot.as_ref() {
            return Ok(Arc::clone(provider));
        }
        let provider = Arc::new(netease::NetEaseProvider::new()?);
        *slot = Some(Arc::clone(&provider));
        Ok(provider)
    }

    fn qq_provider(&self) -> Result<Arc<qq::QqProvider>, String> {
        let mut slot = self
            .qq
            .lock()
            .map_err(|_| "QQ Music provider state is unavailable".to_owned())?;
        if let Some(provider) = slot.as_ref() {
            return Ok(Arc::clone(provider));
        }
        let provider = Arc::new(qq::QqProvider::new()?);
        *slot = Some(Arc::clone(&provider));
        Ok(provider)
    }

    fn kugou_provider(&self) -> Result<Arc<kugou::KugouProvider>, String> {
        let mut slot = self
            .kugou
            .lock()
            .map_err(|_| "Kugou provider state is unavailable".to_owned())?;
        if let Some(provider) = slot.as_ref() {
            return Ok(Arc::clone(provider));
        }
        let provider = Arc::new(kugou::KugouProvider::new()?);
        *slot = Some(Arc::clone(&provider));
        Ok(provider)
    }

    fn lrclib_provider(&self) -> Result<Arc<lrclib::LrclibProvider>, String> {
        let mut slot = self
            .lrclib
            .lock()
            .map_err(|_| "LRCLIB provider state is unavailable".to_owned())?;
        if let Some(provider) = slot.as_ref() {
            return Ok(Arc::clone(provider));
        }
        let provider = Arc::new(lrclib::LrclibProvider::new()?);
        *slot = Some(Arc::clone(&provider));
        Ok(provider)
    }
}

pub(crate) fn detect_channel(content: String) -> Result<LyricChannel, String> {
    if content.trim().is_empty() {
        return Err("lyric channel is empty".into());
    }
    if content.len() > MAX_CHANNEL_BYTES {
        return Err("lyric channel exceeds the configured size limit".into());
    }
    let format = if content.contains("<Lyric_1") && content.contains("LyricContent=") {
        LyricFormat::Qrc
    } else if content.lines().any(is_yrc_line) {
        LyricFormat::Yrc
    } else if content.lines().any(is_lrc_line) {
        LyricFormat::Lrc
    } else {
        LyricFormat::Plain
    };
    Ok(LyricChannel { format, content })
}

fn is_yrc_line(line: &str) -> bool {
    let line = line.trim_start();
    if !line.starts_with('[') {
        return false;
    }
    let Some(end) = line.find(']') else {
        return false;
    };
    let header = &line[1..end];
    header.contains(',')
        && header
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b',')
        && line[end + 1..].starts_with('(')
}

fn is_lrc_line(line: &str) -> bool {
    let line = line.trim_start();
    if !line.starts_with('[') {
        return false;
    }
    let Some(end) = line.find(']') else {
        return false;
    };
    let timestamp = &line[1..end];
    timestamp.contains(':') && timestamp.bytes().any(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::{LyricFormat, detect_channel};

    #[test]
    fn channel_detection_keeps_formats_distinct() {
        assert_eq!(
            detect_channel(r#"<Lyric_1 LyricType="1" LyricContent="x"/>"#.into())
                .unwrap()
                .format,
            LyricFormat::Qrc
        );
        assert_eq!(
            detect_channel("[1000,1000](1000,500,0)word".into())
                .unwrap()
                .format,
            LyricFormat::Yrc
        );
        assert_eq!(
            detect_channel("[00:01.00]word".into()).unwrap().format,
            LyricFormat::Lrc
        );
        assert_eq!(
            detect_channel("plain lyric".into()).unwrap().format,
            LyricFormat::Plain
        );
        assert_eq!(
            detect_channel("][".into()).unwrap().format,
            LyricFormat::Plain
        );
        assert_eq!(
            detect_channel("[é](0,0,0)x".into()).unwrap().format,
            LyricFormat::Plain
        );
        assert!(detect_channel("   ".into()).is_err());
    }
}
