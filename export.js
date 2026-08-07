/* ============================================================
 * export.js — Excel 备份/恢复（SheetJS）
 * ============================================================ */
'use strict';

async function collectAll() {
  const funds = await DB.all('funds');
  const records = await DB.all('records');
  const audit = await DB.all('audit');
  // 重算每行调后资金/份额（与历史页一致）
  const rows = [];
  const sortedFunds = funds.slice().sort((a, b) => a.id - b.id);
  for (const f of sortedFunds) {
    const recs = records.filter(r => r.fundId === f.id).sort((a, b) => a.date === b.date ? a.id - b.id : (a.date < b.date ? -1 : 1));
    let cash = f.initCash, shares = f.manualShares || 0;
    for (const r of recs) {
      const x = xFactor(r.monthlyVol);
      for (const a of r.adjustments) {
        if (a.dir === 'buy') cash = cash - a.amount; else shares = shares - a.amount;
        rows.push({
          日期: r.date, 基金: f.name, 调整: '调整' + a.idx, 方向: a.dir === 'buy' ? '买入' : '卖出',
          波动: a.vol + '%', 档位: x + 'X', 比例: (a.vol === 0.5 ? ratioPct(x) / 2 : ratioPct(x)).toFixed(2) + '%',
          金额份额: a.amount, 调后资金: Math.round((cash + Number.EPSILON) * 100) / 100,
          调后份额: Math.round((shares + Number.EPSILON) * 100) / 100,
          实际波动: r.actualVol === null ? '' : r.actualVol + '%',
          最终累计: r.finalCumulative === null ? '' : r.finalCumulative + '%',
          备注: r.note || ''
        });
      }
      if (r.buySharesFilled) shares = shares + r.buySharesFilled;
    }
  }
  const auditRows = audit.map(a => ({
    时间: a.ts, 记录ID: a.recordId || '', 基金ID: a.fundId || '', 字段: a.field,
    改前值: a.oldVal, 改后值: a.newVal, 动作: a.action
  }));
  const fundRows = funds.map(f => ({ 名称: f.name, 初始资金池: f.initCash, 手动份额: f.manualShares || '', 初始累计: f.initCumulative || 0 }));
  return { rows, auditRows, fundRows };
}

async function exportExcel() {
  const { rows, auditRows, fundRows } = await collectAll();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ 提示: '暂无数据' }]), '每日计算全表');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows.length ? auditRows : [{ 提示: '暂无留痕' }]), '留痕');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fundRows.length ? fundRows : [{ 提示: '暂无基金' }]), '基金设置');
  const fn = '基金工具备份_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fn);
  return fn;
}

async function importExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sFunds = wb.Sheets['基金设置'];
  const sRows = wb.Sheets['每日计算全表'];
  if (!sFunds || !sRows) throw new Error('缺少 基金设置/每日计算全表 sheet');
  const fundRows = XLSX.utils.sheet_to_json(sFunds);
  const rowData = XLSX.utils.sheet_to_json(sRows);
  // 清空重建
  const allFunds = await DB.all('funds');
  for (const f of allFunds) await DB.del('funds', f.id);
  const allRecs = await DB.all('records');
  for (const r of allRecs) await DB.del('records', r.id);
  const allAudit = await DB.all('audit');
  for (const a of allAudit) await DB.del('audit', a.id);
  // 重建基金
  const idMap = {};
  for (const fr of fundRows) {
    const id = await DB.add('funds', {
      name: String(fr['名称'] || ''), initCash: parseFloat(fr['初始资金池']) || 0,
      manualShares: parseFloat(fr['手动份额']) || 0, initCumulative: parseFloat(fr['初始累计']) || 0,
      createdAt: new Date().toISOString()
    });
    idMap[fr['名称']] = id;
  }
  // 重建记录（按行聚合）
  const byKey = {};
  for (const rd of rowData) {
    const key = rd['日期'] + '|' + rd['基金'];
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(rd);
  }
  for (const key of Object.keys(byKey)) {
    const rows = byKey[key].sort((a, b) => (a['调整'] || '').localeCompare(b['调整'] || ''));
    const first = rows[0];
    const fundId = idMap[first['基金']];
    if (!fundId) continue;
    const adjustments = rows.map((r, i) => ({
      idx: i + 1,
      dir: (r['方向'] || '').indexOf('买') >= 0 ? 'buy' : 'sell',
      vol: parseFloat(r['波动']) || 1,
      amount: parseFloat(r['金额份额']) || 0
    }));
    await DB.add('records', {
      date: first['日期'], fundId: fundId,
      estVol: null, monthlyVol: null, actualVol: null, // 导入时未知，可在页面补
      adjustments: adjustments, consumedVol: adjustments.reduce((s, a) => s + a.vol, 0),
      finalCumulative: null, buySharesFilled: null, status: 'imported', note: 'Excel导入',
      createdAt: new Date().toISOString()
    });
  }
  return { funds: fundRows.length, rows: rowData.length };
}
