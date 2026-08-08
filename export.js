/**
 * export.js — Excel 导出/导入（SheetJS）
 * 导出多 sheet：每日计算明细（每调整一行）、留痕、基金设置
 * 用户可把导出的 xlsx 存到 OneDrive；也可导入恢复。
 */
"use strict";

const XLSX_OBJ = (typeof XLSX !== 'undefined') ? XLSX : null;

const EXPORT = (function () {

  function fmtDate(d) {
    const x = new Date(d);
    if (isNaN(x)) return String(d);
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
  }

  function fmtTime(d) {
    const x = new Date(d);
    if (isNaN(x)) return String(d);
    return fmtDate(d) + ' ' + x.toTimeString().slice(0, 5);
  }

  /**
   * 生成历史明细（每调整一行），供表格和 Excel 共用
   * @param {Array} funds 基金
   * @param {Array} records 记录
   * @returns {Array<object>} 明细行
   */
  function buildDetailRows(funds, records) {
    const fundMap = {};
    funds.forEach(function (f) { fundMap[f.id] = f; });
    const rows = [];
    const sorted = records.slice().sort(function (a, b) {
      return (a.date + a.createdAt) < (b.date + b.createdAt) ? -1 : 1;
    });
    sorted.forEach(function (r) {
      const f = fundMap[r.fundId] || { name: r.fundId };
      const base = {
        '日期': fmtDate(r.date),
        '基金': f.name,
        '预估波动%': r.estVol,
        '实际波动%': r.actualVol === undefined || r.actualVol === null || r.actualVol === '' ? '' : r.actualVol,
        '月度波动%': r.monthlyVol,
        '档位': r.x + 'X',
        '方向': r.dir,
        '调整序号': '',
        '调波%': '',
        '比例%': '',
        '金额/份额': '',
        '剩余资金': '',
        '剩余份额': '',
        '执行消耗%': r.executedVol,
        '最终累计%': r.finalCumulative,
        '基金池': f.poolSize === undefined ? '' : f.poolSize,
        '在仓钱款': r.inPositionMoney === undefined ? '' : r.inPositionMoney,
        '在仓比例%': r.inPositionRatio === undefined ? '' : r.inPositionRatio,
        '健康度': r.health === undefined ? '' : r.health,
        '剩余资金': r.cashAfterAll === undefined ? '' : r.cashAfterAll,
        '在仓份额': r.sharesAfterAll === undefined ? '' : r.sharesAfterAll,
        '备注': r.note || ''
      };
      if (!r.adjustments || r.adjustments.length === 0) {
        rows.push(Object.assign({}, base, { '调整序号': '—', '备注': (r.note || '') + (r.actualVol === undefined || r.actualVol === null || r.actualVol === '' ? ' (待补实际波动)' : '') }));
      } else {
        r.adjustments.forEach(function (a) {
          rows.push(Object.assign({}, base, {
            '调整序号': '调整' + a.idx,
            '调波%': a.vol,
            '比例%': a.ratio,
            '金额/份额': a.amount,
            '剩余资金': a.cashAfter === undefined ? '' : a.cashAfter,
            '剩余份额': a.sharesAfter === undefined ? '' : a.sharesAfter
          }));
        });
      }
    });
    return rows;
  }

  /** 导出 Excel（下载 .xlsx） */
  function exportExcel(funds, records, audits) {
    if (!XLSX_OBJ) { alert('Excel 组件未加载'); return; }
    const detail = buildDetailRows(funds, records);
    const auditRows = audits.slice().sort(function (a, b) { return a.time < b.time ? -1 : 1; }).map(function (a) {
      return {
        '时间': fmtTime(a.time),
        '基金': (funds.find(function (f) { return f.id === a.fundId; }) || {}).name || '',
        '记录': a.recordId || '',
        '字段': a.field,
        '改前值': a.oldVal,
        '改后值': a.newVal,
        '说明': a.desc
      };
    });
    const fundRows = funds.map(function (f) {
      return {
        '名称': f.name,
        '基金池': f.poolSize === undefined ? '' : f.poolSize,
        '基线金额': f.startCash,
        '基线份额': f.startShares,
        '基线累计波动%': f.startCumulative,
        '月度波动%': f.monthlyVol,
        '当前金额': f.cash,
        '当前份额': f.shares,
        '当前累计%': f.lastCumulative,
        'ID': f.id
      };
    });

    const wb = XLSX_OBJ.utils.book_new();
    const ws1 = XLSX_OBJ.utils.json_to_sheet(detail);
    const ws2 = XLSX_OBJ.utils.json_to_sheet(auditRows);
    const ws3 = XLSX_OBJ.utils.json_to_sheet(fundRows);
    XLSX_OBJ.utils.book_append_sheet(wb, ws1, '每日计算明细');
    XLSX_OBJ.utils.book_append_sheet(wb, ws2, '留痕记录');
    XLSX_OBJ.utils.book_append_sheet(wb, ws3, '基金设置');
    const fn = 'fund-tool-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    XLSX_OBJ.writeFile(wb, fn);
    return fn;
  }

  /** 导出备份（JSON，全量，用于无损恢复） */
  function exportBackup(funds, records, audits) {
    const data = { version: 1, exportedAt: new Date().toISOString(), funds: funds, records: records, audits: audits };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fund-tool-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return a.download;
  }

  /** 解析 Excel/JSON 备份文件，返回 {funds, records, audits} */
  function parseBackup(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const text = String(e.target.result);
          if (text.trim().startsWith('{')) {
            const data = JSON.parse(text);
            resolve({ funds: data.funds || [], records: data.records || [], audits: data.audits || [] });
          } else if (XLSX_OBJ) {
            const wb = XLSX_OBJ.read(e.target.result, { type: 'array' });
            const sheetNames = wb.SheetNames;
            const funds = XLSX_OBJ.utils.sheet_to_json(wb.Sheets['基金设置'] || wb.Sheets[sheetNames[0]] || {});
            const detail = XLSX_OBJ.utils.sheet_to_json(wb.Sheets['每日计算明细'] || {});
            const audits = XLSX_OBJ.utils.sheet_to_json(wb.Sheets['留痕记录'] || {});
            resolve({ funds: funds, detail: detail, audits: audits });
          } else {
            reject(new Error('无法识别的备份文件'));
          }
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error('读取文件失败')); };
      reader.readAsText(file);
    });
  }

  return { buildDetailRows: buildDetailRows, exportExcel: exportExcel, exportBackup: exportBackup, parseBackup: parseBackup, fmtDate: fmtDate };
})();
