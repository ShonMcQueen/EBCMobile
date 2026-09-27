'use strict';
// Мобильный ЕБЦ — карты (этап 3): «Карта договоров», карта из карточки ЭО, «Карта подстанций».
// Подложка — OpenStreetMap через Leaflet. Файлы Leaflet лежат рядом, из интернета грузятся только картинки карты.
// Этот файл только объявляет функции; вызывает их app.js (маршруты #/map, #/map/eo/…, #/subs, #/nocoords).

const SUB_MIN_ZOOM = 14;   // с этого масштаба (≈ 2–3 км на экран) подстанции видны на карте договоров
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

const MICON = {
  bolt: '<svg viewBox="-5 -5 10 10" class="bolt"><path d="M1.2-4.2 -2.4 0.6H0L-1.2 4.2 2.4-0.6H0z"/></svg>',
  boltBig: '<svg class="i" viewBox="0 0 24 24" style="stroke:none;fill:currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  target: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>'
};

let MC = null;          // карта договоров (один экземпляр, живёт между заходами)
let MS = null;          // карта подстанций
let geoWatch = null;    // слежение за местоположением, пока открыта карта

// ---------------------------------------------------------------- значки
const _icons = {};
function eoIcon(apx) {
  const k = apx ? 'eoA' : 'eo';
  return _icons[k] || (_icons[k] = L.divIcon({ className: 'mk-eo' + (apx ? ' apx' : ''), iconSize: [14, 14] }));
}
function subIcon(type, sel) {
  const k = 'sub' + type + (sel ? 's' : '');
  if (_icons[k]) return _icons[k];
  const pc = type === 'pc';
  return (_icons[k] = L.divIcon({
    className: 'mk-sub ' + type + (sel ? ' sel' : ''),
    html: pc ? '<b>ПЦ</b>' : MICON.bolt,
    iconSize: pc ? [26, 26] : [16, 16]
  }));
}
function pinIcon() {
  return _icons.pin || (_icons.pin = L.divIcon({
    className: 'mk-pin',
    html: '<svg viewBox="0 0 30 40"><path d="M15 39C15 39 28 24 28 14A13 13 0 0 0 2 14C2 24 15 39 15 39z" fill="#FF6408" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg>',
    iconSize: [30, 40], iconAnchor: [15, 39]
  }));
}
function meIcon() {
  return _icons.me || (_icons.me = L.divIcon({ className: 'mk-me', iconSize: [18, 18] }));
}
function clusterIcon(n, kind) {
  const d = n < 100 ? 34 : n < 1000 ? 40 : n < 10000 ? 46 : 52;
  return L.divIcon({ html: `<div><span>${fmtN(n)}</span></div>`, className: 'mk-cl ' + kind, iconSize: [d, d] });
}

// ---------------------------------------------------------------- общая оболочка экрана карты
function makeBase(el) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, maxZoom: 19, minZoom: 6, center: [55.58, 38.2], zoom: 10 });
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map);
  map.attributionControl.setPrefix(false);
  return map;
}

function mapShell(root) {
  root.innerHTML = `<div class="lmap"></div>
    <div class="mtop"></div>
    <div class="mctl">
      <button class="mb" data-z="1" aria-label="Приблизить">+</button>
      <button class="mb" data-z="-1" aria-label="Отдалить">−</button>
      <button class="mb loc" aria-label="Моё местоположение">${MICON.target}</button>
    </div>
    <div class="mlegend" hidden></div>
    <div class="mbottom"></div>
    <div class="msheet" hidden></div>`;
}

function bindCtl(st) {
  const r = st.root;
  r.querySelectorAll('[data-z]').forEach(b => b.onclick = () => st.map.setZoom(st.map.getZoom() + (+b.dataset.z)));
  r.querySelector('.loc').onclick = () => locate(st);
}

function showMapRoot(root) {
  document.body.classList.add('mapmode');
  ['#mapC', '#mapS'].forEach(s => { const el = $(s); if (el) el.hidden = el !== root; });
}

function leaveMaps() {
  if (!document.body.classList.contains('mapmode')) return;
  document.body.classList.remove('mapmode');
  ['#mapC', '#mapS'].forEach(s => { const el = $(s); if (el) el.hidden = true; });
  stopLocate();
}

function showSheet(st, html, cls) {
  const sh = st.root.querySelector('.msheet');
  sh.className = 'msheet' + (cls ? ' ' + cls : '');
  sh.innerHTML = '<button class="grab" aria-label="Закрыть"></button>' + html;
  sh.hidden = false;
  sh.scrollTop = 0;
  st.root.querySelector('.mbottom').hidden = true;
  sh.querySelector('.grab').onclick = () => hideSheet(st);
  bindCopy(sh);
  return sh;
}
function hideSheet(st) {
  const sh = st.root.querySelector('.msheet');
  if (!sh.hidden) { sh.hidden = true; sh.innerHTML = ''; }
  st.root.querySelector('.mbottom').hidden = false;
  if (st.selLayer) st.selLayer.clearLayers();
  st.sel = null;
}

// ---------------------------------------------------------------- подстанции: общие части
function poOf(it) { return it[3].map(i => SUBS.po[i]).join(' / '); }
const SUB_TAG = { net: '<span class="tag net">ТП электросети</span>', priv: '<span class="tag priv">частная</span>', pc: '<span class="tag pc">питающий центр</span>' };

// Описание из Конструктора: переносы по пунктам «1.», «2.»…, полные телефоны — ссылки для звонка.
function fmtDesc(t) {
  if (!t) return '<p class="muted">Описания нет</p>';
  let s = String(t).replace(/\r/g, '').replace(/\t+/g, '\n').replace(/ {2,}/g, ' ');
  // пункты «1.», «2.», «3.»… идут по порядку — переносим строку перед каждым следующим номером
  let pos = 0;
  for (let k = 1; k <= 99; k++) {
    const re = new RegExp('(^|[^\\d\\-/.,])(' + k + ')\\.(?!\\d)', 'g');
    re.lastIndex = pos;
    let m, at = -1;
    while ((m = re.exec(s))) {
      const a = m.index + m[1].length;
      // «д. 7.», «стр. 2.» — это номер дома, а не пункт
      if (/(?:^|[\s,.])(д|дом|стр|корп|к|кв|уч|вл|оф|пом|яч)\.?\s*$/i.test(s.slice(Math.max(0, a - 8), a))) continue;
      at = a; break;
    }
    if (at < 0) break;
    if (at > 0 && s[at - 1] !== '\n') { s = s.slice(0, at).replace(/\s+$/, '') + '\n' + s.slice(at); pos = s.indexOf('\n', at - 1) + 1 + String(k).length; }
    else pos = at + String(k).length;
  }
  return s.split('\n').map(x => x.trim()).filter(Boolean).map(line => {
    const h = esc(line).replace(/(?<![\d-])(?:\+7|8)[\s()-]*\d(?:[\s()-]*\d){9}(?![\d])/g, m => {
      const d = m.replace(/\D/g, '').replace(/^8/, '7');
      return d.length === 11 ? `<a href="tel:+${d}">${m}</a>` : m;
    });
    return `<p data-copy="${esc(line)}">${h}</p>`;
  }).join('');
}

function openSubSheet(st, i) {
  const it = SUBS.items[i];
  st.sel = { sub: i };
  markSelected(st, [it[0], it[1]], it[4], it[2]);
  const col = { net: 'net', priv: 'priv', pc: 'pc' }[it[4]];
  showSheet(st, `<div class="subh"><span class="mk-sub big ${col}">${it[4] === 'pc' ? '<b>ПЦ</b>' : MICON.bolt}</span>
      <div><div class="st" data-copy="${esc(it[2])}">${esc(it[2])} · ${esc(poOf(it))}</div>${SUB_TAG[it[4]]}</div></div>
    <div class="desc">${fmtDesc(it[5])}</div>`, 'tall');
}

function markSelected(st, ll, type, label) {
  if (!st.selLayer) st.selLayer = L.layerGroup().addTo(st.map);
  st.selLayer.clearLayers();
  const m = L.marker(ll, { icon: subIcon(type, true), zIndexOffset: 2000, interactive: false }).addTo(st.selLayer);
  if (label) m.bindTooltip(esc(label), { permanent: true, direction: 'top', offset: [0, type === 'pc' ? -14 : -9], className: 'sublabel' });
}

function subMarker(st, i) {
  const it = SUBS.items[i];
  const m = L.marker([it[0], it[1]], { icon: subIcon(it[4]), zIndexOffset: it[4] === 'pc' ? 600 : 300, keyboard: false });
  m._sub = i;
  m.on('click', () => openSubSheet(st, i));
  return m;
}

function legendHtml() {
  return `<div class="lg"><span class="mk-eo"></span>ЭО</div>
    <div class="lg"><span class="mk-eo apx"></span>ЭО, точка примерная</div>
    <div class="lg"><span class="mk-sub pc"><b>ПЦ</b></span>ПЦ (питающий центр)</div>
    <div class="lg"><span class="mk-sub net">${MICON.bolt}</span>ТП электросети</div>
    <div class="lg"><span class="mk-sub priv">${MICON.bolt}</span>ТП частная</div>
    <div class="lg"><span class="mk-me"></span>Вы здесь</div>`;
}

// ---------------------------------------------------------------- моё местоположение
function locate(st) {
  if (!navigator.geolocation) { toast('Телефон не поддерживает определение местоположения'); return; }
  const btn = st.root.querySelector('.loc');
  if (st.meLL) { st.map.setView(st.meLL, Math.max(st.map.getZoom(), 16)); return; }
  btn.classList.add('wait');
  let first = true;
  stopLocate();
  geoWatch = navigator.geolocation.watchPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude], acc = pos.coords.accuracy || 50;
    btn.classList.remove('wait'); btn.classList.add('on');
    st.meLL = ll;
    if (!st.me) {
      st.meAcc = L.circle(ll, { radius: acc, color: '#1F5FAF', weight: 1, fillColor: '#1F5FAF', fillOpacity: 0.12, interactive: false }).addTo(st.map);
      st.me = L.marker(ll, { icon: meIcon(), interactive: false, zIndexOffset: 3000 }).addTo(st.map);
    } else { st.me.setLatLng(ll); st.meAcc.setLatLng(ll).setRadius(acc); }
    if (first) { first = false; st.map.setView(ll, Math.max(st.map.getZoom(), 16)); }
  }, err => {
    btn.classList.remove('wait', 'on');
    stopLocate();
    toast(err && err.code === 1
      ? 'Нет разрешения на местоположение — разрешите его для сайта в настройках браузера'
      : 'Не удалось определить местоположение — проверьте, включена ли геолокация', 4000);
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  st.geo = true;
}

function stopLocate() {
  if (geoWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null;
  for (const st of [MC, MS]) {
    if (!st) continue;
    if (st.me) { st.map.removeLayer(st.me); st.map.removeLayer(st.meAcc); }
    st.me = st.meAcc = st.meLL = null;
    const b = st.root.querySelector('.loc'); if (b) b.classList.remove('on', 'wait');
  }
}

// ---------------------------------------------------------------- карта договоров
function buildContractsMap() {
  const root = $('#mapC');
  mapShell(root);
  const map = makeBase(root.querySelector('.lmap'));
  const st = { root, map, x: X, subs: SUBS };
  const cl = L.markerClusterGroup({
    chunkedLoading: true, showCoverageOnHover: false, spiderfyOnMaxZoom: false, zoomToBoundsOnClick: false,
    maxClusterRadius: 60, iconCreateFunction: c => clusterIcon(c.getChildCount(), 'eo')
  });
  const markers = [];
  for (const e of X.eos) {
    if (e.lat == null) continue;
    const m = L.marker([e.lat, e.lon], { icon: eoIcon(e.approx), keyboard: false });
    m._eo = e;
    markers.push(m);
  }
  cl.addLayers(markers);
  map.addLayer(cl);
  cl.on('click', ev => openEoSheet(st, ev.layer._eo));
  cl.on('clusterclick', ev => {
    const c = ev.layer, b = c.getBounds();
    // все ЭО в одной точке (один дом) — кружок не распадётся, показываем список
    if (b.getNorthEast().distanceTo(b.getSouthWest()) < 25 || map.getZoom() >= 18) openEoListSheet(st, c.getAllChildMarkers().map(m => m._eo));
    else c.zoomToBounds({ padding: [50, 50] });
  });
  st.cl = cl;
  st.subsLayer = L.layerGroup().addTo(map);
  st.focusLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => updateSubsLayer(st));
  map.on('click', () => hideSheet(st));
  if (markers.length) map.fitBounds(L.latLngBounds(markers.map(m => m.getLatLng())), { padding: [30, 30] });
  bindCtl(st);
  st.root.querySelector('.mlegend').innerHTML = legendHtml();
  return st;
}

function enterContractsMap(focusId) {
  const root = $('#mapC');
  showMapRoot(root);
  if (!MC || MC.x !== X || MC.subs !== SUBS) {
    if (MC) { stopLocate(); MC.map.remove(); }
    MC = buildContractsMap();
  }
  const st = MC;
  st.map.invalidateSize();
  hideSheet(st);
  st.focusLayer.clearLayers();
  const e = focusId ? X.byId.get(focusId) : null;
  const top = st.root.querySelector('.mtop');
  const onSubs = ls.get('subsOn', true);
  const title = e ? esc(e.name) : 'Карта договоров';
  const sub = e ? 'ЭО ' + esc(e.id) : `На карте ${fmtN(X.withCoords)} из ${fmtN(X.eos.length)} ЭО`;
  top.innerHTML = `<div class="rowf"><button class="ib" id="mBack" aria-label="Назад">${ICON.back}</button>
      <div class="pill"><b>${title}</b><span>${sub}</span></div>
      <button class="ib" id="mInfo" aria-label="Легенда">${MICON.info}</button></div>
    ${SUBS ? `<button class="tgl${onSubs ? ' on' : ''}" id="mTgl"><span class="tb">${MICON.boltBig}</span>Подстанции<span class="sw"><i></i></span></button>` : ''}
    <div class="hintchip" id="mHint" hidden>Подстанции появятся при приближении</div>`;
  $('#mBack').onclick = () => (history.length > 1 ? history.back() : go('#/'));
  $('#mInfo').onclick = () => { const lg = st.root.querySelector('.mlegend'); lg.hidden = !lg.hidden; };
  const tg = $('#mTgl');
  if (tg) tg.onclick = () => { const v = !ls.get('subsOn', true); ls.set('subsOn', v); tg.classList.toggle('on', v); updateSubsLayer(st); };
  const noC = X.eos.length - X.withCoords;
  st.root.querySelector('.mbottom').innerHTML = !e && noC > 0
    ? `<button class="nocoord" id="mNo">Без координат: ${fmtN(noC)} ЭО <b>Список ›</b></button>` : '';
  if ($('#mNo')) $('#mNo').onclick = () => go('#/nocoords');
  st.root.querySelector('.mlegend').hidden = true;

  if (e && e.lat != null) {
    L.marker([e.lat, e.lon], { icon: pinIcon(), zIndexOffset: 2500, interactive: false }).addTo(st.focusLayer);
    st.map.setView([e.lat, e.lon], 17, { animate: false });
    showSheet(st, `<div class="meta" style="margin:0">${esc(e.fact || e.tus[0] || '')}</div>`, 'slim');
  }
  updateSubsLayer(st);
}

function updateSubsLayer(st) {
  st.subsLayer.clearLayers();
  const on = ls.get('subsOn', true);
  const z = st.map.getZoom();
  const hint = $('#mHint');
  if (hint) hint.hidden = !(SUBS && on && z < SUB_MIN_ZOOM);
  if (!SUBS || !on || z < SUB_MIN_ZOOM) return;
  const b = st.map.getBounds().pad(0.25);
  for (let i = 0; i < SUBS.items.length; i++) {
    const it = SUBS.items[i];
    if (b.contains([it[0], it[1]])) st.subsLayer.addLayer(subMarker(st, i));
  }
}

function eoAddr(e) { return e.fact || e.tus[0] || ''; }

function openEoSheet(st, e) {
  const nm = e.meters.length;
  const badge = nm ? `<span class="badge b-pu">${nm} ПУ</span>` : '<span class="badge b-x">Нет ПУ</span>';
  const sh = showSheet(st, `<div class="r1"><div class="name">${esc(e.name)}</div>${badge}</div>
    <div class="meta">Договор ${esc(e.contract || '—')}, ЭО ${esc(e.id)}<br>${esc(eoAddr(e))}</div>
    ${transitChips(e)}
    <button class="btn primary" data-open="${esc(e.id)}">Открыть карточку</button>`);
  sh.querySelector('[data-open]').onclick = () => go('#/eo/' + encodeURIComponent(e.id));
}

function openEoListSheet(st, list) {
  list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const sh = showSheet(st, `<div class="st" style="font-size:16px">${esc(eoAddr(list[0]))}</div>
    <div class="meta" style="margin-bottom:6px">В этом месте ${fmtN(list.length)} ЭО</div>
    ${list.map(e => `<button class="srow" data-open="${esc(e.id)}"><div><div class="name" style="font-size:14px">${esc(e.name)}</div>
      <div class="meta">Договор ${esc(e.contract || '—')}, ЭО ${esc(e.id)}</div></div>${ICON.right}</button>`).join('')}`, 'tall');
  sh.querySelectorAll('[data-open]').forEach(b => b.onclick = () => go('#/eo/' + encodeURIComponent(b.dataset.open)));
}

// ---------------------------------------------------------------- карта подстанций
function buildSubsMap() {
  const root = $('#mapS');
  mapShell(root);
  const map = makeBase(root.querySelector('.lmap'));
  const st = { root, map, subs: SUBS };
  const cl = L.markerClusterGroup({
    chunkedLoading: true, showCoverageOnHover: false, spiderfyOnMaxZoom: true, maxClusterRadius: 50,
    iconCreateFunction: c => clusterIcon(c.getChildCount(), 'sub')
  });
  const pcLayer = L.layerGroup();
  const all = [];
  SUBS.items.forEach((it, i) => {
    all.push([it[0], it[1]]);
    if (it[4] === 'pc') pcLayer.addLayer(subMarker(st, i));      // ПЦ видны всегда, в кружки не собираются
    else cl.addLayer(subMarker(st, i));
  });
  pcLayer.addTo(map);
  cl.addTo(map);
  const far = () => root.classList.toggle('far', map.getZoom() <= 11);
  map.on('zoomend', far);
  map.on('click', () => { hideSheet(st); closeDrop(st); });
  map.fitBounds(L.latLngBounds(all), { padding: [20, 20] });
  far();
  st.cl = cl;
  bindCtl(st);
  return st;
}

function enterSubsMap() {
  const root = $('#mapS');
  showMapRoot(root);
  if (!SUBS) { leaveMaps(); go('#/'); toast('В загруженной базе нет подстанций'); return; }
  if (!MS || MS.subs !== SUBS) {
    if (MS) { stopLocate(); MS.map.remove(); }
    MS = buildSubsMap();
    const top = MS.root.querySelector('.mtop');
    top.innerHTML = `<div class="rowf"><button class="ib" id="sBack" aria-label="Назад">${ICON.back}</button>
        <label class="msearch" id="sBox">${ICON.search}<input id="sq" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Номер ТП, РП, ПЦ"><button class="x" id="sClr" aria-label="Очистить">${ICON.close}</button></label></div>
      <div class="sdrop" id="sDrop" hidden></div>`;
    MS.root.querySelector('.mbottom').innerHTML = `<div class="nocoord static">Подстанций: ${fmtN(SUBS.items.length)} · участков: ${SUBS.po.length}</div>`;
    const inp = $('#sq');
    let tmr;
    inp.oninput = () => { clearTimeout(tmr); tmr = setTimeout(() => showSubResults(MS, inp.value), 120); };
    inp.onfocus = () => { if (inp.value.trim()) showSubResults(MS, inp.value); };
    inp.onkeydown = ev => {
      if (ev.key === 'Enter') { const first = $('#sDrop [data-i]'); if (first) first.click(); else inp.blur(); }
    };
    $('#sClr').onclick = ev => { ev.preventDefault(); inp.value = ''; closeDrop(MS); hideSheet(MS); inp.focus(); };
  }
  $('#sBack').onclick = () => (history.length > 1 ? history.back() : go('#/'));
  MS.map.invalidateSize();
}

function closeDrop(st) { const d = st.root.querySelector('#sDrop'); if (d) { d.hidden = true; d.innerHTML = ''; } }

// Поиск подстанции: числа сравниваются целиком (87 ≠ 187), точные совпадения — сверху.
function searchSubs(q) {
  const toks = norm(q).split(' ').filter(Boolean);
  if (!toks.length) return [];
  const nums = toks.filter(t => /^\d+$/.test(t)), words = toks.filter(t => !/^\d+$/.test(t));
  const res = [];
  SUBS.items.forEach((it, i) => {
    const nn = ' ' + norm(it[2]) + ' ';
    const inName = nn.match(/\d+/g) || [];
    let score = 0, inDesc = false, ok = true;
    for (const n of nums) {
      if (inName.includes(n)) score += 100;
      else if (inName.some(x => x.startsWith(n))) score += 40;
      else if (inName.some(x => x.includes(n))) score += 15;
      else { ok = false; break; }
    }
    if (ok) for (const w of words) {
      if (nn.includes(' ' + w)) score += 20;
      else if (nn.includes(w)) score += 10;
      else { ok = false; break; }
    }
    if (!ok && !nums.length && words.every(w => w.length >= 3)) {       // слова ищем и в описании
      const d = norm(it[5]);
      if (words.every(w => d.includes(w))) { ok = true; inDesc = true; score = 1; }
    }
    if (ok) res.push({ i, score, inDesc });
  });
  res.sort((a, b) => b.score - a.score ||
    SUBS.items[a.i][2].localeCompare(SUBS.items[b.i][2], 'ru', { numeric: true }) ||
    poOf(SUBS.items[a.i]).localeCompare(poOf(SUBS.items[b.i]), 'ru'));
  return res;
}

function showSubResults(st, q) {
  const box = st.root.querySelector('#sDrop');
  if (!q.trim()) { closeDrop(st); return; }
  const res = searchSubs(q);
  const toks = norm(q).split(' ').filter(Boolean);
  const hl = s => {
    let h = esc(s);
    for (const t of toks) {
      const re = /^\d+$/.test(t) ? new RegExp('(?<![0-9])(' + t + ')', 'g') : new RegExp('(' + reEsc(t) + ')', 'gi');
      h = h.replace(re, '<mark>$1</mark>');
    }
    return h;
  };
  const LIM = 40;
  box.innerHTML = res.length
    ? `<div class="dh">Найдено ${fmtN(res.length)}${res.length > LIM ? ', показаны первые ' + LIM : ''}</div>` + res.slice(0, LIM).map(r => {
      const it = SUBS.items[r.i];
      const d = (it[5] || '').replace(/\s+/g, ' ');
      return `<button class="ri" data-i="${r.i}"><span class="mk-sub ${it[4]}">${it[4] === 'pc' ? '<b>ПЦ</b>' : MICON.bolt}</span>
        <span class="rt"><b>${hl(it[2])}</b> <span>· ${esc(poOf(it))}${it[4] === 'priv' ? ' · частная' : ''}</span>
        <small>${r.inDesc ? 'совпало в описании: ' : ''}${esc(d.slice(0, 80)) || '—'}</small></span>${ICON.right}</button>`;
    }).join('')
    : '<div class="dh">Ничего не нашлось. Попробуйте только номер, например «87».</div>';
  box.hidden = false;
  box.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, it = SUBS.items[i];
    closeDrop(st);
    const inp = $('#sq'); inp.value = it[2]; inp.blur();
    st.map.setView([it[0], it[1]], 17);
    openSubSheet(st, i);
  });
}

// ---------------------------------------------------------------- список ЭО без координат
function renderNoCoords() {
  leaveMaps();
  setBar(`<button class="ib" id="back" aria-label="Назад">${ICON.back}</button><div class="t">Без координат</div>`);
  $('#back').onclick = () => (history.length > 1 ? history.back() : go('#/'));
  const list = X.eos.filter(e => e.lat == null).map(e => ({ e, why: '' }));
  let shownN = 0;
  $('#view').innerHTML = `<div class="count">ЭО, для которых геокодер не нашёл адрес: ${fmtN(list.length)}</div><div class="list" id="ncList"></div><div id="ncMore"></div>`;
  const more = () => {
    const slice = list.slice(shownN, shownN + PAGE);
    $('#ncList').insertAdjacentHTML('beforeend', slice.map(r => rowHtml(r, [])).join(''));
    shownN += slice.length;
    const left = list.length - shownN;
    $('#ncMore').innerHTML = left > 0 ? `<button class="more">Показать ещё ${fmtN(Math.min(PAGE, left))} из ${fmtN(left)}</button>` : '';
    if (left > 0) $('#ncMore .more').onclick = more;
    $('#ncList').querySelectorAll('.row:not([data-bound])').forEach(el => {
      el.dataset.bound = 1;
      el.onclick = () => go('#/eo/' + encodeURIComponent(el.dataset.id));
    });
  };
  more();
}
