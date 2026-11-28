'use strict';
/* =========================================================
   Erfassen: Foto im Keller (offline) → Erkennen → Bestätigen → Speichern
   Jeder Schritt wird nur auf Tipp ausgeführt und mit Zeit protokolliert.
   ========================================================= */
const STEPS = [['aufgenommen', 'Aufgenommen'], ['erkannt', 'Erkannt'], ['bestaetigt', 'Bestätigt'], ['gespeichert', 'Gespeichert']];
const STEP_I = Object.fromEntries(STEPS.map((s, i) => [s[0], i]));
const MAXBOX = 699;
let showSaved = false, draft = null, draftBox = '', scanArmed = null, cands = {}, recBusy = null, saveBusy = null;
const phURL = {};
const tm = d => new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const items = () => Object.values(S.scan.items).sort((a, b) => b.created.localeCompare(a.created));
const splitParts = t => String(t || '').split(/[,;\/\s]+/).map(norm).filter(Boolean);

function logIt(it, msg, lvl = '') { it.log.push([new Date().toISOString(), msg, lvl]); save('scan'); }

/* ---------- Prüfungen ---------- */
function boxCheck(box, exceptId) {
  const w = [];
  if (!/^\d+$/.test(box) || +box < 1 || +box > MAXBOX) return { bad: `Bitte eine Kästchennummer von 1 bis ${MAXBOX} eingeben.`, w };
  box = String(+box);
  const cur = S.locs.boxes && S.locs.boxes[box];
  if (!S.locs.updated) w.push('Kästchenliste nie geladen – Belegung unbekannt.');
  else if (!S.locs.boxes) w.push('Kästchenliste bitte einmal neu laden (Einstellungen) – Belegung unbekannt.');
  else if (cur && cur.parts) w.push(`In der Tabelle schon belegt: ${cur.parts}${cur.name ? ' – ' + cur.name : ''}. Speichern würde das überschreiben.`);
  for (const it of Object.values(S.scan.items)) if (it.box === box && it.id !== exceptId && it.status !== 'gespeichert') w.push(`Kästchen ${box} ist schon in der Liste (Foto vom ${tm(it.created)}).`);
  return { box, w, cur };
}
function partCheck(it, parts) {
  const w = [];
  for (const p of splitParts(parts)) {
    const keys = keysFor({ part: p });
    const hit = new Set();
    for (const k of keys) for (const b of (S.locs.map[k] || [])) if (b !== it.box) hit.add(b);
    if (hit.size) w.push(`${p}: liegt laut Tabelle schon in Kästchen ${[...hit].sort(boxSort).join(', ')}.`);
    for (const o of Object.values(S.scan.items)) if (o.id !== it.id && o.box !== it.box && o.status !== 'gespeichert' && splitParts(o.parts).some(q => keys.includes(q))) w.push(`${p}: auch in der Liste bei Kästchen ${o.box}.`);
  }
  return w;
}
const warnHTML = w => w.length ? `<div class="warnbox">${w.map(x => `<div>⚠︎ ${esc(x)}</div>`).join('')}</div>` : '';

/* ---------- Fotos ---------- */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Foto nicht lesbar')); i.src = url; });
    const f = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * f); c.height = Math.round(im.naturalHeight * f);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Foto konnte nicht verkleinert werden');
    return { blob, w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}
async function getPhoto(id) {
  const v = await idb.get('ph:' + id);
  return v ? new Blob([v.buf], { type: v.type || 'image/jpeg' }) : null;
}
async function photoURL(id) {
  if (phURL[id]) return phURL[id];
  const b = await getPhoto(id);
  return b ? (phURL[id] = URL.createObjectURL(b)) : '';
}
function fillPhotos() {
  document.querySelectorAll('img[data-ph]').forEach(async el => {
    const u = await photoURL(el.dataset.ph);
    if (u) el.src = u; else el.replaceWith(Object.assign(document.createElement('div'), { className: 'ph', textContent: 'Foto fehlt' }));
  });
}
async function b64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---------- Google-Skript ---------- */
async function gs(payload) {
  const url = (S.settings.scriptUrl || '').trim(), token = (S.settings.token || '').trim();
  if (!url || !token) throw Object.assign(new Error('Skript-Verbindung fehlt (Einstellungen).'), { step: 'einstellungen' });
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw Object.assign(new Error('Skript-URL sieht falsch aus. Sie muss mit /exec enden.'), { step: 'einstellungen' });
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...payload, token }), redirect: 'follow' }); }
  catch (e) { throw Object.assign(new Error('Keine Antwort vom Skript (offline oder blockiert).'), { step: 'netz', unknown: true }); }
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch (e) { throw Object.assign(new Error(`Antwort des Skripts nicht lesbar (HTTP ${res.status}). Ist die Web-App für „Jeder“ freigegeben?`), { step: 'antwort', unknown: true }); }
  if (!j.ok) throw Object.assign(new Error(j.error || 'Unbekannter Fehler'), { step: j.step || 'skript', data: j });
  return j;
}

/* ---------- Brickognize ---------- */
async function recognize(it) {
  if (!navigator.onLine) { toast('Erkennen geht nur mit Internet'); return; }
  recBusy = it.id; render();
  try {
    const blob = await getPhoto(it.id);
    if (!blob) throw new Error('Foto nicht im Gerätespeicher gefunden');
    const fd = new FormData(); fd.append('query_image', blob, 'k' + it.box + '.jpg');
    let res;
    try { res = await fetch('https://api.brickognize.com/predict/parts/', { method: 'POST', body: fd }); }
    catch (e) { throw new Error('Brickognize nicht erreichbar'); }
    if (!res.ok) throw new Error('Brickognize antwortet mit Fehler ' + res.status);
    const j = await res.json();
    const list = (j.items || []).slice(0, 6).map(x => ({ id: String(x.id), name: String(x.name || ''), score: +x.score || 0, img: safeUrl(x.img_url) }));
    it.cands = list;
    if (STEP_I[it.status] < 1) it.status = 'erkannt';
    it.err = null;
    logIt(it, list.length ? 'Erkannt: ' + list.slice(0, 3).map(c => `${c.id} (${Math.round(c.score * 100)} %)`).join(', ') : 'Erkennen: keine Vorschläge');
  } catch (e) {
    it.err = { step: 'erkennen', msg: e.message, at: new Date().toISOString() };
    logIt(it, 'Fehler beim Erkennen: ' + e.message, 'err');
  }
  recBusy = null; save('scan'); render();
}

/* ---------- Ansichten ---------- */
const chip = it => it.err ? '<span class="chip bad">Fehler</span>' : `<span class="chip${it.status === 'gespeichert' ? ' ok' : ''}">${esc(STEPS[STEP_I[it.status]][1])}</span>`;

function vScan() {
  const all = items(), cnt = {}; for (const it of all) cnt[it.status] = (cnt[it.status] || 0) + 1;
  const nErr = all.filter(i => i.err).length, nSaved = cnt.gespeichert || 0;
  const bc = draftBox ? boxCheck(draftBox) : null;
  let h = '';
  if (draft) {
    const c = boxCheck(draft.box);
    h += `<img class="big" src="${esc(draft.url)}" alt="Foto für Kästchen ${esc(draft.box)}"><div class="bignr">Kästchen ${esc(draft.box)}</div>
      ${warnHTML(c.w)}<div class="actionbar"><button data-a="s-drop">Verwerfen</button><button class="pri" data-a="s-keep">${c.w.length ? 'Trotzdem übernehmen' : 'Übernehmen'}</button></div>`;
    return h;
  }
  h += `<div class="capture"><input id="sbox" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="${esc(draftBox)}" placeholder="Nr." aria-label="Kästchennummer">
      <label class="btn pri" for="cam" style="margin:0">Foto aufnehmen</label><input type="file" id="cam" accept="image/*" capture="environment" hidden></div>
      <div id="sboxinfo">${boxInfo(bc)}</div>`;
  if (all.length) h += `<div class="stat">${STEPS.map(([k, l]) => cnt[k] ? `<span><b>${cnt[k]}</b> ${l.toLowerCase()}</span>` : '').join('')}${nErr ? `<span class="miss"><b>${nErr}</b> mit Fehler</span>` : ''}</div>`;
  else h += '<p class="empty">Nummer eintippen, dann ein Teil aus dem Kästchen fotografieren. Erkennen und Speichern geht später mit Internet.</p>';
  const list = showSaved ? all : all.filter(i => i.status !== 'gespeichert');
  if (all.length && !list.length) h += '<p class="empty">Alles gespeichert.</p>';
  for (const it of list) {
    h += `<a class="card" href="#scan/${esc(it.id)}"><img class="thumb" data-ph="${esc(it.id)}" alt=""><div><div class="l1"><b style="flex:none">Kästchen ${esc(it.box)}</b> ${chip(it)}</div>
      <div class="nm ${it.err ? 'miss' : 'mut'}">${it.err ? esc(it.err.msg) : it.parts ? esc(it.parts) + (it.name ? ' · ' + esc(it.name) : '') : 'noch keine Teilenummer'}</div></div></a>`;
  }
  if (all.length) h += `<div class="row2" style="margin-top:16px">${nSaved ? `<button data-a="s-showsaved">${showSaved ? 'Gespeicherte ausblenden' : `${nSaved} gespeicherte zeigen`}</button>` : ''}<button data-a="s-log">Protokoll teilen</button></div>${nSaved && showSaved ? '<div class="row2"><button data-a="s-clean">Gespeicherte vom iPhone entfernen</button></div>' : ''}`;
  return h;
}
function boxInfo(c) {
  if (!c) return '';
  if (c.bad) return `<p class="miss" style="font-size:14px">${esc(c.bad)}</p>`;
  return warnHTML(c.w) || `<p class="mut" style="font-size:14px;margin:6px 0">Kästchen ${esc(c.box)} ist frei.</p>`;
}

function vScanItem(it) {
  const st = STEP_I[it.status], saved = it.status === 'gespeichert';
  let h = `<img class="big" data-ph="${esc(it.id)}" alt="Foto Kästchen ${esc(it.box)}">
    <div class="steps" aria-hidden="true">${STEPS.map((x, i) => `<i class="${i <= st ? 'on' : ''}"></i>`).join('')}</div>
    <div class="stepl">Schritt ${st + 1} von 4: ${esc(STEPS[st][1])}${it.err ? ' · <span class="miss">Fehler</span>' : ''}</div>`;
  if (it.err) h += `<div class="errbox"><b>${esc(it.err.msg)}</b>${it.err.hint ? `<br>${esc(it.err.hint)}` : ''}</div>`;
  let bar = '';
  if (saved) {
    const s = it.saved || {};
    h += `<div class="okbox">Gespeichert in Zeile ${esc(s.row)} · ${esc(tm(s.at))}${s.already ? ' (war schon so eingetragen)' : ''}</div>
      <div class="bignr">${esc(it.parts)}</div><div>${esc(it.name)}</div>${it.note ? `<div class="mut">${esc(it.note)}</div>` : ''}
      ${s.photo && safeUrl(s.photo.url) ? `<p><a href="${esc(safeUrl(s.photo.url))}" target="_blank" rel="noopener">Foto in Google Drive</a></p>` : ''}`;
  } else if (it.status === 'bestaetigt') {
    const c = boxCheck(it.box, it.id);
    h += `<div class="bignr">${esc(it.parts)}</div><div>${esc(it.name) || '<span class="mut">ohne Bezeichnung</span>'}</div>${it.note ? `<div class="mut">Notiz: ${esc(it.note)}</div>` : ''}
      <p class="mut" style="font-size:14px">Vorher in der Tabelle: ${c.cur && c.cur.parts ? esc(c.cur.parts) : 'leer'}</p>${warnHTML([...c.w, ...partCheck(it, it.parts)])}`;
    if (it.err && it.err.step === 'konflikt' && it.err.current) h += `<button class="warn wide" data-a="s-force">Aktuellen Inhalt „${esc(it.err.current.parts)}“ überschreiben</button>`;
    bar = `<button data-a="s-edit">Ändern</button><button class="pri" data-a="s-save" ${saveBusy ? 'disabled' : ''}>${saveBusy === it.id ? 'Speichere …' : 'In Tabelle speichern'}</button>`;
  } else {
    h += `<button class="wide" data-a="s-rec" ${recBusy ? 'disabled' : ''}>${recBusy === it.id ? 'Erkenne …' : (it.cands ? 'Nochmal erkennen' : 'Erkennen')}</button>`;
    if (it.cands) h += it.cands.length ? '<div class="cands">' + it.cands.map((c, i) => `<button class="cand${splitParts(it.parts)[0] === norm(c.id) ? ' sel' : ''}" data-a="s-pick" data-i="${i}" aria-label="${esc(c.id)} ${esc(c.name)} übernehmen">${img(c.img)}<span><b>${esc(c.id)}</b> <span class="mut">${Math.round(c.score * 100)} %</span></span><span class="nm">${esc(c.name)}</span></button>`).join('') + '</div>'
      : '<p class="mut">Keine Vorschläge – Nummer bitte selbst eintragen.</p>';
    h += `<label for="dparts">Teilenummer</label><input id="dparts" value="${esc(it.parts)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="mehrere mit Komma">
      <label for="dname">Bezeichnung</label><input id="dname" value="${esc(it.name)}" autocomplete="off">
      <label for="dnote">Notiz</label><input id="dnote" value="${esc(it.note)}" autocomplete="off">
      <label class="chk"><input type="checkbox" id="dunsure" ${it.unsure ? 'checked' : ''}> Unsicher – „bitte prüfen“ vermerken</label>
      <div id="dwarn">${warnHTML(partCheck(it, it.parts))}</div>
      <details><summary>Kästchennummer ändern</summary><div class="row2"><input id="dbox" inputmode="numeric" pattern="[0-9]*" value="${esc(it.box)}" aria-label="Kästchennummer"><button data-a="s-renum">Übernehmen</button></div></details>`;
    bar = `<button class="pri" data-a="s-confirm">Bestätigen</button>`;
  }
  h += `<details ${it.err ? 'open' : ''}><summary>Protokoll (${it.log.length})</summary><div class="log">${it.log.map(([t, m, l]) => `<div class="${l === 'err' ? 'miss' : ''}"><span class="mut">${esc(tm(t))}</span> ${esc(m)}</div>`).join('')}</div>
    <p class="mut" style="font-size:13px">Vorgang ${esc(it.id)}</p>
    <div class="row2"><button class="${scanArmed === it.id ? 'warn' : ''}" data-a="s-del">${scanArmed === it.id ? 'Wirklich löschen?' : 'Eintrag löschen'}</button></div></details>`;
  if (bar) h += `<div class="actionbar">${bar}</div>`;
  return h;
}

/* ---------- Bestätigungsdialog ---------- */
function ask(html, ok, cls = 'pri') {
  return new Promise(res => {
    const d = document.createElement('div'); d.className = 'modal';
    d.innerHTML = `<div class="mbox">${html}<div class="row2"><button class="${cls}" data-m="1">${esc(ok)}</button><button data-m="0">Abbrechen</button></div></div>`;
    d.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; e.stopPropagation(); d.remove(); res(b.dataset.m === '1'); });
    document.body.appendChild(d);
  });
}

/* ---------- Speichern ---------- */
async function saveItem(it, force) {
  if (!navigator.onLine) { toast('Speichern geht nur mit Internet'); return; }
  const c = boxCheck(it.box, it.id);
  const expect = force ? it.err.current.parts : (it.expect ?? (c.cur ? c.cur.parts : ''));
  const issues = [...c.w, ...partCheck(it, it.parts)];
  let ok = true;
  if (force || issues.length || expect) ok = await ask(`<h3>${force ? 'Überschreiben?' : 'Trotzdem speichern?'}</h3><p><b>Kästchen ${esc(it.box)}</b><br>Vorher: ${expect ? esc(expect) : 'leer'}<br>Nachher: <b>${esc(it.parts)}</b>${it.name ? ' – ' + esc(it.name) : ''}</p>${warnHTML(issues)}`, force ? 'Überschreiben' : 'Speichern', force || expect ? 'warn' : 'pri');
  if (!ok) { logIt(it, 'Speichern abgebrochen'); return; }
  saveBusy = it.id; render();
  logIt(it, `Speichern gestartet (erwartet vorher: ${expect || 'leer'})`);
  try {
    const blob = await getPhoto(it.id);
    const r = await gs({ action: 'write', client: 'app:' + it.id, box: it.box, parts: it.parts, name: it.name, note: it.note, expect, photo: blob ? await b64(blob) : '' });
    if (r.written.parts !== it.parts || r.written.box !== it.box) throw Object.assign(new Error('Gegenprüfung: Tabelle enthält etwas anderes als gesendet'), { step: 'gegenpruefung' });
    it.status = 'gespeichert'; it.err = null; it.expect = undefined;
    it.saved = { row: r.row, at: new Date().toISOString(), already: !!r.already, photo: r.photo, previous: r.previous };
    logIt(it, `Gespeichert in Zeile ${r.row}${r.already ? ' (war schon so eingetragen)' : ''}; gegengeprüft: ${r.written.parts}${r.photo ? '; Foto ' + (r.photo.kept ? 'war schon vorhanden' : 'abgelegt') : ''}`);
    // lokale Kästchenliste nachziehen
    S.locs.boxes = S.locs.boxes || {};
    S.locs.boxes[it.box] = { parts: it.parts, name: it.name, note: it.note };
    for (const p of splitParts(it.parts)) { (S.locs.map[p] ??= []); if (!S.locs.map[p].includes(it.box)) { S.locs.map[p].push(it.box); S.locs.map[p].sort(boxSort); } }
    if (it.name) S.locs.labels[it.box] = it.name;
    save('locs');
    toast(`Kästchen ${it.box} gespeichert`);
  } catch (e) {
    const hint = e.unknown ? 'Unklar, ob gespeichert wurde. Nochmal speichern ist sicher – doppelte Einträge erkennt das Skript.' : e.step === 'konflikt' ? 'Jemand hat das Kästchen inzwischen geändert. Prüfen und ggf. bewusst überschreiben.' : '';
    it.err = { step: e.step || 'speichern', msg: e.message, at: new Date().toISOString(), hint, current: e.data && e.data.current };
    logIt(it, `Fehler beim Speichern (${it.err.step}): ${e.message}${it.err.current ? ' – aktuell in Tabelle: ' + (it.err.current.parts || 'leer') : ''}`, 'err');
  }
  saveBusy = null; save('scan'); render();
}

/* ---------- Ereignisse ---------- */
document.addEventListener('click', async ev => {
  if (ev.target.closest('label[for="cam"]')) { const c = boxCheck(draftBox); if (c.bad) { ev.preventDefault(); toast(c.bad); const i = $('#sbox'); if (i) i.focus(); } return; }
  const el = ev.target.closest('[data-a^="s-"]'); if (!el) return;
  const a = el.dataset.a, r = route();
  if (a !== 's-del') scanArmed = null;
  if (a === 's-drop') { URL.revokeObjectURL(draft.url); draft = null; render(); return; }
  if (a === 's-keep') {
    if (!draft) return;
    const d = draft, id = uid(); el.disabled = true;
    try { await idb.set('ph:' + id, { type: 'image/jpeg', buf: await d.blob.arrayBuffer() }); }
    catch (e) { toast('Foto konnte nicht gespeichert werden – Speicher voll?'); return; }
    const c = boxCheck(d.box);
    const it = { id, box: d.box, created: new Date().toISOString(), status: 'aufgenommen', parts: '', name: '', note: '', unsure: false, cands: null, log: [], err: null, expect: c.cur ? c.cur.parts : '' };
    S.scan.items[id] = it;
    logIt(it, `Foto aufgenommen (${Math.round(d.blob.size / 1024)} KB, ${d.w}×${d.h}) für Kästchen ${d.box}; Tabelle laut Stand ${S.locs.updated ? tm(S.locs.updated) : 'unbekannt'}: ${c.cur && c.cur.parts ? c.cur.parts : 'leer'}`);
    for (const w of c.w) logIt(it, 'Hinweis bestätigt: ' + w);
    phURL[id] = d.url; S.scan.last = +d.box; draftBox = String(+d.box + 1); draft = null;
    save('scan'); render(); toast(`Kästchen ${it.box} übernommen`);
    return;
  }
  if (a === 's-showsaved') { showSaved = !showSaved; render(); return; }
  if (a === 's-log') {
    const t = items().map(it => `Kästchen ${it.box} · ${STEPS[STEP_I[it.status]][1]}${it.err ? ' · FEHLER' : ''} · ${it.id}\n` + it.log.map(([t, m]) => `  ${tm(t)}  ${m}`).join('\n')).join('\n\n');
    return shareOut(t, 'Lego-Lager Protokoll');
  }
  if (a === 's-clean') {
    const done = items().filter(i => i.status === 'gespeichert');
    if (!await ask(`<h3>${done.length} gespeicherte Einträge entfernen?</h3><p class="mut">Sie stehen in der Tabelle, das Foto liegt in Google Drive. Entfernt wird nur die Kopie auf diesem iPhone.</p>`, 'Entfernen')) return;
    for (const it of done) { try { await idb.del('ph:' + it.id); } catch (e) {} delete S.scan.items[it.id]; }
    save('scan'); render(); toast('Entfernt'); return;
  }
  if (r.v !== 'scanitem') return;
  const it = S.scan.items[r.id]; if (!it) return;
  if (a === 's-del') {
    if (scanArmed !== it.id) { scanArmed = it.id; render(); return; }
    try { await idb.del('ph:' + it.id); } catch (e) {}
    delete S.scan.items[it.id]; scanArmed = null; save('scan'); location.hash = '#scan'; toast('Eintrag gelöscht'); return;
  }
  if (a === 's-rec') return recognize(it);
  if (a === 's-pick') { const c = it.cands[+el.dataset.i]; if (!c) return; it.parts = c.id; it.name = c.name; logIt(it, `Vorschlag ausgewählt: ${c.id} (${Math.round(c.score * 100)} %)`); render(); return; }
  if (a === 's-renum') {
    const c = boxCheck($('#dbox').value.trim(), it.id);
    if (c.bad) { toast(c.bad); return; }
    if (c.box === it.box) return;
    if (!await ask(`<h3>Nummer ändern?</h3><p>Kästchen ${esc(it.box)} → <b>${esc(c.box)}</b></p>${warnHTML(c.w)}`, 'Ändern')) return;
    logIt(it, `Kästchennummer geändert: ${it.box} → ${c.box}`); it.box = c.box; it.expect = c.cur ? c.cur.parts : '';
    save('scan'); render(); return;
  }
  if (a === 's-confirm') {
    const parts = splitParts($('#dparts').value).join(', ');
    if (!parts) { toast('Bitte eine Teilenummer eintragen'); return; }
    it.parts = parts; it.name = $('#dname').value.trim(); it.unsure = $('#dunsure').checked;
    let note = $('#dnote').value.trim();
    if (it.unsure && !/bitte prüfen/i.test(note)) note = note ? note + ' – bitte prüfen' : 'bitte prüfen';
    it.note = note;
    const w = partCheck(it, parts);
    if (w.length && !await ask(`<h3>Trotzdem bestätigen?</h3>${warnHTML(w)}<p class="mut">Gleiches Teil in zwei Kästchen ist ok, wenn sie sich wirklich unterscheiden (Farbe, Variante). Sonst lieber zusammenlegen.</p>`, 'Bestätigen')) return;
    it.status = 'bestaetigt'; it.err = null; it.confirmed = { at: new Date().toISOString() };
    logIt(it, `Bestätigt: ${it.parts}${it.name ? ' – ' + it.name : ''}${it.note ? ' (Notiz: ' + it.note + ')' : ''}`);
    for (const x of w) logIt(it, 'Hinweis bestätigt: ' + x);
    save('scan'); render(); return;
  }
  if (a === 's-edit') { it.status = it.cands ? 'erkannt' : 'aufgenommen'; it.confirmed = null; if (it.err && it.err.step === 'konflikt') it.err = null; logIt(it, 'Bestätigung aufgehoben zum Ändern'); save('scan'); render(); return; }
  if (a === 's-save') return saveItem(it, false);
  if (a === 's-force') return saveItem(it, true);
});

document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.id === 'sbox') {
    draftBox = t.value.trim();
    const c = draftBox ? boxCheck(draftBox) : null, i = $('#sboxinfo');
    if (i) i.innerHTML = boxInfo(c);
  }
  if (['dparts', 'dname', 'dnote'].includes(t.id)) {
    const r = route(), it = S.scan.items[r.id];
    if (!it || it.status === 'bestaetigt' || it.status === 'gespeichert') return;
    it[{ dparts: 'parts', dname: 'name', dnote: 'note' }[t.id]] = t.value; save('scan');
    const w = $('#dwarn'); if (t.id === 'dparts' && w) w.innerHTML = warnHTML(partCheck(it, t.value));
  }
});

document.addEventListener('change', async ev => {
  if (ev.target.id === 'dunsure') { const it = S.scan.items[route().id]; if (it) { it.unsure = ev.target.checked; save('scan'); } return; }
  if (ev.target.id !== 'cam') return;
  const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  const c = boxCheck(draftBox);
  if (c.bad) { toast(c.bad); return; }
  try { const s = await shrink(f); draft = { box: c.box, ...s, url: URL.createObjectURL(s.blob) }; }
  catch (e) { toast(e.message); return; }
  render(); scrollTo(0, 0);
});
