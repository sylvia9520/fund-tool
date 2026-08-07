/* ============================================================
 * db.js — 数据层（IndexedDB）
 * 三个存储：funds（基金）、records（操作记录）、audit（留痕）
 * 联动设计：调整金额是唯一"事实"，剩余资金/份额为派生值，
 * 读取时按日期链实时重算 —— 改任何一行，后续行自动更新。
 * schema 版本 v1，预留 migrate 钩子供以后加字段。
 * ============================================================ */
'use strict';

const DB_NAME = 'fund-tool';
const DB_VER = 1;

function openDB() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('funds')) {
        const s = db.createObjectStore('funds', { keyPath: 'id', autoIncrement: true });
        s.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('records')) {
        const s = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        s.createIndex('fundId', 'fundId', { unique: false });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('audit')) {
        const s = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
        s.createIndex('recordId', 'recordId', { unique: false });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function tx(db, store, mode, fn) {
  return new Promise(function (resolve, reject) {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
    t.onerror = function () { reject(t.error); };
    t.onabort = function () { reject(t.error); };
  });
}

const DB = {
  db: null,
  async init() {
    if (!this.db) this.db = await openDB();
    return this.db;
  },
  async put(store, obj) { await this.init(); return tx(this.db, store, 'readwrite', s => s.put(obj)); },
  async add(store, obj) { await this.init(); return tx(this.db, store, 'readwrite', s => s.add(obj)); },
  async del(store, id) { await this.init(); return tx(this.db, store, 'readwrite', s => s.delete(id)); },
  async all(store) {
    await this.init();
    return tx(this.db, store, 'readonly', s => s.getAll());
  },
  async get(store, id) {
    await this.init();
    return tx(this.db, store, 'readonly', s => s.get(id));
  },
  // 某基金全部记录，按日期+id 排序（升序 = 时间链）
  async recordsOf(fundId) {
    await this.init();
    return tx(this.db, 'records', 'readonly', s => {
      const idx = s.index('fundId');
      return idx.getAll(IDBKeyRange.only(fundId));
    }).then(rs => rs.sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1)));
  },
  async auditOf(recordId) {
    await this.init();
    return tx(this.db, 'audit', 'readonly', s => {
      const idx = s.index('recordId');
      return idx.getAll(IDBKeyRange.only(recordId));
    });
  }
};

/* ---------------- 派生状态（联动核心） ----------------
 * 输入事实：fund.initCash（初始资金池）、record.adjustments[].amount（用户可改）、
 *          record.buySharesFilled（买入后手动补的份额）、fund.manualShares（手动份额）
 * 派生：剩余资金链（初始池 − 各买入调整额）、剩余份额链（手动份额 − 各卖出调整额）
 */
function deriveCashChain(fund, records) {
  let cash = fund.initCash;
  return records.map(rec => {
    const buys = rec.adjustments.filter(a => a.dir === 'buy');
    const sells = rec.adjustments.filter(a => a.dir === 'sell');
    // 买入消耗资金；卖出只影响份额（无净值换算，资金不回池——可在设置页手动调整）
    cash = cash - buys.reduce((sum, a) => sum + a.amount, 0);
    return { recId: rec.id, date: rec.date, cashAfter: round2(cash) };
  });
}

function deriveSharesChain(fund, records) {
  let shares = fund.manualShares || 0;
  return records.map(rec => {
    const sells = rec.adjustments.filter(a => a.dir === 'sell');
    const topups = rec.buySharesFilled || 0;
    shares = shares - sells.reduce((sum, a) => sum + a.amount, 0) + topups;
    return { recId: rec.id, date: rec.date, sharesAfter: round2(shares) };
  });
}

// 某基金最新状态（今日操作页"上次操作数据"行）
function latestState(fund, records) {
  const c = deriveCashChain(fund, records);
  const s = deriveSharesChain(fund, records);
  const last = c.length ? c[c.length - 1] : null;
  return {
    cash: last ? last.cashAfter : fund.initCash,
    shares: s.length ? s[s.length - 1].sharesAfter : (fund.manualShares || 0),
    cumulative: records.length ? (records[records.length - 1].finalCumulative || 0) : (fund.initCumulative || 0),
    lastDate: records.length ? records[records.length - 1].date : null
  };
}

// 记账函数：确认操作时写入留痕（新增/修改）
async function auditLog(recordId, fundId, field, oldVal, newVal, action) {
  await DB.put('audit', {
    ts: new Date().toISOString(),
    recordId: recordId || null,
    fundId: fundId || null,
    field: field,
    oldVal: oldVal === undefined ? '' : oldVal,
    newVal: newVal === undefined ? '' : newVal,
    action: action
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DB, deriveCashChain, deriveSharesChain, latestState, auditLog };
}
