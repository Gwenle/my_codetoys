//! 极简 WebSocket 服务端实现（握手 + 帧编解码 + 静态文件 Content-Type）。
//!
//! 只实现本游戏需要的部分：文本帧、分片重组、Close / Ping / Pong。
//! 不依赖 tokio / tungstenite，整个服务端是 std + 线程。

use std::io::{self, Read, Write};
use std::net::TcpStream;

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---------------------------------------------------------------- SHA-1

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let ml = (data.len() as u64).wrapping_mul(8);
    let mut msg: Vec<u8> = Vec::with_capacity(data.len() + 72);
    msg.extend_from_slice(data);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&ml.to_be_bytes());

    let mut w = [0u32; 80];
    for chunk in msg.chunks(64) {
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for i in 0..80 {
            let (f, k) = if i < 20 {
                ((b & c) | ((!b) & d), 0x5A82_7999u32)
            } else if i < 40 {
                (b ^ c ^ d, 0x6ED9_EBA1u32)
            } else if i < 60 {
                ((b & c) | (b & d) | (c & d), 0x8F1B_BCDCu32)
            } else {
                (b ^ c ^ d, 0xCA62_C1D6u32)
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for i in 0..5 {
        out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

// ---------------------------------------------------------------- base64

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

// ---------------------------------------------------------------- 握手

/// 客户端 accept key -> 服务端 accept 值
pub fn accept_key(key: &str) -> String {
    let mut s = String::with_capacity(key.len() + 36);
    s.push_str(key);
    s.push_str(WS_GUID);
    base64_encode(&sha1(s.as_bytes()))
}

pub fn write_handshake(stream: &mut TcpStream, key: &str) -> io::Result<()> {
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\r\n",
        accept_key(key)
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

// ---------------------------------------------------------------- 帧

pub enum Frame {
    Text(String),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

/// 带缓冲的帧读取器。
/// 因为 HTTP 头可能和第一个 WebSocket 帧在同一个 TCP 包里，
/// 所以握手阶段多读出来的字节要交回这里。
pub struct FrameReader<R: Read> {
    inner: R,
    buf: Vec<u8>,
    pos: usize,
    frag: Vec<u8>,
    frag_op: u8,
}

const MAX_PAYLOAD: u64 = 1 << 20;

impl<R: Read> FrameReader<R> {
    pub fn new(inner: R, leftover: Vec<u8>) -> Self {
        FrameReader { inner, buf: leftover, pos: 0, frag: Vec::new(), frag_op: 0 }
    }

    fn take(&mut self, n: usize) -> io::Result<Vec<u8>> {
        while self.buf.len() - self.pos < n {
            let mut chunk = [0u8; 8192];
            let r = self.inner.read(&mut chunk)?;
            if r == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "eof"));
            }
            self.buf.extend_from_slice(&chunk[..r]);
        }
        let out = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        if self.pos > 65536 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        Ok(out)
    }

    fn take1(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }

    /// 读取下一个完整消息（自动处理分片与 ping/pong）。
    pub fn next_message(&mut self) -> io::Result<Option<Frame>> {
        loop {
            let b0 = self.take1()?;
            let b1 = self.take1()?;
            let fin = b0 & 0x80 != 0;
            let opcode = b0 & 0x0f;
            let masked = b1 & 0x80 != 0;
            let mut len = (b1 & 0x7f) as u64;
            if len == 126 {
                let b = self.take(2)?;
                len = u16::from_be_bytes([b[0], b[1]]) as u64;
            } else if len == 127 {
                let b = self.take(8)?;
                len = u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
            }
            if len > MAX_PAYLOAD {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "payload too large"));
            }
            let mask = if masked { Some(self.take(4)?) } else { None };
            let mut payload = self.take(len as usize)?;
            if let Some(m) = mask {
                for i in 0..payload.len() {
                    payload[i] ^= m[i & 3];
                }
            }

            match opcode {
                0x8 => return Ok(Some(Frame::Close)),
                0x9 => return Ok(Some(Frame::Ping(payload))),
                0xA => return Ok(Some(Frame::Pong(payload))),
                0x0 => {
                    self.frag.extend_from_slice(&payload);
                    if fin {
                        let op = self.frag_op;
                        let data = std::mem::take(&mut self.frag);
                        if op == 0x1 {
                            return Ok(Some(Frame::Text(String::from_utf8_lossy(&data).into_owned())));
                        }
                        self.frag_op = 0;
                    }
                }
                0x1 | 0x2 => {
                    if fin {
                        if opcode == 0x1 {
                            return Ok(Some(Frame::Text(String::from_utf8_lossy(&payload).into_owned())));
                        }
                        // 二进制帧：本项目不使用，直接忽略
                    } else {
                        self.frag_op = opcode;
                        self.frag = payload;
                    }
                }
                _ => {}
            }
        }
    }
}

pub fn write_text(stream: &mut TcpStream, s: &str) -> io::Result<()> {
    write_frame(stream, 0x1, s.as_bytes())
}

pub fn write_pong(stream: &mut TcpStream, d: &[u8]) -> io::Result<()> {
    write_frame(stream, 0xA, d)
}

pub fn write_ping(stream: &mut TcpStream, d: &[u8]) -> io::Result<()> {
    write_frame(stream, 0x9, d)
}

pub fn write_close(stream: &mut TcpStream) -> io::Result<()> {
    write_frame(stream, 0x8, &[0x03, 0xE8])
}

fn write_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let len = payload.len();
    let mut head = [0u8; 10];
    let mut n = 0;
    head[n] = 0x80 | opcode;
    n += 1;
    if len < 126 {
        head[n] = len as u8;
        n += 1;
    } else if len <= 65535 {
        head[n] = 126;
        n += 1;
        head[n..n + 2].copy_from_slice(&(len as u16).to_be_bytes());
        n += 2;
    } else {
        head[n] = 127;
        n += 1;
        head[n..n + 8].copy_from_slice(&(len as u64).to_be_bytes());
        n += 8;
    }
    stream.write_all(&head[..n])?;
    stream.write_all(payload)?;
    stream.flush()
}

// ---------------------------------------------------------------- HTTP

pub fn ctype_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}

pub fn write_http(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8]) -> io::Result<()> {
    let reason = match code {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\r\n",
        code,
        reason,
        ctype,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
