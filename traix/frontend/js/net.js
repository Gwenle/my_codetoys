// WebSocket 客户端。协议是极简的竖线分隔文本帧：
//
//   客户端 -> 服务端
//     join|ROOM|NAME        加入/创建房间
//     ready|0|1             准备状态
//     in|TICK|ACT|STATE     输入事件（ACT 为单字符 LRSCWH）
//     hs|TICK|HASH          棋盘哈希（用于不同步检测）
//     dead|TICK             我顶出了
//
//   服务端 -> 客户端
//     slot|SLOT|ROOM|NAME   分配席位
//     peer|SLOT|NAME        对手信息
//     leave|SLOT            对手离开
//     ready|SLOT|0|1        准备状态广播
//     start|SEED|TICK|PIECES_B64|GAPS_B64   开局（含固定序列）
//     tick|TICK             权威逻辑时钟（约 25ms 一次）
//     in|SLOT|TICK|ACT|STATE  对手输入转发
//     hs|SLOT|TICK|HASH     对手哈希转发
//     end|WINNER|REASON     对局结束
//     err|MESSAGE           错误

export class Net {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};
    this.connected = false;
    this._closedByUs = false;
  }

  on(name, fn) {
    this.handlers[name] = fn;
    return this;
  }

  _emit(name, ...args) {
    const h = this.handlers[name];
    if (h) h(...args);
  }

  connect() {
    this._closedByUs = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._emit('close', e);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._emit('open');
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      const i = data.indexOf('|');
      const cmd = i < 0 ? data : data.slice(0, i);
      const rest = i < 0 ? '' : data.slice(i + 1);
      this._emit('message', cmd, rest);
    };
    ws.onerror = () => {
      this._emit('error');
    };
    ws.onclose = () => {
      this.connected = false;
      this._emit('close', this._closedByUs);
    };
  }

  send(s) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(s);
      return true;
    }
    return false;
  }

  close() {
    this._closedByUs = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

/** 从当前页面推导 WebSocket 地址；file:// 打开时退化为本机 8787 */
export function defaultWsUrl() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  return 'ws://127.0.0.1:8787/ws';
}

export function decodeB64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
