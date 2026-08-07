/* ============================================================
 * app.js — 三页 UI：今日操作(#today) / 历史总表(#history) / 基金设置(#funds)
 * 依赖：calc.js, db.js, export.js
 * ============================================================ */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmt = n => (n === null || n === undefined || n === '') ? '—' : (+n).toFixed(2);
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const App = {
  funds: [], records: [], audit: [],
  state: { fundId: null, preview: null },

  async init() {
    await DB.init();
    this.funds = await DB.all('funds');
    this.records = await DB.all('records');
    this.audit = await DB.all('audit');
    this.bindNav();
    this.route();
  },

  bindNav() {
    $$('.nav button').forEach(b => b.onclick = () => location.hash = b.dataset.page);
    window.onhashchange = () => this.route();
  },

  route() {
    const h = location.hash || '#today';
    $$('.page').forEach(p => p.classList.toggle('active', '#' + p.id === h));
    if (h === '#today') this.renderToday();
    if (h === '#history') this.renderHistory();
    if (h === '#funds') this.renderFunds();
  },

  /* ============ 今日操作 ============ */
  async renderToday() {
    const sel = $('#today-fund');
    sel.innerHTML = '<option value="">选择基金…</option>' + this.funds.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    if (this.state.fundId) sel.value = this.state.fundId;
    sel.onchange = () => { this.state.fundId = +sel.value; this.loadFundCtx(); };
    if (sel.value) this.loadFundCtx();
  },

  async loadFundCtx() {
    const fund = this.funds.find(f => f.id === this.state.fundId);
    if (!fund) return;
    const recs = await DB.recordsOf(fund.id);
    const st = latestState(fund, recs);
    const last = recs[recs.length - 1];
    $('#today-last').innerHTML = `
      <b>上次操作</b> ${last ? esc(last.date) : '无'} ｜ 剩余资金 <b>${fmt(st.cash)}</b> ｜ 剩余份额 <b>${fmt(st.shares)}</b> ｜ 累计波动 <b>${fmt(st.cumulative)}%</b>
      ${last && last.actualVol === null ? '<span class="warn">⚠ 上条记录还没录实际波动，先补录！</span>' : ''}`;
    $('#today-mv').value = last ? last.monthlyVol : (fund.monthlyVol || '');
    $('#today-est').value = '';
    $('#today-result').innerHTML = '';
  },

  async computeToday() {
    const fund = this.funds.find(f => f.id === this.state.fundId);
    if (!fund) return alert('先选基金');
    const estVol = parseFloat($('#today-est').value);
    const monthlyVol = parseFloat($('#today-mv').value);
    if (isNaN(estVol)) return alert('请输入当日预估波动');
    if (isNaN(monthlyVol)) return alert('请输入月度波动');
    const recs = await DB.recordsOf(fund.id);
    const st = latestState(fund, recs);
    const prevCum = recs.length ? (recs[recs.length - 1].finalCumulative ?? (fund.initCumulative || 0)) : (fund.initCumulative || 0);
    const adj = estAdjustable(prevCum, estVol);      // 可调波动
    const x = xFactor(monthlyVol);
    const plan = planAdjustments(adj);
    if (!plan.adjustments.length) {
      $('#today-result').innerHTML = `<div class="ok">可调波动 ${fmt(adj)}%，小数部分 <0.5，今天不操作，留给明天。</div>`;
      this.state.preview = null;
      return;
    }
    const rem = plan.dir === 'buy' ? st.cash : st.shares;
    const ex = executePlan(rem, x, plan);
    this.state.preview = { fund, estVol, monthlyVol, adj, x, plan, ex, prevCum, st };
    const unit = plan.dir === 'buy' ? '元' : '份';
    $('#today-result').innerHTML = `
      <div class="box">
        <div>预估波动 <b>${fmt(estVol)}%</b> → 可调波动 <b>${fmt(adj)}%</b>（${plan.dir === 'buy' ? '买入' : '卖出'}）｜ 档位 <b>${x}X</b>（比例 ${fmt(ratioPct(x))}%${ex.steps.some(s => s.vol === 0.5) ? '，0.5% 补调比例减半' : ''}）</div>
        <div>调前 ${plan.dir === 'buy' ? '可用资金' : '可用份额'}：<b>${fmt(rem)}</b>${unit}</div>
        <table class="mini">
          <tr><th>调整</th><th>波动</th><th>方向</th><th>金额/份额(可改)</th><th>剩余${unit}</th></tr>
          ${ex.steps.map((s, i) => `<tr>
            <td>调整${i + 1}</td><td>${s.vol}%</td><td>${s.dir === 'buy' ? '买' : '卖'}</td>
            <td><input class="adj-amount" data-i="${i}" type="number" step="0.01" value="${s.amount}"></td>
            <td class="rem" data-i="${i}">${fmt(s.remainderAfter)}</td>
          </tr>`).join('')}
        </table>
        <button id="btn-confirm">✅ 确认并留档</button>
        <div class="hint">可先改金额再确认；确认后记录留档，之后还能随时改（历史总表页）。</div>
      </div>`;
    $$('#today-result .adj-amount').forEach(inp => inp.oninput = () => this.previewAdjust());
  },

  previewAdjust() {
    const p = this.state.preview; if (!p) return;
    let rem = p.ex.remainderAfter; // 从后往前重算
    const amounts = $$('#today-result .adj-amount').map(i => parseFloat(i.value) || 0);
    const rems = new Array(amounts.length);
    let r = p.ex.steps.length ? amounts.reduce((a, b) => a + b, 0) : 0;
    // 调前余量
    const startRem = p.plan.dir === 'buy' ? p.st.cash : p.st.shares;
    let cur = startRem;
    for (let i = 0; i < amounts.length; i++) {
      cur = cur - amounts[i];
      rems[i] = Math.round((cur + Number.EPSILON) * 100) / 100;
    }
    $$('#today-result .rem').forEach((el, i) => el.textContent = fmt(rems[i]));
  },

  async confirmToday() {
    const p = this.state.preview; if (!p) return;
    const amounts = $$('#today-result .adj-amount').map(i => parseFloat(i.value) || 0);
    const adjustments = p.ex.steps.map((s, i) => ({ idx: s.idx, dir: s.dir, vol: s.vol, amount: amounts[i] }));
    const rec = {
      date: todayStr(), fundId: p.fund.id,
      estVol: p.estVol, monthlyVol: p.monthlyVol,
      actualVol: null, adjustments, consumedVol: p.ex.consumedVol,
      finalCumulative: null, buySharesFilled: null, status: 'pending', note: '',
      createdAt: new Date().toISOString()
    };
    await DB.add('records', rec);
    const newId = (await DB.all('records')).sort((a, b) => b.id - a.id)[0].id;
    await auditLog(newId, p.fund.id, 'record', '', JSON.stringify(adjustments), '新增预估记录');
    this.state.preview = null;
    $('#today-result').innerHTML = `<div class="ok">✅ 已留档（${rec.date} ${esc(p.fund.name)}）。交易完成后回来录入实际波动。</div>`;
    $('#today-est').value = '';
    this.records = await DB.all('records');
  },

  async finalizeActual() {
    const fund = this.funds.find(f => f.id === this.state.fundId);
    if (!fund) return alert('先选基金');
    const recs = await DB.recordsOf(fund.id);
    const last = recs[recs.length - 1];
    if (!last || last.actualVol !== null) return alert('没有待补实际波动的记录');
    const av = parseFloat(prompt('请输入今日实际波动（%）', last.estVol));
    if (isNaN(av)) return;
    const prev = recs.length >= 2 ? (recs[recs.length - 2].finalCumulative ?? 0) : (fund.initCumulative || 0);
    const final = finalCumulative(prev, av, last.consumedVol);
    await DB.put('records', { ...last, actualVol: av, finalCumulative: final, status: 'done' });
    await auditLog(last.id, fund.id, 'actualVol', 'null', av, '补录实际波动');
    this.records = await DB.all('records');
    $('#today-result').innerHTML = `<div class="ok">实际波动 ${fmt(av)}% → 今日最终累计 <b>${fmt(final)}%</b>（留到明天）。</div>`;
  },

  /* ============ 历史总表（Excel 化，可编辑联动） ============ */
  async renderHistory() {
    const rows = [];
    const chains = new Map(); // fundId -> cash/shares 链
    const sortedFunds = this.funds.slice().sort((a, b) => a.id - b.id);
    for (const f of sortedFunds) {
      const recs = (await DB.recordsOf(f.id));
      let cash = f.initCash, shares = f.manualShares || 0;
      const cashByRec = {}, sharesByRec = {};
      recs.forEach(r => {
        r.adjustments.forEach(a => {
          if (a.dir === 'buy') cash = cash - a.amount;
          else shares = shares - a.amount;
        });
        if (r.buySharesFilled) shares = shares + r.buySharesFilled;
        cashByRec[r.id] = cash; sharesByRec[r.id] = shares;
      });
      chains.set(f.id, { cashByRec, sharesByRec, recs });
    }
    let html = `<table class="grid"><tr>
      <th>日期</th><th>基金</th><th>调整</th><th>方向</th><th>波动%</th><th>档位</th><th>比例%</th>
      <th>金额/份额(可改)</th><th>调后资金</th><th>调后份额</th><th>实际波动</th><th>最终累计</th><th>操作</th></tr>`;
    for (const f of sortedFunds) {
      const { cashByRec, sharesByRec, recs } = chains.get(f.id);
      for (const r of recs) {
        const x = xFactor(r.monthlyVol);
        const adjRows = r.adjustments.map(a => `<tr class="row-${r.id}">
          <td>${esc(r.date)}</td><td>${esc(f.name)}</td><td>调整${a.idx}</td>
          <td>${a.dir === 'buy' ? '买' : '卖'}</td><td>${a.vol}%</td><td>${x}X</td><td>${fmt(a.vol === 0.5 ? ratioPct(x) / 2 : ratioPct(x))}</td>
          <td><input class="am" data-rid="${r.id}" data-idx="${a.idx}" type="number" step="0.01" value="${a.amount}"></td>
          <td class="ca">${fmt(cashByRec[r.id])}</td><td class="sa">${fmt(sharesByRec[r.id])}</td>
          <td>${r.actualVol === null ? '<span class="warn">待补</span>' : fmt(r.actualVol)}</td>
          <td>${r.finalCumulative === null ? '—' : fmt(r.finalCumulative) + '%'}</td>
          <td><button class="btn-audit" data-rid="${r.id}">留痕</button> <button class="btn-del" data-rid="${r.id}">删</button></td>
        </tr>`).join('');
        html += adjRows;
      }
    }
    html += '</table>';
    $('#history-table').innerHTML = html;
    $('#history-count').textContent = `共 ${this.records.length} 条记录`;
    // 编辑金额 → 保存 + 留痕 + 重渲染（联动）
    $$('#history-table .am').forEach(inp => inp.onchange = async e => {
      const rid = +e.target.dataset.rid, idx = +e.target.dataset.idx;
      const rec = this.records.find(r => r.id === rid);
      if (!rec) return;
      const old = rec.adjustments[idx - 1].amount;
      const v = parseFloat(e.target.value);
      if (isNaN(v) || v < 0) { alert('金额无效'); e.target.value = old; return; }
      rec.adjustments[idx - 1].amount = v;
      await DB.put('records', rec);
      await auditLog(rid, rec.fundId, `adjustments[${idx - 1}].amount`, old, v, '修改金额');
      this.records = await DB.all('records');
      await this.renderHistory();
    });
    $$('#history-table .btn-del').forEach(b => b.onclick = async e => {
      const rid = +e.target.dataset.rid;
      if (!confirm('删除这条记录？将同时删除其留痕。')) return;
      await DB.del('records', rid);
      this.records = await DB.all('records');
      await this.renderHistory();
    });
    $$('#history-table .btn-audit').forEach(b => b.onclick = async e => {
      const rid = +e.target.dataset.rid;
      const logs = await DB.auditOf(rid);
      alert(logs.length ? logs.map(l => `${l.ts.slice(0, 16).replace('T', ' ')} ${l.action}：${l.field} ${l.oldVal} → ${l.newVal}`).join('\n') : '无留痕记录');
    });
  },

  /* ============ 基金设置 ============ */
  async renderFunds() {
    $('#funds-list').innerHTML = this.funds.map(f => `
      <div class="fund-card">
        <input class="f-name" data-id="${f.id}" value="${esc(f.name)}">
        初始资金池 <input class="f-cash" data-id="${f.id}" type="number" step="0.01" value="${f.initCash}">
        手动份额 <input class="f-shares" data-id="${f.id}" type="number" step="0.01" value="${f.manualShares || ''}" placeholder="当前实际份额">
        初始累计 <input class="f-cum" data-id="${f.id}" type="number" step="0.01" value="${f.initCumulative || 0}">
        <button class="f-save" data-id="${f.id}">保存</button>
        <button class="f-del" data-id="${f.id}">删除</button>
      </div>`).join('');
    $$('#funds-list .f-save').forEach(b => b.onclick = async e => {
      const id = +e.target.dataset.id;
      const f = this.funds.find(x => x.id === id);
      const card = e.target.closest('.fund-card');
      const q = s => card.querySelector(s).value;
      const old = JSON.stringify(f);
      f.name = q('.f-name') || '未命名基金';
      f.initCash = parseFloat(q('.f-cash')) || 0;
      f.manualShares = parseFloat(q('.f-shares')) || 0;
      f.initCumulative = parseFloat(q('.f-cum')) || 0;
      await DB.put('funds', f);
      await auditLog(null, f.id, 'fund', old, JSON.stringify(f), '修改基金设置');
      this.funds = await DB.all('funds');
      alert('已保存');
    });
    $$('#funds-list .f-del').forEach(b => b.onclick = async e => {
      const id = +e.target.dataset.id;
      if (!confirm('删除该基金及其全部记录？')) return;
      const recs = await DB.recordsOf(id);
      for (const r of recs) await DB.del('records', r.id);
      await DB.del('funds', id);
      this.funds = await DB.all('funds');
      this.records = await DB.all('records');
      await this.renderFunds();
    });
  },

  async addFund() {
    const name = prompt('基金名称：');
    if (!name) return;
    const cash = parseFloat(prompt('初始资金池金额：', '10000')) || 0;
    await DB.add('funds', { name, initCash: cash, manualShares: 0, initCumulative: 0, createdAt: new Date().toISOString() });
    this.funds = await DB.all('funds');
    await this.renderFunds();
  }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
