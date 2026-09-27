// Canvas 渲染。可以画两块棋盘：自己的（大）和对手的（小）。
// 整块棋盘含顶部 4 行缓冲行（干扰行会把方块往上推，这 4 行就是缓冲）。

import { COLS, TOTAL_ROWS, HIDDEN, GARBAGE_ID } from './constants.js';
import { COLORS, GARBAGE_COLOR, ROT } from './pieces.js';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawCell(ctx, px, py, cell, color) {
  const pad = Math.max(1, cell * 0.06);
  const x = px + pad;
  const y = py + pad;
  const s = cell - pad * 2;
  const r = Math.max(2, cell * 0.18);

  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  if (color === GARBAGE_COLOR) {
    g.addColorStop(0, '#6d7d96');
    g.addColorStop(1, '#3f4c60');
  } else {
    g.addColorStop(0, color);
    g.addColorStop(1, shade(color, -0.35));
  }
  ctx.fillStyle = g;
  roundRect(ctx, x, y, s, s, r);
  ctx.fill();

  // 顶部高光
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  roundRect(ctx, x + s * 0.12, y + s * 0.1, s * 0.76, Math.max(1, s * 0.14), r * 0.6);
  ctx.fill();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r + r * amt)));
  g = Math.max(0, Math.min(255, Math.round(g + g * amt)));
  b = Math.max(0, Math.min(255, Math.round(b + b * amt)));
  return `rgb(${r},${g},${b})`;
}

function colorFor(v) {
  if (v === GARBAGE_ID) return GARBAGE_COLOR;
  return COLORS[v - 1] || '#888';
}

/** 计算方块所有实心格坐标 */
export function pieceCells(type, rot, px, py) {
  const m = ROT[type][rot];
  const out = [];
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (m[y][x]) out.push([px + x, py + y]);
    }
  }
  return out;
}

export class Backboard {
  constructor(canvas, { showGhost = false, scale = 1 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showGhost = showGhost;
    this.scale = scale;
    this.cell = 24;
  }

  resize(cellSize) {
    this.cell = cellSize;
    const w = COLS * cellSize;
    const h = TOTAL_ROWS * cellSize;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  draw(game, opts = {}) {
    const ctx = this.ctx;
    const cell = this.cell;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);

    // 棋盘底
    ctx.fillStyle = 'rgba(6, 10, 20, 0.55)';
    ctx.fillRect(0, 0, w, h);

    // 网格
    if (cell >= 12) {
      ctx.strokeStyle = 'rgba(120, 160, 255, 0.07)';
      ctx.lineWidth = 1;
      for (let x = 1; x < COLS; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cell + 0.5, 0);
        ctx.lineTo(x * cell + 0.5, h);
        ctx.stroke();
      }
      for (let y = 1; y < TOTAL_ROWS; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cell + 0.5);
        ctx.lineTo(w, y * cell + 0.5);
        ctx.stroke();
      }
    }

    // 已固定方块
    for (let y = 0; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = game.cells[y * COLS + x];
        if (v) drawCell(ctx, x * cell, y * cell, cell, colorFor(v));
      }
    }

    // 幽灵 + 当前方块
    const p = game.piece;
    if (p && !game.dead) {
      if (this.showGhost) {
        const gy = game.ghostY();
        if (gy !== p.y) {
          ctx.globalAlpha = 0.22;
          for (const c of pieceCells(p.type, p.rot, p.x, gy)) {
            if (c[1] < 0) continue;
            drawCell(ctx, c[0] * cell, c[1] * cell, cell, COLORS[p.type]);
          }
          ctx.globalAlpha = 1;
        }
      }
      for (const c of pieceCells(p.type, p.rot, p.x, p.y)) {
        if (c[1] < 0) continue;
        drawCell(ctx, c[0] * cell, c[1] * cell, cell, COLORS[p.type]);
      }
    }

    // 缓冲行压暗
    ctx.fillStyle = 'rgba(3, 6, 14, 0.62)';
    ctx.fillRect(0, 0, w, HIDDEN * cell);

    // 缓冲区分界线
    ctx.strokeStyle = 'rgba(120, 160, 255, 0.28)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, HIDDEN * cell + 0.5);
    ctx.lineTo(w, HIDDEN * cell + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // 消行闪光
    if (game.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.05 * game.flash})`;
      ctx.fillRect(0, HIDDEN * cell, w, h - HIDDEN * cell);
    }

    // 刚刚收到干扰行的红色警示
    const age = game.lastTick - game.lastGarbageTick;
    if (game.lastGarbageTick >= 0 && age >= 0 && age < 14) {
      const a = (1 - age / 14) * 0.5;
      ctx.fillStyle = `rgba(248,113,113,${a})`;
      const rows = Math.min(game.lastGarbageRows, TOTAL_ROWS);
      ctx.fillRect(0, h - rows * cell, w, rows * cell);
    }

    // 危险区（堆到缓冲行）
    if (opts.danger !== false && game.stackHeight() > TOTAL_ROWS - HIDDEN - 3) {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, 'rgba(248,113,113,0.45)');
      grad.addColorStop(0.5, 'rgba(248,113,113,0.15)');
      grad.addColorStop(1, 'rgba(248,113,113,0.45)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, 3);
    }

    // 顶出遮罩
    if (game.dead) {
      ctx.fillStyle = 'rgba(140, 20, 20, 0.32)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,220,220,0.9)';
      ctx.font = `700 ${Math.round(cell * 0.9)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GAME OVER', w / 2, h / 2);
    }

    // 等待开局
    if (opts.waiting) {
      ctx.fillStyle = 'rgba(6, 10, 20, 0.7)';
      ctx.fillRect(0, 0, w, h);
    }
  }
}

/** 绘制「下一个」预览 */
export class NextBoard {
  constructor(canvas, count = 5) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.count = count;
  }

  resize(width, cell) {
    this.cell = cell;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const h = this.count * cell * 3;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = width;
    this.h = h;
  }

  draw(game) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const seq = game.seq.pieces;
    const cell = this.cell;
    const slotH = cell * 3;

    for (let i = 0; i < this.count; i++) {
      const type = seq[(game.pieceIndex + i) % seq.length];
      const m = ROT[type][0];
      // 求形状包围盒
      let minX = 9, maxX = -1, minY = 9, maxY = -1;
      for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m.length; x++) {
          if (m[y][x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const bw = (maxX - minX + 1) * cell;
      const bh = (maxY - minY + 1) * cell;
      const ox = (this.w - bw) / 2 - minX * cell;
      const oy = i * slotH + (slotH - bh) / 2 - minY * cell;
      ctx.globalAlpha = i === 0 ? 1 : 0.72;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (m[y][x]) drawCell(ctx, ox + x * cell, oy + y * cell, cell, COLORS[type]);
        }
      }
      ctx.globalAlpha = 1;
    }
  }
}
