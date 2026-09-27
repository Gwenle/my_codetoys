//! 方块序列 / 干扰行缺口序列的生成。
//!
//! 关键设计：这两条序列在**服务端**一次性生成，然后随着开局消息下发给双方。
//! 因此「双方方块掉落顺序完全一致」「缺口形成序列对双方固定」是由服务端保证的，
//! 而不是靠客户端各自随机后再祈祷它们一致。

/// 32bit 位混淆（murmur3 finalizer 变体）。用于把 (seed, index) 打散成伪随机数。
#[inline]
pub fn mix32(mut z: u32) -> u32 {
    z = (z ^ (z >> 16)).wrapping_mul(0x7feb_352d);
    z = (z ^ (z >> 15)).wrapping_mul(0x846c_a68b);
    z ^ (z >> 16)
}

/// 生成 count 个方块类型（7-bag 随机，保证每个袋子中 7 种方块各出现一次）。
/// 取值 0..=6 => I J L O S T Z
pub fn generate_pieces(seed: u64, count: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(count);
    let mut bag_no: u32 = 0;
    let sl = seed as u32;
    while out.len() < count {
        let mut bag: [u8; 7] = [0, 1, 2, 3, 4, 5, 6];
        let base = sl ^ mix32(sl ^ bag_no.wrapping_mul(0x9E37_79B9));
        // Fisher-Yates
        let mut i = 6usize;
        while i >= 1 {
            let r = mix32(base ^ (i as u32).wrapping_mul(0x85EB_CA6B) ^ bag_no.wrapping_mul(0xC2B2_AE35));
            let j = (r as usize) % (i + 1);
            bag.swap(i, j);
            i -= 1;
        }
        for v in bag.iter() {
            out.push(*v);
        }
        bag_no = bag_no.wrapping_add(1);
    }
    out.truncate(count);
    out
}

/// 生成 count 个干扰行缺口列号（0..10）。
/// 第 k 个收到干扰行的玩家，其第 k 行缺口就是 gaps[k]。
/// 因为序列服务端下发，双方看到的缺口序列完全相同。
pub fn generate_gaps(seed: u64, count: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(count);
    let sl = seed as u32;
    for i in 0..count {
        let r = mix32(sl ^ ((i as u32).wrapping_mul(0x9E37_79B9)) ^ 0x5bf0_3635);
        out.push((r % 10) as u8);
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64 编码（带 = 填充）。
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bag_is_permutation() {
        let p = generate_pieces(42, 700);
        for bag in p.chunks(7) {
            let mut v: Vec<u8> = bag.to_vec();
            v.sort();
            assert_eq!(v, vec![0, 1, 2, 3, 4, 5, 6]);
        }
    }

    #[test]
    fn deterministic() {
        assert_eq!(generate_pieces(7, 100), generate_pieces(7, 100));
        assert_eq!(generate_gaps(7, 100), generate_gaps(7, 100));
        assert_ne!(generate_gaps(7, 100), generate_gaps(8, 100));
    }
}
