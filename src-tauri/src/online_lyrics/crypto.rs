// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Adapted for AMLL from the GPL-3.0-only LDDC decryptor implementation.

use std::io::{Cursor, Read};

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, generic_array::GenericArray};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use flate2::read::ZlibDecoder;
use md5::{Digest as _, Md5};
use serde_json::Value;

use super::http::MAX_LYRIC_BYTES;

#[path = "qrc_des.rs"]
mod qrc_des;

const QRC_KEY: &[u8; 24] = b"!@#)(*$%123ZXC!@!@#)(NHL";
const KRC_KEY: &[u8] = b"@Gaw^2tGQ61-\xce\xd2ni";
const EAPI_KEY: &[u8; 16] = b"e82ckenh8dichen8";
const DEVICEID_XOR_KEY: &[u8] = b"3go8&$8*3*3h0k(2)2";

pub(crate) fn qrc_decrypt_hex(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("encrypted QRC data is empty".into());
    }
    if input.len() > MAX_LYRIC_BYTES * 2 {
        return Err("encrypted QRC data is too large".into());
    }
    let encrypted =
        hex::decode(input).map_err(|_| "encrypted QRC data is not valid hex".to_owned())?;
    qrc_decrypt(&encrypted)
}

pub(crate) fn qrc_decrypt(encrypted: &[u8]) -> Result<String, String> {
    if encrypted.is_empty() {
        return Err("encrypted QRC data is empty".into());
    }
    if encrypted.len() > MAX_LYRIC_BYTES {
        return Err("encrypted QRC data is too large".into());
    }
    if encrypted.len() % 8 != 0 {
        return Err("encrypted QRC data has an invalid block length".into());
    }

    let mut decrypted = encrypted.to_vec();
    triple_des_decrypt_blocks(&mut decrypted, QRC_KEY)?;
    let text = decompress_zlib_limited(&decrypted, MAX_LYRIC_BYTES)?;
    String::from_utf8(text).map_err(|_| "decrypted QRC data is not UTF-8".into())
}

pub(crate) fn krc_decrypt(encrypted: &[u8]) -> Result<String, String> {
    if encrypted.len() <= 4 {
        return Err("encrypted KRC data is truncated".into());
    }
    if encrypted.len() > MAX_LYRIC_BYTES {
        return Err("encrypted KRC data is too large".into());
    }
    if &encrypted[..4] != b"krc1" {
        return Err("encrypted KRC data has an invalid header".into());
    }

    let mut decrypted = Vec::with_capacity(encrypted.len() - 4);
    for (index, byte) in encrypted[4..].iter().enumerate() {
        decrypted.push(byte ^ KRC_KEY[index % KRC_KEY.len()]);
    }
    let text = decompress_zlib_limited(&decrypted, MAX_LYRIC_BYTES)?;
    String::from_utf8(text).map_err(|_| "decrypted KRC data is not UTF-8".into())
}

pub(crate) fn decompress_zlib_limited(input: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    if input.is_empty() {
        return Err("compressed lyric data is empty".into());
    }
    let decoder = ZlibDecoder::new(Cursor::new(input));
    let mut reader = decoder.take(limit as u64 + 1);
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    reader
        .read_to_end(&mut output)
        .map_err(|error| format!("lyric decompression failed: {error}"))?;
    if output.len() > limit {
        return Err("decompressed lyric data exceeds the configured size limit".into());
    }
    Ok(output)
}

pub(crate) fn eapi_params_encrypt(path: &str, params: &Value) -> Result<String, String> {
    let params = serde_json::to_vec(params)
        .map_err(|error| format!("failed to serialize EAPI parameters: {error}"))?;
    let path = path.as_bytes();
    let sign_source = [
        b"nobody".as_slice(),
        path,
        b"use",
        &params,
        b"md5forencrypt",
    ]
    .concat();
    let sign = md5_hex(&sign_source);

    let mut plain = Vec::with_capacity(path.len() + params.len() + sign.len() + 40);
    plain.extend_from_slice(path);
    plain.extend_from_slice(b"-36cd479b6b5-");
    plain.extend_from_slice(&params);
    plain.extend_from_slice(b"-36cd479b6b5-");
    plain.extend_from_slice(sign.as_bytes());

    let encrypted = aes_ecb_encrypt(&plain, EAPI_KEY)?;
    Ok(format!("params={}", hex::encode_upper(encrypted)))
}

pub(crate) fn eapi_response_decrypt(input: &[u8]) -> Result<Value, String> {
    let decrypted = aes_ecb_decrypt(input, EAPI_KEY)?;
    serde_json::from_slice(&decrypted)
        .map_err(|error| format!("invalid decrypted EAPI response: {error}"))
}

pub(crate) fn anonymous_username(device_id: &str) -> String {
    let xored: Vec<u8> = device_id
        .as_bytes()
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ DEVICEID_XOR_KEY[index % DEVICEID_XOR_KEY.len()])
        .collect();
    let digest = Md5::digest(xored);
    let combined = format!("{device_id} {}", BASE64.encode(digest));
    BASE64.encode(combined)
}

pub(crate) fn md5_hex(input: &[u8]) -> String {
    hex::encode(Md5::digest(input))
}

fn aes_ecb_encrypt(input: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    let cipher =
        aes::Aes128::new_from_slice(key).map_err(|_| "invalid AES key length".to_owned())?;
    let padding = 16 - input.len() % 16;
    let mut output = Vec::with_capacity(input.len() + padding);
    output.extend_from_slice(input);
    output.extend(std::iter::repeat_n(padding as u8, padding));
    for block in output.chunks_exact_mut(16) {
        cipher.encrypt_block(GenericArray::from_mut_slice(block));
    }
    Ok(output)
}

fn aes_ecb_decrypt(input: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    if input.is_empty() || input.len() % 16 != 0 {
        return Err("encrypted AES data has an invalid length".into());
    }
    let cipher =
        aes::Aes128::new_from_slice(key).map_err(|_| "invalid AES key length".to_owned())?;
    let mut output = input.to_vec();
    for block in output.chunks_exact_mut(16) {
        cipher.decrypt_block(GenericArray::from_mut_slice(block));
    }
    let padding = *output
        .last()
        .ok_or_else(|| "encrypted AES data is empty".to_owned())? as usize;
    if !(1..=16).contains(&padding)
        || output.len() < padding
        || !output[output.len() - padding..]
            .iter()
            .all(|byte| *byte as usize == padding)
    {
        return Err("encrypted AES data has invalid padding".into());
    }
    output.truncate(output.len() - padding);
    Ok(output)
}

fn triple_des_decrypt_blocks(input: &mut [u8], key: &[u8]) -> Result<(), String> {
    qrc_des::triple_des_decrypt(input, key)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use serde_json::json;

    use super::{
        EAPI_KEY, KRC_KEY, aes_ecb_decrypt, aes_ecb_encrypt, decompress_zlib_limited,
        eapi_params_encrypt, krc_decrypt, qrc_decrypt_hex,
    };

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    fn encrypted_krc(content: &str) -> Vec<u8> {
        let mut output = b"krc1".to_vec();
        let compressed = zlib(content.as_bytes());
        output.extend(
            compressed
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ KRC_KEY[index % KRC_KEY.len()]),
        );
        output
    }

    #[test]
    fn qrc_matches_lddc_known_vector_and_invalid_inputs() {
        let encrypted = concat!(
            "c90db2e3f6940a43538b45865eb67538",
            "63c981f936a71a093b450246d48b65f0",
            "0e18c3f4862a65a8aa854f1a2b265927",
            "00f097b8bf445fd3ecff96ec57fdc8b8"
        );
        assert_eq!(
            qrc_decrypt_hex(encrypted).unwrap(),
            r#"<Lyric_1 LyricType="1" LyricContent="[1000,2000]test(1000,2000)"/>"#
        );
        let multi_block = "b7b4c752fc237fa7be5f5a179eaf7b294b9b671742af6254e33057f585871d76a2eb4ee34435dd65f8d99fc33bacb1253dcd5c82e638f663ccdbe85a09e6dcec68287557a83057c3318b7dc8663e3e8de3df2152a61cfb1f7dd9aacb5c4c642a144d2444f0d8d50910a97c8254f1cd7be33b97b6d0df92646ad6b70c351afef819391da49877eefea37c0af7954d3fb72b2f6ba7b1b13b7663142d9770c374d40e258948a2f2f8e3d535c8f7ae38a1295740b7930e6400d54bcca9cbe2a18fabf0047efc248cf8adf0b05cdf1e71aeaa1cafd1bbbddeaaf4ababae0c171d2c7f";
        let expected = (0..32)
            .map(|line| format!("[{},{}]line {line}", line * 1000, line * 1000 + 800))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(qrc_decrypt_hex(multi_block).unwrap(), expected);
        assert!(qrc_decrypt_hex("").is_err());
        assert!(qrc_decrypt_hex("zz").is_err());
        assert!(qrc_decrypt_hex("00").is_err());
    }

    #[test]
    fn krc_round_trip_and_invalid_header() {
        let plain = "[ti:test]\n[1000,1000]<0,1000,0>text";
        assert_eq!(krc_decrypt(&encrypted_krc(plain)).unwrap(), plain);
        assert!(krc_decrypt(b"bad!").is_err());
        assert!(krc_decrypt(b"krc1").is_err());
    }

    #[test]
    fn decompression_limit_and_corruption_are_errors() {
        let compressed = zlib(b"0123456789");
        assert!(decompress_zlib_limited(&compressed, 9).is_err());
        assert_eq!(
            decompress_zlib_limited(&compressed, 10).unwrap(),
            b"0123456789"
        );
        assert!(decompress_zlib_limited(b"not zlib", 1024).is_err());
    }

    #[test]
    fn eapi_aes_and_padding_are_checked() {
        let plain = b"some padded text";
        let encrypted = aes_ecb_encrypt(plain, EAPI_KEY).unwrap();
        assert_eq!(aes_ecb_decrypt(&encrypted, EAPI_KEY).unwrap(), plain);
        assert!(aes_ecb_decrypt(&encrypted[..15], EAPI_KEY).is_err());
        let mut broken = encrypted;
        let last = broken.len() - 1;
        broken[last] ^= 1;
        assert!(aes_ecb_decrypt(&broken, EAPI_KEY).is_err());
    }

    #[test]
    fn eapi_request_payload_is_fixed_shape() {
        let encrypted = eapi_params_encrypt("/api/song/lyric/v1", &json!({"id": 1})).unwrap();
        assert!(encrypted.starts_with("params="));
        assert!(encrypted[7..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
