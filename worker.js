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

    if (isZip) {
      const reader = new zip.ZipReader(new zip.BlobReader(file));
      const entries = (await reader.getEntries()).filter(en => !en.directory && /\.csv$/i.test(en.filename));
      if (!entries.length) { await reader.close(); throw userError('В архиве нет CSV-файла.'); }
      entries.sort((a, b) => b.uncompressedSize - a.uncompressedSize);
      const entry = entries[0];
      if (entry.encrypted && !password) { await reader.close(); post('need-password'); return; }
      try {
        bytes = await entry.getData(new zip.Uint8ArrayWriter(), {
          password: password || undefined,
          onprogress: (i, t) => post('progress', { stage: 'Распаковываю', pct: 2 + Math.round((i / (t || 1)) * 28) })
        });
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
    post('progress', { stage: 'Сохраняю на телефоне', pct: 93 });
    post('done', { json: JSON.stringify(model), meta: model.meta });
  } catch (err) {
    post('error', { message: err.user ? err.message : 'Не удалось обработать файл: ' + (err.message || err) });
  }
};

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
    tu: findAll(/^адрес точки учета/)
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
