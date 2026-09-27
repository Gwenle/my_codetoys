// 应用主逻辑：大厅 -> 匹配 -> 对局 -> 结算
import { INPUT_DELAY, TOTAL_ROWS, COLS } from './constants.js';
import { Match } from './match.js';
import { Net, defaultWsUrl, decodeB64ToBytes } from './net.js';
import { InputManager, isTouchDevice } from './input.js';
import { Backboard, NextBoard } from './render.js';

const $ = (id) => document.getElementById(id);

const el = {
  netStatus: $('netStatus'),
  netText: $('netText'),
  roomChip: $('roomChip'),
  roomCode: $('roomCode'),
  copyRoom: $('copyRoom'),
  lobbyView: $('lobbyView'),
  gameView: $('gameView'),
  nameInput: $('nameInput'),
  codeInput: $('codeInput'),
  joinBtn: $('joinBtn'),
  randomBtn: $('randomBtn'),
  lobbyHint: $('lobbyHint'),
  readyBar: $('readyBar'),
  readyText: $('readyText'),
  readyBtn: $('readyBtn'),
  leaveBtn: $('leaveBtn'),
  touchPad: $('touchPad'),
  overlay: $('overlay'),
  ovTitle: $('ovTitle'),
  ovText: $('ovText'),
  againBtn: $('againBtn'),
  ovLeaveBtn: $('ovLeaveBtn'),
  toast: $('toast'),
  meName: $('meName'),
  themName: $('themName'),
  meBadge: $('meBadge'),
  themBadge: $('themBadge'),
  mySent: $('mySent'),
  myRecv: $('myRecv'),
  myLines: $('myLines'),
  myLevel: $('myLevel'),
  myTetris: $('myTetris'),
  myRewind: $('myRewind'),
  themLines: $('themLines'),
  themRecv: $('themRecv'),
  syncState: $('syncState'),
};

const state = {
  slot: -1,
  room: '',
  myName: '',
  peerName: '',
  peerPresent: false,
  peerReady: false,
  iAmReady: false,
  match: null,
  running: false,
  startedAt: 0,
  seq: null,
  startTick: 0,
  seed: 0,
  lastGarbageToast: -9999,
};

// ---------------------------------------------------------------- 网络

const net = new Net(defaultWsUrl());
const input = new InputManager((act, st) => {
  const m = state.match;
  if (!m || !state.running) return;
  const t = m.localInput(act, st);
  net.send(`in|${t}|${act}|${st}`);
});

net
  .on('open', () => {
    setNet('on', '已连接');
  })
  .on('close', () => {
    setNet('off', '连接已断开');
    if (state.match) {
      state.running = false;
      input.setEnabled(false);
      showOverlay('连接断开', '与服务端的连接已中断，请刷新页面重试。', false);
    }
  })
  .on('error', () => setNet('off', '连接异常'))
  .on('message', onMessage);

function setNet(kind, text) {
  el.netStatus.className = `netstatus ${kind}`;
  el.netText.textContent = text;
}

function onMessage(cmd, rest) {
  switch (cmd) {
    case 'slot': {
      const [slotStr, room, name] = rest.split('|');
      state.slot = parseInt(slotStr, 10);
      state.room = room;
      state.myName = name || state.myName;
      el.roomCode.textContent = room;
      el.roomChip.hidden = false;
      el.meName.textContent = state.myName;
      el.lobbyView.hidden = true;
      el.gameView.hidden = false;
      el.readyBar.hidden = false;
      updateReadyBar();
      setNet('on', '已连接');
      resizeAll();
      break;
    }
    case 'peer': {
      const [slotStr, name] = rest.split('|');
      state.peerName = name;
      state.peerPresent = true;
      el.themName.textContent = name;
      updateReadyBar();
      toast(`${name} 已加入房间`);
      break;
    }
    case 'leave': {
      state.peerPresent = false;
      state.peerReady = false;
      state.peerName = '';
      el.themName.textContent = '对手';
      el.themBadge.textContent = '已离开';
      el.themBadge.className = 'badge';
      updateReadyBar();
      if (state.running) {
        state.running = false;
        input.setEnabled(false);
        showOverlay('对手离开了', '对手断开了连接，本局结束。', false);
      } else {
        toast('对手离开了房间');
      }
      break;
    }
    case 'ready': {
      const parts = rest.split('|');
      const slot = parseInt(parts[0], 10);
      const v = parts[1] === '1';
      if (slot === state.slot) {
        state.iAmReady = v;
      } else {
        state.peerReady = v;
      }
      updateReadyBar();
      break;
    }
    case 'start': {
      onStart(rest);
      break;
    }
    case 'tick': {
      if (state.match) state.match.setServerTick(parseInt(rest, 10) || 0);
      break;
    }
    case 'in': {
      // in|SLOT|TICK|ACT|STATE
      const parts = rest.split('|');
      if (parts.length < 4 || !state.match) break;
      const slot = parseInt(parts[0], 10);
      const tick = parseInt(parts[1], 10);
      const act = parts[2];
      const st = parts[3] === '1' ? 1 : 0;
      state.match.pushInput(slot, tick, act, st);
      break;
    }
    case 'hs': {
      const parts = rest.split('|');
      if (parts.length < 3 || !state.match) break;
      const slot = parseInt(parts[0], 10);
      const tick = parseInt(parts[1], 10);
      const hash = parseInt(parts[2], 10) >>> 0;
      state.match.checkPeerHash(slot, tick, hash);
      break;
    }
    case 'end': {
      const parts = rest.split('|');
      const winner = parseInt(parts[0], 10);
      const reason = parts[1] || 'topout';
      onServerEnd(winner, reason);
      break;
    }
    case 'err': {
      toast(rest, true);
      el.lobbyHint.textContent = rest;
      el.lobbyHint.style.color = '#f87171';
      break;
    }
    case 'pong':
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 开局

function onStart(rest) {
  // rest = SEED|START_TICK|PIECES_B64|GAPS_B64
  const parts = rest.split('|');
  if (parts.length < 4) {
    toast('开局数据不完整', true);
    return;
  }
  state.seed = parseInt(parts[0], 10);
  state.startTick = parseInt(parts[1], 10);
  const pieces = decodeB64ToBytes(parts[2]);
  const gaps = decodeB64ToBytes(parts[3]);
  state.seq = { pieces, gaps };
  state.match = new Match({ mySlot: state.slot, seq: state.seq, startTick: state.startTick });
  state.match.setServerTick(state.startTick);
  state.running = true;
  state.lastGarbageToast = -9999;
  el.overlay.hidden = true;
  state.iAmReady = false;
  el.readyBtn.textContent = '我准备好了';
  el.meBadge.textContent = '对战中';
  el.meBadge.className = 'badge live';
  el.themBadge.textContent = '对战中';
  el.themBadge.className = 'badge live';
  input.setEnabled(true);
  updateReadyBar();
  toast('开始！双方方块序列已锁定');
}

function onServerEnd(winner, reason) {
  state.running = false;
  input.setEnabled(false);
  const win = winner === state.slot;
  const draw = winner < 0;
  const reasonText =
    reason === 'leave'
      ? '对手断线，你获胜。'
      : draw
      ? '双方同时顶出，平局。'
      : win
      ? '对手顶出，本局你获胜！'
      : '你的方块堆到了顶端，本局失败。';
  showOverlay(draw ? '平局' : win ? '胜利' : '失败', reasonText, win);
  el.meBadge.textContent = draw ? '平局' : win ? '胜利' : '失败';
  el.meBadge.className = `badge ${win ? 'live' : 'dead'}`;
  el.themBadge.textContent = draw ? '平局' : win ? '失败' : '胜利';
  el.themBadge.className = `badge ${win ? 'dead' : 'live'}`;
  updateReadyBar();
}

function showOverlay(title, text, win) {
  el.ovTitle.textContent = title;
  el.ovTitle.className = win ? 'win' : win === false ? 'lose' : '';
  el.ovText.textContent = text;
  el.overlay.hidden = false;
}

// ---------------------------------------------------------------- 大厅交互

el.joinBtn.addEventListener('click', doJoin);
el.randomBtn.addEventListener('click', () => {
  el.codeInput.value = '';
  doJoin();
});
el.codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoin();
});
el.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoin();
});

function doJoin() {
  const name = (el.nameInput.value || '').trim() || `玩家${Math.floor(Math.random() * 900 + 100)}`;
  const code = (el.codeInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  state.myName = name;
  localStorage.setItem('traix.name', name);
  const go = () => {
    net.send(`join|${code}|${name}`);
    setNet('busy', '加入房间…');
  };
  if (net.connected) {
    go();
  } else {
    net.on('open', go);
    setNet('busy', '连接中…');
    net.connect();
  }
}

el.copyRoom.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.room);
    toast('房间号已复制');
  } catch (e) {
    toast(`房间号：${state.room}`);
  }
});

el.readyBtn.addEventListener('click', () => {
  state.iAmReady = !state.iAmReady;
  net.send(`ready|${state.iAmReady ? 1 : 0}`);
  updateReadyBar();
});

el.leaveBtn.addEventListener('click', leaveRoom);
el.ovLeaveBtn.addEventListener('click', leaveRoom);

function leaveRoom() {
  net.close();
  state.running = false;
  state.match = null;
  input.setEnabled(false);
  el.overlay.hidden = true;
  el.gameView.hidden = true;
  el.readyBar.hidden = true;
  el.roomChip.hidden = true;
  el.lobbyView.hidden = false;
  el.lobbyHint.style.color = '';
  el.lobbyHint.textContent = '已离开房间。输入房间号可以再次进入。';
  setNet('off', '已断开');
  // 重新连接以便再次加入
  setTimeout(() => {
    net.on('open', () => setNet('on', '已连接'));
    net.connect();
  }, 120);
}

el.againBtn.addEventListener('click', () => {
  el.overlay.hidden = true;
  // 不本地猜状态：准备状态一律以服务端广播为准
  net.send('ready|1');
  toast('已准备好，等待对手…');
});

function updateReadyBar() {
  if (!state.peerPresent) {
    el.readyText.textContent = '等待对手加入…把房间号发给朋友吧';
    el.readyBtn.disabled = true;
  } else if (state.iAmReady && state.peerReady) {
    el.readyText.textContent = '双方已准备，开始！';
    el.readyBtn.disabled = false;
    el.readyBtn.textContent = '取消准备';
  } else if (state.iAmReady) {
    el.readyText.textContent = `已准备，等待 ${state.peerName || '对手'} 准备…`;
    el.readyBtn.disabled = false;
    el.readyBtn.textContent = '取消准备';
  } else if (state.peerReady) {
    el.readyText.textContent = `${state.peerName || '对手'} 已准备，等你确认`;
    el.readyBtn.disabled = false;
    el.readyBtn.textContent = '我准备好了';
  } else {
    el.readyText.textContent = '双方都点击「我准备好了」后开始对局';
    el.readyBtn.disabled = false;
    el.readyBtn.textContent = '我准备好了';
  }
}

let toastTimer = 0;
function toast(msg, bad = false) {
  el.toast.textContent = msg;
  el.toast.className = bad ? 'toast bad' : 'toast';
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2400);
}

// ---------------------------------------------------------------- 渲染

const boardMe = new Backboard($('boardMe'), { showGhost: true });
const boardThem = new Backboard($('boardThem'), { showGhost: false });
const nextBoard = new NextBoard($('nextCanvas'), 5);

function resizeAll() {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const narrow = vw < 900;

  let cell = Math.floor((vh - 260) / TOTAL_ROWS);
  cell = Math.min(cell, Math.floor((vw - (narrow ? 40 : 380)) / COLS));
  cell = Math.max(cell, 11);
  cell = Math.min(cell, 30);
  boardMe.resize(cell);

  const themCell = Math.max(7, Math.min(Math.round(cell * 0.52), Math.floor((vw - 60) / (COLS * 3))));
  boardThem.resize(Math.max(7, themCell));

  const nCell = Math.max(7, Math.round(cell * 0.4));
  nextBoard.resize(Math.round(nCell * 4.6), nCell);

  if (isTouchDevice()) el.touchPad.hidden = false;
}

window.addEventListener('resize', () => {
  if (!el.gameView.hidden) resizeAll();
});

let lastFrameStats = 0;

/**
 * 模拟主循环的驱动源。
 *
 * 为什么不能只用 setInterval：
 *   浏览器会冻结后台标签页的定时器（实测 requestAnimationFrame 完全停止、
 *   setInterval 也会被冻结），玩家一切到别的标签页，本地模拟就停摆 ——
 *   方块不动、永远不会被顶出，回来时还和对手脱节。
 *
 * 所以把心跳放在 Web Worker 里（Worker 的定时器不会被冻结），
 * 主线程收到心跳就推进模拟。Worker 不可用时退回 setInterval。
 */
function startHeartbeat(onTick) {
  try {
    const src =
      'let id=setInterval(()=>postMessage(1),16);' +
      "onmessage=(e)=>{if(e.data==='stop'){clearInterval(id);self.close();}};";
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = () => onTick();
    return () => {
      try {
        w.postMessage('stop');
        w.terminate();
      } catch (e) {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    };
  } catch (e) {
    const id = setInterval(onTick, 16);
    return () => clearInterval(id);
  }
}

function simLoop() {
  const m = state.match;
  if (!m) return;
  m.update();

  if (m.mine.dead && !m._reported) {
    m._reported = true;
    net.send(`dead|${m.tick}`);
  }
  if (!m.finished) {
    const h = m.maybeHash();
    if (h) net.send(`hs|${h.tick}|${h.hash}`);
  }
}
startHeartbeat(simLoop);

// 双保险：恢复可见时立刻追赶一次
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) simLoop();
});

function frame() {
  const m = state.match;
  if (m) {
    boardMe.draw(m.mine, { waiting: !state.running && !m.finished && m.tick < state.startTick + INPUT_DELAY });
    boardThem.draw(m.theirs, { waiting: m.tick < state.startTick + INPUT_DELAY });
    nextBoard.draw(m.mine);

    const now = performance.now();
    if (now - lastFrameStats > 100) {
      lastFrameStats = now;
      el.mySent.textContent = m.mine.sent;
      el.myRecv.textContent = m.mine.received;
      el.myLines.textContent = m.mine.lines;
      el.myLevel.textContent = m.mine.level + 1;
      el.myTetris.textContent = m.mine.tetris;
      el.myRewind.textContent = m.rewinds;
      el.themLines.textContent = m.theirs.lines;
      el.themRecv.textContent = m.theirs.received;

      const bad = m.hashMismatch > 0 || m.droppedInputs > 0;
      el.syncState.textContent = bad ? '异常' : '正常';
      el.syncState.parentElement.className = `chip ${bad ? 'sync-bad' : 'sync-ok'}`;
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 启动

(function boot() {
  // 调试用：浏览器控制台里可以直接 __traix.match.mine 查看棋盘模拟状态
  window.__traix = state;
  const savedName = localStorage.getItem('traix.name');
  if (savedName) el.nameInput.value = savedName;
  const qs = new URLSearchParams(location.search);
  const room = qs.get('room');
  if (room) el.codeInput.value = room.toUpperCase();
  if (isTouchDevice()) {
    el.lobbyHint.textContent =
      '检测到触屏设备：进入房间后下方会出现虚拟按键。同房间号的两人自动配对。';
  }
  net.connect();
  requestAnimationFrame(frame);
})();
