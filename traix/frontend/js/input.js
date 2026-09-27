// 键盘 + 触屏输入。
// 注意：这里**不做** DAS/ARR 自动重复，那是模拟层的事（保证双方一致）；
// 浏览器自带的按键重复（e.repeat）必须忽略。

const KEYMAP = {
  ArrowLeft: 'L',
  ArrowRight: 'R',
  ArrowDown: 'S',
  ArrowUp: 'C',
  KeyX: 'C',
  KeyZ: 'W',
  Space: 'H',
};

export class InputManager {
  /**
   * @param {(act:string, state:number)=>void} onAction
   */
  constructor(onAction) {
    this.onAction = onAction;
    this.enabled = false;
    this.pressed = new Set();
    this._bindKeyboard();
    this._bindTouch();
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!v) this.releaseAll();
  }

  releaseAll() {
    for (const act of ['L', 'R', 'S']) {
      if (this.pressed.has(act)) {
        this.pressed.delete(act);
        this.onAction(act, 0);
      }
    }
  }

  _press(act) {
    if (!this.enabled) return;
    if (this.pressed.has(act)) return;
    this.pressed.add(act);
    this.onAction(act, 1);
  }

  _release(act) {
    if (!this.pressed.has(act)) return;
    this.pressed.delete(act);
    this.onAction(act, 0);
  }

  _bindKeyboard() {
    window.addEventListener(
      'keydown',
      (e) => {
        const act = KEYMAP[e.code];
        if (!act) return;
        e.preventDefault();
        if (e.repeat) return;
        if (act === 'H') {
          // 硬降是单次动作
          this.onAction('H', 1);
          return;
        }
        if (act === 'C' || act === 'W') {
          if (!this.enabled) return;
          this.onAction(act, 1);
          return;
        }
        this._press(act);
      },
      { passive: false }
    );

    window.addEventListener('keyup', (e) => {
      const act = KEYMAP[e.code];
      if (!act) return;
      e.preventDefault();
      if (act === 'C' || act === 'W' || act === 'H') return;
      this._release(act);
    });

    window.addEventListener('blur', () => this.releaseAll());
  }

  _bindTouch() {
    const pad = document.getElementById('touchPad');
    if (!pad) return;
    const buttons = pad.querySelectorAll('[data-act]');
    buttons.forEach((btn) => {
      const act = btn.getAttribute('data-act');
      const oneShot = act === 'C' || act === 'W' || act === 'H';
      const down = (e) => {
        e.preventDefault();
        if (oneShot) {
          if (this.enabled) this.onAction(act, 1);
        } else {
          this._press(act);
        }
      };
      const up = (e) => {
        e.preventDefault();
        if (!oneShot) this._release(act);
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
  }
}

/** 是否触屏设备 */
export function isTouchDevice() {
  return (
    ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
    window.matchMedia('(pointer: coarse)').matches
  );
}
