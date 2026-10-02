// История по месяцам (файл history.ebch из геокодера): графики расхода ЭО и ПУ, журнал изменений,
// сводка изменений за последний месяц. Если в архиве истории нет — ничего из этого не показывается.
//
// В телефоне: «hmeta» — общие сведения (месяцы, источники, сводка), «h:<ЭО>» — строка JSON по каждому ЭО:
//   { e, m0, t:[расход ЭО по месяцам от m0], p:[ {n, k, r, m0, t, a, b, s, cur, m1?, mv?} ], h:[[месяц, вид, заголовок, текст]] }

let H = null;                       // общие сведения истории
const HC = new Map();               // кэш разобранных строк по ЭО

const MSHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MLET = ['я', 'ф', 'м', 'а', 'м', 'и', 'и', 'а', 'с', 'о', 'н', 'д'];
const MGEN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const mY = m => +m.slice(0, 4), mM = m => +m.slice(5, 7);           // '2026-01' → 2026, 1
const mNum = m => mY(m) * 12 + mM(m) - 1;
const mStr = n => `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
const mFull = m => cap(MONTHS[mM(m) - 1]) + ' ' + mY(m);          // «Январь 2026»
const mShort = m => MSHORT[mM(m) - 1] + ' ' + String(mY(m)).slice(2); // «янв 26»
const mDot = m => String(mM(m)).padStart(2, '0') + '.' + mY(m);     // «01.2026»
const kwh = v => fmtN(Math.round(v)) + ' кВт·ч';
const numKey = n => { const s = String(n || '').trim().toUpperCase().replace(/\s+/g, ''); return s.replace(/^0+/, '') || s; };

async function loadHistMeta() {
  try { const s = await idb.get('hmeta'); H = s ? JSON.parse(s) : null; } catch { H = null; }
  HC.clear();
}

async function getHist(id) {
  if (!H) return null;
  if (HC.has(id)) return HC.get(id);
  let v = null;
  try { const s = await idb.get('h:' + id); v = s ? JSON.parse(s) : null; } catch { v = null; }
  HC.set(id, v);
  return v;
}

// Значение ряда за календарный месяц (или undefined, если месяца нет в архиве / до начала ряда).
function valAt(arr, m0, month) {
  const j = H.months.indexOf(month) - m0;
  return j >= 0 && j < arr.length ? arr[j] : undefined;
}

// ПУ из истории, соответствующий строке карточки (номер без ведущих нулей + роль).
function histMeter(h, num, role) {
  if (!h) return null;
  const k = numKey(num), r = role === 'T' ? 'T' : 'R';
  return h.p.find(p => p.k === k && p.r === r) || h.p.find(p => p.k === k) || null;
}
const puKey = p => encodeURIComponent(p.k + '~' + p.r);

// Столбики: values — массив чисел или null; opts.last — индекс выделенного; opts.h — высота
function barsHtml(values, opts = {}) {
  const h = opts.h || 28, max = Math.max(1, ...values.map(v => Math.abs(v || 0)));
  return `<div class="hbars" style="height:${h}px">${values.map((v, i) => {
    if (v == null) return '<i class="nil"></i>';
    const px = Math.max(2, Math.round(Math.abs(v) / max * h));
    return `<i class="${i === opts.last ? 'lst' : ''}${opts.cls ? ' ' + opts.cls : ''}" style="height:${px}px"></i>`;
  }).join('')}</div>`;
}

// Последние 12 календарных месяцев, кончая последним месяцем архива
function last12() { const n = mNum(H.last); return Array.from({ length: 12 }, (_, i) => mStr(n - 11 + i)); }

// ---------------------------------------------------------------- карточка ЭО: маленький график и кнопки
async function decorateCard(e) {
  const box = $('#histmini');
  if (!box || !H) return;
  const h = await getHist(e.id);
  if (!h || !location.hash.startsWith('#/eo/')) return;
  window._cardHist = { id: e.id, h };
  const ms = last12();
  const vals = ms.map(m => { const v = valAt(h.t, h.m0, m); return v === undefined ? null : v; });
  const hasR = h.p.some(p => p.r === 'R');
  if (hasR && vals.some(v => v != null)) {
    const sum = vals.reduce((s, v) => s + (v || 0), 0);
    box.innerHTML = `<button class="hmini" id="toChart">
      <div class="r1"><span class="st">Расход ЭО · 12 мес.</span><span>${esc(kwh(sum))}</span></div>
      ${barsHtml(vals, { last: 11, h: 30 })}
      <div class="r1 meta"><span>по расчётным ПУ</span><span>Нажмите, чтобы раскрыть →</span></div></button>`;
    $('#toChart').onclick = () => go(`#/eo/${encodeURIComponent(e.id)}/chart`);
  } else box.innerHTML = '';
  const hb = $('#histlink');
  if (hb && h.h.length) {
    hb.innerHTML = `<button class="hrow" id="toHist"><span class="st">История изменений · ${h.h.length}</span>${ICON.right}</button>`;
    $('#toHist').onclick = () => go(`#/eo/${encodeURIComponent(e.id)}/hist`);
  }
  document.querySelectorAll('#view .pucard[data-pu]').forEach(c => decoratePu(c, e));
}

// кнопка «Посмотреть расход ПУ помесячно» в карточке прибора учёта
function decoratePu(card, e) {
  const ch = window._cardHist;
  if (!ch || ch.id !== e.id || card.querySelector('.hpu')) return;
  const [num, role] = card.dataset.pu.split('|');
  const p = histMeter(ch.h, num, role);
  if (!p) return;
  const b = document.createElement('button');
  b.className = 'hpu';
  b.textContent = 'Посмотреть расход ПУ помесячно →';
  b.onclick = () => go(`#/eo/${encodeURIComponent(e.id)}/pu/${puKey(p)}`);
  card.appendChild(b);
}

function histBar(title, sub, id) {
  setBar(`<button class="ib" id="back" aria-label="Назад">${ICON.back}</button><div class="t">${esc(title)}${sub ? `<small class="tsub">${esc(sub)}</small>` : ''}</div>`);
  $('#back').onclick = () => (history.length > 1 ? history.back() : go('#/eo/' + encodeURIComponent(id)));
}

// ---------------------------------------------------------------- расход ЭО по годам
async function renderEoChart(id, state) {
  const e = X.byId.get(id);
  histBar('Расход ЭО', e ? `${e.name} · ЭО ${id}` : 'ЭО ' + id, id);
  window.scrollTo(0, 0);
  const h = await getHist(id);
  if (!h) { $('#view').innerHTML = '<div class="empty">Истории по этому ЭО нет в загруженной базе.</div>'; return; }
  const years = [...new Set(H.months.map(mY))];
  const st = state || { year: mY(H.last), mode: 'eo', sel: null };
  const Y = st.year;
  const ym = y => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const cur = ym(Y).map(m => { const v = valAt(h.t, h.m0, m); return v === undefined ? null : v; });
  const prev = ym(Y - 1).map(m => { const v = valAt(h.t, h.m0, m); return v === undefined ? null : v; });
  const view = $('#view');
  const tabs = `<div class="ytabs">${years.map(y => `<button data-y="${y}" class="${y === Y ? 'on' : ''}">${y}</button>`).join('')}</div>
    <div class="chips2"><button data-mode="eo" class="${st.mode === 'eo' ? 'on' : ''}">Вся ЭО</button><button data-mode="pu" class="${st.mode === 'pu' ? 'on' : ''}">По каждому ПУ</button></div>`;
  let body = '';
  if (st.mode === 'eo') {
    const max = Math.max(1, ...cur.concat(prev).map(v => Math.abs(v || 0)));
    const H2 = 200;
    const lastIdx = Y === mY(H.last) ? mM(H.last) - 1 : -1;
    const cols = cur.map((v, i) => {
      const pv = prev[i];
      const ph = pv == null ? 0 : Math.max(2, Math.round(Math.abs(pv) / max * H2));
      const ch = v == null ? 0 : Math.max(2, Math.round(Math.abs(v) / max * H2));
      return `<button class="gcol${st.sel === i ? ' sel' : ''}" data-i="${i}" aria-label="${esc(cap(MONTHS[i]))}">
        <i class="gp" style="height:${ph}px"></i><i class="gc${i === lastIdx ? ' lst' : ''}" style="height:${ch}px"></i></button>`;
    }).join('');
    const missing = ym(Y).filter(m => mNum(m) <= mNum(H.last) && mNum(m) >= mNum(H.months[0]) && !H.months.includes(m));
    const inYear = cur.map((v, i) => [v, i]).filter(x => x[0] != null);
    const sum = inYear.reduce((s, x) => s + x[0], 0);
    const both = inYear.filter(x => prev[x[1]] != null);
    const sumC = both.reduce((s, x) => s + x[0], 0), sumP = both.reduce((s, x) => s + prev[x[1]], 0);
    const pct = both.length && sumP ? Math.round((sumC - sumP) / Math.abs(sumP) * 100) : null;
    const maxM = inYear.length ? inYear.reduce((a, b) => (b[0] > a[0] ? b : a)) : null;
    const selTxt = st.sel != null ? `<div class="gsel">${esc(cap(MONTHS[st.sel]))} ${Y}: <b>${cur[st.sel] == null ? 'нет данных' : esc(kwh(cur[st.sel]))}</b>`
      + (prev[st.sel] != null ? ` · ${Y - 1}: ${esc(kwh(prev[st.sel]))}` : '') + '</div>' : '';
    body = `<div class="card gcard">
      <div class="legend"><span><i class="lc"></i>${Y}</span><span><i class="lp"></i>${Y - 1} для сравнения</span></div>
      <div class="gchart" style="height:${H2}px">${cols}</div>
      <div class="glabels">${MLET.map(l => `<span>${l}</span>`).join('')}</div>
      ${selTxt}
      <p class="gnote">Общий расход по расчётным ПУ, транзит не вычитается.${missing.length ? ` Нет данных за: ${missing.map(m => MONTHS[mM(m) - 1]).join(', ')}.` : ''} Нажмите на столбик — значение месяца.</p>
    </div>
    <div class="tiles">
      <div class="tile"><span>Итого за ${inYear.length} ${plural(inYear.length, 'месяц', 'месяца', 'месяцев')}</span><b class="or">${esc(kwh(sum))}</b></div>
      <div class="tile"><span>К тем же мес. ${Y - 1}</span><b class="${pct == null ? '' : pct <= 0 ? 'gr' : 'rd'}">${pct == null ? '—' : (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct) + '%'}</b></div>
      <div class="tile"><span>Средний месяц</span><b>${inYear.length ? esc(kwh(sum / inYear.length)) : '—'}</b></div>
      <div class="tile"><span>Максимум</span><b>${maxM ? esc(MONTHS[maxM[1]]) : '—'}</b></div>
    </div>
    <div class="card htable"><div class="tr th"><span>Месяц</span><span>кВт·ч</span><span>к ${Y - 1}</span></div>
      ${inYear.slice().reverse().map(([v, i]) => {
        const p = prev[i];
        const d = p != null && p !== 0 ? Math.round((v - p) / Math.abs(p) * 100) : null;
        return `<div class="tr"><span>${esc(cap(MONTHS[i]))}</span><span>${fmtN(Math.round(v))}</span><span class="${d == null ? '' : d <= 0 ? 'gr' : 'rd'}">${d == null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + '%'}</span></div>`;
      }).join('') || '<p class="meta" style="padding:10px 0">Нет данных за этот год.</p>'}</div>`;
  } else {
    const items = h.p.filter(p => p.r === 'R').concat(h.p.filter(p => p.r === 'T')).map(p => {
      const vals = ym(Y).map(m => { const v = valAt(p.t, p.m0, m); return v === undefined ? null : v; });
      if (!vals.some(v => v != null)) return '';
      const sum = vals.reduce((s, v) => s + (v || 0), 0);
      const lastIdx = Y === mY(H.last) ? mM(H.last) - 1 : -1;
      return `<button class="hpucard" data-k="${puKey(p)}">
        <div class="r1"><span class="pu-title">ПУ № ${esc(p.n)}</span>${p.r === 'T' ? '<span class="badge b-T">Транзитный</span>' : '<span class="badge b-B">Расчётный</span>'}</div>
        ${p.cur ? '' : `<div class="meta">Снят · последние данные за ${esc(mDot(H.months[p.m1]))}</div>`}
        ${barsHtml(vals, { last: lastIdx, h: 34, cls: p.r === 'T' ? 'tr' : '' })}
        <div class="glabels sm">${MLET.map(l => `<span>${l}</span>`).join('')}</div>
        <div class="r1 meta"><span>За ${Y}: ${esc(kwh(sum))}</span><span>Подробнее →</span></div></button>`;
    }).join('');
    body = items || '<div class="empty">В этом году данных по ПУ нет.</div>';
    body += '<p class="gnote" style="margin-top:10px">Общий расход за месяц из Ф18. У транзитных ПУ расход со знаком минус — столбики показаны по модулю.</p>';
  }
  view.innerHTML = tabs + body;
  view.querySelectorAll('[data-y]').forEach(b => b.onclick = () => renderEoChart(id, { ...st, year: +b.dataset.y, sel: null }));
  view.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => renderEoChart(id, { ...st, mode: b.dataset.mode, sel: null }));
  view.querySelectorAll('.gcol').forEach(b => b.onclick = () => renderEoChart(id, { ...st, sel: +b.dataset.i === st.sel ? null : +b.dataset.i }));
  view.querySelectorAll('[data-k]').forEach(b => b.onclick = () => go(`#/eo/${encodeURIComponent(id)}/pu/${b.dataset.k}`));
}

// ---------------------------------------------------------------- расход ПУ помесячно
async function renderPuChart(id, key, state) {
  const e = X.byId.get(id);
  const [k, r] = decodeURIComponent(key).split('~');
  const h = await getHist(id);
  const p = h && (h.p.find(x => x.k === k && x.r === r) || h.p.find(x => x.k === k));
  histBar('Расход ПУ помесячно', p ? `ПУ № ${p.n}${e ? ' · ' + e.name : ''}` : '', id);
  window.scrollTo(0, 0);
  if (!p) { $('#view').innerHTML = '<div class="empty">Истории по этому ПУ нет в загруженной базе.</div>'; return; }
  const st = state || { all: true, rows: 6 };
  const first = mNum(H.months[p.m0]), lastN = p.cur ? mNum(H.last) : mNum(H.months[p.m1]);
  const from = st.all ? first : Math.max(first, lastN - 11);
  const months = []; for (let n = from; n <= lastN; n++) months.push(mStr(n));
  const vals = months.map(m => { const v = valAt(p.t, p.m0, m); return v === undefined ? null : v; });
  const years = [];
  months.forEach((m, i) => { if (mM(m) === 1 || i === 0) years.push([i, mY(m)]); });
  const N = months.length;
  const ylab = st.all
    ? `<div class="ylab">${years.map(([i, y]) => `<span style="left:min(${((i / N) * 100).toFixed(2)}%, calc(100% - 34px))">${y}</span>`).join('')}</div>`
    : `<div class="glabels" style="grid-template-columns:repeat(${N},1fr)">${months.map(m => `<span>${MLET[mM(m) - 1]}</span>`).join('')}</div>`;
  const rows = [];
  for (let j = p.t.length - 1; j >= 0; j--) {
    const m = H.months[p.m0 + j];
    if (p.t[j] == null && p.a[j] == null && p.b[j] == null) continue;
    rows.push({ m, a: p.a[j], b: p.b[j], t: p.t[j], s: p.s[j] == null ? '' : H.src[p.s[j]] });
  }
  const shown = rows.slice(0, st.rows);
  const mv = p.mv ? (() => {
    const there = X.byId.get(p.mv.e);
    const lbl = `До ${esc(mDot(H.months[p.mv.m1]))} этот ПУ был на ЭО № ${esc(p.mv.e)}${p.mv.name ? ' (' + esc(p.mv.name) + ')' : ''}.`;
    return `<div class="hnote">${lbl}${there ? ` <button class="linkbtn" data-go="${esc(p.mv.e)}">Открыть ЭО</button>` : ''}</div>`;
  })() : '';
  $('#view').innerHTML = `
    ${mv}
    ${p.cur ? '' : `<div class="hnote">ПУ снят: последние данные за ${esc(mFull(H.months[p.m1]).toLowerCase())}.</div>`}
    <div class="card gcard">
      <div class="r1"><span class="st" style="font-size:16px">Расход ПУ</span>
        <span class="chips2 sm"><button data-all="0" class="${st.all ? '' : 'on'}">12 мес.</button><button data-all="1" class="${st.all ? 'on' : ''}">Всё время</button></span></div>
      ${barsHtml(vals, { last: N - 1, h: 150, cls: p.r === 'T' ? 'tr' : '' })}
      ${ylab}
      <p class="gnote">Общий расход за месяц из Ф18, кВт·ч. Оранжевым — последний месяц.${p.r === 'T' ? ' Транзитный ПУ: расход со знаком минус, столбики — по модулю.' : ''}</p>
    </div>
    <div class="card htable pu4"><h2>Показания</h2>
      <div class="tr th"><span>Месяц</span><span>Предыд.</span><span>Текущ.</span><span>Расход</span></div>
      ${shown.map(x => `<div class="tr"><span>${esc(mShort(x.m))}</span><span>${esc(x.a ?? '—')}</span><span>${esc(x.b ?? '—')}</span><span>${x.t == null ? '—' : fmtN(Math.round(x.t))}</span>
        ${x.s ? `<small>источник: ${esc(x.s)}</small>` : ''}</div>`).join('')}
      ${rows.length > shown.length ? `<button class="more" id="allRows">Показать все ${rows.length} ${plural(rows.length, 'месяц', 'месяца', 'месяцев')}</button>` : ''}
    </div>`;
  document.querySelectorAll('[data-all]').forEach(b => b.onclick = () => renderPuChart(id, key, { ...st, all: b.dataset.all === '1' }));
  if ($('#allRows')) $('#allRows').onclick = () => renderPuChart(id, key, { ...st, rows: 1e6 });
  bindGo($('#view'));
}

// ---------------------------------------------------------------- история изменений ЭО
async function renderEoHist(id) {
  histBar('История изменений', `ЭО ${id} · с ${H ? mShort(H.months[0]) : ''}`, id);
  window.scrollTo(0, 0);
  const h = await getHist(id);
  if (!h || !h.h.length) { $('#view').innerHTML = '<div class="empty">Изменений по этому ЭО в архиве нет.</div>'; return; }
  const dot = k => (k === 'transit' || k === 'new' || k === 'repl') ? 'or' : k === 'first' ? 'gy' : 'bl';
  $('#view').innerHTML = `<div class="tl">${h.h.map(([j, k, t, x]) => `
    <div class="tli"><div class="tld ${dot(k)}"></div><div class="tlb">
      <div class="meta">${esc(mFull(H.months[j]))}</div>
      <div class="tlc"><div class="st">${esc(t)}</div><div class="tlx">${esc(x)}</div></div></div></div>`).join('')}</div>
    <p class="gnote" style="margin-top:6px">Каждое событие — изменение в Ф18 между двумя соседними месяцами архива. Месяцы без изменений не показываются.</p>`;
}

// ---------------------------------------------------------------- «База данных»: блок изменений за месяц
const CHG = {
  newEo: 'Новые ЭО', goneEo: 'Выбывшие ЭО', puRepl: 'Замены ПУ', coords: 'Уточнены координаты', other: 'Прочие изменения'
};

function changesCardHtml() {
  if (!H || !H.prev) return '';
  const s = H.sum || {};
  return `<div class="card hl"><div class="r1"><h2>Изменения за ${esc(MONTHS[mM(H.last) - 1])}</h2><span class="meta">к ${esc(mShort(H.prev))}</span></div>
    ${Object.keys(CHG).map(k => `<button class="srow2" data-chg="${k}"><span>${CHG[k]}</span><span><b>${fmtN((s[k] || []).length)}</b>${ICON.right}</span></button>`).join('')}
    ${H.gaps && H.gaps.length ? `<p class="meta" style="margin-top:6px">В архиве нет месяцев: ${H.gaps.length}. Графики за них пустые.</p>` : ''}</div>`;
}

function bindChanges() {
  document.querySelectorAll('[data-chg]').forEach(b => b.onclick = () => go('#/changes/' + b.dataset.chg));
}

function renderChanges(type, limit = 200) {
  setBar(`<button class="ib" id="back" aria-label="Назад">${ICON.back}</button><div class="t">${esc(CHG[type] || 'Изменения')}<small class="tsub">${H ? esc(mFull(H.last)) + ' к ' + esc(mShort(H.prev || H.last)) : ''}</small></div>`);
  $('#back').onclick = () => (history.length > 1 ? history.back() : go('#/data'));
  window.scrollTo(0, 0);
  const list = (H && H.sum && H.sum[type]) || [];
  if (!list.length) { $('#view').innerHTML = '<div class="empty">Нет изменений.</div>'; return; }
  const item = x => {
    if (type === 'goneEo') {
      const [id, name, contract, addr] = x;
      return `<div class="row"><div class="name">${esc(name)}</div><div class="meta">Договор ${esc(contract || '—')}, ЭО ${esc(id)}${addr ? '<br>' + esc(addr) : ''}</div></div>`;
    }
    const id = Array.isArray(x) ? x[0] : x, text = Array.isArray(x) ? x[1] : '';
    const e = X.byId.get(id);
    return `<button class="row" data-go="${esc(id)}"><div class="name">${esc(e ? e.name : 'ЭО ' + id)}</div>
      <div class="meta">${e ? `Договор ${esc(e.contract || '—')}, ` : ''}ЭО ${esc(id)}</div>${text ? `<div class="why">${esc(text)}</div>` : ''}</button>`;
  };
  $('#view').innerHTML = `<div class="count">Всего: ${fmtN(list.length)}${type === 'goneEo' ? '. Карточек у них нет: в последней Ф18 этих ЭО уже нет' : ''}</div>
    <div class="list">${list.slice(0, limit).map(item).join('')}</div>
    ${list.length > limit ? `<button class="more" id="more">Показать ещё (${fmtN(list.length - limit)})</button>` : ''}`;
  bindGo($('#view'));
  if ($('#more')) $('#more').onclick = () => renderChanges(type, limit + 500);
}
