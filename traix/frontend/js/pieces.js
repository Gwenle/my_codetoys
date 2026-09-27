// 七种方块：形状表 / 旋转表 / SRS 踢墙表
// 顺序必须与服务端 sequence.rs 的 0..6 完全一致：I J L O S T Z

import { HIDDEN } from './constants.js';

export const PIECE_COUNT = 7;

const BASE = [
  // 0 = I
  [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  // 1 = J
  [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  // 2 = L
  [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
  // 3 = O
  [[1, 1], [1, 1]],
  // 4 = S
  [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  // 5 = T
  [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  // 6 = Z
  [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
];

function rotateCW(m) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) {
    const row = new Array(n);
    for (let x = 0; x < n; x++) row[x] = m[n - 1 - x][y];
    out.push(row);
  }
  return out;
}

/** ROT[type][rot] = 二维矩阵，rot 0..3 */
export const ROT = BASE.map((m) => {
  const list = [m];
  for (let i = 1; i < 4; i++) list.push(rotateCW(list[i - 1]));
  return list;
});

// SRS 踢墙表：kicks[from * 4 + to] = [[dx, dy], ...]
// dy 已转换成本项目坐标系（向下为正）。
function buildTable(entries) {
  const t = new Array(16);
  for (let i = 0; i < 16; i++) t[i] = [[0, 0]];
  for (const e of entries) {
    t[e[0] * 4 + e[1]] = e[2].map((k) => [k[0], -k[1]]);
  }
  return t;
}

const JLSTZ = [
  [0, 1, [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]],
  [1, 0, [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]],
  [1, 2, [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]],
  [2, 1, [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]],
  [2, 3, [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]],
  [3, 2, [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]],
  [3, 0, [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]],
  [0, 3, [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]],
];

const IKICKS = [
  [0, 1, [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]],
  [1, 0, [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]],
  [1, 2, [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]],
  [2, 1, [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]],
  [2, 3, [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]],
  [3, 2, [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]],
  [3, 0, [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]],
  [0, 3, [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]],
];

export const KICKS_JLSTZ = buildTable(JLSTZ);
export const KICKS_I = buildTable(IKICKS);
export const KICKS_O = buildTable([]); // O 不踢墙

/** 出生点：所有方块的最下方实心行落在可见区第一行 (row = HIDDEN) */
export const SPAWN_Y = HIDDEN - 1;

export function spawnX(type) {
  return type === 3 ? 4 : 3; // O 是 2x2，居中到 4/5 列
}

export function kicksFor(type) {
  if (type === 0) return KICKS_I;
  if (type === 3) return KICKS_O;
  return KICKS_JLSTZ;
}

export const COLORS = [
  '#22d3ee', // I 青
  '#3b82f6', // J 蓝
  '#f59e0b', // L 橙
  '#facc15', // O 黄
  '#22c55e', // S 绿
  '#a855f7', // T 紫
  '#ef4444', // Z 红
];
export const GARBAGE_COLOR = '#5b6b82';
