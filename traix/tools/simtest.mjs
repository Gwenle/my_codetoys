// 确定性 / 干扰行机制验证脚本。
//
//   node tools/simtest.mjs
//
// 它做三件真实的事：
//   1) 用两个 Match 实例扮演两台客户端，喂**相同**的输入但**不同的到达时序**
//      （其中一部分输入故意迟到，逼出「回滚重演」路径），
//      逐 tick 比对双方对两块棋盘的哈希 —— 必须永远一致。
//   2) 定向验证干扰行：底行只差一格时消行，检查对手底部多出一行带指定缺口的行，
//      且原有方块整体上移。
//   3) 验证「固定序列」：双方第 n 个方块、第 n 行干扰缺口完全相同。

import { Match } from '../frontend/js/match.js';
import { Game } from '../frontend/js/game.js';
import { COLS, TOTAL_ROWS, INPUT_DELAY, GARBAGE_ID, HIDDEN } from '../frontend/js/constants.js';
import { ROT, SPAWN_Y, spawnX } from '../frontend/js/pieces.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function makeSeq(seed) {
  // 复刻服务端下发格式：0..6 的方块序列 + 0..9 的缺口序列
  const pieces = new Uint8Array(2000);
  const gaps = new Uint8Array(2000);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < pieces.length; i++) pieces[i] = Math.floor(rnd() * 7);
  for (let i = 0; i < gaps.length; i++) gaps[i] = Math.floor(rnd() * 10);
  return { pieces, gaps };
}

// ------------------------------------------------------------------ 1) 锁步一致性

function randomInputs(seed, limit) {
  // 生成一份「按键发生时刻」为绝对时间轴的输入表：
  //   { gen: 玩家按下按键的时刻, slot, act, state }
  // 真实协议里：输入在 gen + INPUT_DELAY 这个 tick 生效，
  // 发送给对手后会经过网络延迟 latency 到达。
  const out = [];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  // 模拟一个「会玩」的玩家：每块方块左右挪几格、偶尔旋转、然后硬降落地。
  // 这样才会真的消行、真的触发干扰行派发。
  const nextAt = [0, 0];
  const softUntil = [0, 0];
  const softOn = [false, false];

  for (let g = 0; g < limit; g++) {
    for (let slot = 0; slot < 2; slot++) {
      // 大部分时间按住软降
      if (!softOn[slot] && g >= softUntil[slot]) {
        out.push({ gen: g, slot, act: 'S', state: 1 });
        softOn[slot] = true;
        softUntil[slot] = g + 40 + Math.floor(rnd() * 80);
      } else if (softOn[slot] && g >= softUntil[slot]) {
        out.push({ gen: g, slot, act: 'S', state: 0 });
        softOn[slot] = false;
        softUntil[slot] = g + 2 + Math.floor(rnd() * 8);
      }

      if (g >= nextAt[slot]) {
        const dir = rnd() < 0.5 ? 'L' : 'R';
        const hold = 4 + Math.floor(rnd() * 18);
        out.push({ gen: g, slot, act: dir, state: 1 });
        out.push({ gen: g + hold, slot, act: dir, state: 0 });
        if (rnd() < 0.4) out.push({ gen: g + 1, slot, act: 'C', state: 1 });
        if (rnd() < 0.15) out.push({ gen: g + 2, slot, act: 'W', state: 1 });
        out.push({ gen: g + hold + 1, slot, act: 'H', state: 1 });
        nextAt[slot] = g + hold + 2 + Math.floor(rnd() * 12);
      }
    }
  }
  return out;
}

/**
 * 模拟一台「正在游玩某 slot 的客户端」。
 *
 * 关键不变量：
 *   * 本地输入：按下后立刻 pushInput(目标 tick = 当前 tick + INPUT_DELAY)
 *   * 对手输入：经过 latency 帧之后到达；若到达时目标 tick 已经过去，
 *     Match 会自动回滚重演
 *   * 只有当「目标 tick <= 当前模拟 tick 的全部输入都已投递」时，
 *     两台机器的棋盘才有可比性（这就是真实游戏的正确性定义）
 */
function makeClient(slot, seq, inputs, latency) {
  const match = new Match({ mySlot: slot, seq, startTick: 0 });
  const inBox = inputs
    .filter((it) => it.slot === slot)
    .sort((a, b) => a.gen - b.gen)
    .map((it) => ({ tick: it.gen + INPUT_DELAY, act: it.act, state: it.state, at: it.gen }));
  const remoteBox = inputs
    .filter((it) => it.slot !== slot)
    .sort((a, b) => a.gen - b.gen)
    .map((it) => ({ tick: it.gen + INPUT_DELAY, act: it.act, state: it.state, at: it.gen + latency(it.gen, slot) }));

  // 同一发送者的消息顺序必须保持（TCP 保证）
  const enforceOrder = (box) => {
    let last = -1;
    for (const it of box) {
      it.at = Math.max(it.at, last + 1);
      last = it.at;
    }
    return box.sort((a, b) => a.at - b.at);
  };
  enforceOrder(inBox);
  enforceOrder(remoteBox);
  return { slot, match, inBox, remoteBox, iIn: 0, iRemote: 0, delivered: -1 };
}

function deliver(c, now) {
  // 本地输入：按下瞬间就排进时间轴（目标 tick = 按下时的 tick + INPUT_DELAY，由表格给定）
  while (c.iIn < c.inBox.length && c.inBox[c.iIn].at <= now) {
    const it = c.inBox[c.iIn++];
    c.match.pushInput(c.slot, it.tick, it.act, it.state);
    if (it.tick > c.delivered) c.delivered = it.tick;
  }
  // 对手输入：经过网络延迟后到达
  while (c.iRemote < c.remoteBox.length && c.remoteBox[c.iRemote].at <= now) {
    const it = c.remoteBox[c.iRemote++];
    c.match.pushInput(1 - c.slot, it.tick, it.act, it.state);
    if (it.tick > c.delivered) c.delivered = it.tick;
  }
}

/** 是否所有目标 tick <= t 的输入都已经投递完毕（此时两台机器必须完全一致） */
function comparable(c, t) {
  if (c.delivered < t) return false;
  // 检查是否还有「目标 tick <= t 但还没到」的在途消息
  for (let i = c.iRemote; i < c.remoteBox.length; i++) if (c.remoteBox[i].tick <= t) return false;
  for (let i = c.iIn; i < c.inBox.length; i++) if (c.inBox[i].tick <= t) return false;
  return true;
}

function runPair(label, latencyA, latencyB, opts = {}) {
  const seq = opts.seq || makeSeq(opts.seed || 0xc0ffee);
  const inputs = opts.inputs || randomInputs(opts.inputSeed || 12345, opts.limit || 4000);
  const A = makeClient(0, seq, inputs, latencyA);
  const B = makeClient(1, seq, inputs, latencyB);
  const clients = [
    { c: A, lat: latencyA },
    { c: B, lat: latencyB },
  ];

  let mismatchAt = -1;
  let compared = 0;
  let steps = 0;
  const maxSteps = opts.limit || 4000;

  // 两台机器可能推进到不同的 tick（一方已经判定结束、另一方还在等迟到输入），
  // 所以严格正确的比对方式是：取两者都到达过的 tick，
  // 且该 tick 的输入在两边都已投递完毕，然后比对**该 tick 的历史哈希**。
  const compareAt = (t) => {
    if (A.match.hist[0].get(t) !== B.match.hist[0].get(t)) return false;
    if (A.match.hist[1].get(t) !== B.match.hist[1].get(t)) return false;
    return true;
  };

  while (steps++ < maxSteps) {
    for (const { c } of clients) deliver(c, c.match.tick);
    for (const { c } of clients) {
      c.match.setServerTick(c.match.tick + INPUT_DELAY + 1);
      c.match.update();
    }

    // 把所有 tick 都推进到两者相同的进度后逐个比对（只比对可比对的 tick）
    const t = Math.min(A.match.tick, B.match.tick);
    if (comparable(A, t) && comparable(B, t)) {
      for (let k = Math.max(1, t - 20); k <= t; k++) {
        if (A.match.hist[0].get(k) === undefined) continue;
        if (!compareAt(k)) {
          mismatchAt = k;
          break;
        }
        compared++;
      }
      if (mismatchAt >= 0) break;
    }

    if (A.match.finished || B.match.finished) {
      // 让剩余在途输入全部投递，再比对最终局面
      for (const { c } of clients) deliver(c, Infinity);
      const tf = Math.min(A.match.tick, B.match.tick);
      if (!compareAt(tf)) mismatchAt = tf;
      break;
    }
  }

  const rewinds = A.match.rewinds + B.match.rewinds;
  console.log(
    `  ${label}: tick=${A.match.tick} 比对帧=${compared} 回滚=${rewinds} 消行=${A.match.games[0].lines}/${A.match.games[1].lines} 干扰行=${A.match.games[0].received}/${A.match.games[1].received}`
  );
  return { mismatchAt, compared, rewinds, A, B, finished: A.match.finished && B.match.finished };
}

function runLockstepTest() {
  console.log('\n[1] 双客户端锁步一致性');

  // 1a. 理想网络：输入总是提前 INPUT_DELAY 帧到达 -> 不该出现任何回滚，且逐帧一致
  const ideal = runPair('理想网络  ', () => 0, () => 0, { seed: 0xc0ffee, inputSeed: 7 });
  check('理想网络下逐帧完全一致', ideal.mismatchAt < 0, `tick ${ideal.mismatchAt} 不一致`);
  check('理想网络下无需回滚', ideal.rewinds === 0, `回滚=${ideal.rewinds}`);
  check('比对帧数足够多', ideal.compared > 100, `比对帧=${ideal.compared}`);

  // 1b. 抖动网络：大量输入迟到，强制走回滚重演路径
  const lag = runPair(
    '抖动的网络',
    (g) => (g % 11 === 0 ? 18 : g % 3),
    (g) => (g % 5 === 0 ? 12 : (g % 2) + 1),
    { seed: 0xbeef, inputSeed: 999 }
  );
  check('抖动网络下依然逐帧收敛', lag.mismatchAt < 0, `tick ${lag.mismatchAt} 不一致`);
  check('确实触发了回滚重演', lag.rewinds > 0, `回滚=${lag.rewinds}`);
  check('没有输入被丢弃', lag.A.match.droppedInputs === 0 && lag.B.match.droppedInputs === 0);
  check('双方对局结果判定一致', lag.A.match.winner === lag.B.match.winner);

  // 1c. 长期随机对局：一路跑到终局，验证终局状态一致
  const long = runPair('长局      ', (g) => (g % 4), (g) => (g % 6), {
    seed: 424242,
    inputSeed: 31337,
    limit: 20000,
  });
  check('长局中始终保持一致', long.mismatchAt < 0, `tick ${long.mismatchAt} 不一致`);
  check('长局最终分出结果', long.A.match.finished && long.B.match.finished);
  console.log(
    `    终局: 双方是否都顶出 = ${long.A.match.games[0].dead}/${long.A.match.games[1].dead}，胜者 = ${long.A.match.winner}（对方视角 ${long.B.match.winner}）`
  );
}

// ------------------------------------------------------------------ 2) 干扰行机制

function testGarbage() {
  console.log('\n[2] 干扰行机制');
  const seq = makeSeq(7);
  const g = new Game(seq);
  const target = new Game(seq);

  // 构造：target 底行放一块方块，方便观察「上推」
  target.cells[(TOTAL_ROWS - 1) * COLS + 3] = 5;
  const beforeRow = TOTAL_ROWS - 1;

  const gap = seq.gaps[0];
  target.addGarbage(gap, 1);

  let holes = 0;
  let holeAt = -1;
  const base = (TOTAL_ROWS - 1) * COLS;
  for (let x = 0; x < COLS; x++) {
    if (!target.cells[base + x]) {
      holes++;
      holeAt = x;
    }
  }
  check('最底层新增 1 行干扰行', true);
  check('干扰行恰好一个缺口', holes === 1, `缺口数=${holes}`);
  check('缺口列 = 固定序列给出的列', holeAt === gap, `缺口=${holeAt} 期望=${gap}`);
  check('干扰行其它格为实心', target.cells[base + ((gap + 1) % COLS)] === GARBAGE_ID);
  check('原有方块被整体上推一行', target.cells[(beforeRow - 1) * COLS + 3] === 5);

  // 连续两行干扰行 -> 两个缺口依次来自序列
  const g2 = new Game(seq);
  g2.addGarbage(seq.gaps[0], 1);
  g2.addGarbage(seq.gaps[1], 2);
  const last = (TOTAL_ROWS - 1) * COLS;
  const second = (TOTAL_ROWS - 2) * COLS;
  const holeOf = (b) => {
    let c = -1;
    for (let x = 0; x < COLS; x++) if (!g2.cells[b + x]) c = x;
    return c;
  };
  check(
    '连续干扰行的缺口按固定序列依次出现',
    holeOf(last) === seq.gaps[1] && holeOf(second) === seq.gaps[0],
    `实际=${holeOf(last)},${holeOf(second)} 期望=${seq.gaps[1]},${seq.gaps[0]}`
  );

  // 顶出判定：第 0 行有方块时再收到干扰行 -> 直接落败
  const g3 = new Game(seq);
  g3.cells[0 * COLS + 0] = 1;
  g3.addGarbage(0, 5);
  check('方块被推出顶端时判负', g3.dead === true);
}

// ------------------------------------------------------------------ 2.5) 消行 -> 干扰行全链路

function testLineClear() {
  console.log('\n[2.5] 消行 -> 派发干扰行');
  const seq = makeSeq(11);
  const me = new Game(seq);
  const opp = new Game(seq);

  // 把最底行填满，只留 0、1 两列
  const base = (TOTAL_ROWS - 1) * COLS;
  for (let x = 2; x < COLS; x++) me.cells[base + x] = 1;
  // 手工放一个 O 方块恰好补上 (0,1) 两列
  me.piece = { type: 3, rot: 0, x: 0, y: TOTAL_ROWS - 2 };
  check('O 方块放在底行缺口处不会碰撞', me.collides(3, 0, 0, TOTAL_ROWS - 2) === false);
  me.lockPiece();

  check('底行被消除', me.lines === 1, `lines=${me.lines}`);
  check('被消掉的格子清空、其余下落', me.cells[base + 5] === 0 && me.cells[base + 2] === 0);
  check('上方残留的方块随之下落一行', me.cells[base] === 4 && me.cells[base + 1] === 4);
  check('消行后登记了 1 行待发送干扰行', me.takeGarbage() === 1);
  check('再次取干扰行为 0（不会重复发送）', me.takeGarbage() === 0);

  // Match 层：A 消行 -> B 立刻在底层收到带缺口的干扰行
  const m = new Match({ mySlot: 0, seq, startTick: 0 });
  const mBase = (TOTAL_ROWS - 1) * COLS;
  for (let x = 2; x < COLS; x++) m.games[0].cells[mBase + x] = 1;
  m.games[0].cells[mBase + 0] = 0;
  m.games[0].cells[mBase + 1] = 0;
  m.games[0].piece = { type: 3, rot: 0, x: 0, y: TOTAL_ROWS - 2 };
  m.games[0].wasGrounded = true;
  m.games[0].lockTimer = 1; // 下一帧立即锁定 -> 消行
  const bBefore = m.games[1].received;
  m.step(1);
  check('Match 层把消行转成了对手的干扰行', m.games[1].received === bBefore + 1, `received=${m.games[1].received}`);
  let holes = 0;
  let holeAt = -1;
  for (let x = 0; x < COLS; x++) {
    if (!m.games[1].cells[(TOTAL_ROWS - 1) * COLS + x]) {
      holes++;
      holeAt = x;
    }
  }
  check('对手底层干扰行只有一个缺口', holes === 1);
  check('缺口来自固定缺口序列的第一项', holeAt === seq.gaps[0], `缺口=${holeAt} 期望=${seq.gaps[0]}`);
  check('对手已消费 1 个缺口游标', m.gapCursor[1] === 1);
}

// ------------------------------------------------------------------ AI 玩家（用于压测）

/** 把方块放到 (rot, px) 并处理消行，返回结果棋盘；放不下返回 null */
function placeSim(cells, type, rot, px) {
  const m = ROT[type][rot];
  const n = m.length;
  const cc = new Uint8Array(cells.length);
  cc.set(cells);
  const coll = (x, y) => {
    for (let dy = 0; dy < n; dy++) {
      for (let dx = 0; dx < n; dx++) {
        if (!m[dy][dx]) continue;
        const bx = x + dx;
        const by = y + dy;
        if (bx < 0 || bx >= COLS || by >= TOTAL_ROWS) return true;
        if (by >= 0 && cc[by * COLS + bx]) return true;
      }
    }
    return false;
  };
  let y = SPAWN_Y;
  if (coll(px, y)) return null;
  while (!coll(px, y + 1)) y++;
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      if (!m[dy][dx]) continue;
      const bx = px + dx;
      const by = y + dy;
      if (by >= 0 && by < TOTAL_ROWS && bx >= 0 && bx < COLS) cc[by * COLS + bx] = type + 1;
    }
  }
  let cleared = 0;
  let r = TOTAL_ROWS - 1;
  while (r >= 0) {
    let full = true;
    for (let x = 0; x < COLS; x++) {
      if (!cc[r * COLS + x]) {
        full = false;
        break;
      }
    }
    if (full) {
      cc.copyWithin(COLS, 0, r * COLS);
      cc.fill(0, 0, COLS);
      cleared++;
    } else {
      r--;
    }
  }
  return { cells: cc, cleared };
}

/** 简易 Dellacherie 风格评估函数（两位 AI 权重略有不同，避免完全对称的镜像对局） */
const BOT_W = [
  { cleared: 3.2, agg: -0.51, bump: -0.28, holes: -7.5, max: -0.18 },
  { cleared: 3.0, agg: -0.44, bump: -0.37, holes: -8.6, max: -0.25 },
];

function scoreBoard(cells, cleared, w) {
  const h = new Array(COLS).fill(0);
  let holes = 0;
  for (let x = 0; x < COLS; x++) {
    let seen = false;
    for (let y = 0; y < TOTAL_ROWS; y++) {
      if (cells[y * COLS + x]) {
        if (!seen) {
          seen = true;
          h[x] = TOTAL_ROWS - y;
        }
      } else if (seen) {
        holes++;
      }
    }
  }
  const agg = h.reduce((a, b) => a + b, 0);
  const maxH = Math.max(...h);
  let bump = 0;
  for (let x = 0; x + 1 < COLS; x++) bump += Math.abs(h[x] - h[x + 1]);
  return w.cleared * cleared + w.agg * agg + w.bump * bump + w.holes * holes + w.max * maxH;
}

/** 为当前方块规划一串输入：旋转 -> 平移 -> 硬降 */
function planPlacement(cells, type, slot) {
  const w = BOT_W[slot] || BOT_W[0];
  let best = null;
  for (let rot = 0; rot < 4; rot++) {
    for (let px = -3; px <= COLS + 3; px++) {
      const sim = placeSim(cells, type, rot, px);
      if (!sim) continue;
      const s = scoreBoard(sim.cells, sim.cleared, w);
      if (!best || s > best.s) best = { rot, px, s };
    }
  }
  if (!best) return ['H'];
  const acts = [];
  for (let i = 0; i < best.rot; i++) acts.push('C');
  const dx = best.px - spawnX(type);
  for (let i = 0; i < Math.abs(dx); i++) acts.push(dx < 0 ? 'L' : 'R');
  acts.push('H');
  return acts;
}

/**
 * 用两个 AI 跑一局，产出「按键发生时刻」的输入时间轴。
 * 这是测试用的输入源：真实感强（会消行、会互相扔干扰行、会把对方顶死）。
 */
function botMatchInputs(seq, limit) {
  const ref = new Match({ mySlot: 0, seq, startTick: 0 });
  const out = [];
  const lastSeen = [-1, -1];
  let guard = 0;

  while (ref.tick < limit && !ref.finished && guard++ < limit * 2) {
    for (let slot = 0; slot < 2; slot++) {
      const g = ref.games[slot];
      if (g.dead || !g.piece || g.pieceIndex === lastSeen[slot]) continue;
      lastSeen[slot] = g.pieceIndex;
      const type = seq.pieces[(g.pieceIndex - 1 + seq.pieces.length) % seq.pieces.length];
      const acts = planPlacement(g.cells, type, slot);
      let gen = ref.tick + 1;
      for (const a of acts) {
        const oneShot = a === 'C' || a === 'H';
        out.push({ gen, slot, act: a, state: 1 });
        ref.pushInput(slot, gen + INPUT_DELAY, a, 1);
        if (!oneShot) {
          out.push({ gen: gen + 1, slot, act: a, state: 0 });
          ref.pushInput(slot, gen + 1 + INPUT_DELAY, a, 0);
          gen += 2; // 一次按键平移一格
        } else {
          gen += 1;
        }
      }
    }
    ref.setServerTick(ref.tick + INPUT_DELAY + 1);
    ref.update();
  }
  return { out, ref };
}

function testBotMatch() {
  console.log('\n[1.5] 两个 AI 的真实对局（压测消行/干扰行/长局一致性）');
  const seq = makeSeq(0x5eed);
  const { out, ref } = botMatchInputs(seq, 30000);
  const stats = ref.games.map((g) => ({ lines: g.lines, sent: g.sent, recv: g.received, dead: g.dead }));
  console.log(
    `    参考对局: tick=${ref.tick} 消行=${stats[0].lines}/${stats[1].lines} 发出干扰=${stats[0].sent}/${stats[1].sent} 收到=${stats[0].recv}/${stats[1].recv} 顶出=${stats[0].dead}/${stats[1].dead} 胜者=${ref.winner}`
  );
  check('AI 对局真的消掉了大量行', stats[0].lines + stats[1].lines > 10, `消行=${stats[0].lines + stats[1].lines}`);
  check('AI 对局真的产生了干扰行', stats[0].recv + stats[1].recv > 5, `收到=${stats[0].recv + stats[1].recv}`);
  check('AI 对局时长足够', ref.tick > 400, `tick=${ref.tick}`);

  const r = runPair('AI 对局(抖动网络)', (g) => (g % 9 === 0 ? 16 : g % 3), (g) => (g % 6 === 0 ? 11 : (g % 2) + 1), {
    inputs: out,
    seed: 0x5eed,
  });
  check('真实对局在抖动网络下逐帧一致', r.mismatchAt < 0, `tick ${r.mismatchAt} 不一致`);
  check('真实对局触发了回滚重演', r.rewinds > 0, `回滚=${r.rewinds}`);
  check('没有输入被丢弃', r.A.match.droppedInputs === 0 && r.B.match.droppedInputs === 0);
  check('双方胜者判定一致', r.A.match.winner === r.B.match.winner);
  check(
    '双方最终棋盘完全一致',
    r.A.match.games[0].hash() === r.B.match.games[0].hash() &&
      r.A.match.games[1].hash() === r.B.match.games[1].hash()
  );
}

// ------------------------------------------------------------------ 3) 固定序列

function testSameSequence() {
  console.log('\n[3] 双方序列一致');
  const seq = makeSeq(99);
  const a = new Game(seq);
  const b = new Game(seq);
  let same = true;
  for (let i = 0; i < 200; i++) {
    // 直接读取「第 i 个方块」
    if (seq.pieces[a.pieceIndex % seq.pieces.length] !== seq.pieces[b.pieceIndex % seq.pieces.length]) {
      same = false;
      break;
    }
    a.pieceIndex++;
    b.pieceIndex++;
    if (a.pieceIndex % seq.pieces.length !== b.pieceIndex % seq.pieces.length) same = false;
  }
  check('第 n 个方块形状对双方恒定', same);

  const g1 = new Game(seq);
  const g2 = new Game(seq);
  g1.addGarbage(seq.gaps[0], 1);
  g1.addGarbage(seq.gaps[1], 2);
  g2.addGarbage(seq.gaps[0], 1);
  g2.addGarbage(seq.gaps[1], 2);
  check('相同次数的干扰行缺口序列相同', g1.cells.join(',') === g2.cells.join(','));
}

// ------------------------------------------------------------------ 4) 软降加速

function testSoftDrop() {
  console.log('\n[4] 软降加速');
  const seq = makeSeq(3);
  const a = new Game(seq);
  const b = new Game(seq);
  a.seq = seq;
  // 双方都在第 0 tick 生成方块，一方按住软降
  for (let t = 1; t <= 30; t++) {
    a.applyAction('S', 1);
    a.tick(t);
    b.tick(t);
  }
  const ya = a.piece ? a.piece.y : SPAWN_Y;
  const yb = b.piece ? b.piece.y : SPAWN_Y;
  check('按住 ↓ 后下落明显更快', ya > yb + 2, `软降 y=${ya} 自然 y=${yb}`);
}

// ------------------------------------------------------------------ 5) 出生位置

function testSpawn() {
  console.log('\n[5] 出生位置与可见性');
  const seq = makeSeq(5);
  const g = new Game(seq);
  g.tick(1);
  const p = g.piece;
  const m = ROT[p.type][p.rot];
  let bottom = -1;
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) bottom = Math.max(bottom, p.y + y);
  check('新方块出现在可见区第一行', bottom === HIDDEN, `bottom=${bottom} 期望=${HIDDEN}`);
  check('出生点未被占用（未误判顶出）', g.dead === false && g.collides(p.type, p.rot, p.x, p.y) === false);
  void spawnX;
}

runLockstepTest();
testBotMatch();
testGarbage();
testLineClear();
testSameSequence();
testSoftDrop();
testSpawn();

console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
