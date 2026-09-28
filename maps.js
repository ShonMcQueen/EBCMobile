'use strict';
// Мобильный ЕБЦ — карты (этап 3): «Карта договоров», карта из карточки ЭО, «Карта подстанций».
// Подложка — Яндекс Карты (Tiles API, нужен ключ в config.js) или OpenStreetMap; при сбое одной — переключаемся на другую. Файлы Leaflet лежат рядом, из интернета грузятся только картинки карты.
// Этот файл только объявляет функции; вызывает их app.js (маршруты #/map, #/map/eo/…, #/subs, #/nocoords).

const SUB_MIN_ZOOM = 14;   // с этого масштаба (≈ 2–3 км на экран) подстанции видны на карте договоров
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
// Яндекс: web_mercator — та же проекция, что у Leaflet; scale=2 — чёткие картинки на экранах телефонов
const Y_URL = 'https://tiles.api-maps.yandex.ru/v1/tiles/?apikey={key}&lang=ru_RU&x={x}&y={y}&z={z}&l=map&projection=web_mercator&scale={sc}';
const BASE_NAME = { yandex: 'Яндекс Карты', osm: 'OpenStreetMap' };
let baseSession = null;   // подложка, на которую переключились сами из-за сбоя (до перезапуска приложения)
let baseAutoDone = false; // автоматически переключаем не больше одного раза, чтобы не «прыгать» туда-обратно

const MICON = {
  bolt: '<svg viewBox="-5 -5 10 10" class="bolt"><path d="M1.2-4.2 -2.4 0.6H0L-1.2 4.2 2.4-0.6H0z"/></svg>',
  boltBig: '<svg class="i" viewBox="0 0 24 24" style="stroke:none;fill:currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  target: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  layers: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3 2 8.5 12 14l10-5.5z"/><path d="m2 13.5 10 5.5 10-5.5"/></svg>'
};

let MC = null;          // карта договоров (один экземпляр, живёт между заходами)
let MS = null;          // карта подстанций
let geoWatch = null;    // слежение за местоположением, пока открыта карта

// ---------------------------------------------------------------- значки
const _icons = {};
// kind: '' — обычная точка, 'apx' — примерная, 'fix' — уточнена вами (на проверке), 'man' — уточнена на месте (из базы)
function eoIcon(kind) {
  const k = 'eo' + (kind || '');
  return _icons[k] || (_icons[k] = L.divIcon({ className: 'mk-eo' + (kind ? ' ' + kind : ''), iconSize: [22, 22] }));
}
function eoKind(e) { return e.fix ? 'fix' : e.manual ? 'man' : e.approx ? 'apx' : ''; }
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
  const d = n < 10 ? 30 : n < 100 ? 34 : n < 1000 ? 40 : n < 10000 ? 46 : 52;
  return L.divIcon({ html: `<div><span>${fmtN(n)}</span></div>`, className: 'mk-cl ' + kind, iconSize: [d, d] });
}

// ---------------------------------------------------------------- общая оболочка экрана карты
function yKey() { return String((window.APP_CONFIG && APP_CONFIG.yandexTilesKey) || '').trim(); }
// какая подложка сейчас: выбор пользователя (кнопка «слои») → автопереключение при сбое → Яндекс, если есть ключ
function curBase() {
  if (!yKey()) return 'osm';
  return baseSession || (ls.get('base', 'yandex') === 'osm' ? 'osm' : 'yandex');
}

// Логотип Яндекса — обязательное условие: в углу карты, ссылкой на Яндекс Карты.
// Файл yandex-logo.png кладётся рядом с приложением; если его нет — показываем надпись.
const YLogo = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const a = L.DomUtil.create('a', 'ylogo');
    a.href = 'https://yandex.ru/maps'; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = '<img src="yandex-logo.png" alt="Яндекс Карты">';
    a.querySelector('img').onerror = () => { a.textContent = 'Яндекс Карты'; a.classList.add('txt'); };
    L.DomEvent.disableClickPropagation(a);
    return a;
  }
});

function makeBase(el) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, maxZoom: 19, minZoom: 6, center: [55.58, 38.2], zoom: 10 });
  map.attributionControl.setPrefix(false);
  setBase(map, curBase());
  return map;
}

function setBase(map, kind) {
  if (map._baseKind === kind) return;
  if (map._baseLayer) map.removeLayer(map._baseLayer);
  if (map._ylogo) { map.removeControl(map._ylogo); map._ylogo = null; }
  const layer = kind === 'yandex'
    ? L.tileLayer(Y_URL, { maxZoom: 19, key: encodeURIComponent(yKey()), sc: L.Browser.retina ? 2 : 1, attribution: '' })
    : L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR });
  // следим, грузятся ли картинки: если подряд одни ошибки — переключаемся на другую подложку
  let ok = 0, bad = 0;
  layer.on('tileload', () => { ok++; });
  layer.on('tileerror', () => {
    bad++;
    if (bad >= 4 && ok === 0 && !baseAutoDone && navigator.onLine !== false && yKey()) {
      baseAutoDone = true;
      baseSession = kind === 'yandex' ? 'osm' : 'yandex';
      syncBases();
      toast(`${BASE_NAME[kind]} не загружаются — показываю ${BASE_NAME[baseSession]}`);
    }
  });
  layer.addTo(map);
  layer.bringToBack();
  if (kind === 'yandex') map._ylogo = new YLogo().addTo(map);
  map._baseLayer = layer;
  map._baseKind = kind;
}

// привести обе карты (договоров и подстанций) к текущей подложке
function syncBases() {
  for (const st of [MC, MS]) if (st && st.map) {
    setBase(st.map, curBase());
    const b = st.root.querySelector('.mb.lay');
    if (b) b.hidden = !yKey();
  }
}

function toggleBase() {
  const next = curBase() === 'yandex' ? 'osm' : 'yandex';
  ls.set('base', next);
  baseSession = null;
  syncBases();
  toast('Подложка: ' + BASE_NAME[next]);
}

function mapShell(root) {
  root.innerHTML = `<div class="lmap"></div>
    <div class="mtop"></div>
    <div class="mctlwrap">
      <div class="mctl">
        <button class="mb" data-z="1" aria-label="Приблизить">+</button>
        <button class="mb" data-z="-1" aria-label="Отдалить">−</button>
      </div>
      <div class="mctl2">
        <button class="mb loc solo" aria-label="Моё местоположение">${MICON.target}</button>
        <button class="mb lay solo" aria-label="Сменить подложку карты"${yKey() ? '' : ' hidden'}>${MICON.layers}</button>
      </div>
    </div>
    <div class="pickpin" hidden><svg viewBox="0 0 30 40"><path d="M15 39C15 39 28 24 28 14A13 13 0 0 0 2 14C2 24 15 39 15 39z" fill="#FF6408" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg></div>
    <div class="mlegend" hidden></div>
    <div class="mbottom"></div>
    <div class="msheet" hidden></div>`;
}

function bindCtl(st) {
  const r = st.root;
  r.querySelectorAll('[data-z]').forEach(b => b.onclick = () => st.map.setZoom(st.map.getZoom() + (+b.dataset.z)));
  r.querySelector('.loc').onclick = () => locate(st);
  r.querySelector('.lay').onclick = () => toggleBase();
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
  sh.innerHTML = '<div class="grab" role="button" aria-label="Смахните вниз, чтобы закрыть"><i></i></div>' + html;
  sh.hidden = false;
  sh.style.transform = '';
  sh.scrollTop = 0;
  st.root.querySelector('.mbottom').hidden = true;
  bindSwipe(st, sh);
  bindCopy(sh);
  return sh;
}
// Смахивание окошка вниз за полосу сверху: окошко идёт за пальцем; далеко или резко — закрывается,
// иначе возвращается на место. Простое нажатие на полосу тоже закрывает.
function bindSwipe(st, sh) {
  const grab = sh.querySelector('.grab');
  let y0 = null, t0 = 0, dy = 0, moved = false;
  grab.addEventListener('pointerdown', ev => {
    y0 = ev.clientY; t0 = performance.now(); dy = 0; moved = false;
    grab.setPointerCapture(ev.pointerId);
    sh.style.transition = 'none';
  });
  grab.addEventListener('pointermove', ev => {
    if (y0 === null) return;
    dy = Math.max(0, ev.clientY - y0);
    if (dy > 4) moved = true;
    sh.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 === null) return;
    const v = dy / Math.max(1, performance.now() - t0);
    y0 = null;
    sh.style.transition = 'transform .18s ease-out';
    if (!moved || dy > 90 || (dy > 30 && v > 0.5)) {
      sh.style.transform = `translateY(${sh.offsetHeight}px)`;
      setTimeout(() => { sh.style.transition = ''; hideSheet(st); }, 170);
    } else {
      sh.style.transform = '';
      setTimeout(() => { sh.style.transition = ''; }, 190);
    }
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

function hideSheet(st) {
  const sh = st.root.querySelector('.msheet');
  if (!sh.hidden) { sh.hidden = true; sh.innerHTML = ''; sh.style.transform = ''; }
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
    <div class="lg"><span class="mk-eo man"></span>ЭО, уточнено на месте</div>
    <div class="lg"><span class="mk-eo fix"></span>Уточнено вами, на проверке</div>
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
  const st = { root, map, x: X, subs: SUBS, fixVer: FIX_VER };
  const cl = L.markerClusterGroup({
    chunkedLoading: true, showCoverageOnHover: false, spiderfyOnMaxZoom: false, zoomToBoundsOnClick: false,
    maxClusterRadius: 60, iconCreateFunction: c => clusterIcon(c.getChildCount(), 'eo')
  });
  const markers = [];
  for (const e of X.eos) {
    const ll = eoLL(e);
    if (!ll) continue;
    const m = L.marker(ll, { icon: eoIcon(eoKind(e)), keyboard: false });
    m._eo = e;
    markers.push(m);
  }
  cl.addLayers(markers);
  map.addLayer(cl);
  cl.on('click', ev => { if (!st.picking) openEoSheet(st, ev.layer._eo); });
  cl.on('clusterclick', ev => {
    const c = ev.layer, b = c.getBounds();
    // все ЭО в одной точке (один дом) — кружок не распадётся, показываем список
    if (!st.picking && (b.getNorthEast().distanceTo(b.getSouthWest()) < 25 || map.getZoom() >= 18)) openEoListSheet(st, c.getAllChildMarkers().map(m => m._eo));
    else c.zoomToBounds({ padding: [50, 50] });
  });
  st.cl = cl;
  st.subsLayer = L.layerGroup().addTo(map);
  st.focusLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => updateSubsLayer(st));
  map.on('click', () => { if (!st.picking) { hideSheet(st); closeEoDrop(st); } });
  // без анимации: иначе конец анимации перебивает приближение к ЭО (карта из карточки, уточнение точки)
  if (markers.length) map.fitBounds(L.latLngBounds(markers.map(m => m.getLatLng())), { padding: [30, 30], animate: false });
  bindCtl(st);
  st.root.querySelector('.mlegend').innerHTML = legendHtml();
  return st;
}

// mode: null — обычная карта; 'fix' — указать точку ЭО на карте (метка в центре)
function enterContractsMap(focusId, mode) {
  const root = $('#mapC');
  showMapRoot(root);
  if (!MC || MC.x !== X || MC.subs !== SUBS || MC.fixVer !== FIX_VER) {
    if (MC) { stopLocate(); MC.map.remove(); }
    MC = buildContractsMap();
  }
  const st = MC;
  syncBases();
  st.map.invalidateSize();
  hideSheet(st);
  st.focusLayer.clearLayers();
  if (st.selLayer) st.selLayer.clearLayers();
  const e = focusId ? X.byId.get(focusId) : null;
  const picking = mode === 'fix' && !!e;
  st.picking = picking;
  st.root.classList.toggle('picking', picking);
  st.root.querySelector('.pickpin').hidden = !picking;
  const top = st.root.querySelector('.mtop');
  const onSubs = ls.get('subsOn', true);
  const back = `<button class="ib" id="mBack" aria-label="Назад">${ICON.back}</button>`;
  const info = `<button class="ib" id="mInfo" aria-label="Легенда">${MICON.info}</button>`;
  let head;
  if (picking) head = `<div class="rowf">${back}<div class="pill"><b>Уточнение точки</b><span>${esc(e.name)}</span></div></div>`;
  else if (e) head = `<div class="rowf">${back}<div class="pill"><b>${esc(e.name)}</b><span>ЭО ${esc(e.id)}</span></div>${info}</div>`;
  else head = `<div class="rowf">${back}<label class="msearch" id="cBox">${ICON.search}<input id="cq" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Договор, ЭО, счётчик, адрес, абонент"><button class="x" id="cClr" aria-label="Очистить">${ICON.close}</button></label>${info}</div>`;
  top.innerHTML = head + (SUBS ? `<button class="tgl${onSubs ? ' on' : ''}" id="mTgl"><span class="tb">${MICON.boltBig}</span>Подстанции<span class="sw"><i></i></span></button>` : '')
    + `<div class="hintchip" id="mHint" hidden>Подстанции появятся при приближении</div><div class="sdrop" id="cDrop" hidden></div>`;
  $('#mBack').onclick = () => (history.length > 1 ? history.back() : go('#/'));
  if ($('#mInfo')) $('#mInfo').onclick = () => { const lg = st.root.querySelector('.mlegend'); lg.hidden = !lg.hidden; };
  const tg = $('#mTgl');
  if (tg) tg.onclick = () => { const v = !ls.get('subsOn', true); ls.set('subsOn', v); tg.classList.toggle('on', v); updateSubsLayer(st); };
  st.root.querySelector('.mlegend').hidden = true;

  const bottom = st.root.querySelector('.mbottom');
  const onMap = X.eos.reduce((n, x) => n + (eoLL(x) ? 1 : 0), 0);
  const noC = X.eos.length - onMap;
  bottom.innerHTML = '';
  if (!e) {
    bottom.innerHTML = `<button class="nocoord" id="mNo"${noC ? '' : ' disabled'}>На карте ${fmtN(onMap)} из ${fmtN(X.eos.length)} ЭО${noC ? ` · без координат ${fmtN(noC)} <b>Список ›</b>` : ''}</button>`;
    if (noC) $('#mNo').onclick = () => go('#/nocoords');
    const inp = $('#cq');
    let tmr;
    inp.oninput = () => { clearTimeout(tmr); tmr = setTimeout(() => showEoResults(st, inp.value), 150); };
    inp.onfocus = () => { if (inp.value.trim()) showEoResults(st, inp.value); };
    inp.onkeydown = ev => { if (ev.key === 'Enter') { const f = $('#cDrop [data-id]'); if (f) f.click(); else inp.blur(); } };
    $('#cClr').onclick = ev => { ev.preventDefault(); inp.value = ''; closeEoDrop(st); hideSheet(st); inp.focus(); };
  }

  const ll = e ? eoLL(e) : null;
  if (picking) {
    const c = ll || st.meLL || st.map.getCenter();
    st.map.setView(c, Math.max(17, ll ? 18 : 16), { animate: false });
    bottom.innerHTML = `<div class="pickbar"><p>Передвиньте карту так, чтобы метка встала на объект</p>
      <div class="row2"><button class="btn danger" id="pkCancel">Отмена</button><button class="btn primary" id="pkSave">Сохранить точку</button></div></div>`;
    $('#pkCancel').onclick = () => history.back();
    $('#pkSave').onclick = async () => {
      const c2 = st.map.getCenter();
      if (await saveFix(e, c2.lat, c2.lng, 'map', null)) history.back();
    };
  } else if (e && ll) {
    L.marker(ll, { icon: pinIcon(), zIndexOffset: 2500, interactive: false }).addTo(st.focusLayer);
    st.map.setView(ll, 17, { animate: false });
    showSheet(st, `<div class="meta" style="margin:0">${esc(eoAddr(e))}</div>${eoPointNote(e)}`, 'slim');
  }
  updateSubsLayer(st);
}

function closeEoDrop(st) { const d = st.root.querySelector('#cDrop'); if (d) { d.hidden = true; d.innerHTML = ''; } }

// Поиск на карте договоров — тот же, что на главной.
function showEoResults(st, q) {
  const box = st.root.querySelector('#cDrop');
  if (!q.trim()) { closeEoDrop(st); return; }
  const res = search(q);
  const toks = tokensOf(q);
  const LIM = 40;
  box.innerHTML = res.length
    ? `<div class="dh">Найдено ${fmtN(res.length)} ЭО${res.length > LIM ? ', показаны первые ' + LIM : ''}</div>` + res.slice(0, LIM).map(({ e }) => {
      const has = !!eoLL(e);
      return `<button class="ri${has ? '' : ' nomap'}" data-id="${esc(e.id)}"><span class="mk-eo ${has ? eoKind(e) : 'none'}"></span>
        <span class="rt"><b>${highlight(e.name, toks)}</b><small>Договор ${highlight(e.contract || '—', toks)}, ЭО ${highlight(e.id, toks)}</small>
        <small>${has ? highlight(eoAddr(e), toks) : 'нет на карте — откроется карточка'}</small></span>${ICON.right}</button>`;
    }).join('')
    : '<div class="dh">Ничего не нашлось. Проверьте номер или попробуйте часть слова.</div>';
  box.hidden = false;
  box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
    const e = X.byId.get(b.dataset.id);
    closeEoDrop(st);
    const inp = $('#cq'); inp.blur();
    const ll = eoLL(e);
    if (!ll) { go('#/eo/' + encodeURIComponent(e.id)); return; }
    rememberQuery(q);
    st.map.setView(ll, Math.max(st.map.getZoom(), 17));
    if (!st.selLayer) st.selLayer = L.layerGroup().addTo(st.map);
    st.selLayer.clearLayers();
    L.marker(ll, { icon: L.divIcon({ className: 'mk-selring', iconSize: [40, 40] }), interactive: false, zIndexOffset: 2400 }).addTo(st.selLayer);
    openEoSheet(st, e, true);
  });
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

// строка про уточнённую точку (для окошка на карте и карточки)
function eoPointNote(e) {
  if (e.fix) return `<div class="fixnote">Точка уточнена вами ${esc(fmtDay(e.fix.ts))} — на проверке</div>`;
  if (e.manual) return `<div class="mannote">Точка уточнена на месте${e.manualInfo ? ': ' + esc(e.manualInfo) : ''}</div>`;
  return '';
}

function openEoSheet(st, e, keepSel) {
  if (!keepSel && st.selLayer) st.selLayer.clearLayers();
  const nm = e.meters.length;
  const badge = nm ? `<span class="badge b-pu">${nm} ПУ</span>` : '<span class="badge b-x">Нет ПУ</span>';
  const sh = showSheet(st, `<div class="r1"><div class="name">${esc(e.name)}</div>${badge}</div>
    <div class="meta">Договор ${esc(e.contract || '—')}, ЭО ${esc(e.id)}<br>${esc(eoAddr(e))}</div>
    ${eoPointNote(e)}
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
  map.fitBounds(L.latLngBounds(all), { padding: [20, 20], animate: false });
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
  syncBases();
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
