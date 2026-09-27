'use strict';
// Мобильный ЕБЦ: поиск, карточка ЭО, транзит, загрузка базы. Карты — в maps.js.

const CFG = Object.assign({ yandexFolderUrl: '', staleDays: 35 }, window.APP_CONFIG || {});
const VERSION = '1.6.0';
const PAGE = 50;

// ---------- мелкие помощники ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, ' ').trim();
const normH = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();
const fmtN = n => Number(n || 0).toLocaleString('ru-RU');
const fmtDate = t => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const fmtPeriod = p => { const m = /^(\d{2})\.(\d{4})$/.exec(p || ''); return m ? MONTHS[+m[1] - 1] + ' ' + m[2] : ''; };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };

const ICON = {
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  back: '<svg class="i" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  close: '<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  gear: '<svg class="i" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  map: '<svg class="i" viewBox="0 0 24 24"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  chev: '<svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  right: '<svg class="i" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  file: '<svg class="i" viewBox="0 0 24 24"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/></svg>',
  bolt: '<svg class="i" viewBox="0 0 24 24" style="stroke:none;fill:currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  target: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  share: '<svg class="i" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>'
};

// ---------- хранилища ----------
const idb = {
  open() {
    return this._p || (this._p = new Promise((res, rej) => {
      const r = indexedDB.open('mobile-ebc', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const st = t.objectStore('kv');
      const req = fn(st);
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  get(k) { return this.tx('readonly', s => s.get(k)); },
  set(k, v) { return this.tx('readwrite', s => s.put(v, k)); },
  del(k) { return this.tx('readwrite', s => s.delete(k)); }
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
// лозунг под логотипом: случайный при каждом открытии приложения, не тот же, что в прошлый раз
const SLOGANS = [
  'ЕБЦ всегда под рукой',
  'Вся база — в кармане',
  'Счётчик не спрячется',
  'Работает даже в подвале',
  'Ctrl+F для всего Южного ТО',
  'Найдём быстрее, чем дозвонитесь в офис',
  'Где ТП? Вот ТП.',
  'Меньше звонков — больше дела',
  'Договор, ЭО, счётчик — одним поиском',
  'Инспектор знает, куда идти',
];
const SLOGAN = (() => {
  const prev = ls.get('slogan', '');
  const pool = SLOGANS.filter(x => x !== prev);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  ls.set('slogan', pick);
  return pick;
})();


// ---------- модель данных ----------
let M = null;   // таблица из файла
let X = null;   // индекс: ЭО, транзитные связи, поиск
let SUBS = null; // подстанции из .geojson (хранятся отдельно: новая база без подстанций их не стирает)
let FIXES = {};  // уточнения координат, сделанные на этом телефоне: ЭО → {lat, lon, ts, how, acc, sent}
let FIX_VER = 0; // растёт при каждом изменении уточнений — карта перестраивается

// Точка ЭО на карте: своё уточнение (на проверке) важнее координат из базы.
function eoLL(e) { return e.fix ? [e.fix.lat, e.fix.lon] : e.lat != null ? [e.lat, e.lon] : null; }
const fmtDay = t => new Date(t).toLocaleDateString('ru-RU');
function distM(a, b) {
  const dy = (a[0] - b[0]) * 111000, dx = (a[1] - b[1]) * 111000 * Math.cos(a[0] * Math.PI / 180);
  return Math.round(Math.hypot(dx, dy));
}

function joinAddr(parts) {
  const out = [];
  for (const p of parts) { const v = (p || '').trim(); if (v && !out.includes(v)) out.push(v); }
  return out.join(', ');
}

function buildIndex(m) {
  const { rows, f } = m;
  const col = (r, i) => (i == null || i < 0 ? '' : (r[i] || ''));
  const roleOf = r => { const t = norm(col(r, f.role)); return t.startsWith('транзит') ? 'T' : t.startsWith('расч') ? 'B' : ''; };
  const meterOf = r => { const v = col(r, f.meter); return /\d/.test(v) ? v : ''; };
  const factOf = r => joinAddr(f.fact.map(i => col(r, i)));
  const tuOf = r => joinAddr(f.tu.map(i => col(r, i)));

  const byId = new Map(), eos = [], rowEo = new Array(rows.length);
  rows.forEach((r, i) => {
    const id = col(r, f.eo) || ('без номера, строка ' + (i + 1));
    let e = byId.get(id);
    if (!e) { e = { id, rows: [], receivers: [], givers: [] }; byId.set(id, e); eos.push(e); }
    e.rows.push(i); rowEo[i] = e;
  });

  // Транзит: один и тот же счётчик — «Транзитная» у транзитодателя и «Расчётная» у транзитоприёмника.
  const meterRows = new Map();
  rows.forEach((r, i) => { const n = meterOf(r); if (n) { if (!meterRows.has(n)) meterRows.set(n, []); meterRows.get(n).push(i); } });
  let links = 0;
  rows.forEach((r, i) => {
    if (roleOf(r) !== 'T') return;
    const n = meterOf(r), giver = rowEo[i];
    let cands = n ? meterRows.get(n).filter(j => j !== i && roleOf(rows[j]) === 'B' && rowEo[j] !== giver) : [];
    if (cands.length > 1) {
      const same = cands.filter(j => col(rows[j], f.ikts) && col(rows[j], f.ikts) === col(r, f.ikts));
      if (same.length) cands = same;
    }
    if (!cands.length) { giver.receivers.push({ giver, giverRow: i, recv: null, recvRow: null }); return; }
    for (const j of cands) {
      const link = { giver, giverRow: i, recv: rowEo[j], recvRow: j };
      giver.receivers.push(link); rowEo[j].givers.push(link); links++;
    }
  });

  for (const e of eos) {
    const r0 = rows[e.rows[0]];
    e.name = col(r0, f.name) || 'Без наименования';
    e.contract = col(r0, f.contract);
    e.inn = col(r0, f.inn);
    e.fact = factOf(r0);
    e.meters = e.rows.map(i => ({ row: i, num: meterOf(rows[i]), role: roleOf(rows[i]) })).filter(x => x.num);
    e.tus = [...new Set(e.rows.map(i => tuOf(rows[i])).filter(Boolean))];
    e.recvCount = new Set(e.receivers.map(l => (l.recv ? l.recv.id : 'row' + l.giverRow))).size;
    e.giverList = [...new Map(e.givers.map(l => [l.giver.id, l.giver])).values()];
    e.nName = norm(e.name);
    e.addr = ' ' + normQ([e.fact, e.tus.join(' ')].join(' ')) + ' ';
    e.hay = ' ' + normQ([e.name, e.inn, e.contract, e.id, e.meters.map(x => x.num).join(' ')].join(' ')) + e.addr;
    // координаты из геокодера (колонки «Координаты / Широта, Долгота, Точность»)
    e.lat = e.lon = null; e.approx = false; e.manual = false; e.manualInfo = ''; e.fix = null;
    if (f.lat >= 0 && f.lon >= 0) {
      for (const i of e.rows) {
        const la = parseFloat(String(col(rows[i], f.lat)).replace(',', '.')), lo = parseFloat(String(col(rows[i], f.lon)).replace(',', '.'));
        if (isFinite(la) && isFinite(lo) && la > 40 && la < 75 && lo > 19 && lo < 180) {
          e.lat = la; e.lon = lo;
          const pr = norm(col(rows[i], f.prec));
          e.approx = !!pr && pr !== 'дом';
          const src = col(rows[i], f.src);
          e.manual = /^вручную/i.test(src);
          if (e.manual) { const m = /\((.+)\)/.exec(src); e.manualInfo = m ? m[1] : ''; }
          break;
        }
      }
    }
  }
  const withCoords = eos.reduce((n, e) => n + (e.lat != null ? 1 : 0), 0);
  return { eos, byId, rowEo, roleOf, meterOf, tuOf, col, links, withCoords, hasCoordCols: f.lat >= 0 };
}

// ---------- поиск ----------
// Нормализация для поиска: «Красноармейская7» → «красноармейская 7», «7 А» → «7а».
function normQ(v) {
  return norm(v)
    .replace(/([a-zа-я]{2,})(\d)/g, '$1 $2')
    .replace(/(^| )(\d{1,3}) ([абвгдежз])(?= |$)/g, '$1$2$3');
}
function tokensOf(q) { return normQ(q).split(' ').filter(Boolean); }

// Короткий номер (дом, строение, корпус): 7, 12, 7а. Ищется только в адресе и только целиком.
const isHouse = t => /^\d{1,3}[а-я]?$/.test(t);
const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function houseRe(t) {
  return new RegExp(' ' + reEsc(t) + (/[а-я]$/.test(t) ? '(?![0-9а-я])' : '(?![0-9])'));
}

function search(q) {
  const toks = tokensOf(q);
  if (!toks.length) return [];
  const nq = toks.join(' ');
  const single = toks.length === 1 ? toks[0] : null;
  const houses = toks.filter(isHouse);
  const words = toks.filter(t => !isHouse(t) && !/^\d+$/.test(t) && t.length >= 3);
  const plain = toks.filter(t => !isHouse(t));
  const hRe = houses.map(houseRe);
  // «улица … дом»: номер идёт сразу за названием улицы (между ними могут стоять «д», «дом», «ул» и т.п.)
  const pairRe = [];
  for (const w of words) for (const h of houses) {
    const base = reEsc(w) + '[а-я]*(?: [а-я]{1,6}){0,2} ' + reEsc(h);
    pairRe.push([new RegExp(base + '(?![0-9а-я])'), new RegExp(base + '(?![0-9])')]);
  }
  const res = [];
  for (const e of X.eos) {
    let ok = true;
    for (const t of plain) if (!e.hay.includes(t)) { ok = false; break; }
    if (ok) for (const r of hRe) if (!r.test(e.addr)) { ok = false; break; }
    if (!ok) continue;
    let score = 0, why = '';
    if (single && /\d/.test(single) && !isHouse(single)) {
      const checks = [['№ ПУ', e.meters.map(m => m.num)], ['договор', [e.contract]], ['ЭО', [e.id]], ['ИНН', [e.inn]]];
      for (const [label, vals] of checks) {
        for (const v of vals) {
          const nv = norm(v);
          if (!nv) continue;
          if (nv === single) { score = Math.max(score, 100); why = why || label; }
          else if (nv.startsWith(single)) { score = Math.max(score, 60); why = why || label; }
          else if (nv.includes(single)) { score = Math.max(score, 30); why = why || label; }
        }
      }
    }
    for (const [exact, loose] of pairRe) {
      if (exact.test(e.addr)) { score += 50; break; }
      if (loose.test(e.addr)) { score += 35; break; }
    }
    if (e.nName.startsWith(nq)) score += 20; else if (e.nName.includes(nq)) score += 10;
    res.push({ e, score, why });
  }
  res.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name, 'ru'));
  return res;
}

function highlight(text, toks) {
  const s = esc(text);
  if (!toks || !toks.length) return s;
  const parts = toks.map(t => {
    const p = reEsc(t).replace(/е/g, '[её]');
    return isHouse(t) ? '(?<![0-9])' + p + '(?![0-9])' : p;
  });
  try { return s.replace(new RegExp('(' + parts.join('|') + ')', 'gi'), '<mark>$1</mark>'); }
  catch { return s; }
}

// ---------- интерфейс: общие части ----------
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function setBar(html) { $('#bar').innerHTML = html; }
function go(hash) { location.hash = hash; }
function currentQuery() {
  const h = location.hash || '#/';
  return h.startsWith('#/?') || h === '#/' || h === '' ? (new URLSearchParams(h.split('?')[1] || '').get('q') || '') : '';
}

function roleBadge(role) {
  return role === 'T' ? '<span class="badge b-T">Транзитный</span>'
    : role === 'B' ? '<span class="badge b-B">Расчётный</span>'
      : '<span class="badge b-x">Тип не указан</span>';
}

function transitChips(e) {
  let h = '';
  // голубая плашка — про транзитодателя, оранжевая — про транзитоприёмников
  if (e.recvCount) h += `<span class="trl recv">Есть транзитоприёмники: ${e.recvCount}</span>`;
  if (e.giverList.length === 1) h += `<span class="trl giver">Транзитодатель: ${esc(e.giverList[0].name)}</span>`;
  else if (e.giverList.length > 1) h += `<span class="trl giver">Транзитодателей: ${e.giverList.length}</span>`;
  return h;
}

// ---------- главная и результаты ----------
let lastResults = [], shown = 0, lastQ = null;

function renderHome() {
  const q = currentQuery();
  setBar(`<div class="t"></div><button class="ib" id="toData" aria-label="База данных">${ICON.gear}</button>`);
  $('#toData').onclick = () => go('#/data');
  $('#view').innerHTML = `
    <div class="homelogo"><div><img src="logo.svg" alt="ЕБЦ"><div class="slogan">${esc(SLOGAN)}</div></div></div>
    <label class="search" id="sbox">${ICON.search}
      <input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Договор, ЭО, счётчик, адрес, ИНН, абонент">
      <button class="clear" id="clr" aria-label="Очистить">${ICON.close}</button></label>
    <div id="homeExtra"></div>
    <div id="results"></div>`;
  const input = $('#q');
  input.value = q;
  let tmr;
  input.oninput = () => {
    clearTimeout(tmr);
    tmr = setTimeout(() => {
      history.replaceState(null, '', input.value.trim() ? '#/?q=' + encodeURIComponent(input.value) : '#/');
      updateResults(input.value);
    }, 150);
  };
  input.onkeydown = ev => { if (ev.key === 'Enter') input.blur(); };
  $('#clr').onclick = ev => { ev.preventDefault(); input.value = ''; history.replaceState(null, '', '#/'); updateResults(''); input.focus(); };
  lastQ = null;
  updateResults(q, true);
}

function renderHomeExtra() {
  const m = M.meta;
  const recent = ls.get('recent', []);
  const stale = Date.now() - m.loadedAt > CFG.staleDays * 864e5;
  $('#homeExtra').innerHTML = `
    <div class="hint">Можно вводить часть номера или несколько слов: «ленина 12», «12345678», «ромашка раменское».</div>
    <div class="mapbtns"><button class="mapbtn" id="toMap"${X.withCoords ? '' : ' disabled'}>${ICON.map}<div>Карта договоров<small>${X.withCoords ? 'ЭО и подстанции' : 'В базе нет координат — нужен архив из геокодера'}</small></div></button>
    <button class="mapbtn dark" id="toSubs"${SUBS ? '' : ' disabled'}>${ICON.bolt}<div>Карта подстанций<small>${SUBS ? 'Поиск ТП по номеру' : 'В архиве не было подстанций'}</small></div></button></div>
    ${recent.length ? `<div class="sub">Недавние запросы</div><div class="chips">${recent.map(r => `<button class="chip" data-q="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
    <button class="basebar${stale ? ' stale' : ''}" id="baseInfo" style="width:100%;text-align:left">
      <span>${stale ? 'База загружена больше месяца назад.<br>' : ''}База ${esc(fmtPeriod(m.period) || m.fileName)}<br>${fmtN(m.eo)} ЭО, ${fmtN(m.rows)} строк</span><b>Обновить</b></button>`;
  document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    const input = $('#q'); input.value = b.dataset.q;
    history.replaceState(null, '', '#/?q=' + encodeURIComponent(b.dataset.q));
    updateResults(b.dataset.q);
  });
  $('#baseInfo').onclick = () => go('#/data');
  if (X.withCoords) $('#toMap').onclick = () => go('#/map');
  if (SUBS) $('#toSubs').onclick = () => go('#/subs');
}

function updateResults(q, restoring) {
  const box = $('#results'), has = !!q.trim();
  $('#sbox').classList.toggle('has', has);
  $('#sbox').classList.toggle('compact', has);
  document.body.classList.toggle('home-idle', !has);
  if (!has) { $('#homeExtra').hidden = false; renderHomeExtra(); box.innerHTML = ''; return; }
  $('#homeExtra').hidden = true;
  if (q !== lastQ) {
    lastQ = q;
    lastResults = search(q);
    shown = 0;
  }
  const want = restoring ? Math.max(PAGE, +(sessionStorage.getItem('shown:' + q) || 0)) : PAGE;
  box.innerHTML = lastResults.length
    ? `<div class="count">Найдено ${fmtN(lastResults.length)} ЭО</div><div class="list" id="list"></div><div id="moreBox"></div>`
    : `<div class="empty">Ничего не нашлось.<br>Проверьте номер или попробуйте часть слова.</div>`;
  shown = 0;
  appendRows(want, q);
  if (restoring) {
    const y = +(sessionStorage.getItem('scroll:' + q) || 0);
    if (y) requestAnimationFrame(() => window.scrollTo(0, y));
  }
}

function appendRows(n, q) {
  const list = $('#list'); if (!list) return;
  const toks = tokensOf(q);
  const slice = lastResults.slice(shown, shown + n);
  list.insertAdjacentHTML('beforeend', slice.map(r => rowHtml(r, toks)).join(''));
  shown += slice.length;
  const more = $('#moreBox');
  const left = lastResults.length - shown;
  more.innerHTML = left > 0 ? `<button class="more" id="moreBtn">Показать ещё ${fmtN(Math.min(PAGE, left))} из ${fmtN(left)}</button>` : '';
  if (left > 0) $('#moreBtn').onclick = () => appendRows(PAGE, q);
  list.querySelectorAll('.row:not([data-bound])').forEach(el => {
    el.dataset.bound = 1;
    el.onclick = () => {
      sessionStorage.setItem('scroll:' + q, String(window.scrollY));
      sessionStorage.setItem('shown:' + q, String(shown));
      rememberQuery(q);
      go('#/eo/' + encodeURIComponent(el.dataset.id));
    };
  });
}

function rememberQuery(q) {
  q = q.trim(); if (!q) return;
  const r = ls.get('recent', []).filter(x => x !== q);
  r.unshift(q); ls.set('recent', r.slice(0, 6));
}

function rowHtml({ e, why }, toks) {
  const nm = e.meters.length;
  const badge = nm ? `<span class="badge b-pu">${nm} ПУ</span>` : '<span class="badge b-x">Нет ПУ</span>';
  const single = toks.length === 1 ? toks[0] : '';
  const MAXPU = 3;
  let meters = e.meters;
  // найденный счётчик показываем первым
  if (single) meters = [...meters].sort((a, b) => (norm(b.num).includes(single) ? 1 : 0) - (norm(a.num).includes(single) ? 1 : 0));
  const pus = meters.slice(0, MAXPU).map(m => `<div class="pu${single && norm(m.num).includes(single) ? ' hit' : ''}"><span>№ ${highlight(m.num, toks)}</span>${roleBadge(m.role)}</div>`).join('');
  const morePu = nm > MAXPU ? `<div class="pu" style="color:var(--muted)">ещё ${nm - MAXPU} ПУ</div>` : '';
  // показываем тот адрес, где нашлось совпадение (фактический или ТУ)
  const addrs = [e.fact, ...e.tus].filter(Boolean);
  const fits = a => { const n = ' ' + normQ(a) + ' '; return toks.every(t => (isHouse(t) ? houseRe(t).test(n) : n.includes(t))); };
  const addr = addrs.find(fits) || addrs.find(a => toks.some(t => !isHouse(t) && (' ' + normQ(a)).includes(t))) || addrs[0] || '';
  const addrLabel = addr && addr !== e.fact ? 'Адрес ТУ: ' : '';
  const whyLine = why === 'ИНН' ? `<div class="why">совпало: ИНН ${highlight(e.inn, toks)}</div>` : '';
  return `<button class="row" data-id="${esc(e.id)}">
    <div class="r1"><div class="name">${highlight(e.name, toks)}</div>${badge}</div>
    <div class="meta">Договор ${highlight(e.contract || '—', toks)}<br>ЭО ${highlight(e.id, toks)}${addr ? '<br>' + addrLabel + highlight(addr, toks) : ''}</div>
    ${whyLine}
    ${nm ? `<div class="pus">${pus}${morePu}</div>` : ''}
    ${transitChips(e)}
  </button>`;
}

// ---------- карточка ЭО ----------
const SECTIONS = [
  { key: 'contract', title: 'Договор и потребитель', re: /^(наименование потребителя|инн|договор|вид договора|ценовая категория|категория потребителя|юридический адрес|состояние абонента)/ },
  { key: 'object', title: 'Энергообъект', re: /^(номер объекта|фактический адрес|регион)/ },
  { key: 'net', title: 'Точка поставки и сеть', re: /^(наименование сетевой|наименование пэс|наименование рэс|№ рэс|наименование отделения|наименование точки поставки)/ }
];
const SKIP = /^(№ п ?\/ ?п)$/;
const STRIP_TOP = ['договор', 'фактический адрес', 'прибор учета', 'потери', 'уровень напряжения', 'юридический адрес', 'адрес точки учета', 'наименование точки поставки электрической энергии'];
const HIDE_ZERO = /^(показания|потери|расчетный способ)/;
const METER_FIRST = [/тип счетчика/, /марка счетчика/, /^адрес точки учета/, /^расход электроэнергии/, /^общий расход/, /^показания/, /^расчетный коэффициент/, /^источник показаний/];

function labelOf(h) {
  const k = h.indexOf(' / ');
  if (k < 0) return h;
  const top = h.slice(0, k), sub = h.slice(k + 3);
  const nt = normH(top);
  if (nt === 'показания счетчика') return 'Показания: ' + sub.toLowerCase();
  return STRIP_TOP.includes(nt) ? sub : top + ': ' + sub;
}

function sectionOf(i) {
  const h = X.hn[i];
  if (SKIP.test(h)) return 'skip';
  if (/^координаты \//.test(h)) return 'skip';   // служебные колонки геокодера — они для карты
  for (const s of SECTIONS) if (s.re.test(h)) return s.key;
  return 'meter';
}

function field(label, value, wide) {
  return `<div class="f${wide ? ' w' : ''}"><span>${esc(label)}</span><b data-copy="${esc(value)}">${esc(value)}</b></div>`;
}

function renderCard(id) {
  const e = X.byId.get(id);
  setBar(`<button class="ib" id="back" aria-label="Назад">${ICON.back}</button><div class="t">Карточка ЭО</div>`);
  $('#back').onclick = () => (history.length > 1 ? history.back() : go('#/'));
  if (!e) { $('#view').innerHTML = '<div class="empty">Такой ЭО не найден в текущей базе.</div>'; return; }
  window.scrollTo(0, 0);
  const { rows, header } = M;

  // поля уровня ЭО (одинаковые для всех строк) — различающиеся значения показываем через «/»
  const secHtml = {};
  for (const s of SECTIONS) secHtml[s.key] = [];
  header.forEach((h, i) => {
    const sec = sectionOf(i);
    if (sec === 'meter' || sec === 'skip') return;
    if (sec === 'object' && M.f.fact.includes(i)) return;
    const vals = [...new Set(e.rows.map(r => rows[r][i] || '').filter(Boolean))];
    if (!vals.length) return;
    const v = vals.length > 3 ? vals.slice(0, 3).join(' / ') + ' …' : vals.join(' / ');
    secHtml[sec].push(field(labelOf(h), v, true));
  });
  if (e.fact) secHtml.object.unshift(field('Фактический адрес', e.fact, true));
  if (e.tus.length) secHtml.object.push(field(e.tus.length > 1 ? 'Адреса точек учёта' : 'Адрес точки учёта', e.tus.join(' / '), true));
  if (X.hasCoordCols || e.fix) secHtml.object.push(eoLL(e)
    ? `<button class="onmap" id="onMap">${ICON.pin}Показать на карте</button>`
    : `<button class="onmap" disabled>${ICON.pin}Адрес не найден</button>`);
  secHtml.object.push(eoPointNote(e)
    + (e.fix ? `<div class="fixinfo">${e.fix.how === 'gps' ? 'По GPS' + (e.fix.acc ? ', точность ±' + Math.round(e.fix.acc) + ' м' : '') : 'Указано на карте'}${e.fix.sent ? ' · отправлено' : ' · ещё не отправлено'}
        <button class="linkbtn danger" id="fixDel">Удалить уточнение</button></div>` : '')
    + `<button class="onmap" id="fixBtn">${ICON.target}Уточнить местоположение</button>`);

  const trRows = e.rows.filter(ri => X.roleOf(rows[ri]) === 'T');
  const ownRows = e.rows.filter(ri => X.roleOf(rows[ri]) !== 'T');
  const acc = (title, body, open) => body ? `<details class="acc"${open ? ' open' : ''}><summary>${title}${ICON.chev}</summary>${body}</details>` : '';
  const kv = arr => arr.length ? `<div class="kv">${arr.join('')}</div>` : '';

  $('#view').innerHTML = `
    <div class="head">
      <div class="name">${esc(e.name)}</div>
      <div class="meta">Договор ${esc(e.contract || '—')}<br>ЭО ${esc(e.id)}${e.inn ? '<br>ИНН ' + esc(e.inn) : ''}</div>
      ${transitBlocks(e)}
    </div>
    ${acc('Договор и потребитель', kv(secHtml.contract))}
    ${acc('Энергообъект', kv(secHtml.object), true)}
    ${trRows.length
      ? acc(`Приборы учёта (${ownRows.length})`, '<div id="meters"></div>', true) +
        acc(`ПУ транзитоприёмников (${trRows.length})`, '<div id="trmeters"></div>', false)
      : acc(`Приборы учёта (${e.rows.length})`, '<div id="meters"></div>', true)}
    ${acc('Точка поставки и сеть', kv(secHtml.net))}
  `;
  // У транзитодателя свои (расчётные) ПУ — развёрнуты, транзитные — в отдельном свёрнутом аккордеоне.
  if (trRows.length) {
    renderMeters('#meters', e, ownRows, 10, 'Своих расчётных ПУ нет');
    renderMeters('#trmeters', e, trRows, 10);
  } else renderMeters('#meters', e, e.rows, 10);
  bindCard(e);
  if ($('#onMap')) $('#onMap').onclick = () => go('#/map/eo/' + encodeURIComponent(e.id));
  $('#fixBtn').onclick = () => openFixChooser(e);
  if ($('#fixDel')) $('#fixDel').onclick = async () => {
    if (!confirm('Удалить ваше уточнение точки? Вернётся точка из базы.')) return;
    delete FIXES[e.id]; await saveFixes(); toast('Уточнение удалено'); renderCard(e.id);
  };
}

function transitBlocks(e) {
  let h = '';
  if (e.receivers.length) {
    // один транзитоприёмник — одна строка, даже если связей через несколько ПУ
    const groups = new Map(), orphans = [];
    for (const l of e.receivers) {
      if (!l.recv) { orphans.push(l); continue; }
      if (!groups.has(l.recv.id)) groups.set(l.recv.id, { recv: l.recv, meters: [] });
      const n = X.meterOf(M.rows[l.giverRow]);
      if (!groups.get(l.recv.id).meters.includes(n)) groups.get(l.recv.id).meters.push(n);
    }
    const items = [...groups.values()].map(g => {
      const ms = g.meters.length > 3 ? g.meters.slice(0, 3).join(', ') + ` и ещё ${g.meters.length - 3}` : g.meters.join(', ');
      return `<button class="link" data-go="${esc(g.recv.id)}"><div><div class="name" style="font-size:14px">${esc(g.recv.name)}</div><div class="meta">Договор ${esc(g.recv.contract || '—')}, ЭО ${esc(g.recv.id)}<br>ПУ № ${esc(ms)}</div></div>${ICON.right}</button>`;
    }).concat(orphans.map(l => `<div class="orphan">ПУ № ${esc(X.meterOf(M.rows[l.giverRow]) || '—')}: транзитоприёмник не найден в этой базе</div>`));
    const LIM = 5;
    h += `<div class="warn recv"><div class="wt">${ICON.warn}Есть транзитоприёмники: ${e.recvCount}</div>
      <div id="recvList">${items.slice(0, LIM).join('')}</div>
      ${items.length > LIM ? `<button class="linkbtn" id="recvAll">Показать все (${items.length})</button>` : ''}</div>`;
    transitBlocks._items = items;
  }
  for (const g of e.giverList) {
    const via = e.givers.filter(l => l.giver === g).map(l => X.meterOf(M.rows[l.recvRow]));
    h += `<div class="warn giver"><div class="wt">${ICON.warn}Транзитодатель</div>
      <button class="link" data-go="${esc(g.id)}"><div><div class="name" style="font-size:14px">${esc(g.name)}</div><div class="meta">Договор ${esc(g.contract || '—')}, ЭО ${esc(g.id)}<br>через ПУ № ${esc([...new Set(via)].join(', '))}</div></div>${ICON.right}</button></div>`;
  }
  return h;
}

function renderMeters(sel, e, list, limit, emptyText) {
  const box = $(sel);
  if (!list.length) { box.innerHTML = `<div class="nopu">${esc(emptyText || 'Приборов учёта нет')}</div>`; return; }
  const { rows, header } = M;
  const cols = header.map((h, i) => i).filter(i => sectionOf(i) === 'meter');
  const rank = i => { const h = X.hn[i]; const k = METER_FIRST.findIndex(re => re.test(h)); return k < 0 ? 99 : k; };
  cols.sort((a, b) => rank(a) - rank(b) || a - b);
  const skipCols = new Set([M.f.meter]);
  const cards = list.slice(0, limit).map(ri => {
    const r = rows[ri];
    const num = X.meterOf(r), role = X.roleOf(r);
    const fs = [];
    for (const i of cols) {
      if (skipCols.has(i)) continue;
      const v = r[i] || '';
      if (!v) continue;
      if (HIDE_ZERO.test(X.hn[i]) && /^0([.,]0+)?$/.test(v)) continue;
      if (/тип счетчика/.test(X.hn[i])) continue;
      const wide = v.length > 22 || /адрес|примечание|информация|наименование|причина|структура/.test(X.hn[i]);
      fs.push(field(labelOf(header[i]), v, wide));
    }
    // У транзитного ПУ — к какому транзитоприёмнику он относится. У транзитоприёмника пометки нет:
    // ссылка на транзитодателя уже стоит в голубом блоке вверху карточки.
    let note = '';
    if (role === 'T') {
      const ls_ = e.receivers.filter(l => l.giverRow === ri);
      note = ls_.map(l => l.recv
        ? `<div class="note">Транзитоприёмник: <button data-go="${esc(l.recv.id)}">${esc(l.recv.name)}, ЭО ${esc(l.recv.id)}</button></div>`
        : '<div class="note">Транзитоприёмник не найден в этой базе</div>').join('');
    }
    const title = num ? '№ ' + num : (r[M.f.meter] || 'Без прибора учёта');
    return `<div class="pucard"><div class="r1"><span class="pu-title" data-copy="${esc(num)}">${esc(title)}</span>${num ? roleBadge(role) : ''}</div>
      ${note}<div class="kv grid2">${fs.join('')}</div></div>`;
  }).join('');
  const left = list.length - limit;
  box.innerHTML = cards + (left > 0 ? `<div style="padding:0 14px 12px"><button class="more" style="margin-top:0">Показать все приборы (${list.length})</button></div>` : '');
  if (left > 0) box.querySelector('.more').onclick = () => renderMeters(sel, e, list, list.length, emptyText);
  bindGo(box); bindCopy(box);
}

function bindGo(root) {
  root.querySelectorAll('[data-go]:not([data-gb])').forEach(b => {
    b.dataset.gb = 1;
    b.onclick = () => go('#/eo/' + encodeURIComponent(b.dataset.go));
  });
}

function bindCard() {
  const v = $('#view');
  bindGo(v); bindCopy(v);
  const all = $('#recvAll');
  if (all) all.onclick = () => { $('#recvList').innerHTML = transitBlocks._items.join(''); all.remove(); bindGo($('#recvList')); };
}

// Долгое нажатие на значение — копирование.
function bindCopy(root) {
  root.querySelectorAll('[data-copy]:not([data-cb])').forEach(el => {
    el.dataset.cb = 1;
    let t = null, sx = 0, sy = 0;
    const cancel = () => { clearTimeout(t); t = null; };
    el.addEventListener('pointerdown', ev => {
      sx = ev.clientX; sy = ev.clientY;
      t = setTimeout(() => { t = null; copyText(el.dataset.copy, el); }, 550);
    });
    el.addEventListener('pointermove', ev => { if (t && (Math.abs(ev.clientX - sx) > 8 || Math.abs(ev.clientY - sy) > 8)) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', ev => ev.preventDefault());
  });
}

async function copyText(text, el) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (navigator.vibrate) navigator.vibrate(30);
  el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 700);
  toast('Скопировано: ' + (text.length > 40 ? text.slice(0, 40) + '…' : text));
}

// ---------- экран «База» ----------
function renderData() {
  const hasDb = !!M;
  if (hasDb) {
    setBar(`<button class="ib" id="back" aria-label="Назад">${ICON.back}</button><div class="t">База данных</div>`);
    $('#back').onclick = () => (history.length > 1 ? history.back() : go('#/'));
  } else setBar('<div class="t">Мобильный ЕБЦ</div>');
  const m = hasDb ? M.meta : null;
  const yd = CFG.yandexFolderUrl;
  $('#view').innerHTML = `
    ${hasDb ? `<div class="card"><h2>Загруженная база</h2>
      <div class="stat"><span>Файл</span><b>${esc(m.fileName)}</b></div>
      ${m.period ? `<div class="stat"><span>Период</span><b>${esc(fmtPeriod(m.period))}</b></div>` : ''}
      <div class="stat"><span>Загружена</span><b>${esc(fmtDate(m.loadedAt))}</b></div>
      <div class="stat"><span>Энергообъектов</span><b>${fmtN(m.eo)}</b></div>
      <div class="stat"><span>Строк</span><b>${fmtN(m.rows)}</b></div>
      <div class="stat"><span>Транзитных связей</span><b>${fmtN(X.links)}</b></div>
      ${X.hasCoordCols ? `<div class="stat"><span>ЭО на карте</span><b>${fmtN(X.withCoords)}</b></div>` : '<div class="stat"><span>ЭО на карте</span><b>нет координат<small>загрузите архив из геокодера</small></b></div>'}
      <div class="stat"><span>Подстанций</span><b>${SUBS ? fmtN(SUBS.items.length) + `<small>ПЦ ${fmtN(SUBS.counts.pc)} · сети ${fmtN(SUBS.counts.net)} · частных ${fmtN(SUBS.counts.priv)}</small>` : 'нет'}</b></div></div>`
      : `<div class="hello">Данные<br>не загружены</div>
      <div class="card"><h2>Как загрузить</h2><ol class="steps">
        <li>Нажмите «Скачать с Яндекс Диска» и скачайте архив с базой.</li>
        <li>Вернитесь сюда и нажмите «Загрузить файл».</li>
        <li>Выберите скачанный архив и введите пароль.</li></ol>
        <p style="margin-top:8px">Файл обрабатывается только на этом устройстве и никуда не отправляется.</p></div>`}
    <div class="card">
      <h2>${hasDb ? 'Обновить базу' : 'Загрузка'}</h2>
      <button class="btn primary" id="yd"${yd ? '' : ' disabled'}>${ICON.down}Скачать с Яндекс Диска</button>
      ${yd ? '' : '<p style="margin-top:6px;font-size:13px">Ссылка на папку ещё не указана в файле config.js.</p>'}
      <button class="btn secondary" id="pick">${ICON.file}Загрузить файл (.zip или .csv)</button>
      <div id="prog"></div>
    </div>
    ${hasDb ? fixesCardHtml() : ''}
    ${ls.get('pw', null) ? `<div class="card"><div class="stat"><span>Пароль от архива сохранён на этом устройстве</span></div><button class="btn danger" id="forget">Забыть пароль</button></div>` : ''}
    ${hasDb ? '<button class="btn danger" id="wipe">Удалить базу с устройства</button>' : ''}
    <button class="btn secondary" id="upd">Обновить приложение</button>
    <p style="text-align:center;color:var(--muted);font-size:12px;margin-top:12px">Версия приложения ${VERSION}</p>`;
  if (yd) $('#yd').onclick = () => window.open(yd, '_blank', 'noopener');
  $('#pick').onclick = () => $('#file').click();
  $('#upd').onclick = updateApp;
  if ($('#fxSend')) $('#fxSend').onclick = sendFixes;
  if ($('#fxName')) $('#fxName').onclick = async () => { const n = await askName(true); if (n) renderData(); };
  document.querySelectorAll('#fxList [data-go]').forEach(b => b.onclick = () => go('#/eo/' + encodeURIComponent(b.dataset.go)));
  if ($('#forget')) $('#forget').onclick = () => { ls.del('pw'); toast('Пароль удалён с устройства'); renderData(); };
  if ($('#wipe')) $('#wipe').onclick = async () => {
    if (!confirm('Удалить базу с этого устройства? Её можно будет загрузить заново.')) return;
    await idb.del('db'); await idb.del('subs'); M = null; X = null; SUBS = null; ls.del('recent'); toast('База удалена'); go('#/data'); renderData();
  };
}

function setProgress(pct, stage) {
  const p = $('#prog'); if (!p) return;
  p.innerHTML = `<div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><p>${esc(stage)}… ${pct}%</p></div>`;
}
function showError(msg) { const p = $('#prog'); if (p) p.innerHTML = `<div class="err">${esc(msg)}</div>`; else toast(msg, 4000); }

function askPassword(errText) {
  return new Promise(resolve => {
    const md = $('#modal');
    md.innerHTML = `<form class="sheet" id="pwf">
      <h2>Пароль от архива</h2>
      <p>${errText ? `<span style="color:var(--red)">${esc(errText)}</span>` : 'Архив защищён паролем. Он нужен, чтобы открыть базу на этом устройстве.'}</p>
      <input type="password" id="pw" autocomplete="current-password" placeholder="Пароль" required>
      <label class="check"><input type="checkbox" id="rem"> Запомнить на этом устройстве</label>
      <div class="row2"><button type="button" class="btn danger" id="pwc">Отмена</button><button class="btn primary">Открыть</button></div>
    </form>`;
    md.hidden = false;
    setTimeout(() => $('#pw').focus(), 50);
    const done = v => { md.hidden = true; md.innerHTML = ''; resolve(v); };
    $('#pwc').onclick = () => done(null);
    $('#pwf').onsubmit = ev => { ev.preventDefault(); done({ password: $('#pw').value, remember: $('#rem').checked }); };
  });
}

function loadFile(file) {
  let saved = ls.get('pw', null);
  let usedSaved = !!saved, typed = null;
  const w = new Worker('worker.js');
  const run = password => w.postMessage({ file, password });
  setProgress(1, 'Начинаю');
  w.onmessage = async ({ data }) => {
    if (data.type === 'progress') return setProgress(data.pct, data.stage);
    if (data.type === 'need-password' || data.type === 'bad-password') {
      if (data.type === 'bad-password' && usedSaved) { ls.del('pw'); usedSaved = false; }
      const r = await askPassword(data.type === 'bad-password' ? 'Пароль не подошёл. Попробуйте ещё раз.' : '');
      if (!r) { w.terminate(); const p = $('#prog'); if (p) p.innerHTML = ''; return; }
      typed = r; run(r.password); return;
    }
    if (data.type === 'error') { w.terminate(); showError(data.message); return; }
    if (data.type === 'done') {
      w.terminate();
      setProgress(96, 'Сохраняю на телефоне');
      try {
        await idb.set('db', data.json);
      } catch (err) {
        showError('Не хватило места на устройстве, чтобы сохранить базу. Освободите память и попробуйте снова.');
        return;
      }
      if (data.subs) {           // в архиве были подстанции — заменяем; не было — оставляем прошлые
        try { await idb.set('subs', data.subs); SUBS = JSON.parse(data.subs); } catch (err) { console.error(err); }
      }
      if (typed) { if (typed.remember) ls.set('pw', typed.password); else ls.del('pw'); }
      M = JSON.parse(data.json); X = makeIndex(M);
      const acceptedFixes = await pruneAcceptedFixes();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast(`База загружена: ${fmtN(M.meta.eo)} ЭО` + (data.subs ? `, подстанций ${fmtN(SUBS.items.length)}` : SUBS ? ' (подстанции — из прошлой загрузки)' : '')
        + (acceptedFixes ? `. Ваших уточнений принято: ${acceptedFixes}` : ''), 4000);
      go('#/');
    }
  };
  run(saved);
}

$('#file').addEventListener('change', ev => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (f) { if (!location.hash.startsWith('#/data')) go('#/data'); setTimeout(() => loadFile(f), 0); }
});

// Проверить новую версию на сайте и перезапустить приложение.
async function updateApp() {
  if (!navigator.onLine) { toast('Нет интернета — обновить приложение сейчас нельзя'); return; }
  toast('Проверяю обновление…', 4000);
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch {}
  setTimeout(() => location.reload(), 1200);
}

// ---------- навигация и запуск ----------
function makeIndex(m) {
  const x = buildIndex(m);
  x.hn = m.header.map(normH);
  X = x;
  applyFixes();
  return x;
}

// ---------- уточнение координат инспектором ----------
function applyFixes() {
  if (!X) return;
  for (const e of X.eos) e.fix = FIXES[e.id] || null;
}
async function saveFixes() {
  await idb.set('fixes', JSON.stringify(FIXES));
  FIX_VER++;
  applyFixes();
}

// После загрузки новой базы: если там уже стоит ручная точка (вы её приняли) рядом с уточнением — уточнение снимаем.
async function pruneAcceptedFixes() {
  let n = 0;
  for (const id of Object.keys(FIXES)) {
    const e = X.byId.get(id), f = FIXES[id];
    if (e && e.manual && e.lat != null && distM([e.lat, e.lon], [f.lat, f.lon]) < 15) { delete FIXES[id]; n++; }
  }
  await saveFixes();
  return n;
}

function askName(change) {
  return new Promise(resolve => {
    const md = $('#modal');
    md.innerHTML = `<form class="sheet" id="nmf">
      <h2>Ваше имя</h2>
      <p>Оно попадёт в файл уточнений, чтобы было видно, кто уточнил точку. Спрашиваем один раз.</p>
      <input type="text" id="nm" placeholder="Фамилия И. О." value="${esc(ls.get('inspector', '') || '')}" required>
      <div class="row2"><button type="button" class="btn danger" id="nmc">Отмена</button><button class="btn primary">${change ? 'Сохранить' : 'Продолжить'}</button></div>
    </form>`;
    md.hidden = false;
    setTimeout(() => $('#nm').focus(), 50);
    const done = v => { md.hidden = true; md.innerHTML = ''; resolve(v); };
    $('#nmc').onclick = () => done(null);
    $('#nmf').onsubmit = ev => { ev.preventDefault(); const v = $('#nm').value.trim(); if (!v) return; ls.set('inspector', v); done(v); };
  });
}

async function saveFix(e, lat, lon, how, acc) {
  if (!ls.get('inspector', '') && !(await askName())) return false;
  FIXES[e.id] = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), ts: Date.now(), how, acc: acc == null ? null : Math.round(acc), sent: false };
  await saveFixes();
  toast('Точка сохранена — на проверке. Отправьте уточнения с экрана «База данных»', 4000);
  return true;
}

function openFixChooser(e) {
  const md = $('#modal');
  md.innerHTML = `<div class="sheet">
    <h2>Уточнить местоположение</h2>
    <p>${esc(e.name)}<br>ЭО ${esc(e.id)}</p>
    <button class="btn primary" id="fxGps">${ICON.target}Я на объекте — взять моё местоположение</button>
    <button class="btn secondary" id="fxMap">${ICON.map}Указать на карте</button>
    <button class="btn danger" id="fxNo">Отмена</button></div>`;
  md.hidden = false;
  const close = () => { md.hidden = true; md.innerHTML = ''; };
  $('#fxNo').onclick = close;
  $('#fxMap').onclick = () => { close(); go('#/map/fix/' + encodeURIComponent(e.id)); };
  $('#fxGps').onclick = () => {
    if (!navigator.geolocation) { toast('Телефон не поддерживает определение местоположения'); return; }
    const b = $('#fxGps'); b.disabled = true; b.lastChild.textContent = 'Определяю местоположение…';
    navigator.geolocation.getCurrentPosition(async pos => {
      close();
      const acc = pos.coords.accuracy;
      const warn = acc > 50 ? `\n\nТочность низкая (±${Math.round(acc)} м). Лучше выйти на улицу или указать точку на карте.` : '';
      if (!confirm(`Сохранить ваше местоположение как точку ЭО?\nТочность ±${Math.round(acc)} м.${warn}`)) return;
      if (await saveFix(e, pos.coords.latitude, pos.coords.longitude, 'gps', acc)) renderCard(e.id);
    }, err => {
      close();
      toast(err && err.code === 1 ? 'Нет разрешения на местоположение — разрешите его для сайта в настройках браузера'
        : 'Не удалось определить местоположение — проверьте, включена ли геолокация', 4000);
    }, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
  };
}

function fixesCardHtml() {
  const ids = Object.keys(FIXES);
  const unsent = ids.filter(id => !FIXES[id].sent).length;
  const name = ls.get('inspector', '');
  const list = ids.slice(0, 20).map(id => {
    const e = X.byId.get(id), f = FIXES[id];
    return `<button class="link" data-go="${esc(id)}"><div><div class="name" style="font-size:14px">${esc(e ? e.name : 'ЭО ' + id)}</div>
      <div class="meta">ЭО ${esc(id)} · ${esc(fmtDay(f.ts))} · ${f.how === 'gps' ? 'GPS' : 'на карте'}${f.sent ? ' · отправлено' : ''}</div></div>${ICON.right}</button>`;
  }).join('');
  return `<div class="card"><h2>Уточнения координат</h2>
    <div class="stat"><span>На проверке</span><b>${fmtN(ids.length)}${ids.length ? `<small>не отправлено: ${fmtN(unsent)}</small>` : ''}</b></div>
    <div class="stat"><span>Ваше имя</span><b>${name ? esc(name) : 'не указано'} <button class="linkbtn" id="fxName">изменить</button></b></div>
    ${ids.length ? `<div id="fxList">${list}${ids.length > 20 ? `<p class="meta">и ещё ${ids.length - 20}</p>` : ''}</div>` : '<p class="meta">Уточнить точку можно в карточке ЭО: «Уточнить местоположение».</p>'}
    <button class="btn primary" id="fxSend"${ids.length ? '' : ' disabled'}>${ICON.share}Отправить уточнения</button>
    <p class="meta" style="margin-top:6px">Откроется «Поделиться» — выберите MAX и получателя. Точки появятся у всех после проверки, со следующей базой.</p></div>`;
}

// Файл уточнений — CSV (Chrome разрешает отправлять через «Поделиться» только некоторые типы файлов, .json среди них нет).
async function sendFixes() {
  const ids = Object.keys(FIXES);
  if (!ids.length) return;
  let who = ls.get('inspector', '');
  if (!who) { who = await askName(); if (!who) return; }
  const q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = ['eo;lat;lon;ts;how;acc;inspector;name;contract'];
  for (const id of ids) {
    const f = FIXES[id], e = X.byId.get(id);
    lines.push([id, f.lat, f.lon, f.ts, f.how, f.acc ?? '', who, e ? e.name : '', e ? e.contract : ''].map(q).join(';'));
  }
  // имя файла латиницей: браузеры и мессенджеры иногда теряют русские имена файлов
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const lat = w => w.split('').map(c => { const l = c.toLowerCase(), t = TR[l]; return t === undefined ? c : (c !== l ? t.charAt(0).toUpperCase() + t.slice(1) : t); }).join('').replace(/[^A-Za-z0-9-]/g, '');
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const fname = `utochneniya_${lat(who.split(/\s+/)[0]) || 'inspector'}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
  const file = new File(['\ufeff' + lines.join('\r\n') + '\r\n'], fname, { type: 'text/csv' });
  const markSent = async () => { for (const id of ids) FIXES[id].sent = true; await saveFixes(); renderData(); };
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Уточнения координат', text: `Уточнения координат ЭО: ${ids.length} — ${who}` });
      await markSent();
      toast('Уточнения отправлены');
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('Не удалось открыть «Поделиться»: ' + err.message, 4000);
    }
    return;
  }
  // ПК или браузер без «Поделиться» — сохраняем файл
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = fname; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  await markSent();
  toast('Файл сохранён в «Загрузки» — отправьте его через MAX', 4500);
}

function route() {
  document.body.classList.remove('home-idle');   // вернётся, если это главная без запроса
  const h = location.hash || '#/';
  $('#modal').hidden = true;
  const isMap = h.startsWith('#/map') || h.startsWith('#/subs');
  if (!isMap) leaveMaps();
  if (!M || h.startsWith('#/data')) { leaveMaps(); return renderData(); }
  if (h.startsWith('#/map/eo/')) return enterContractsMap(decodeURIComponent(h.slice(9)));
  if (h.startsWith('#/map/fix/')) return enterContractsMap(decodeURIComponent(h.slice(10)), 'fix');
  if (h === '#/map') return enterContractsMap(null);
  if (h.startsWith('#/subs')) return enterSubsMap();
  if (h.startsWith('#/nocoords')) return renderNoCoords();
  if (h.startsWith('#/eo/')) return renderCard(decodeURIComponent(h.slice(5)));
  renderHome();
}
window.addEventListener('hashchange', route);

(async () => {
  try {
    const json = await idb.get('db');
    if (json) { M = JSON.parse(json); X = makeIndex(M); }
    const sj = await idb.get('subs');
    if (sj) SUBS = JSON.parse(sj);
    const fj = await idb.get('fixes');
    if (fj) { FIXES = JSON.parse(fj) || {}; if (X) applyFixes(); }
  } catch (err) { console.error(err); }
  route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // Когда новая версия приложения вступила в силу — один раз перезагружаем страницу.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  }
})();
