//! 房间 / 对战生命周期 / 60Hz 逻辑时钟。
//!
//! 服务端**不做游戏模拟**，只做三件事：
//!   1. 生成一次性的方块序列与干扰行缺口序列（保证双方一致）
//!   2. 驱动权威的 60Hz tick 时钟（保证双方时间轴一致）
//!   3. 转发双方的输入事件（极低带宽：只有按键事件，没有状态同步）
//!
//! 每个房间的常驻开销 = 2 个 mpsc 通道 + 一个 tick 线程。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::sequence;

/// 发给某个连接的数据（由每个连接的写线程消费）
pub enum Out {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

pub struct Player {
    pub name: String,
    pub tx: Sender<Out>,
    pub ready: bool,
}

#[derive(PartialEq, Clone, Copy)]
pub enum Phase {
    Lobby,
    Playing,
    Finished,
}

pub struct RoomState {
    pub players: Vec<Option<Player>>,
    pub phase: Phase,
    pub seed: u64,
    pub start_tick: u64,
    pub stop: Option<Arc<AtomicBool>>,
    pub rounds: u32,
}

pub struct Room {
    pub code: String,
    pub state: Mutex<RoomState>,
}

pub struct Registry {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    counter: AtomicU64,
}

/// tick 频率：60Hz
const TICK_MICROS: u64 = 16_667;
/// tick 广播间隔：25ms（客户端按绝对值对齐，不需要每 tick 都发）
const TICK_BROADCAST_MS: u64 = 25;
/// 序列长度
const SEQ_LEN: usize = 3000;

fn now_seed() -> u64 {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::from_secs(0));
    let mut x = t.as_nanos() as u64;
    x ^= (std::process::id() as u64) << 32;
    // 再混淆一次，避免连续同毫秒
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^ (x >> 33)
}

pub fn sanitize_name(s: &str) -> String {
    let mut out: String = s
        .chars()
        .filter(|c| !c.is_control() && *c != '|' && *c != '<' && *c != '>')
        .take(16)
        .collect();
    let t = out.trim().to_string();
    out = t;
    if out.is_empty() {
        out = "玩家".to_string();
    }
    out
}

pub fn sanitize_code(s: &str) -> String {
    let out: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_uppercase();
    out
}

impl Registry {
    pub fn new() -> Self {
        Registry { rooms: Mutex::new(HashMap::new()), counter: AtomicU64::new(1) }
    }

    pub fn random_code(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let s = now_seed() ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        const ALPHA: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let mut code = String::with_capacity(4);
        for i in 0..4 {
            let idx = ((s >> (i * 8)) as usize) % 32;
            code.push(ALPHA[idx] as char);
        }
        code
    }

    fn get(&self, code: &str) -> Option<Arc<Room>> {
        let m = self.rooms.lock().unwrap();
        m.get(code).cloned()
    }

    fn insert(&self, code: &str, room: Arc<Room>) {
        let mut m = self.rooms.lock().unwrap();
        m.insert(code.to_string(), room);
    }

    fn drop_room(&self, code: &str) {
        let mut m = self.rooms.lock().unwrap();
        m.remove(code);
    }

    /// 加入房间（房间不存在则创建，即“开房”）
    pub fn join(
        &self,
        want_code: &str,
        name: &str,
        tx: Sender<Out>,
    ) -> Result<(Arc<Room>, usize), String> {
        let mut code = sanitize_code(want_code);
        if code.is_empty() {
            code = self.random_code();
        }

        let room = match self.get(&code) {
            Some(r) => r,
            None => {
                let r = Arc::new(Room {
                    code: code.clone(),
                    state: Mutex::new(RoomState {
                        players: vec![None, None],
                        phase: Phase::Lobby,
                        seed: 0,
                        start_tick: 0,
                        stop: None,
                        rounds: 0,
                    }),
                });
                self.insert(&code, r.clone());
                r
            }
        };

        let slot = {
            let mut st = room.state.lock().unwrap();
            if st.phase == Phase::Playing {
                return Err("该房间正在对局中".to_string());
            }
            let mut found = None;
            for (i, p) in st.players.iter_mut().enumerate() {
                if p.is_none() {
                    found = Some(i);
                    break;
                }
            }
            match found {
                Some(i) => {
                    st.players[i] = Some(Player {
                        name: sanitize_name(name),
                        tx,
                        ready: false,
                    });
                    i
                }
                None => return Err("房间已满".to_string()),
            }
        };

        // 告诉所有人：当前房间状态
        let (peer_name, peer_ready, my_name) = {
            let st = room.state.lock().unwrap();
            let other = st.players[1 - slot].as_ref();
            (
                other.map(|p| p.name.clone()),
                other.map(|p| p.ready).unwrap_or(false),
                st.players[slot].as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            )
        };
        room.send_to(slot, format!("slot|{}|{}|{}", slot, code, my_name));
        if let Some(pn) = peer_name {
            room.send_to(slot, format!("peer|{}|{}", 1 - slot, pn));
            room.broadcast_except(slot, format!("peer|{}|{}", slot, my_name));
            room.send_to(slot, format!("ready|{}|{}", 1 - slot, if peer_ready { 1 } else { 0 }));
        }
        Ok((room, slot))
    }

    pub fn cleanup_empty(&self, room: &Arc<Room>) {
        let empty = {
            let st = room.state.lock().unwrap();
            st.players.iter().all(|p| p.is_none())
        };
        if empty {
            self.drop_room(&room.code);
        }
    }
}

impl Room {
    pub fn send_to(&self, slot: usize, msg: String) {
        let st = self.state.lock().unwrap();
        if let Some(Some(p)) = st.players.get(slot) {
            let _ = p.tx.send(Out::Text(msg));
        }
    }

    pub fn broadcast(&self, msg: String) {
        let st = self.state.lock().unwrap();
        for p in st.players.iter().flatten() {
            let _ = p.tx.send(Out::Text(msg.clone()));
        }
    }

    pub fn broadcast_except(&self, slot: usize, msg: String) {
        let st = self.state.lock().unwrap();
        for (i, p) in st.players.iter().enumerate() {
            if i == slot {
                continue;
            }
            if let Some(p) = p {
                let _ = p.tx.send(Out::Text(msg.clone()));
            }
        }
    }

    /// 转发输入：收到 "in|tick|act|state" -> 转发 "in|slot|tick|act|state"
    pub fn relay_input(&self, slot: usize, payload: &str) {
        if payload.len() > 64 {
            return;
        }
        let msg = format!("in|{}|{}", slot, payload);
        self.broadcast_except(slot, msg);
    }

    /// 转发棋盘哈希（用于检测不同步）
    pub fn relay_hash(&self, slot: usize, payload: &str) {
        if payload.len() > 32 {
            return;
        }
        let msg = format!("hs|{}|{}", slot, payload);
        self.broadcast_except(slot, msg);
    }

    pub fn set_ready(&self, slot: usize, v: bool) {
        let start = {
            let mut st = self.state.lock().unwrap();
            if let Some(Some(p)) = st.players.get_mut(slot) {
                p.ready = v;
            }
            let both = st.players.len() == 2
                && st.players.iter().all(|p| p.is_some())
                && st.players.iter().flatten().all(|p| p.ready);
            if both && st.phase != Phase::Playing {
                st.phase = Phase::Playing;
                st.rounds += 1;
                true
            } else {
                false
            }
        };
        self.broadcast(format!("ready|{}|{}", slot, if v { 1 } else { 0 }));
        if start {
            self.start_match();
        }
    }

    fn start_match(&self) {
        let (seed, start_tick, senders, stop) = {
            let mut st = self.state.lock().unwrap();
            let seed = now_seed();
            let start_tick = 1000u64;
            st.seed = seed;
            st.start_tick = start_tick;
            st.stop = Some(Arc::new(AtomicBool::new(false)));
            let senders: Vec<Sender<Out>> =
                st.players.iter().flatten().map(|p| p.tx.clone()).collect();
            (seed, start_tick, senders, st.stop.clone().unwrap())
        };

        let pieces = sequence::generate_pieces(seed, SEQ_LEN);
        let gaps = sequence::generate_gaps(seed, SEQ_LEN);
        let msg = format!(
            "start|{}|{}|{}|{}",
            seed,
            start_tick,
            sequence::base64_encode(&pieces),
            sequence::base64_encode(&gaps)
        );
        for s in senders.iter() {
            let _ = s.send(Out::Text(msg.clone()));
        }

        let _ = thread::Builder::new()
            .name("traix-ticker".to_string())
            .stack_size(64 * 1024)
            .spawn(move || {
                let t0 = Instant::now();
                let mut last = start_tick;
                let mut last_send = Instant::now();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let el = t0.elapsed().as_micros() as u64;
                    let t = start_tick + el / TICK_MICROS;
                    if t > last && last_send.elapsed() >= Duration::from_millis(TICK_BROADCAST_MS) {
                        last = t;
                        last_send = Instant::now();
                        for s in senders.iter() {
                            let _ = s.send(Out::Text(format!("tick|{}", t)));
                        }
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            });
    }

    /// 某方顶出/阵亡
    pub fn player_dead(&self, slot: usize) {
        let go = {
            let mut st = self.state.lock().unwrap();
            if st.phase != Phase::Playing {
                false
            } else {
                st.phase = Phase::Finished;
                if let Some(s) = st.stop.as_ref() {
                    s.store(true, Ordering::Relaxed);
                }
                // 本局结束，准备状态归零：下一局必须双方都重新点「准备好了」，
                // 否则一个人点「再来一局」就会把还在看结算的对手直接拽进新对局。
                for p in st.players.iter_mut().flatten() {
                    p.ready = false;
                }
                true
            }
        };
        if go {
            // 两边的准备状态都归零，并且要**广播给双方**：
            // 只通知玩家自己会导致客户端残留「对手仍已准备」的旧状态，
            // 界面会显示「双方已准备」但其实服务端并不这么认为。
            for i in 0..2usize {
                self.broadcast(format!("ready|{}|0", i));
            }
            self.broadcast(format!("end|{}|topout", 1 - slot));
        }
    }

    /// 连接断开
    pub fn leave(&self, slot: usize) {
        let (playing, peer) = {
            let mut st = self.state.lock().unwrap();
            let playing = st.phase == Phase::Playing;
            if let Some(s) = st.stop.as_ref() {
                s.store(true, Ordering::Relaxed);
            }
            st.stop = None;
            if let Some(p) = st.players.get_mut(slot) {
                *p = None;
            }
            // 只有「对局中掉线」才需要让另一方重新确认准备状态；
            // 大厅阶段掉线不动另一方的准备状态，否则「A 已准备 -> B 重连进来 ->
            // B 点准备」这个很自然的流程会被打断（服务端重置了 ready 但 A 的界面不知道）。
            if playing {
                for p in st.players.iter_mut().flatten() {
                    p.ready = false;
                }
            }
            st.phase = Phase::Lobby;
            let peer = st.players[1 - slot].is_some();
            (playing, peer)
        };
        if peer {
            if playing {
                // 告知剩下的人：你的准备状态已被服务端重置
                self.send_to(1 - slot, format!("ready|{}|0", 1 - slot));
                self.broadcast_except(slot, format!("end|{}|leave", 1 - slot));
            }
            self.broadcast_except(slot, format!("leave|{}", slot));
        }
    }
}
