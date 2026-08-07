/**
 * db.js — IndexedDB 数据层
 * 表：funds（基金/资金池）、records（每日计算+调整明细）、audit（留痕）
 * 数据只存本地浏览器，可导出/导入（Excel/JSON）到 OneDrive。
 */
"use strict";

const DB = (function () {
  const DB_NAME = 'fund-tool';
  const DB_VER = 1;
  let _db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (_db) { resolve(_db); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('funds')) {
          const s = db.createObjectStore('funds', { keyPath: 'id' });
          s.createIndex('name', 'name', { unique: false });
        }
        if (!db.objectStoreNames.contains('records')) {
          const s = db.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('fundId', 'fundId', { unique: false });
        }
        if (!db.objectStoreNames.contains('audit')) {
          const s = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
          s.createIndex('time', 'time', { unique: false });
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function getAll(store) {
    return tx(store, 'readonly').then(function (os) {
      return new Promise(function (res, rej) {
        const r = os.getAll();
        r.onsuccess = function () { res(r.result || []); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function put(store, obj) {
    return tx(store, 'readwrite').then(function (os) {
      return new Promise(function (res, rej) {
        const r = os.put(obj);
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function putAll(store, objs) {
    return tx(store, 'readwrite').then(function (os) {
      return new Promise(function (res, rej) {
        objs.forEach(function (o) { os.put(o); });
        const r = os.put(objs[objs.length - 1]);
        r.onsuccess = function () { res(); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function remove(store, key) {
    return tx(store, 'readwrite').then(function (os) {
      return new Promise(function (res, rej) {
        const r = os.delete(key);
        r.onsuccess = function () { res(); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  function clear(store) {
    return tx(store, 'readwrite').then(function (os) {
      return new Promise(function (res, rej) {
        const r = os.clear();
        r.onsuccess = function () { res(); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }

  // 留痕：记录任意字段变更（改前值→改后值）
  function audit(fundId, recordId, field, oldVal, newVal, desc) {
    return put('audit', {
      id: undefined,
      time: new Date().toISOString(),
      fundId: fundId || '',
      recordId: recordId || '',
      field: field,
      oldVal: oldVal === undefined ? '' : String(oldVal),
      newVal: newVal === undefined ? '' : String(newVal),
      desc: desc || ''
    });
  }

  function genId() {
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  return {
    open: open, getAll: getAll, put: put, putAll: putAll, remove: remove, clear: clear,
    audit: audit, genId: genId
  };
})();
