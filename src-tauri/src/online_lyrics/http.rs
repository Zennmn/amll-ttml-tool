// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC provider implementation.

use std::time::Duration;

use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{Map, Value};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_LYRIC_BYTES: usize = 8 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 3;

pub(crate) struct LimitedResponse {
    pub body: Vec<u8>,
    pub headers: reqwest::header::HeaderMap,
}

pub(crate) fn build_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to create HTTP client: {error}"))
}

pub(crate) async fn send_with_retry<F>(
    provider: &str,
    max_body_bytes: usize,
    mut request: F,
) -> Result<LimitedResponse, String>
where
    F: FnMut() -> RequestBuilder,
{
    let mut last_error = None;
    for attempt in 0..MAX_ATTEMPTS {
        match request().send().await {
            Ok(response) if response.status().is_success() => {
                let headers = response.headers().clone();
                let body = read_limited(response, max_body_bytes).await?;
                return Ok(LimitedResponse { body, headers });
            }
            Ok(response) => {
                let status = response.status();
                let error = format!("{provider} request failed with HTTP {status}");
                if !retryable_status(status) || attempt + 1 == MAX_ATTEMPTS {
                    return Err(error);
                }
                last_error = Some(error);
            }
            Err(error) => {
                let error = format!("{provider} request failed: {error}");
                if attempt + 1 == MAX_ATTEMPTS {
                    return Err(error);
                }
                last_error = Some(error);
            }
        }

        tokio::time::sleep(Duration::from_millis(200 * (attempt as u64 + 1))).await;
    }

    Err(last_error.unwrap_or_else(|| format!("{provider} request failed")))
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("response exceeds the configured size limit".into());
    }

    let initial = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0)
        .min(limit);
    let mut body = Vec::with_capacity(initial);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("failed to read response body: {error}"))?
    {
        extend_bounded(&mut body, &chunk, limit)?;
    }
    Ok(body)
}

pub(crate) fn extend_bounded(
    target: &mut Vec<u8>,
    bytes: &[u8],
    limit: usize,
) -> Result<(), String> {
    let new_length = target
        .len()
        .checked_add(bytes.len())
        .ok_or_else(|| "response size overflow".to_owned())?;
    if new_length > limit {
        return Err("response exceeds the configured size limit".into());
    }
    target.extend_from_slice(bytes);
    Ok(())
}

pub(crate) fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_EARLY
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub(crate) fn parse_json(body: &[u8], provider: &str) -> Result<Value, String> {
    serde_json::from_slice(body)
        .map_err(|error| format!("invalid {provider} JSON response: {error}"))
}

pub(crate) fn object<'a>(
    value: &'a Value,
    context: &str,
) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("invalid {context}: expected an object"))
}

pub(crate) fn required_object<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a Map<String, Value>, String> {
    let object = object(value, context)?;
    object
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("invalid {context}: missing object field {key}"))
}

pub(crate) fn required_array<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a [Value], String> {
    let object = object(value, context)?;
    object
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("invalid {context}: missing array field {key}"))
}

pub(crate) fn required_str<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a str, String> {
    let object = object(value, context)?;
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("invalid {context}: missing string field {key}"))
}

pub(crate) fn scalar_string(value: &Value, context: &str) -> Result<String, String> {
    match value {
        Value::String(text) if !text.is_empty() => Ok(text.clone()),
        Value::Number(number) => Ok(number.to_string()),
        _ => Err(format!(
            "invalid {context}: expected a non-empty string or number"
        )),
    }
}

pub(crate) fn optional_scalar_string(value: &Value, key: &str) -> Result<Option<String>, String> {
    let object = object(value, "response")?;
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.is_empty() => Ok(None),
        Some(item @ (Value::String(_) | Value::Number(_))) => scalar_string(item, key).map(Some),
        Some(_) => Err(format!("invalid response: field {key} has an invalid type")),
    }
}

pub(crate) fn required_u64(value: &Value, key: &str, context: &str) -> Result<u64, String> {
    let object = object(value, context)?;
    let item = object
        .get(key)
        .ok_or_else(|| format!("invalid {context}: missing number field {key}"))?;
    optional_u64_value(item)
        .ok_or_else(|| format!("invalid {context}: field {key} is not a number"))
}

pub(crate) fn optional_u64(value: &Value, key: &str) -> Option<u64> {
    value.as_object()?.get(key).and_then(optional_u64_value)
}

pub(crate) fn optional_i64(value: &Value, key: &str) -> Option<i64> {
    let item = value.as_object()?.get(key)?;
    item.as_i64()
        .or_else(|| item.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
}

pub(crate) fn optional_u64_value(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::{extend_bounded, retryable_status};
    use reqwest::StatusCode;

    #[test]
    fn response_limit_rejects_overflow_without_partial_growth() {
        let mut body = Vec::new();
        assert!(extend_bounded(&mut body, b"1234", 4).is_ok());
        assert!(extend_bounded(&mut body, b"5", 4).is_err());
        assert_eq!(body, b"1234");
    }

    #[test]
    fn only_transient_http_errors_are_retried() {
        assert!(retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(StatusCode::BAD_GATEWAY));
        assert!(!retryable_status(StatusCode::BAD_REQUEST));
        assert!(!retryable_status(StatusCode::UNAUTHORIZED));
    }
}
