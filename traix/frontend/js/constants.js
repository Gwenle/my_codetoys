// 全局常量与手感参数
export const COLS = 10;
export const ROWS = 20; // 可见行数
export const HIDDEN = 4; // 可见区上方的缓冲行（干扰行会往上推，需要缓冲）
export const TOTAL_ROWS = ROWS + HIDDEN;

export const TICK_MS = 1000 / 60;
export const TICK_HZ = 60;

// 锁定步输入延迟（tick）。双方输入都在「未来」的 tick 生效，
// 这样对手的输入能在到达前就排进时间轴。值越大越稳，越小手感越跟手。
export const INPUT_DELAY = 5;

// 手感参数
export const DAS = 9; // 按住左右后，首次自动重复前的等待 tick
export const ARR = 2; // 自动重复间隔 tick
export const SOFT_MULT = 20; // 软降倍率
export const LOCK_DELAY = 30; // 落地锁定延迟 tick
export const MAX_LOCK_RESETS = 15;

// 每级下落所需 tick（索引 = 等级）。等级 = 消行数 / 10。
// 对战节奏比单机快，初始就约 0.4s / 行，配合软降非常跟手。
export const GRAVITY_TABLE = [24, 21, 18, 15, 13, 11, 9, 8, 7, 6, 5, 4, 4, 3, 3, 2];

// 快照保留长度（tick），等于可回滚窗口
export const SNAPSHOT_KEEP = 360;

// 扩展行在棋盘里的存储值
export const GARBAGE_ID = 8;
