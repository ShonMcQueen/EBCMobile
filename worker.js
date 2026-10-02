// Фоновый обработчик: распаковывает zip (в т.ч. с паролем AES), читает CSV
// и превращает его в компактную таблицу. Работает отдельно от экрана,
// поэтому интерфейс не «замирает» на больших файлах.
importScripts('zip.min.js');
zip.configure({ useWebWorkers: false });

const post = (type, data = {}) => postMessage({ type, ...data });
const userError = msg => Object.assign(new Error(msg), { user: true });

onmessage = async e => {
  const { file, password } = e.data;
  try {
    post('progress', { stage: 'Открываю файл', pct: 2 });
    let bytes, name = file.name || 'data.csv';
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;

    let subs = null, histText = null;
    if (isZip) {
      const reader = new zip.ZipReader(new zip.BlobReader(file));
      const all = (await reader.getEntries()).filter(en => !en.directory);
      const entries = all.filter(en => /\.csv$/i.test(en.filename));
      const geos = all.filter(en => /\.geojson$/i.test(en.filename));
      const hist = all.find(en => /\.ebch$/i.test(en.filename));     // история по месяцам из геокодера 1.2
      if (!entries.length) { await reader.close(); throw userError('В архиве нет CSV-файла.'); }
      entries.sort((a, b) => b.uncompressedSize - a.uncompressedSize);
      const entry = entries[0];
      if ((entry.encrypted || geos.some(g => g.encrypted) || (hist && hist.encrypted)) && !password) { await reader.close(); post('need-password'); return; }
      try {
        bytes = await entry.getData(new zip.Uint8ArrayWriter(), {
          password: password || undefined,
          onprogress: (i, t) => post('progress', { stage: 'Распаковываю', pct: 2 + Math.round((i / (t || 1)) * 28) })
        });
        if (geos.length) {
          post('progress', { stage: 'Читаю подстанции', pct: 30 });
          const files = [];
          for (const g of geos) {
            const b = await g.getData(new zip.Uint8ArrayWriter(), { password: password || undefined });
            files.push({ name: g.filename.split('/').pop(), text: decode(b) });
          }
          subs = buildSubs(files);
        }
        if (hist) {
          post('progress', { stage: 'Распаковываю историю', pct: 31 });
          histText = decode(await hist.getData(new zip.Uint8ArrayWriter(), { password: password || undefined }));
        }
      } catch (err) {
        await reader.close();
        if (/password|encrypted/i.test(err.message || '')) { post('bad-password'); return; }
        throw err;
      }
      await reader.close();
      name = entry.filename.split('/').pop();
    } else {
      bytes = new Uint8Array(await file.arrayBuffer());
    }

    post('progress', { stage: 'Читаю текст', pct: 32 });
    let text = decode(bytes);
    bytes = null;

    const model = buildModel(text, name, p => post('progress', { stage: 'Разбираю строки', pct: 32 + Math.round(p * 58) }));
    text = null;
    const histMeta = await saveHistory(histText, p => post('progress', { stage: 'Сохраняю историю', pct: 90 + Math.round(p * 3) }));
    histText = null;
    post('progress', { stage: 'Сохраняю на телефоне', pct: 93 });
    post('done', { json: JSON.stringify(model), meta: model.meta, subs: subs ? JSON.stringify(subs) : null, hist: histMeta });
  } catch (err) {
    post('error', { message: err.user ? err.message : 'Не удалось обработать файл: ' + (err.message || err) });
  }
};

// ---------------------------------------------------------------- история по месяцам
// Пишем прямо в хранилище телефона: «hmeta» — общие сведения, «h:<ЭО>» — строка по каждому ЭО.
// Старая история удаляется всегда: если в новом архиве её нет, графики просто не показываются.
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('mobile-ebc', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function txDone(t) { return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

async function saveHistory(text, onProgress) {
  const db = await openDb();
  let t = db.transaction('kv', 'readwrite');
  t.objectStore('kv').delete(IDBKeyRange.bound('h:', 'h:\uffff'));
  t.objectStore('kv').delete('hmeta');
  await txDone(t);
  if (!text) { db.close(); return null; }
  const nl = text.indexOf('\n');
  let meta;
  try { meta = JSON.parse(text.slice(0, nl)); } catch { db.close(); return null; }
  if (!meta || meta.v !== 1) { db.close(); return null; }
  const re = /^\{"e":"([^"]+)"/;
  let pos = nl + 1, n = 0;
  const total = text.length;
  while (pos < total) {
    t = db.transaction('kv', 'readwrite');
    const st = t.objectStore('kv');
    for (let k = 0; k < 2000 && pos < total; k++) {
      let end = text.indexOf('\n', pos);
      if (end < 0) end = total;
      const line = text.slice(pos, end);
      pos = end + 1;
      const m = re.exec(line);
      if (m) { st.put(line, 'h:' + m[1]); n++; }
    }
    await txDone(t);
    onProgress(pos / total);
  }
  const ms = JSON.stringify(meta);
  t = db.transaction('kv', 'readwrite');
  t.objectStore('kv').put(ms, 'hmeta');
  await txDone(t);
  db.close();
  return ms;
}

// UTF-8, а если файл сохранён в старой кодировке Windows — cp1251.
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}

// Разбор CSV: кавычки, "" внутри кавычек, переносы строк внутри ячеек.
function parseCSV(text, D, onProgress) {
  const rows = [];
  const n = text.length;
  let i = 0, row = [];
  while (i < n) {
    let c = text.charCodeAt(i), field;
    if (c === 34) {
      let j = i + 1, s = '';
      for (;;) {
        const k = text.indexOf('"', j);
        if (k < 0) { s += text.slice(j); i = n; break; }
        if (text.charCodeAt(k + 1) === 34) { s += text.slice(j, k + 1); j = k + 2; }
        else { s += text.slice(j, k); i = k + 1; break; }
      }
      let j2 = i;
      while (j2 < n) { c = text.charCodeAt(j2); if (c === D || c === 10 || c === 13) break; j2++; }
      if (j2 > i) s += text.slice(i, j2);
      i = j2; field = s;
    } else {
      let j = i;
      while (j < n) { c = text.charCodeAt(j); if (c === D || c === 10 || c === 13) break; j++; }
      field = text.slice(i, j); i = j;
    }
    row.push(field);
    if (i >= n) { rows.push(row); break; }
    c = text.charCodeAt(i);
    if (c === D) { i++; if (i >= n) { row.push(''); rows.push(row); } continue; }
    i += (c === 13 && text.charCodeAt(i + 1) === 10) ? 2 : 1;
    rows.push(row); row = [];
    if ((rows.length & 2047) === 0) onProgress(i / n);
  }
  return rows;
}

const normH = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').trim();

function buildModel(text, fileName, onProgress) {
  const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : 2000);
  const semi = (firstLine.match(/;/g) || []).length, comma = (firstLine.match(/,/g) || []).length;
  const D = semi >= comma ? 59 : 44;
  const all = parseCSV(text, D, onProgress);

  // Шапка: строки до строки с нумерацией колонок «1;2;3…».
  let numIdx = -1;
  for (let k = 0; k < Math.min(8, all.length); k++) {
    const r = all[k].map(s => s.trim());
    if (r[0] === '1' && r[1] === '2' && r[2] === '3') { numIdx = k; break; }
  }
  const hdrRows = numIdx > 0 ? all.slice(0, numIdx) : [all[0] || []];
  const dataStart = numIdx > 0 ? numIdx + 1 : 1;
  const width = Math.max(...hdrRows.map(r => r.length));

  const header = [];
  const seen = {};
  let top = '';
  for (let c = 0; c < width; c++) {
    const lv = hdrRows.map(r => (r[c] || '').trim().replace(/\s+/g, ' '));
    const lowerHas = lv.slice(1).some(Boolean);
    if (lv[0]) top = lv[0];
    else if (lowerHas) lv[0] = top;
    else top = '';
    let name = lv.filter(Boolean).join(' / ') || ('Колонка ' + (c + 1));
    if (seen[name]) name += ' (' + (++seen[name]) + ')'; else seen[name] = 1;
    header.push(name);
  }

  const H = header.map(normH);
  const find = re => H.findIndex(h => re.test(h));
  const findAll = re => H.map((h, i) => (re.test(h) ? i : -1)).filter(i => i >= 0);
  const f = {
    name: find(/^наименование потребителя$/),
    inn: find(/^инн/),
    contract: find(/номер договора$/),
    eo: find(/^номер объекта$/),
    meter: find(/№ счетчика$/),
    role: find(/тип счетчика$/),
    iktsHead: find(/^иктс головной/),
    ikts: find(/^иктс ту$/),
    fact: findAll(/^фактический адрес/),
    tu: findAll(/^адрес точки учета/),
    lat: find(/^координаты \/ широта$/),
    lon: find(/^координаты \/ долгота$/),
    prec: find(/^координаты \/ точность$/),
    src: find(/^координаты \/ источник координат$/)
  };
  const missing = [];
  if (f.eo < 0) missing.push('«Номер объекта»');
  if (f.name < 0) missing.push('«Наименование потребителя»');
  if (missing.length) throw userError('В файле не нашлось колонок ' + missing.join(' и ') + '. Похоже, это не выгрузка Ф18.');

  const rows = [];
  for (let k = dataStart; k < all.length; k++) {
    const r = all[k];
    for (let q = 0; q < r.length; q++) r[q] = r[q].trim();
    while (r.length && r[r.length - 1] === '') r.pop();
    if (!r.length) continue;
    if (!r[f.eo] && !r[f.name]) continue;
    rows.push(r);
  }

  const eoSet = new Set(rows.map(r => r[f.eo]));
  const transit = f.role >= 0 ? rows.filter(r => normH(r[f.role]).startsWith('транзит')).length : 0;
  const pm = fileName.match(/(\d{2})[._\-](\d{4})/);
  return {
    v: 1, header, f, rows,
    meta: {
      fileName, period: pm ? pm[1] + '.' + pm[2] : '',
      rows: rows.length, eo: eoSet.size, transit, loadedAt: Date.now()
    }
  };
}

// ---------------------------------------------------------------- подстанции (.geojson из Конструктора Яндекс Карт)
// Цвет точки = тип: #1e98ff — ТП электросети, #1bad03 — частная ТП, #ed4543 — ПЦ.
const SUB_TYPES = { '#1e98ff': 'net', '#1bad03': 'priv', '#ed4543': 'pc' };

// «ТП Раменского ПО» → «Раменское ПО», «ТП Жуковского РЭС» → «Жуковский РЭС»
function poName(meta, fileName) {
  let n = (meta || '').trim() || fileName.replace(/\.geojson$/i, '');
  n = n.replace(/^(тп|подстанции|трансформаторные подстанции)\s+/i, '');
  // \b в JavaScript не видит русские буквы, поэтому граница слова — через (?=…)
  n = n.replace(/([А-Яа-яЁё]+)ского(\s+ПО)(?=$|[\s,.])/g, '$1ское$2');
  n = n.replace(/([А-Яа-яЁё]+)ского(\s+РЭС)(?=$|[\s,.])/g, '$1ский$2');
  return n.trim() || 'участок не указан';
}

function buildSubs(files) {
  const po = [], items = [], counts = { pc: 0, net: 0, priv: 0 };
  let dupes = 0;
  const byName = new Map();          // название → индексы в items (для поиска дублей между файлами)
  for (const f of files) {
    let data;
    try { data = JSON.parse(f.text); } catch { continue; }
    const feats = (data && data.features) || [];
    const pName = poName(data.metadata && data.metadata.name, f.name);
    let pi = po.indexOf(pName);
    if (pi < 0) { po.push(pName); pi = po.length - 1; }
    for (const ft of feats) {
      const g = ft && ft.geometry, pr = (ft && ft.properties) || {};
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const lon = +g.coordinates[0], lat = +g.coordinates[1];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const desc = String(pr.description || '').trim();
      const name = String(pr.iconCaption || '').trim() || desc.split(/[\n\t]/)[0].slice(0, 40) || 'Без названия';
      const type = SUB_TYPES[String(pr['marker-color'] || '').toLowerCase()] || 'net';
      const key = name.toLowerCase().replace(/\s+/g, ' ');
      const same = (byName.get(key) || []).find(i => {
        const o = items[i];
        const dy = (o[0] - lat) * 111000, dx = (o[1] - lon) * 111000 * Math.cos(lat * Math.PI / 180);
        return Math.hypot(dx, dy) < 50;
      });
      if (same !== undefined) {                     // тот же ПЦ в двух файлах — показываем один раз
        const o = items[same];
        if (!o[3].includes(pi)) o[3].push(pi);
        if (!o[5] && desc) o[5] = desc;
        dupes++;
        continue;
      }
      items.push([+lat.toFixed(6), +lon.toFixed(6), name, [pi], type, desc]);
      counts[type]++;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(items.length - 1);
    }
  }
  if (!items.length) return null;
  return { v: 1, po, items, counts, dupes, files: files.length, loadedAt: Date.now() };
}
