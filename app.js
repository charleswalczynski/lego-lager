'use strict';
const VERSION = '3.2';
const API = 'https://rebrickable.com/api/v3/lego';
const DEFAULT_SHEET = '';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString('de-DE');
const safeUrl = u => (typeof u === 'string' && u.startsWith('https://')) ? u : '';
const CN={"Black":"Schwarz","White":"Weiß","Red":"Rot","Blue":"Blau","Yellow":"Gelb","Green":"Grün","Bright Green":"Hellgrün","Light Bluish Gray":"Hellgrau","Dark Bluish Gray":"Dunkelgrau","Light Gray":"Altgrau hell","Dark Gray":"Altgrau dunkel","Tan":"Beige","Dark Tan":"Dunkelbeige","Reddish Brown":"Rotbraun","Brown":"Braun (alt)","Dark Brown":"Dunkelbraun","Orange":"Orange","Lime":"Limette","Dark Red":"Dunkelrot","Dark Blue":"Dunkelblau","Medium Blue":"Mittelblau","Medium Azure":"Azur","Dark Azure":"Dunkelazur","Sand Green":"Sandgrün","Sand Blue":"Sandblau","Dark Green":"Dunkelgrün","Olive Green":"Olivgrün","Pearl Gold":"Perlgold","Flat Silver":"Silber","Medium Nougat":"Nougat","Light Nougat":"Hautfarbe hell","Nougat":"Nougat hell","Bright Pink":"Hellpink","Dark Pink":"Pink","Magenta":"Magenta","Medium Lavender":"Lavendel","Dark Purple":"Dunkellila","Bright Light Orange":"Hellorange","Bright Light Yellow":"Hellgelb","Dark Orange":"Dunkelorange","Trans-Clear":"Transparent","Trans-Red":"Trans-Rot","Trans-Light Blue":"Trans-Hellblau","Trans-Yellow":"Trans-Gelb","Trans-Black":"Trans-Schwarz","Trans-Neon Green":"Trans-Neongrün","Trans-Orange":"Trans-Orange","Trans-Dark Blue":"Trans-Dunkelblau","Trans-Green":"Trans-Grün","Chrome Gold":"Chromgold","Chrome Silver":"Chromsilber","Pearl Dark Gray":"Perlgrau dunkel","Metallic Silver":"Metallic-Silber"};
const cn = c => CN[c] ? `<span title="${esc(c)}">${CN[c]}</span>` : esc(c);
const cnLong = c => CN[c] ? `${CN[c]} <span class="mut">(${esc(c)})</span>` : esc(c);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Speicher (IndexedDB) ---------- */
const idb = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('lego-lager', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode), req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)) };
})();

const S = { settings: { key: '', sheetId: DEFAULT_SHEET, scriptUrl: '', token: '' }, locs: { map: {}, labels: {}, boxes: {}, rows: 0, updated: null }, sets: {}, blColors: null, scan: { items: {}, last: 0 }, meta: { changes: 0, changedAt: null, lastBackup: null } };
const saveT = {};
function save(k) {
  if (k === 'sets') { S.meta.changes = (S.meta.changes || 0) + 1; S.meta.changedAt = new Date().toISOString(); save('meta'); }
  clearTimeout(saveT[k]); saveT[k] = setTimeout(() => idb.set(k, S[k]).catch(() => toast('Speichern fehlgeschlagen')), 250); }

let hideDone = true, busy = null, armed = null, query = '', addOpen = false, printNew = true;
const toast = t => { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('on'), 2600); };

/* ---------- Teilenummern & Standorte ---------- */
const norm = p => String(p || '').toLowerCase().replace(/\s+/g, '');
function keysFor(it) {
  const ks = [norm(it.part), ...(it.bl || []).map(norm)];
  const out = new Set(ks);
  for (const k of ks) {
    const noPrint = k.replace(/(pr|pat|px|pb)\d+[a-z]*$/, '');
    out.add(noPrint);
    out.add(noPrint.replace(/[a-z]+$/, ''));
  }
  return [...out].filter(Boolean);
}
function locate(it) {
  if (it.kind === 'fig') return { boxes: [], fig: true };
  const ks = keysFor(it);
  for (let i = 0; i < ks.length; i++) {
    const b = S.locs.map[ks[i]];
    if (b && b.length) return { boxes: b, fuzzy: i > 0 && ks[i] !== norm(it.part) && !(it.bl || []).map(norm).includes(ks[i]) };
  }
  return { boxes: [] };
}
const boxSort = (a, b) => String(a).localeCompare(String(b), 'de', { numeric: true });

function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function loadLocs() {
  let rows, src;
  if (S.settings.scriptUrl && S.settings.token) {
    rows = (await gs({ action: 'read' })).rows; src = 'Skript';
  } else {
    const id = S.settings.sheetId.trim();
    if (!id) throw new Error('Bitte die ID der Google-Tabelle eintragen.');
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent('Kästchen')}`;
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); } catch (e) { throw new Error('Tabelle nicht erreichbar. Bist du online, und ist die Tabelle per Link lesbar?'); }
    if (!res.ok) throw new Error('Tabelle nicht lesbar (' + res.status + '). Freigabe „Jeder mit dem Link“ prüfen.');
    const txt = await res.text();
    if (txt.trim().startsWith('<')) throw new Error('Tabelle nicht freigegeben. Bitte „Jeder mit dem Link: Betrachter“ einstellen.');
    rows = parseCSV(txt).slice(1); src = 'Link';
  }
  const map = {}, labels = {}, boxes = {};
  let n = 0;
  for (const r of rows) {
    const box = String(r[0] || '').trim();
    if (!box || /^beispiel$/i.test(box)) continue;
    const raw = String(r[1] || '').trim();
    boxes[box] = { parts: raw, name: String(r[2] || '').trim(), note: String(r[3] || '').trim() };
    const parts = raw.split(/[,;\/\s]+/).map(norm).filter(Boolean);
    if (r[2]) labels[box] = String(r[2]).trim();
    for (const p of parts) { (map[p] ??= []); if (!map[p].includes(box)) map[p].push(box); n++; }
  }
  for (const k in map) map[k].sort(boxSort);
  S.locs = { map, labels, boxes, rows: n, updated: new Date().toISOString(), src };
  save('locs');
  return n;
}

/* ---------- Rebrickable ---------- */
async function api(path) {
  if (!S.settings.key) throw new Error('Bitte zuerst den Rebrickable-API-Schlüssel in den Einstellungen eintragen.');
  const url = (path.startsWith('http') ? path : API + path);
  const u = new URL(url); u.searchParams.set('key', S.settings.key);
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try { r = await fetch(u.toString()); } catch (e) { throw new Error('Rebrickable nicht erreichbar. Bist du online?'); }
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (r.status === 401 || r.status === 403) throw new Error('API-Schlüssel ungültig.');
    if (r.status === 404) throw new Error('Nicht gefunden.');
    if (!r.ok) throw new Error('Rebrickable-Fehler ' + r.status);
    return r.json();
  }
  throw new Error('Rebrickable bremst gerade, bitte gleich nochmal.');
}
async function apiAll(path) {
  let out = [], next = path;
  while (next) { const j = await api(next); out = out.concat(j.results || []); next = j.next; if (next) await sleep(1100); }
  return out;
}
const bagNo = b => { const m = /^A(\d+)$/i.exec(String(b || '').trim()); return m ? +m[1] : 0; };
const nextBag = () => 'A' + (Math.max(0, ...Object.values(S.sets).map(s => bagNo(s.bag))) + 1);
function assignBags() {
  let n = 0;
  for (const s of Object.values(S.sets).sort((a, b) => String(a.added).localeCompare(String(b.added)) || a.num.localeCompare(b.num))) if (!bagNo(s.bag)) { s.bag = nextBag(); n++; }
  if (n) save('sets');
  return n;
}
const setNum = s => { s = String(s).trim().toLowerCase(); return /-\d+$/.test(s) ? s : s + '-1'; };

async function addSet(raw, bulk) {
  const num = setNum(raw);
  if (S.sets[num]) { if (!bulk) location.hash = '#set/' + encodeURIComponent(num); return true; }
  busy = (bulk ? bulk + ' · ' : '') + 'Lade Set ' + num + ' …'; render();
  try {
    const info = await api(`/sets/${encodeURIComponent(num)}/`);
    await sleep(1100);
    const parts = await apiAll(`/sets/${encodeURIComponent(num)}/parts/?page_size=1000`);
    await sleep(1100);
    let figs = [];
    try { figs = await apiAll(`/sets/${encodeURIComponent(num)}/minifigs/?page_size=1000`); } catch (e) { figs = []; }
    const m = new Map();
    for (const p of parts) {
      if (p.is_spare) continue;
      const id = p.part.part_num + '|' + p.color.id;
      const ex = m.get(id);
      if (ex) { ex.qty += p.quantity; continue; }
      m.set(id, {
        id, kind: 'part', part: p.part.part_num, name: p.part.name, img: safeUrl(p.part.part_img_url),
        color: p.color.name, colorId: p.color.id, rgb: /^[0-9a-f]{6}$/i.test(p.color.rgb || '') ? p.color.rgb : 'cccccc',
        bl: (p.part.external_ids && p.part.external_ids.BrickLink) || [],
        blColor: p.color.external_ids && p.color.external_ids.BrickLink && p.color.external_ids.BrickLink.ext_ids ? p.color.external_ids.BrickLink.ext_ids[0] : null,
        qty: p.quantity, found: 0, done: false
      });
    }
    for (const f of figs) m.set('fig|' + f.set_num, { id: 'fig|' + f.set_num, kind: 'fig', part: f.set_num, name: f.set_name, img: safeUrl(f.set_img_url), color: 'Minifigur', colorId: null, rgb: 'ffd500', bl: [], blColor: null, qty: f.quantity, found: 0, done: false });
    S.sets[num] = { num, name: info.name, year: info.year, img: safeUrl(info.set_img_url), items: [...m.values()], added: new Date().toISOString(), bagged: false, bag: nextBag() };
    save('sets');
    busy = (bulk ? bulk + ' · ' : '') + 'Bilder für ' + info.name + ' …'; render();
    await cacheImages(S.sets[num]);
    if (bulk) return true;
    busy = null;
    toast(`${info.name}: ${fmt(m.size)} Positionen, offline bereit`);
    location.hash = '#set/' + encodeURIComponent(num);
  } catch (e) { if (bulk) throw e; busy = null; toast(e.message); }
  render();
}
async function importSets(text) {
  const all = [...new Set((String(text).match(/\b\d{3,7}-\d{1,2}\b/g) || []).map(setNum))];
  const nums = all.filter(n => !S.sets[n]), skipped = all.length - nums.length;
  if (!all.length) { toast('Keine Set-Nummern in der Datei gefunden'); return; }
  if (!nums.length) { toast(`Alle ${all.length} Sets sind schon vorhanden, nichts importiert`); return; }
  const failed = [];
  for (let i = 0; i < nums.length; i++) {
    try { await addSet(nums[i], `Set ${i + 1} von ${nums.length}`); }
    catch (e) { failed.push(nums[i] + ' (' + e.message + ')'); if (/Schlüssel|online/i.test(e.message)) break; }
    await sleep(1100);
  }
  busy = null; render();
  const sk = skipped ? `, ${skipped} schon vorhanden (übersprungen)` : '';
  toast(failed.length ? `Fertig, ${failed.length} nicht geladen: ${failed.slice(0, 3).join(', ')}${sk}` : `${nums.length} neue Sets geladen${sk}`);
}
async function cacheImages(set) {
  const urls = [set.img, ...set.items.map(i => i.img)].filter(Boolean);
  let done = 0;
  const work = async () => {
    while (urls.length) {
      const u = urls.shift();
      try { await fetch(u, { mode: 'no-cors' }); } catch (e) {}
      done++;
      const p = $('#prog'); if (p) p.textContent = `Bilder ${done} geladen …`;
    }
  };
  await Promise.all([work(), work(), work(), work()]);
}

/* ---------- Rechnen ---------- */
const tot = s => s.items.reduce((a, i) => a + i.qty, 0);
const fnd = s => s.items.reduce((a, i) => a + Math.min(i.found, i.qty), 0);
const missing = s => s.items.filter(i => i.done && i.found < i.qty);
function status(s) {
  if (s.bagged) return 'eingebeutelt';
  if (s.items.every(i => i.done)) return missing(s).length ? 'fertig, Teile fehlen' : 'komplett';
  return fnd(s) || s.items.some(i => i.done) ? 'in Arbeit' : 'offen';
}

/* ---------- Ansichten ---------- */
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('set/')) return { v: 'set', id: h.slice(4) };
  if (h.startsWith('print/')) return { v: 'print', id: h.slice(6) };
  if (h.startsWith('scan/')) return { v: 'scanitem', id: h.slice(5) };
  if (h.startsWith('box/')) return { v: 'box', id: h.slice(4) };
  if (h === 'box') return { v: 'boxes' };
  if (h === 'scan') return { v: 'scan' };
  if (h === 'print') return { v: 'print' };
  if (h === 'shop' || h === 'settings') return { v: h };
  return { v: 'sets' };
}
function render() {
  const r = route();
  const tab = { set: 'sets', print: 'sets', box: 'box', boxes: 'box', scanitem: 'scan' }[r.v] || r.v;
  for (const t of ['sets', 'box', 'scan', 'shop', 'settings']) { const e = $('#t-' + t); e.classList.toggle('on', tab === t); e.toggleAttribute('aria-current', tab === t); }
  $('#b-scan').textContent = Object.values(S.scan.items).filter(i => i.status !== 'gespeichert').length || '';
  const n = Object.keys(S.sets).length, set = r.v === 'set' ? S.sets[r.id] : null, it = r.v === 'scanitem' ? S.scan.items[r.id] : null;
  const back = { set: '#sets', box: String(lastFrom).startsWith('#set/') ? lastFrom : '#box', scanitem: '#scan', print: r.id ? '#set/' + encodeURIComponent(r.id) : '#sets' }[r.v];
  const bk = $('#back'); bk.hidden = !back; if (back) bk.href = back;
  $('#title').textContent = {
    sets: n ? `Sets (${n})` : 'Sets', set: set ? (set.bag ? 'Beutel ' + set.bag : set.num) : 'Set', box: 'Kästchen ' + r.id, boxes: 'Kästchen',
    scan: 'Erfassen', scanitem: it ? 'Kästchen ' + it.box : 'Erfassen', shop: 'Einkauf', settings: 'Mehr', print: 'Etiketten'
  }[r.v];
  const m = $('#main');
  if (r.v === 'settings') m.innerHTML = vSettings();
  else if (r.v === 'scan') m.innerHTML = vScan();
  else if (r.v === 'scanitem') m.innerHTML = it ? vScanItem(it) : '<p class="empty">Eintrag nicht gefunden.</p>';
  else if (r.v === 'shop') m.innerHTML = vShop();
  else if (r.v === 'box') m.innerHTML = vBox(r.id);
  else if (r.v === 'boxes') m.innerHTML = vBoxes();
  else if (r.v === 'print') m.innerHTML = vPrint(r.id);
  else if (r.v === 'set') m.innerHTML = set ? vSet(set) : '<p class="empty">Set nicht gefunden.</p>';
  else m.innerHTML = vSets();
  if (r.v === 'scan' || r.v === 'scanitem') fillPhotos();
}
const img = (u, cls = '') => u ? `<img src="${esc(u)}" alt="" loading="lazy" class="${cls}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'kein Bild'}))">` : '<div class="ph">kein Bild</div>';

function vSets() {
  let list = Object.values(S.sets).sort((a, b) => (a.bagged - b.bagged) || bagNo(a.bag) - bagNo(b.bag));
  const open = addOpen || !list.length || busy;
  let h = backupBar();
  if (list.length) h += `<div class="sticky"><input id="q" type="search" placeholder="Suchen: Teil, Set, Beutel" value="${esc(query)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Suchen"></div>`;
  if (!S.settings.key) h += `<div class="warnbox">Zum Anlegen von Sets fehlt der Rebrickable-Schlüssel – <a href="#settings">unter „Mehr“ eintragen</a>.</div>`;
  if (open) {
    h += `<div class="addbox"><div class="row2" style="margin:0"><input id="newset" inputmode="text" placeholder="Set-Nummer, z. B. 6086" autocomplete="off" aria-label="Set-Nummer" ${busy ? 'disabled' : ''}><button class="pri" data-a="add" ${busy ? 'disabled' : ''}>Laden</button></div>`;
    if (!busy) h += '<div class="row2" style="margin-bottom:0"><label class="btn" style="flex:1;margin:0;font-size:15px">CSV-Liste von Rebrickable importieren<input type="file" id="csvin" accept=".csv,text/csv,text/plain" hidden></label></div>';
    h += '</div>';
  }
  if (busy) h += `<p class="prog"><b>${esc(busy)}</b> <span id="prog"></span></p>`;
  const q = norm(query), hits = {};
  if (q) list = list.filter(s => {
    if (norm(s.num + s.name).includes(q) || norm(s.bag) === q) return true;
    const its = s.items.filter(it => keysFor(it).includes(q) || norm(it.part).startsWith(q));
    if (its.length) { hits[s.num] = its; return true; }
    return false;
  });
  if (q && !list.length) return h + '<p class="empty">Nichts gefunden.</p>';
  if (!list.length) return h + '<p class="empty">Noch keine Sets. Set-Nummer eingeben, solange du Internet hast – Teileliste und Bilder werden fürs Arbeiten offline gespeichert.</p>';
  h += list.map(s => {
    const t = tot(s), g = fnd(s), st = status(s), mc = missing(s).reduce((a, i) => a + i.qty - i.found, 0);
    const chip = st === 'eingebeutelt' || st === 'komplett' ? `<span class="chip ok">${esc(st)}</span>` : '';
    return `<a class="card" href="#set/${encodeURIComponent(s.num)}">${img(s.img)}<div><div class="l1"><span class="bagno">${esc(s.bag || '–')}</span><b>${esc(s.name)}</b></div><div class="bar"><i style="width:${t ? Math.round(g / t * 100) : 0}%"></i></div><div class="mut" style="font-size:13px">${esc(s.num.replace(/-1$/, ''))} · ${fmt(g)}/${fmt(t)} Teile${mc ? ` · <span class="miss">${fmt(mc)} fehlen</span>` : ''} ${chip}</div>${hits[s.num] ? hits[s.num].map(it => { const L = locate(it); return `<div class="nm">→ ${it.qty}× ${esc(it.part)} ${CN[it.color] || esc(it.color)} · ${L.boxes.length ? 'Kästchen ' + L.boxes.map(esc).join(', ') : 'kein Standort'}</div>`; }).join('') : ''}</div></a>`;
  }).join('');
  return h + `<div class="row2" style="margin-top:16px"><button data-a="toggleadd">${open ? 'Hinzufügen schließen' : '+ Sets hinzufügen'}</button><a class="btn" href="#print">Etiketten drucken</a></div>`;
}

function itemRow(it, i, attrs, left, line2) {
  return `<div class="it ${it.done ? 'done' : ''}"><div class="tap" data-a="inc" ${attrs} data-i="${i}">${left}<div><div class="q">${it.found}<small> / ${it.qty}</small> <span class="nm" style="font-size:14px;font-weight:500"><span class="sw" style="background:#${esc(it.rgb)}"></span>${cn(it.color)}</span></div><div class="nm mut">${line2}</div></div></div><div class="side"><button data-a="dec" ${attrs} data-i="${i}" aria-label="ein Stück weniger">−1</button><button class="fz" data-a="done" ${attrs} data-i="${i}" aria-label="${it.done ? 'Wieder öffnen' : 'Als fertig markieren'}">${it.done ? '↺' : '✓'}</button></div></div>`;
}
function vSet(s) {
  const t = tot(s), g = fnd(s), st = status(s);
  const groups = new Map();
  s.items.forEach((it, i) => {
    const L = locate(it);
    const key = L.fig ? '~fig' : L.boxes.length ? L.boxes[0] : '~none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ it, i, L });
  });
  const keys = [...groups.keys()].sort((a, b) => a.startsWith('~') - b.startsWith('~') || boxSort(a, b));
  const nDone = s.items.filter(i => i.done).length;
  let h = `<div class="seth"><span class="bagbig">${esc(s.bag || '–')}</span><div><h2>${esc(s.name)}</h2><div class="mut" style="font-size:13px">${esc(s.num)}${s.year ? ' · ' + esc(s.year) : ''} · ${esc(st)}</div></div></div>
  <div class="bar"><i style="width:${t ? Math.round(g / t * 100) : 0}%"></i></div>
  <div class="seg"><span class="mut">${fmt(g)} von ${fmt(t)} Teilen</span>${nDone ? `<button class="link" data-a="hide">${hideDone ? `${nDone} erledigte zeigen` : 'Erledigte ausblenden'}</button>` : ''}</div>`;
  let shown = 0;
  for (const k of keys) {
    const rows = groups.get(k).filter(x => !hideDone || !x.it.done)
      .sort((a, b) => a.it.color.localeCompare(b.it.color) || a.it.part.localeCompare(b.it.part));
    if (!rows.length) continue;
    shown += rows.length;
    const label = k === '~fig' ? 'Minifiguren' : k === '~none' ? 'Kein Kästchen erfasst' : (S.locs.labels[k] || '');
    h += `<div class="gh">${k.startsWith('~') ? `<span class="nr ${k === '~none' ? 'none' : ''}">${k === '~fig' ? '☺' : '?'}</span>` : `<a class="nr" href="#box/${esc(k)}" aria-label="Kästchen ${esc(k)} öffnen">${esc(k)}</a>`}<b>${esc(label)}</b></div>`;
    h += rows.map(({ it, i, L }) => {
      const extra = [];
      if (L.boxes.length > 1) extra.push('auch ' + L.boxes.slice(1).map(esc).join(', '));
      if (L.fuzzy) extra.push('Variante prüfen');
      return itemRow(it, i, '', img(it.img), `${esc(it.part)} · ${esc(it.name)}${extra.length ? ' · ' + extra.join(' · ') : ''}`);
    }).join('');
  }
  if (!shown) h += `<p class="empty">${hideDone ? 'Alles erledigt.' : 'Keine Teile.'}</p>`;
  const mc = missing(s).reduce((a, i) => a + i.qty - i.found, 0);
  if (mc) h += `<p><a href="#shop">${fmt(mc)} fehlende Teile auf der Einkaufsliste</a></p>`;
  h += `<div class="row2" style="margin-top:18px">${s.bagged ? '<button data-a="unbag">Doch nicht eingebeutelt</button>' : `<button class="${nDone === s.items.length ? 'pri' : ''}" data-a="bag">Als eingebeutelt markieren</button>`}</div>
  <details><summary>Weitere Aktionen</summary>
  <div class="row2"><a class="btn" href="#print/${encodeURIComponent(s.num)}">Etikett drucken</a></div>
  <div class="row2"><input id="bagin" value="${esc(s.bag || '')}" autocapitalize="characters" autocomplete="off" aria-label="Beutelnummer" style="flex:0 1 100px"><button data-a="setbag">Beutelnummer ändern</button></div>
  <div class="row2"><button class="${armed === 'del' ? 'warn' : ''}" data-a="del">${armed === 'del' ? 'Wirklich löschen?' : 'Set löschen'}</button></div></details>`;
  return h;
}

function shopItems() {
  const out = [];
  for (const s of Object.values(S.sets)) for (const it of missing(s)) out.push({ s, it, n: it.qty - it.found });
  return out.sort((a, b) => a.s.num.localeCompare(b.s.num, 'de', { numeric: true }) || a.it.part.localeCompare(b.it.part));
}
function vShop() {
  const L = shopItems();
  if (!L.length) return '<p class="empty">Nichts zu kaufen. Teile landen hier, wenn du eine Zeile mit ✓ abschließt, obwohl noch Stücke fehlen.</p>';
  const total = L.reduce((a, x) => a + x.n, 0);
  let h = `<p class="mut">${fmt(total)} Teile in ${fmt(L.length)} Positionen</p>
  <div class="row2"><button class="pri" data-a="share">Liste teilen</button><button data-a="cpxml">BrickLink-XML</button><button data-a="cpcsv">Rebrickable-CSV</button></div><div id="out"></div>`;
  let last = '';
  for (const x of L) {
    if (x.s.num !== last) { last = x.s.num; h += `<div class="gh"><span class="bagno" style="font-size:16px;padding:4px 8px">${esc(x.s.bag || '–')}</span><b>${esc(x.s.name)}</b></div>`; }
    const i = x.s.items.indexOf(x.it);
    h += `<div class="it">${img(x.it.img)}<div><div class="q">${x.n}× <span class="nm" style="font-size:14px;font-weight:500"><span class="sw" style="background:#${esc(x.it.rgb)}"></span>${cn(x.it.color)}</span></div><div class="nm mut">${esc(x.it.part)} · ${esc(x.it.name)}</div></div><div class="side"><button data-a="got" data-s="${esc(x.s.num)}" data-i="${i}">Erhalten</button></div></div>`;
  }
  return h;
}

function vSettings() {
  const l = S.locs, lb = S.meta.lastBackup, conf = S.settings.key && (S.settings.scriptUrl || S.settings.sheetId);
  return `<h3 class="sec" style="margin-top:6px">Sicherung</h3>
  <p style="margin:4px 0">${lb ? `Zuletzt ${esc(tm(lb.at))} · ${fmt(lb.sets)} Sets` : 'Noch nie gesichert'}${S.meta.changes ? ` · <span class="miss">${fmt(S.meta.changes)} Änderungen offen</span>` : ''}</p>
  <label class="chk" style="margin:8px 0"><input type="checkbox" id="autob" ${S.settings.autoBackup !== false ? 'checked' : ''}> Automatisch sichern, sobald online</label>
  ${S.meta.lastAuto ? `<p class="${S.meta.lastAuto.ok ? 'mut' : 'miss'}" style="font-size:13px;margin:0">Letzte automatische Sicherung ${esc(tm(S.meta.lastAuto.at))}: ${S.meta.lastAuto.ok ? 'ok' : esc(S.meta.lastAuto.err || 'Fehler')}</p>` : ''}
  <div class="row2"><button class="pri" data-a="b-save">Jetzt sichern</button><button data-a="b-list">Wiederherstellen …</button></div><div id="bout"></div>
  <h3 class="sec">Kästchenliste</h3>
  <p style="margin:4px 0">${l.updated ? `Stand ${esc(tm(l.updated))} · ${fmt(Object.values(l.boxes || {}).filter(b => b.parts).length)} Kästchen belegt` : 'Noch nicht geladen'}</p>
  <div class="row2"><button data-a="locs">Jetzt laden</button></div>
  <h3 class="sec">Offline</h3>
  <div class="row2"><button data-a="imgs">Bilder aller Sets laden</button></div><p class="mut" id="imgprog" style="margin:0">Einmal mit WLAN, damit im Keller alle Teilebilder da sind.</p>
  <details ${conf ? '' : 'open'}><summary>Verbindungen</summary>
  <label for="k">Rebrickable-API-Schlüssel</label><input id="k" value="${esc(S.settings.key)}" autocomplete="off" autocapitalize="off" spellcheck="false">
  <p class="mut" style="margin:4px 0">rebrickable.com → Profil → Settings → API → „Generate new API key“</p>
  <label for="sh">Google-Tabelle (ID)</label><input id="sh" value="${esc(S.settings.sheetId)}" autocomplete="off" autocapitalize="off" spellcheck="false">
  <label for="su">Skript-URL</label><input id="su" value="${esc(S.settings.scriptUrl)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec">
  <label for="tk">Skript-Schlüssel</label><input id="tk" value="${esc(S.settings.token)}" autocomplete="off" autocapitalize="off" spellcheck="false">
  <div class="row2"><button class="pri" data-a="savecfg">Speichern</button><button data-a="ping">Verbindung testen</button></div><div id="pingout"></div></details>
  <details><summary>Sicherung als Text</summary>
  <div class="row2"><button data-a="export">Teilen/Kopieren</button><button data-a="importshow">Einspielen</button></div><div id="out"></div></details>
  <p class="mut" style="margin-top:20px;font-size:13px">Version ${VERSION} · <span id="persist"></span></p>`;
}

function labelsFor(r) {
  if (r.id) return [S.sets[r.id]].filter(Boolean);
  let list = Object.values(S.sets).sort((a, b) => a.num.localeCompare(b.num, 'de', { numeric: true }));
  return printNew ? list.filter(s => !s.printed) : list;
}
function vPrint(id) {
  const r = route(), sets = labelsFor(r), size = S.settings.label || 'a5', per = size === 'a5' ? 2 : 4;
  let h = `<div class="noprint">
  <div class="row2"><select id="lsize" aria-label="Format"><option value="a5" ${size === 'a5' ? 'selected' : ''}>A5 – 2 pro A4-Blatt</option><option value="a6" ${size === 'a6' ? 'selected' : ''}>A6 – 4 pro A4-Blatt</option></select></div>`;
  if (!r.id) h += `<div class="row2"><button data-a="pnew">${printNew ? 'Zeigt: nur noch nicht gedruckte' : 'Zeigt: alle Sets'} (umschalten)</button></div>`;
  h += `<div class="row2"><button class="pri" data-a="print" ${sets.length ? '' : 'disabled'}>${sets.length} ${sets.length === 1 ? 'Etikett' : 'Etiketten'} drucken</button></div>
  <p class="mut">A4, Skalierung 100 %, an den Linien schneiden.</p></div>`;
  if (!sets.length) return h + '<p class="empty">Alle Sets haben schon ein Etikett. Oben auf „alle Sets“ umschalten, um sie erneut zu drucken.</p>';
  for (let i = 0; i < sets.length; i += per) {
    h += `<div class="sheet ${size}">` + sets.slice(i, i + per).map(s => {
      const mc = missing(s).reduce((a, x) => a + x.qty - x.found, 0);
      return `<div class="lbl">${s.img ? `<img src="${esc(s.img)}" alt="">` : '<div class="ph">kein Bild</div>'}
      <div class="lnum">${esc(s.bag || '')}</div><div class="lname">${esc(s.num.replace(/-1$/, ''))} · ${esc(s.name)}</div>
      <div class="lmeta">${s.year ? esc(s.year) + ' · ' : ''}${fmt(tot(s))} Teile${mc ? ` · fehlen: ${fmt(mc)}` : ''}</div>
      <div class="lbag">Beutel ____ von ____</div></div>`;
    }).join('') + '</div>';
  }
  return h;
}

/* ---------- Exporte ---------- */
function shopText() {
  return 'Lego-Einkaufsliste\n' + shopItems().map(x => `${x.n}x ${x.it.part} ${x.it.color}${CN[x.it.color] ? ' ('+CN[x.it.color]+')' : ''} – ${x.it.name} (Set ${x.s.num})`).join('\n');
}
function shopCSV() {
  const m = new Map();
  for (const x of shopItems()) { if (x.it.kind !== 'part') continue; const k = x.it.part + ',' + x.it.colorId; m.set(k, (m.get(k) || 0) + x.n); }
  return 'Part,Color,Quantity\n' + [...m].map(([k, n]) => k + ',' + n).join('\n');
}
async function ensureBLColors() {
  if (S.blColors) return;
  const cs = await apiAll('/colors/?page_size=1000');
  S.blColors = {};
  for (const c of cs) { const e = c.external_ids && c.external_ids.BrickLink; if (e && e.ext_ids && e.ext_ids.length) S.blColors[c.id] = e.ext_ids[0]; }
  save('blColors');
}
async function shopXML() {
  const need = shopItems().some(x => x.it.kind === 'part' && x.it.blColor == null);
  if (need) { try { await ensureBLColors(); } catch (e) { toast('Für BrickLink-Farben kurz online sein'); } }
  const m = new Map(), skipped = [];
  for (const x of shopItems()) {
    if (x.it.kind !== 'part') { skipped.push(x.it.part); continue; }
    const id = (x.it.bl && x.it.bl[0]) || x.it.part, col = x.it.blColor ?? (S.blColors && S.blColors[x.it.colorId]);
    if (col == null) { skipped.push(x.it.part); continue; }
    const k = id + '|' + col; m.set(k, (m.get(k) || 0) + x.n);
  }
  const xml = '<INVENTORY>\n' + [...m].map(([k, n]) => { const [id, c] = k.split('|'); return `<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>${esc(id)}</ITEMID><COLOR>${esc(c)}</COLOR><MINQTY>${n}</MINQTY></ITEM>`; }).join('\n') + '\n</INVENTORY>';
  if (skipped.length) toast(`${skipped.length} Positionen (z. B. Minifiguren) nicht im XML, siehe Textliste`);
  return xml;
}
async function copyOut(txt) {
  try { await navigator.clipboard.writeText(txt); toast('Kopiert'); }
  catch (e) { const o = $('#out'); if (o) { o.innerHTML = '<textarea readonly></textarea>'; const t = o.querySelector('textarea'); t.value = txt; t.select(); } toast('Bitte manuell kopieren'); }
}
async function shareOut(txt, title) {
  if (navigator.share) { try { await navigator.share({ title, text: txt }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  copyOut(txt);
}

/* ---------- Klicks ---------- */
document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, r = route();
  if (a !== 'del') armed = null;
  if (a === 'toggleadd') { addOpen = !addOpen; render(); if (addOpen) { const i = $('#newset'); if (i) i.focus(); } return; }
  if (a === 'pnew') { printNew = !printNew; render(); return; }
  if (a === 'print') {
    const sets = labelsFor(r);
    for (const s of sets) s.printed = true;
    save('sets');
    try { window.print(); } catch (e) { toast('Drucken wird hier nicht unterstützt'); }
    return;
  }
  if (a === 'add') { const v = $('#newset').value.trim(); if (v) addSet(v); return; }
  if (a === 'hide') { hideDone = !hideDone; render(); return; }
  if (a === 'boxgo') { const v = ($('#boxgo').value || '').trim(); if (/^\d+$/.test(v)) location.hash = '#box/' + (+v); else toast('Bitte eine Kästchennummer eingeben'); return; }
  if (a === 'setbag' && r.v === 'set') {
    const s = S.sets[r.id], v = ($('#bagin').value || '').trim().toUpperCase();
    if (!bagNo(v)) { toast('Format: A und Zahl, z. B. A12'); return; }
    if (v === s.bag) return;
    const other = Object.values(S.sets).find(x => x !== s && x.bag === v);
    if (other) { toast(`${v} hat schon ${other.num} ${other.name}`); return; }
    if (!await ask(`<h3>Beutelnummer ändern?</h3><p>${esc(s.num)} ${esc(s.name)}<br>${esc(s.bag || '–')} → <b>${esc(v)}</b></p><p class="mut">Ist das Etikett schon gedruckt, danach neu drucken.</p>`, 'Ändern')) return;
    s.bag = v; s.printed = false; save('sets'); render(); return;
  }
  if (r.v === 'set' || (r.v === 'box' && el.dataset.s)) {
    const s = r.v === 'set' ? S.sets[r.id] : S.sets[el.dataset.s]; if (!s) return;
    if (r.v === 'box' && !['inc', 'dec', 'done'].includes(a)) return;
    if (a === 'bag' || a === 'unbag') { s.bagged = a === 'bag'; save('sets'); render(); return; }
    if (a === 'del') { if (armed !== 'del') { armed = 'del'; render(); return; } delete S.sets[s.num]; armed = null; save('sets'); location.hash = '#sets'; toast('Set gelöscht'); return; }
    const it = s.items[+el.dataset.i]; if (!it) return;
    if (a === 'inc') { if (it.done) return; it.found = Math.min(it.qty, it.found + 1); if (it.found >= it.qty) it.done = true; }
    if (a === 'dec') { it.found = Math.max(0, it.found - 1); it.done = false; }
    if (a === 'done') { it.done = !it.done; if (it.done && it.found < it.qty) toast(`${it.qty - it.found}× auf die Einkaufsliste`); }
    save('sets'); render(); return;
  }
  if (a === 'got') { const s = S.sets[el.dataset.s], it = s && s.items[+el.dataset.i]; if (it) { it.found = it.qty; it.done = true; save('sets'); render(); toast('Als erhalten eingetragen'); } return; }
  if (a === 'share') return shareOut(shopText(), 'Lego-Einkaufsliste');
  if (a === 'cpcsv') return copyOut(shopCSV());
  if (a === 'cpxml') return copyOut(await shopXML());
  if (a === 'savecfg' || a === 'locs' || a === 'ping') {
    S.settings.key = $('#k').value.trim(); S.settings.sheetId = $('#sh').value.trim();
    S.settings.scriptUrl = $('#su').value.trim(); S.settings.token = $('#tk').value.trim(); save('settings');
    if (a === 'ping') {
      const o = $('#pingout'); o.innerHTML = '<p class="mut">Teste …</p>';
      try { const j = await gs({ action: 'ping' }); o.innerHTML = `<div class="okbox">Verbunden mit „${esc(j.spreadsheet)}“ · ${fmt(j.filled)} Kästchen belegt · Skript v${esc(j.version)}</div>`; }
      catch (e) { o.innerHTML = `<div class="errbox"><b>${esc(e.step || 'Fehler')}</b>: ${esc(e.message)}</div>`; }
      return;
    }
    if (a === 'savecfg') { toast('Gespeichert'); return; }
    el.disabled = true; el.textContent = 'Lade …';
    try { const n = await loadLocs(); toast(fmt(n) + ' Teilenummern geladen'); } catch (e) { toast(e.message); }
    render(); return;
  }
  if (a === 'imgs') {
    if (!navigator.onLine) { toast('Geht nur mit Internet'); return; }
    const list = Object.values(S.sets), urls = [...new Set(list.flatMap(s => [s.img, ...s.items.map(i => i.img)]).filter(Boolean))];
    el.disabled = true; let n = 0, fail = 0; const p = $('#imgprog');
    const work = async () => { while (urls.length) { const u = urls.shift(); try { await fetch(u, { mode: 'no-cors' }); } catch (e) { fail++; } n++; if (p && n % 20 === 0) p.textContent = `${fmt(n)} Bilder geladen …`; } };
    const total = urls.length;
    await Promise.all([work(), work(), work(), work(), work(), work()]);
    if (p) p.textContent = `Fertig: ${fmt(total - fail)} von ${fmt(total)} Bildern offline verfügbar${fail ? ` – ${fmt(fail)} fehlgeschlagen, bitte nochmal tippen` : ''}.`;
    el.disabled = false; return;
  }
  if (a === 'export') return shareOut(JSON.stringify({ app: 'lego-lager', v: 1, at: new Date().toISOString(), settings: { sheetId: S.settings.sheetId }, sets: S.sets, scan: S.scan }), 'Lego-Lager Sicherung');
  if (a === 'importshow') { $('#out').innerHTML = '<textarea id="imp" placeholder="Sicherung hier einfügen"></textarea><div class="row2"><button class="pri" data-a="import">Einspielen</button></div>'; return; }
  if (a === 'import') {
    try { const j = JSON.parse($('#imp').value); if (j.app !== 'lego-lager' || !j.sets) throw 0; S.sets = j.sets; assignBags(); save('sets'); toast('Sicherung eingespielt – jetzt noch „Bilder offline laden“'); render(); }
    catch (e) { toast('Das ist keine gültige Sicherung'); }
    return;
  }
});
document.addEventListener('input', ev => {
  if (ev.target.id !== 'q') return;
  query = ev.target.value;
  const pos = ev.target.selectionStart; render();
  const i = $('#q'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) {} }
});
document.addEventListener('change', async ev => {
  if (ev.target.id === 'lsize') { S.settings.label = ev.target.value; save('settings'); render(); return; }
  if (ev.target.id !== 'csvin' || !ev.target.files[0] || busy) return;
  const txt = await ev.target.files[0].text();
  importSets(txt);
});
document.addEventListener('change', ev => { if (ev.target.id === 'autob') { S.settings.autoBackup = ev.target.checked; save('settings'); toast(ev.target.checked ? 'Automatische Sicherung an' : 'Automatische Sicherung aus'); } });
document.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.id === 'boxgo') { ev.preventDefault(); const b = $('[data-a="boxgo"]'); if (b) b.click(); return; } if (ev.key === 'Enter' && ev.target.id === 'newset') { ev.preventDefault(); const v = ev.target.value.trim(); if (v && !busy) addSet(v); } });
addEventListener('hashchange', () => { armed = null; render(); scrollTo(0, 0); });

/* ---------- Online-Status, Start ---------- */
const net = () => { $('#net').hidden = navigator.onLine; };
addEventListener('online', net); addEventListener('offline', net);

(async () => {
  net();
  try {
    for (const k of ['settings', 'locs', 'sets', 'blColors', 'scan', 'meta']) { const v = await idb.get(k); if (v) S[k] = k === 'settings' ? { ...S.settings, ...v } : v; }
  } catch (e) { toast('Gerätespeicher nicht verfügbar'); }
  const bad = Object.values(S.sets || {}).filter(s => !s || !Array.isArray(s.items) || s.items.some(i => !i || typeof i.qty !== 'number' || typeof i.found !== 'number'));
  if (bad.length) { S.damaged = bad.length; } else { const n = assignBags(); if (n) toast(n + ' Sets haben Beutelnummern bekommen'); }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) {
    try { const p = await navigator.storage.persist(); const e = $('#persist'); if (e) e.textContent = p ? 'Speicher dauerhaft' : 'Speicher nicht garantiert'; } catch (e) {}
  }
  if (navigator.onLine && (S.settings.sheetId || S.settings.scriptUrl) && (!S.locs.updated || Date.now() - Date.parse(S.locs.updated) > 6 * 3600e3)) {
    loadLocs().then(() => render()).catch(() => {});
  }
})();
