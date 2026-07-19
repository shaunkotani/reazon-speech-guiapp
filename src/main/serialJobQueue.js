'use strict';

// 1ジョブが内部の全ワーカープールを使うため、ファイル単位では直列に実行する。
// 待機位置は「実行中を1番目」とした全体順で通知する。
class SerialJobQueue {
  constructor({ onChange = () => {} } = {}) {
    this._active = null;
    this._waiting = [];
    this._onChange = onChange;
  }

  get activeId() { return this._active ? this._active.id : null; }
  get size() { return (this._active ? 1 : 0) + this._waiting.length; }

  hasQueued(id) {
    return this._waiting.some((entry) => entry.id === id);
  }

  enqueue({ id, run, onPosition = () => {} }) {
    if (this.activeId === id || this.hasQueued(id)) {
      return Promise.reject(new Error(`job is already queued: ${id}`));
    }
    return new Promise((resolve, reject) => {
      this._waiting.push({ id, run, onPosition, resolve, reject });
      this._notify();
      this._pump();
    });
  }

  cancelQueued(id, error = new Error('中止しました')) {
    const index = this._waiting.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this._waiting.splice(index, 1);
    entry.reject(error);
    this._notify();
    return true;
  }

  _notify() {
    const offset = this._active ? 1 : 0;
    const total = this.size;
    this._waiting.forEach((entry, index) => {
      try { entry.onPosition({ position: offset + index + 1, total }); }
      catch (_) { /* 表示先が閉じられてもキュー実行は継続する */ }
    });
    try { this._onChange({ activeId: this.activeId, size: total, waiting: this._waiting.length }); }
    catch (_) { /* タスクバー等の付随表示失敗で処理を止めない */ }
  }

  _pump() {
    if (this._active || this._waiting.length === 0) return;
    const entry = this._waiting.shift();
    this._active = entry;
    this._notify();
    Promise.resolve()
      .then(() => entry.run())
      .then(
        (value) => this._finish(entry, () => entry.resolve(value)),
        (error) => this._finish(entry, () => entry.reject(error)),
      );
  }

  _finish(entry, settle) {
    if (this._active === entry) this._active = null;
    this._notify();
    this._pump();
    settle();
  }
}

module.exports = SerialJobQueue;
