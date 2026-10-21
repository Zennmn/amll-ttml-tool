// SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
// SPDX-License-Identifier: GPL-3.0-only
// Direct Rust adaptation of LDDC's GPL-3.0-only TripleDES implementation.
// Upstream: https://github.com/chenmozhijin/LDDC

const SBOX: [[u8; 64]; 8] = [
    [
        14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12,
        11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9,
        1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
    ],
    [
        15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1,
        10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15,
        4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
    ],
    [
        10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5,
        14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6,
        9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
    ],
    [
        7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2,
        12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10,
        10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
    ],
    [
        2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15,
        10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14,
        2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
    ],
    [
        12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13,
        14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5,
        15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
    ],
    [
        4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5,
        12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4,
        10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
    ],
    [
        13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6,
        11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10,
        8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
    ],
];

const IP_A: [usize; 32] = [
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63,
    55, 47, 39, 31, 23, 15, 7,
];
const IP_B: [usize; 32] = [
    56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62,
    54, 46, 38, 30, 22, 14, 6,
];
const KEY_PERM_C: [usize; 28] = [
    56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59,
    51, 43, 35,
];
const KEY_PERM_D: [usize; 28] = [
    62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4,
    27, 19, 11, 3,
];
const KEY_COMPRESSION: [usize; 48] = [
    13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51,
    30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
];
const KEY_SHIFTS: [u32; 16] = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

type RoundSchedule = [[u8; 6]; 16];

#[derive(Clone, Copy)]
enum Mode {
    Encrypt,
    Decrypt,
}

pub(crate) fn triple_des_decrypt(data: &mut [u8], key: &[u8]) -> Result<(), String> {
    if key.len() != 24 {
        return Err("LDDC TripleDES requires a 24-byte key".into());
    }
    if data.is_empty() || data.len() % 8 != 0 {
        return Err("LDDC TripleDES input has an invalid block length".into());
    }

    let schedules = [
        key_schedule(&key[16..24], Mode::Decrypt)?,
        key_schedule(&key[8..16], Mode::Encrypt)?,
        key_schedule(&key[0..8], Mode::Decrypt)?,
    ];
    for chunk in data.chunks_exact_mut(8) {
        let mut block: [u8; 8] = chunk
            .try_into()
            .map_err(|_| "invalid LDDC TripleDES block".to_owned())?;
        for schedule in &schedules {
            block = crypt(&block, schedule);
        }
        chunk.copy_from_slice(&block);
    }
    Ok(())
}

fn bitnum(bytes: &[u8], bit: usize, shift: usize) -> u32 {
    let index = (bit / 32) * 4 + 3 - (bit % 32) / 8;
    u32::from((bytes[index] >> (7 - bit % 8)) & 1) << shift
}

fn bitnum_intr(value: u32, bit: usize, shift: usize) -> u32 {
    ((value >> (31 - bit)) & 1) << shift
}

fn bitnum_intl(value: u32, bit: usize, shift: usize) -> u32 {
    ((value << bit) & 0x8000_0000) >> shift
}

fn sbox_bit(value: u8) -> usize {
    usize::from((value & 32) | ((value & 31) >> 1) | ((value & 1) << 4))
}

fn initial_permutation(input: &[u8]) -> (u32, u32) {
    let a = IP_A.iter().enumerate().fold(0, |value, (shift, bit)| {
        value | bitnum(input, *bit, 31 - shift)
    });
    let b = IP_B.iter().enumerate().fold(0, |value, (shift, bit)| {
        value | bitnum(input, *bit, 31 - shift)
    });
    (a, b)
}

fn inverse_permutation(s0: u32, s1: u32) -> [u8; 8] {
    let mut data = [0_u8; 8];
    data[3] = (bitnum_intr(s1, 7, 7)
        | bitnum_intr(s0, 7, 6)
        | bitnum_intr(s1, 15, 5)
        | bitnum_intr(s0, 15, 4)
        | bitnum_intr(s1, 23, 3)
        | bitnum_intr(s0, 23, 2)
        | bitnum_intr(s1, 31, 1)
        | bitnum_intr(s0, 31, 0)) as u8;
    data[2] = (bitnum_intr(s1, 6, 7)
        | bitnum_intr(s0, 6, 6)
        | bitnum_intr(s1, 14, 5)
        | bitnum_intr(s0, 14, 4)
        | bitnum_intr(s1, 22, 3)
        | bitnum_intr(s0, 22, 2)
        | bitnum_intr(s1, 30, 1)
        | bitnum_intr(s0, 30, 0)) as u8;
    data[1] = (bitnum_intr(s1, 5, 7)
        | bitnum_intr(s0, 5, 6)
        | bitnum_intr(s1, 13, 5)
        | bitnum_intr(s0, 13, 4)
        | bitnum_intr(s1, 21, 3)
        | bitnum_intr(s0, 21, 2)
        | bitnum_intr(s1, 29, 1)
        | bitnum_intr(s0, 29, 0)) as u8;
    data[0] = (bitnum_intr(s1, 4, 7)
        | bitnum_intr(s0, 4, 6)
        | bitnum_intr(s1, 12, 5)
        | bitnum_intr(s0, 12, 4)
        | bitnum_intr(s1, 20, 3)
        | bitnum_intr(s0, 20, 2)
        | bitnum_intr(s1, 28, 1)
        | bitnum_intr(s0, 28, 0)) as u8;
    data[7] = (bitnum_intr(s1, 3, 7)
        | bitnum_intr(s0, 3, 6)
        | bitnum_intr(s1, 11, 5)
        | bitnum_intr(s0, 11, 4)
        | bitnum_intr(s1, 19, 3)
        | bitnum_intr(s0, 19, 2)
        | bitnum_intr(s1, 27, 1)
        | bitnum_intr(s0, 27, 0)) as u8;
    data[6] = (bitnum_intr(s1, 2, 7)
        | bitnum_intr(s0, 2, 6)
        | bitnum_intr(s1, 10, 5)
        | bitnum_intr(s0, 10, 4)
        | bitnum_intr(s1, 18, 3)
        | bitnum_intr(s0, 18, 2)
        | bitnum_intr(s1, 26, 1)
        | bitnum_intr(s0, 26, 0)) as u8;
    data[5] = (bitnum_intr(s1, 1, 7)
        | bitnum_intr(s0, 1, 6)
        | bitnum_intr(s1, 9, 5)
        | bitnum_intr(s0, 9, 4)
        | bitnum_intr(s1, 17, 3)
        | bitnum_intr(s0, 17, 2)
        | bitnum_intr(s1, 25, 1)
        | bitnum_intr(s0, 25, 0)) as u8;
    data[4] = (bitnum_intr(s1, 0, 7)
        | bitnum_intr(s0, 0, 6)
        | bitnum_intr(s1, 8, 5)
        | bitnum_intr(s0, 8, 4)
        | bitnum_intr(s1, 16, 3)
        | bitnum_intr(s0, 16, 2)
        | bitnum_intr(s1, 24, 1)
        | bitnum_intr(s0, 24, 0)) as u8;
    data
}

fn f(state: u32, key: &[u8; 6]) -> u32 {
    let t1 = bitnum_intl(state, 31, 0)
        | ((state & 0xf000_0000) >> 1)
        | bitnum_intl(state, 4, 5)
        | bitnum_intl(state, 3, 6)
        | ((state & 0x0f00_0000) >> 3)
        | bitnum_intl(state, 8, 11)
        | bitnum_intl(state, 7, 12)
        | ((state & 0x00f0_0000) >> 5)
        | bitnum_intl(state, 12, 17)
        | bitnum_intl(state, 11, 18)
        | ((state & 0x000f_0000) >> 7)
        | bitnum_intl(state, 16, 23);

    let t2 = bitnum_intl(state, 15, 0)
        | ((state & 0x0000_f000) << 15)
        | bitnum_intl(state, 20, 5)
        | bitnum_intl(state, 19, 6)
        | ((state & 0x0000_0f00) << 13)
        | bitnum_intl(state, 24, 11)
        | bitnum_intl(state, 23, 12)
        | ((state & 0x0000_00f0) << 11)
        | bitnum_intl(state, 28, 17)
        | bitnum_intl(state, 27, 18)
        | ((state & 0x0000_000f) << 9)
        | bitnum_intl(state, 0, 23);

    let mut mixed = [
        ((t1 >> 24) & 0xff) as u8 ^ key[0],
        ((t1 >> 16) & 0xff) as u8 ^ key[1],
        ((t1 >> 8) & 0xff) as u8 ^ key[2],
        ((t2 >> 24) & 0xff) as u8 ^ key[3],
        ((t2 >> 16) & 0xff) as u8 ^ key[4],
        ((t2 >> 8) & 0xff) as u8 ^ key[5],
    ];
    let substituted = (u32::from(SBOX[0][sbox_bit(mixed[0] >> 2)]) << 28)
        | (u32::from(SBOX[1][sbox_bit(((mixed[0] & 0x03) << 4) | (mixed[1] >> 4))]) << 24)
        | (u32::from(SBOX[2][sbox_bit(((mixed[1] & 0x0f) << 2) | (mixed[2] >> 6))]) << 20)
        | (u32::from(SBOX[3][sbox_bit(mixed[2] & 0x3f)]) << 16)
        | (u32::from(SBOX[4][sbox_bit(mixed[3] >> 2)]) << 12)
        | (u32::from(SBOX[5][sbox_bit(((mixed[3] & 0x03) << 4) | (mixed[4] >> 4))]) << 8)
        | (u32::from(SBOX[6][sbox_bit(((mixed[4] & 0x0f) << 2) | (mixed[5] >> 6))]) << 4)
        | u32::from(SBOX[7][sbox_bit(mixed[5] & 0x3f)]);
    mixed.fill(0);

    bitnum_intl(substituted, 15, 0)
        | bitnum_intl(substituted, 6, 1)
        | bitnum_intl(substituted, 19, 2)
        | bitnum_intl(substituted, 20, 3)
        | bitnum_intl(substituted, 28, 4)
        | bitnum_intl(substituted, 11, 5)
        | bitnum_intl(substituted, 27, 6)
        | bitnum_intl(substituted, 16, 7)
        | bitnum_intl(substituted, 0, 8)
        | bitnum_intl(substituted, 14, 9)
        | bitnum_intl(substituted, 22, 10)
        | bitnum_intl(substituted, 25, 11)
        | bitnum_intl(substituted, 4, 12)
        | bitnum_intl(substituted, 17, 13)
        | bitnum_intl(substituted, 30, 14)
        | bitnum_intl(substituted, 9, 15)
        | bitnum_intl(substituted, 1, 16)
        | bitnum_intl(substituted, 7, 17)
        | bitnum_intl(substituted, 23, 18)
        | bitnum_intl(substituted, 13, 19)
        | bitnum_intl(substituted, 31, 20)
        | bitnum_intl(substituted, 26, 21)
        | bitnum_intl(substituted, 2, 22)
        | bitnum_intl(substituted, 8, 23)
        | bitnum_intl(substituted, 18, 24)
        | bitnum_intl(substituted, 12, 25)
        | bitnum_intl(substituted, 29, 26)
        | bitnum_intl(substituted, 5, 27)
        | bitnum_intl(substituted, 21, 28)
        | bitnum_intl(substituted, 10, 29)
        | bitnum_intl(substituted, 3, 30)
        | bitnum_intl(substituted, 24, 31)
}

fn crypt(input: &[u8; 8], key: &RoundSchedule) -> [u8; 8] {
    let (mut s0, mut s1) = initial_permutation(input);
    for round in 0..15 {
        let previous_s1 = s1;
        s1 = f(s1, &key[round]) ^ s0;
        s0 = previous_s1;
    }
    s0 = f(s1, &key[15]) ^ s0;
    inverse_permutation(s0, s1)
}

fn key_schedule(key: &[u8], mode: Mode) -> Result<RoundSchedule, String> {
    if key.len() < 8 {
        return Err("LDDC DES key is truncated".into());
    }
    let key = &key[..8];
    let mut c = KEY_PERM_C
        .iter()
        .enumerate()
        .map(|(index, bit)| bitnum(key, *bit, 31 - index))
        .sum::<u32>();
    let mut d = KEY_PERM_D
        .iter()
        .enumerate()
        .map(|(index, bit)| bitnum(key, *bit, 31 - index))
        .sum::<u32>();
    let mut schedule = [[0_u8; 6]; 16];
    for (round, shift) in KEY_SHIFTS.iter().enumerate() {
        c = ((c << shift) | (c >> (28 - shift))) & 0xffff_fff0;
        d = ((d << shift) | (d >> (28 - shift))) & 0xffff_fff0;
        let target = if matches!(mode, Mode::Decrypt) {
            15 - round
        } else {
            round
        };
        for j in 0..24 {
            schedule[target][j / 8] |= bitnum_intr(c, KEY_COMPRESSION[j], 7 - (j % 8)) as u8;
        }
        for j in 24..48 {
            schedule[target][j / 8] |= bitnum_intr(d, KEY_COMPRESSION[j] - 27, 7 - (j % 8)) as u8;
        }
    }
    Ok(schedule)
}
