//! TETRIX ARENA —— 联网对战俄罗斯方块服务端。
//!
//! 零第三方依赖。用 std::net + 线程实现 HTTP 静态资源和 WebSocket 对战通道。
//!
//! 用法:
//!   cargo run --release -- --port 8787 --web frontend

mod room;
mod sequence;
mod ws;

use std::io::Read;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use room::{Out, Registry};
use ws::{Frame, FrameReader};

fn main() {
    let mut port: u16 = 8787;
    let mut web = PathBuf::from("frontend");
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" => {
                if i + 1 < args.len() {
                    port = args[i + 1].parse().unwrap_or(8787);
                    i += 1;
                }
            }
            "--web" | "-w" => {
                if i + 1 < args.len() {
                    web = PathBuf::from(args[i + 1].clone());
                    i += 1;
                }
            }
            "--help" | "-h" => {
                print_help();
                return;
            }
            _ => {}
        }
        i += 1;
    }

    let registry = Arc::new(Registry::new());
    let listener = match TcpListener::bind(("0.0.0.0", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[traix] 绑定端口 {} 失败: {}", port, e);
            std::process::exit(1);
        }
    };
    println!("[traix] 服务已启动");
    println!("[traix] 本机访问     : http://127.0.0.1:{}/", port);
    println!("[traix] 局域网访问   : http://<你的局域网IP>:{}/", port);
    println!("[traix] 静态资源目录 : {}", web.display());
    println!("[traix] 对战通道     : ws://<host>:{}/ws", port);

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let reg = registry.clone();
                let web = web.clone();
                let r = std::thread::Builder::new()
                    .name("traix-conn".to_string())
                    .stack_size(256 * 1024)
                    .spawn(move || {
                        if let Err(e) = handle_conn(s, reg, web) {
                            let msg = e.to_string();
                            if !msg.contains("eof") {
                                eprintln!("[traix] 连接结束: {}", msg);
                            }
                        }
                    });
                if r.is_err() {
                    eprintln!("[traix] 创建线程失败");
                }
            }
            Err(e) => eprintln!("[traix] accept 失败: {}", e),
        }
    }
}

fn print_help() {
    println!("traix-server 参数:");
    println!("  -p, --port <PORT>   监听端口，默认 8787");
    println!("  -w, --web  <DIR>    前端静态资源目录，默认 frontend");
}

// ------------------------------------------------------------------ HTTP 解析

fn handle_conn(mut stream: TcpStream, reg: Arc<Registry>, web: PathBuf) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_nodelay(true);
    let (head, leftover) = read_head(&mut stream)?;

    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("").trim().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut is_upgrade = false;
    let mut ws_key = String::new();
    for l in lines {
        let ll = l.to_ascii_lowercase();
        if ll.starts_with("upgrade:") && ll.contains("websocket") {
            is_upgrade = true;
        } else if ll.starts_with("sec-websocket-key:") {
            ws_key = l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string();
        }
    }

    if is_upgrade && !ws_key.is_empty() {
        return handle_ws(stream, leftover, ws_key, reg);
    }

    if method != "GET" {
        return ws::write_http(&mut stream, 405, "text/plain; charset=utf-8", b"405");
    }
    let (code, ctype, body) = serve_static(&web, &path);
    ws::write_http(&mut stream, code, ctype, &body)
}

fn read_head(stream: &mut TcpStream) -> std::io::Result<(String, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 2048];
    loop {
        if let Some(p) = find_head_end(&buf) {
            let head = String::from_utf8_lossy(&buf[..p - 4]).into_owned();
            let leftover = buf[p..].to_vec();
            return Ok((head, leftover));
        }
        if buf.len() > 32 * 1024 {
            break;
        }
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), Vec::new()))
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    if buf.len() < 4 {
        return None;
    }
    for i in 3..buf.len() {
        if &buf[i - 3..=i] == b"\r\n\r\n" {
            return Some(i + 1);
        }
    }
    None
}

fn serve_static(web: &Path, req_path: &str) -> (u16, &'static str, Vec<u8>) {
    let mut rel = req_path.trim_start_matches('/').to_string();
    if let Some(q) = rel.find('?') {
        rel.truncate(q);
    }
    if rel.is_empty() {
        rel = "index.html".to_string();
    }
    if rel.contains("..") {
        return (404, "text/plain; charset=utf-8", b"404".to_vec());
    }
    let full = web.join(&rel);
    match std::fs::read(&full) {
        Ok(data) => (200, ws::ctype_for(&rel), data),
        Err(_) => (404, "text/plain; charset=utf-8", b"404 Not Found".to_vec()),
    }
}

// ------------------------------------------------------------------ WebSocket

fn handle_ws(
    stream: TcpStream,
    leftover: Vec<u8>,
    ws_key: String,
    reg: Arc<Registry>,
) -> std::io::Result<()> {
    // 1) 握手（必须在启动写线程之前完成，保证响应头是第一个写出的数据）
    let mut wstream = stream.try_clone()?;
    // WS 连接建立后不再需要读超时（空闲是正常的）
    let _ = stream.set_read_timeout(None);
    ws::write_handshake(&mut wstream, &ws_key)?;

    // 2) 写线程：唯一往这个 socket 写数据的地方
    let (tx, rx) = mpsc::channel::<Out>();
    let mut writer_stream = wstream;
    let writer = std::thread::Builder::new()
        .name("traix-ws-write".to_string())
        .stack_size(128 * 1024)
        .spawn(move || loop {
            match rx.recv_timeout(Duration::from_secs(20)) {
                Ok(Out::Text(s)) => {
                    if ws::write_text(&mut writer_stream, &s).is_err() {
                        let _ = writer_stream.shutdown(Shutdown::Both);
                        break;
                    }
                }
                Ok(Out::Pong(d)) => {
                    if ws::write_pong(&mut writer_stream, &d).is_err() {
                        let _ = writer_stream.shutdown(Shutdown::Both);
                        break;
                    }
                }
                Ok(Out::Close) => {
                    let _ = ws::write_close(&mut writer_stream);
                    let _ = writer_stream.shutdown(Shutdown::Both);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // 心跳：写失败说明对端已消失，直接关掉 socket 让读线程退出
                    if ws::write_ping(&mut writer_stream, b"t").is_err() {
                        let _ = writer_stream.shutdown(Shutdown::Both);
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        })
        .ok();

    // 3) 读线程（当前线程）
    let mut fr = FrameReader::new(stream, leftover);
    let mut joined: Option<(Arc<room::Room>, usize)> = None;

    loop {
        let frame = match fr.next_message() {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(_) => break,
        };
        match frame {
            Frame::Text(s) => {
                if s.len() > 8192 {
                    continue;
                }
                let mut it = s.splitn(2, '|');
                let cmd = it.next().unwrap_or("");
                let rest = it.next().unwrap_or("");
                match cmd {
                    "join" => {
                        if joined.is_some() {
                            continue;
                        }
                        let mut j = rest.splitn(2, '|');
                        let code = j.next().unwrap_or("");
                        let name = j.next().unwrap_or("玩家");
                        match reg.join(code, name, tx.clone()) {
                            Ok((room, slot)) => {
                                println!(
                                    "[traix] {} 加入房间 {} (slot {})",
                                    room::sanitize_name(name),
                                    room.code,
                                    slot
                                );
                                joined = Some((room, slot));
                            }
                            Err(e) => {
                                let _ = tx.send(Out::Text(format!("err|{}", e)));
                            }
                        }
                    }
                    "ready" => {
                        if let Some((room, slot)) = joined.as_ref() {
                            let v = rest.trim() == "1";
                            room.set_ready(*slot, v);
                        }
                    }
                    "in" => {
                        if let Some((room, slot)) = joined.as_ref() {
                            room.relay_input(*slot, rest);
                        }
                    }
                    "hs" => {
                        if let Some((room, slot)) = joined.as_ref() {
                            room.relay_hash(*slot, rest);
                        }
                    }
                    "dead" => {
                        if let Some((room, slot)) = joined.as_ref() {
                            room.player_dead(*slot);
                        }
                    }
                    "ping" => {
                        let _ = tx.send(Out::Text("pong|".to_string()));
                    }
                    _ => {}
                }
            }
            Frame::Ping(d) => {
                let _ = tx.send(Out::Pong(d));
            }
            Frame::Pong(_) => {}
            Frame::Close => break,
        }
    }

    if let Some((room, slot)) = joined {
        room.leave(slot);
        reg.cleanup_empty(&room);
    }
    let _ = tx.send(Out::Close);
    drop(tx);
    if let Some(h) = writer {
        let _ = h.join();
    }
    Ok(())
}

