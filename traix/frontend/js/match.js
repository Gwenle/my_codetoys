// 锁定步（lockstep）对战引擎。
//
// 设计要点：
//   * 服务端只提供权威 60Hz tick 时钟和转发输入，不做模拟。
//   * 每个客户端同时模拟**两块棋盘**（自己的 + 对手的），
//     所以对手画面不是「同步过来的」，而是本地算出来的 —— 带宽只需要按键事件。
//   * 双方输入都排进「未来」的 tick（INPUT_DELAY）生效，因此双方时间轴一致。
//   * 万一对手的输入迟到（网络抖动），回滚到自己保留的快照重新推演，
//     保证两台机器结果永远逐格一致。
//   * 消行 -> 干扰行的派发完全由确定性模拟推导，不需要网络同步。
//     干扰行缺口来自服务端下发的固定序列，双方各自消费同一序列。

import { INPUT_DELAY, SNAPSHOT_KEEP } from './constants.js';
import { Game } from './game.js';

export class Match {
  /**
   * @param {object} opts
   * @param {number} opts.mySlot  我是 0 还是 1
   * @param {{pieces:Uint8Array, gaps:Uint8Array}} opts.seq 服务端下发序列
   * @param {number} opts.startTick 服务端开局 tick
   */
  constructor({ mySlot, seq, startTick }) {
    this.mySlot = mySlot;
    this.seq = seq;
    this.games = [new Game(seq), new Game(seq)];
    this.inputs = [new Map(), new Map()]; // slot -> Map<tick, [[act,state],...]>
    this.snaps = new Map(); // tick -> [snapA, snapB, gapCursorA, gapCursorB, winner]
    this.gapCursor = [0, 0];
    this.tick = startTick;
    this.serverTick = startTick;
    this.finished = false;
    this.winner = -1;
    this.rewinds = 0;
    this.droppedInputs = 0;
    this.hashMismatch = 0;
    this._lastHashTick = 0;
    // tick -> 该 tick 两块棋盘的哈希，用于与对手上报的哈希做「同 tick」比对
    this.hist = [new Map(), new Map()];
  }

  get mine() {
    return this.games[this.mySlot];
  }
  get theirs() {
    return this.games[1 - this.mySlot];
  }

  // -------------------------------------------------- 时间轴

  setServerTick(t) {
    if (t > this.serverTick) this.serverTick = t;
  }

  /** 把模拟推进到「服务端 tick - 输入延迟」 */
  update() {
    if (this.finished) return;
    const target = this.serverTick - INPUT_DELAY;
    if (this.tick >= target) return;
    // 单帧最多追 600 tick（10 秒）。
    // 浏览器会把后台标签页的定时器节流到 ~1Hz，这里给足追赶能力，
    // 保证「切到后台再切回来」不会掉队（掉队 = 不同步 = 对局作废）。
    const step = Math.min(target - this.tick, 600);
    this.advanceTo(this.tick + step);
  }

  advanceTo(target) {
    while (this.tick < target && !this.finished) {
      const t = this.tick + 1;
      this.step(t);
      this.tick = t;
      this.storeSnapshot(t);
      this.prune();
    }
  }

  /** 一个逻辑帧：先应用双方输入，再跑两块棋盘，最后派发干扰行 */
  step(t) {
    for (let s = 0; s < 2; s++) {
      const acts = this.inputs[s].get(t);
      if (acts) {
        for (let i = 0; i < acts.length; i++) {
          this.games[s].applyAction(acts[i][0], acts[i][1]);
        }
      }
    }

    for (let s = 0; s < 2; s++) this.games[s].tick(t);

    for (let s = 0; s < 2; s++) {
      const n = this.games[s].takeGarbage();
      if (n <= 0) continue;
      const other = 1 - s;
      for (let i = 0; i < n; i++) {
        const gaps = this.seq.gaps;
        const gap = gaps[this.gapCursor[other] % gaps.length];
        this.gapCursor[other]++;
        this.games[other].addGarbage(gap, t);
      }
    }

    if (!this.finished) {
      const a = this.games[0].dead;
      const b = this.games[1].dead;
      if (a || b) {
        this.finished = true;
        // 两方同帧顶出：判平局
        this.winner = a && b ? -1 : a ? 1 : 0;
      }
    }
  }

  // -------------------------------------------------- 输入

  /**
   * 把一个输入排进时间轴。
   * @param {number} slot 谁的操作
   * @param {number} tick 在哪个 tick 生效
   */
  pushInput(slot, tick, act, state) {
    let list = this.inputs[slot].get(tick);
    if (!list) {
      list = [];
      this.inputs[slot].set(tick, list);
    }
    list.push([act, state]);

    if (tick <= this.tick) {
      // 输入迟到：回滚到该 tick 之前，再重演到现在。
      // 注意：即使本局已经结束也要走这条路。否则「先结束的那一方」会丢弃迟到输入，
      // 而「后来才判定结束的一方」会重演它 —— 两台机器就会不一致。
      const target = this.tick;
      if (this.rewindTo(tick - 1)) {
        this.rewinds++;
        this.advanceTo(target);
      } else {
        // 超出快照窗口，只能在当前 tick 生效（会导致不同步，UI 会提示）
        this.droppedInputs++;
        this.games[slot].applyAction(act, state);
      }
    }
  }

  /** 本地玩家的操作：排在 INPUT_DELAY 帧之后生效（双方一致） */
  localInput(act, state) {
    const t = this.tick + INPUT_DELAY;
    this.pushInput(this.mySlot, t, act, state);
    return t;
  }

  // -------------------------------------------------- 快照 / 回滚

  storeSnapshot(t) {
    this.snaps.set(t, [
      this.games[0].snapshot(),
      this.games[1].snapshot(),
      this.gapCursor[0],
      this.gapCursor[1],
      this.winner,
    ]);
    this.hist[0].set(t, this.games[0].hash());
    this.hist[1].set(t, this.games[1].hash());
  }

  rewindTo(t) {
    const s = this.snaps.get(t);
    if (!s) return false;
    this.games[0].restore(s[0]);
    this.games[1].restore(s[1]);
    this.gapCursor[0] = s[2];
    this.gapCursor[1] = s[3];
    this.winner = s[4];
    this.finished = false;
    this.tick = t;
    const stale = [];
    for (const k of this.snaps.keys()) if (k > t) stale.push(k);
    for (const k of stale) this.snaps.delete(k);
    for (let i = 0; i < 2; i++) {
      const gone = [];
      for (const k of this.hist[i].keys()) if (k > t) gone.push(k);
      for (const k of gone) this.hist[i].delete(k);
    }
    return true;
  }

  prune() {
    const limit = this.tick - SNAPSHOT_KEEP;
    if (limit <= 0) return;
    const stale = [];
    for (const k of this.snaps.keys()) if (k < limit) stale.push(k);
    for (const k of stale) this.snaps.delete(k);
    for (let s = 0; s < 2; s++) {
      const m = this.inputs[s];
      const gone = [];
      for (const k of m.keys()) if (k < limit) gone.push(k);
      for (const k of gone) m.delete(k);
      const gh = this.hist[s];
      const gone2 = [];
      for (const k of gh.keys()) if (k < limit) gone2.push(k);
      for (const k of gone2) gh.delete(k);
    }
  }

  // -------------------------------------------------- 不同步检测

  /** 每隔一段时间上报「我自己的棋盘」在某个 tick 的哈希，对手会比对 */
  maybeHash() {
    if (this.tick - this._lastHashTick < 90) return null;
    this._lastHashTick = this.tick;
    return { tick: this.tick, hash: this.games[this.mySlot].hash() };
  }

  /**
   * 收到对手上报的哈希。
   * 对手上报的是「对手棋盘」在 tick T 的状态；我本地在 T 时刻也模拟了对手棋盘，
   * 两者应当逐格一致。不一致说明发生不同步。
   */
  checkPeerHash(peerSlot, tick, hash) {
    if (peerSlot === this.mySlot) return;
    const local = this.hist[peerSlot].get(tick);
    if (local === undefined) return;
    if (local !== hash) this.hashMismatch++;
  }
}
