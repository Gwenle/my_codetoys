// 单个玩家的棋盘模拟。
//
// 这个类必须是**完全确定性**的：给定相同的初始序列 + 相同的输入时间轴，
// 双方客户端跑出来的结果必须逐格一致。所以：
//   * 不读取 Date.now() / Math.random()
//   * tick 号由外部（服务端时钟）驱动
//   * 所有会影响结果的量都能被 snapshot/restore

import {
  COLS,
  TOTAL_ROWS,
  DAS,
  ARR,
  SOFT_MULT,
  LOCK_DELAY,
  MAX_LOCK_RESETS,
  GRAVITY_TABLE,
  GARBAGE_ID,
} from './constants.js';
import { ROT, spawnX, kicksFor, SPAWN_Y } from './pieces.js';

export class Game {
  constructor(seq) {
    this.seq = seq;
    this.reset();
  }

  reset() {
    this.cells = new Uint8Array(TOTAL_ROWS * COLS);
    this.piece = null;
    this.pieceIndex = 0;
    this.gravityAcc = 0;
    this.lockTimer = LOCK_DELAY;
    this.lockResets = 0;
    this.wasGrounded = false;
    this.dasDir = 0;
    this.dasTimer = 0;
    this.arrTimer = 0;
    this.held = { L: false, R: false, S: false };
    this.lines = 0;
    this.singles = 0;
    this.doubles = 0;
    this.triples = 0;
    this.tetris = 0;
    this.level = 0;
    this.sent = 0;
    this.received = 0;
    this.outGarbage = 0;
    this.dead = false;
    this.deathTick = 0;
    this.lastTick = 0;
    this.flash = 0;
    this.lastGarbageTick = -9999;
    this.lastGarbageRows = 0;
    this.piecesSpawned = 0;
  }

  // -------------------------------------------------- 查询

  gravityTicks() {
    const i = Math.min(this.level, GRAVITY_TABLE.length - 1);
    return GRAVITY_TABLE[i];
  }

  collides(type, rot, px, py) {
    const m = ROT[type][rot];
    const n = m.length;
    for (let y = 0; y < n; y++) {
      const row = m[y];
      for (let x = 0; x < n; x++) {
        if (!row[x]) continue;
        const bx = px + x;
        const by = py + y;
        if (bx < 0 || bx >= COLS || by >= TOTAL_ROWS) return true;
        if (by >= 0 && this.cells[by * COLS + bx]) return true;
      }
    }
    return false;
  }

  pieceCollides() {
    const p = this.piece;
    return p ? this.collides(p.type, p.rot, p.x, p.y) : false;
  }

  /** 当前方块是否已经落地（下方会被挡住） */
  isGrounded() {
    const p = this.piece;
    return p ? this.collides(p.type, p.rot, p.x, p.y + 1) : false;
  }

  /** 幽灵方块落点 */
  ghostY() {
    const p = this.piece;
    if (!p) return 0;
    let y = p.y;
    while (!this.collides(p.type, p.rot, p.x, y + 1)) y++;
    return y;
  }

  /** 堆叠高度（用于危险指示） */
  stackHeight() {
    for (let y = 0; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (this.cells[y * COLS + x]) return TOTAL_ROWS - y;
      }
    }
    return 0;
  }

  /** 供不同步检测用的轻量哈希 */
  hash() {
    let h = 2166136261 >>> 0;
    const c = this.cells;
    for (let i = 0; i < c.length; i++) {
      h ^= c[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    const p = this.piece;
    const extra = p ? p.type * 1000 + p.rot * 100 + p.x * 10 + p.y : 0;
    h ^= extra >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= this.pieceIndex >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= this.lines >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    return h >>> 0;
  }

  // -------------------------------------------------- 输入

  applyAction(a, s) {
    if (this.dead) return;
    if (a === 'L' || a === 'R') {
      const on = !!s;
      if (a === 'L') this.held.L = on;
      else this.held.R = on;
      if (on) {
        this.dasDir = a === 'L' ? -1 : 1;
        this.dasTimer = DAS;
        this.arrTimer = 0;
        this.tryMove(this.dasDir, 0);
      } else if (this.dasDir === (a === 'L' ? -1 : 1)) {
        this.dasDir = this.held.L ? -1 : this.held.R ? 1 : 0;
        this.dasTimer = DAS;
        this.arrTimer = 0;
      }
      return;
    }
    if (a === 'S') {
      this.held.S = !!s;
      return;
    }
    if (!s) return;
    if (a === 'C') this.rotate(1);
    else if (a === 'W') this.rotate(-1);
    else if (a === 'H') this.hardDrop();
  }

  updateDas() {
    if (!this.dasDir) return;
    if (this.dasTimer > 0) {
      this.dasTimer--;
      return;
    }
    this.arrTimer++;
    if (this.arrTimer >= ARR) {
      this.arrTimer = 0;
      this.tryMove(this.dasDir, 0);
    }
  }

  // -------------------------------------------------- 操作

  onMoved() {
    if (this.wasGrounded && this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = LOCK_DELAY;
      this.lockResets++;
    }
  }

  tryMove(dx, dy) {
    const p = this.piece;
    if (!p) return false;
    if (this.collides(p.type, p.rot, p.x + dx, p.y + dy)) return false;
    p.x += dx;
    p.y += dy;
    this.onMoved();
    return true;
  }

  rotate(dir) {
    const p = this.piece;
    if (!p) return;
    const from = p.rot;
    const to = (from + (dir > 0 ? 1 : 3)) % 4;
    const kicks = kicksFor(p.type)[from * 4 + to];
    for (let i = 0; i < kicks.length; i++) {
      const nx = p.x + kicks[i][0];
      const ny = p.y + kicks[i][1];
      if (!this.collides(p.type, to, nx, ny)) {
        p.rot = to;
        p.x = nx;
        p.y = ny;
        this.onMoved();
        return;
      }
    }
  }

  hardDrop() {
    const p = this.piece;
    if (!p) return;
    let d = 0;
    while (!this.collides(p.type, p.rot, p.x, p.y + 1)) {
      p.y++;
      d++;
    }
    this.lockPiece();
  }

  // -------------------------------------------------- 一个逻辑帧

  tick(t) {
    if (this.dead) return;
    this.lastTick = t;
    if (this.flash > 0) this.flash--;

    if (!this.piece) {
      this.spawn(t);
      return;
    }

    this.updateDas();
    if (this.dead || !this.piece) return;

    // 重力 / 软降
    const g = this.gravityTicks();
    this.gravityAcc += this.held.S ? SOFT_MULT : 1;
    while (this.gravityAcc >= g) {
      this.gravityAcc -= g;
      if (!this.tryMove(0, 1)) {
        this.gravityAcc = 0;
        break;
      }
    }
    if (this.dead || !this.piece) return;

    // 锁定延迟
    const grounded = this.isGrounded();
    if (grounded) {
      if (!this.wasGrounded) {
        this.lockTimer = LOCK_DELAY;
        this.lockResets = 0;
        this.wasGrounded = true;
      }
      this.lockTimer--;
      if (this.lockTimer <= 0) this.lockPiece();
    } else {
      this.wasGrounded = false;
      this.lockTimer = LOCK_DELAY;
    }
  }

  spawn(t) {
    const seq = this.seq.pieces;
    const type = seq[this.pieceIndex % seq.length];
    this.pieceIndex++;
    this.piecesSpawned++;
    const p = { type, rot: 0, x: spawnX(type), y: SPAWN_Y };
    this.gravityAcc = 0;
    this.lockTimer = LOCK_DELAY;
    this.lockResets = 0;
    this.wasGrounded = false;
    this.piece = p;
    if (this.collides(p.type, p.rot, p.x, p.y)) {
      this.piece = p;
      this.die(t);
    }
  }

  lockPiece() {
    const p = this.piece;
    if (!p) return;
    const m = ROT[p.type][p.rot];
    const n = m.length;
    let overflow = false;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!m[y][x]) continue;
        const bx = p.x + x;
        const by = p.y + y;
        if (by < 0) {
          overflow = true;
          continue;
        }
        if (by < TOTAL_ROWS && bx >= 0 && bx < COLS) {
          this.cells[by * COLS + bx] = p.type + 1;
        }
      }
    }
    this.piece = null;
    this.gravityAcc = 0;
    this.wasGrounded = false;

    // 消行
    let cleared = 0;
    let y = TOTAL_ROWS - 1;
    while (y >= 0) {
      let full = true;
      const base = y * COLS;
      for (let x = 0; x < COLS; x++) {
        if (!this.cells[base + x]) {
          full = false;
          break;
        }
      }
      if (full) {
        // 上面的行整体下移一行
        this.cells.copyWithin(COLS, 0, base);
        this.cells.fill(0, 0, COLS);
        cleared++;
      } else {
        y--;
      }
    }

    if (cleared > 0) {
      this.lines += cleared;
      if (cleared === 1) this.singles++;
      else if (cleared === 2) this.doubles++;
      else if (cleared === 3) this.triples++;
      else this.tetris++;
      this.level = Math.floor(this.lines / 10);
      // 消 1 行 = 给对手制造 1 行干扰行
      this.outGarbage += cleared;
      this.flash = 8;
    }

    if (overflow) this.die(this.lastTick);
  }

  /** 本帧产生的、需要发给对手的干扰行数量 */
  takeGarbage() {
    const n = this.outGarbage;
    this.outGarbage = 0;
    if (n > 0) this.sent += n;
    return n;
  }

  /**
   * 收到一行干扰行：最下层出现一行带缺口的实心行，现有方块整体上推一行。
   * gap 由服务端下发的缺口序列决定。
   */
  addGarbage(gap, t) {
    if (this.dead) return;
    this.received++;
    if (this.lastGarbageTick !== t) {
      this.lastGarbageTick = t;
      this.lastGarbageRows = 0;
    }
    this.lastGarbageRows++;

    // 被顶出棋盘顶端的方块 => 直接判负
    let lost = false;
    for (let x = 0; x < COLS; x++) {
      if (this.cells[x]) {
        lost = true;
        break;
      }
    }

    this.cells.copyWithin(0, COLS, TOTAL_ROWS * COLS);
    const base = (TOTAL_ROWS - 1) * COLS;
    for (let x = 0; x < COLS; x++) {
      this.cells[base + x] = x === gap ? 0 : GARBAGE_ID;
    }

    if (lost) {
      this.die(t);
      return;
    }

    // 正在下落的方块一起被上推
    if (this.piece) {
      let guard = 0;
      while (this.pieceCollides() && guard < TOTAL_ROWS) {
        this.piece.y--;
        guard++;
      }
      if (this.pieceCollides() || this.pieceTopRow() < 0) {
        this.die(t);
        return;
      }
      this.wasGrounded = false;
      this.lockTimer = LOCK_DELAY;
    }
  }

  pieceTopRow() {
    const p = this.piece;
    if (!p) return 0;
    const m = ROT[p.type][p.rot];
    for (let y = 0; y < m.length; y++) {
      for (let x = 0; x < m.length; x++) {
        if (m[y][x]) return p.y + y;
      }
    }
    return 0;
  }

  die(t) {
    if (this.dead) return;
    this.dead = true;
    this.deathTick = t;
    this.piece = null;
    this.held.L = false;
    this.held.R = false;
    this.held.S = false;
    this.dasDir = 0;
  }

  // -------------------------------------------------- 快照（用于回滚重演）

  snapshot() {
    const p = this.piece;
    return {
      cells: this.cells.slice(),
      piece: p ? [p.type, p.rot, p.x, p.y] : null,
      pieceIndex: this.pieceIndex,
      gravityAcc: this.gravityAcc,
      lockTimer: this.lockTimer,
      lockResets: this.lockResets,
      wasGrounded: this.wasGrounded,
      dasDir: this.dasDir,
      dasTimer: this.dasTimer,
      arrTimer: this.arrTimer,
      hL: this.held.L,
      hR: this.held.R,
      hS: this.held.S,
      lines: this.lines,
      singles: this.singles,
      doubles: this.doubles,
      triples: this.triples,
      tetris: this.tetris,
      level: this.level,
      sent: this.sent,
      received: this.received,
      outGarbage: this.outGarbage,
      dead: this.dead,
      deathTick: this.deathTick,
      flash: this.flash,
      lastGarbageTick: this.lastGarbageTick,
      lastGarbageRows: this.lastGarbageRows,
      piecesSpawned: this.piecesSpawned,
      lastTick: this.lastTick,
    };
  }

  restore(s) {
    this.cells.set(s.cells);
    this.piece = s.piece ? { type: s.piece[0], rot: s.piece[1], x: s.piece[2], y: s.piece[3] } : null;
    this.pieceIndex = s.pieceIndex;
    this.gravityAcc = s.gravityAcc;
    this.lockTimer = s.lockTimer;
    this.lockResets = s.lockResets;
    this.wasGrounded = s.wasGrounded;
    this.dasDir = s.dasDir;
    this.dasTimer = s.dasTimer;
    this.arrTimer = s.arrTimer;
    this.held.L = s.hL;
    this.held.R = s.hR;
    this.held.S = s.hS;
    this.lines = s.lines;
    this.singles = s.singles;
    this.doubles = s.doubles;
    this.triples = s.triples;
    this.tetris = s.tetris;
    this.level = s.level;
    this.sent = s.sent;
    this.received = s.received;
    this.outGarbage = s.outGarbage;
    this.dead = s.dead;
    this.deathTick = s.deathTick;
    this.flash = s.flash;
    this.lastGarbageTick = s.lastGarbageTick;
    this.lastGarbageRows = s.lastGarbageRows;
    this.piecesSpawned = s.piecesSpawned;
    this.lastTick = s.lastTick;
  }
}
