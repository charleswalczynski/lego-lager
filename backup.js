'use strict';
/* =========================================================
   Kästchen-Ansicht und Sicherung nach Google Drive
   ========================================================= */

/* ---------- Kästchen ---------- */
let lastFrom = '';
addEventListener('hashchange', e => { try { lastFrom = new URL(e.oldURL).hash; } catch (x) { lastFrom = ''; } });

function boxNeeds() {
  const need = {};
  for (const s of Object.values(S.sets)) {
    if (s.bagged) continue;
    for (const it of s.items) {
      if (it.done || it.found >= it.qty) continue;
      for (const b of locate(it).boxes) { const n = (need[b] ??= { n: 0, sets: new Set() }); n.n += it.qty - it.found; n.sets.add(s.num); }
    }
  }
  return need;
}

function vBoxes() {
  const need = boxNeeds(), top = Object.entries(need).sort((a, b) => b[1].n - a[1].n).slice(0, 40);
  const rec = (S.meta.recent || []).slice(0, 8);
  let h = `<div class="row2"><input id="boxgo" inputmode="numeric" pattern="[0-9]*" placeholder="Kästchen-Nr." autocomplete="off" aria-label="Kästchennummer" style="font-size:22px;font-weight:700;text-align:center"><button class="pri" data-a="boxgo" style="flex:0 0 110px">Öffnen</button></div>`;
  if (rec.length) h += `<h3 class="sec">Zuletzt geöffnet</h3><div class="recent">${rec.map(b => `<a class="nr" href="#box/${esc(b)}">${esc(b)}</a>`).join('')}</div>`;
  h += '<h3 class="sec">Am meisten gesucht</h3>';
  if (!top.length) return h + '<p class="empty">Gerade braucht kein offenes Set etwas aus einem Kästchen.</p>';
  return h + top.map(([b, x]) => `<a class="brow" href="#box/${esc(b)}"><span class="nr">${esc(b)}</span><span class="nm">${esc(S.locs.labels[b] || (S.locs.boxes && S.locs.boxes[b] && S.locs.boxes[b].parts) || '')}</span><span class="cnt">${fmt(x.n)} Teile<small>${fmt(x.sets.size)} ${x.sets.size === 1 ? 'Set' : 'Sets'}</small></span></a>`).join('');
}

function vBox(box) {
  box = String(+box || box);
  const rc = (S.meta.recent || []).filter(b => b !== box); rc.unshift(box); S.meta.recent = rc.slice(0, 8); save('meta');
  const info = (S.locs.boxes || {})[box];
  const rows = [];
  for (const s of Object.values(S.sets)) {
    if (s.bagged) continue;
    s.items.forEach((it, i) => { const L = locate(it); if (L.boxes.includes(box)) rows.push({ s, it, i, L }); });
  }
  const open = rows.filter(x => !x.it.done), need = open.reduce((a, x) => a + Math.max(0, x.it.qty - x.it.found), 0);
  const nDone = rows.length - open.length;
  const parts = new Set(rows.map(x => x.it.part));
  const pic = rows.find(x => x.it.img);
  const shown = rows.filter(x => !hideDone || !x.it.done)
    .sort((a, b) => a.it.color.localeCompare(b.it.color) || a.it.part.localeCompare(b.it.part) || bagNo(a.s.bag) - bagNo(b.s.bag));
  let h = `<div class="seth">${pic ? img(pic.it.img) : ''}<div><h2>${esc(info && info.name || S.locs.labels[box] || 'Kästchen ' + box)}</h2><div class="mut" style="font-size:13px">${info && info.parts ? esc(info.parts) : 'nicht in der Tabelle belegt'}</div></div></div>
    <div class="seg"><span><b>${fmt(need)} Teile</b> <span class="mut">für ${fmt(new Set(open.map(x => x.s.num)).size)} Sets</span></span>${nDone ? `<button class="link" data-a="hide">${hideDone ? `${nDone} erledigte zeigen` : 'Erledigte ausblenden'}</button>` : ''}</div>`;
  if (!shown.length) return h + `<p class="empty">${rows.length ? 'Aus diesem Kästchen ist alles verteilt.' : 'Kein offenes Set braucht etwas aus diesem Kästchen.'}</p>`;
  let lastColor = null;
  for (const { s, it, i, L } of shown) {
    if (it.color !== lastColor) { lastColor = it.color; h += `<div class="gh"><span class="sw big" style="background:#${esc(it.rgb)}"></span><b>${cnLong(it.color)}</b></div>`; }
    const extra = [];
    if (parts.size > 1) extra.push(esc(it.part));
    if (L.boxes.length > 1) extra.push('auch ' + L.boxes.filter(b => b !== box).map(esc).join(', '));
    if (L.fuzzy) extra.push('Variante prüfen');
    h += `<div class="it ${it.done ? 'done' : ''}"><div class="tap" data-a="inc" data-s="${esc(s.num)}" data-i="${i}"><span class="bagbig">${esc(s.bag || '–')}</span><div><div class="q">${it.found}<small> / ${it.qty}</small></div><div class="nm mut">${esc(s.name)}${extra.length ? ' · ' + extra.join(' · ') : ''}</div></div></div>
      <div class="side"><button data-a="dec" data-s="${esc(s.num)}" data-i="${i}" aria-label="ein Stück weniger">−1</button><button class="fz" data-a="done" data-s="${esc(s.num)}" data-i="${i}" aria-label="${it.done ? 'Wieder öffnen' : 'Als fertig markieren'}">${it.done ? '↺' : '✓'}</button></div></div>`;
  }
  return h;
}

/* ---------- Sicherung ---------- */
async function sha256(str) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const summary = sets => { const v = Object.values(sets || {}); return { sets: v.length, found: v.reduce((a, s) => a + fnd(s), 0), total: v.reduce((a, s) => a + tot(s), 0), bagged: v.filter(s => s.bagged).length }; };
const sumTxt = x => `${fmt(x.sets)} Sets · ${fmt(x.found)} von ${fmt(x.total)} Teilen gefunden · ${fmt(x.bagged)} eingebeutelt`;

const autoOn = () => S.settings.autoBackup !== false && !!(S.settings.scriptUrl && S.settings.token);
function backupBar() {
  const m = S.meta || {}, lb = m.lastBackup;
  if (S.damaged) return `<div class="errbox"><b>${S.damaged} Sets im Gerätespeicher sind beschädigt.</b> Nichts abhaken und unter <a href="#settings">Mehr</a> eine Sicherung wiederherstellen.</div>`;
  if (!Object.keys(S.sets).length || (!m.changes && lb)) return '';
  const failed = m.lastAuto && !m.lastAuto.ok && autoOn();
  if (autoOn() && !failed && lb && Date.now() - Date.parse(lb.at) < 24 * 3600e3) return '';
  return `<div class="warnbox" style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:4px 4px 4px 12px"><span>${failed ? 'Automatische Sicherung fehlgeschlagen' : m.changes ? `<b>${fmt(m.changes)}</b> Änderungen nicht gesichert` : 'Noch nie gesichert'}</span><button class="pri" data-a="b-save" style="flex:0 0 auto;min-height:36px">Sichern</button></div>`;
}

/* Automatische Sicherung: sobald online, Änderungen da sind und 2 Min. Ruhe war – höchstens alle 20 Min. */
let autoBusy = false;
async function autoBackup() {
  const m = S.meta;
  if (autoBusy || !autoOn() || !navigator.onLine || !m || !m.changes || S.damaged || document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (m.lastBackup && now - Date.parse(m.lastBackup.at) < 20 * 60e3) return;
  if (m.changedAt && now - Date.parse(m.changedAt) < 2 * 60e3) return;
  autoBusy = true;
  try { await doBackup('auto', true); m.lastAuto = { at: new Date().toISOString(), ok: true }; }
  catch (e) { m.lastAuto = { at: new Date().toISOString(), ok: false, err: (e.step ? e.step + ': ' : '') + e.message }; }
  save('meta'); autoBusy = false;
  const r = route(), ae = document.activeElement;
  if ((r.v === 'sets' || r.v === 'settings') && !(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName))) render();
}
setInterval(autoBackup, 60e3);
addEventListener('online', () => setTimeout(autoBackup, 3000));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(autoBackup, 3000); });
setTimeout(autoBackup, 8000);

async function doBackup(label, silent) {
  const data = JSON.stringify({ app: 'lego-lager', v: 2, at: new Date().toISOString(), version: VERSION, settings: { sheetId: S.settings.sheetId, label: S.settings.label }, sets: S.sets });
  const sha = await sha256(data), sm = summary(S.sets), changes = S.meta.changes || 0;
  const r = await gs({ action: 'backup', client: 'app', data, sha, label });
  if (r.sha !== sha) throw Object.assign(new Error('Gegenprüfung der Sicherung fehlgeschlagen'), { step: 'gegenpruefung' });
  // nur die Änderungen bis zum Start der Sicherung gelten als gesichert
  S.meta.changes = Math.max(0, (S.meta.changes || 0) - changes);
  S.meta.lastBackup = { at: new Date().toISOString(), name: r.name, url: r.url, size: r.size, sha, ...sm };
  save('meta');
  if (!silent) toast('Gesichert');
  return r;
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-a^="b-"]'); if (!el) return;
  const a = el.dataset.a;
  if (a === 'b-save') {
    if (!navigator.onLine) { toast('Sichern geht nur mit Internet'); return; }
    const sm = summary(S.sets);
    if (!await ask(`<h3>Fortschritt sichern?</h3><p>${sumTxt(sm)}</p><p class="mut">Wird als neue Datei im Drive-Ordner „Lego-Lager Sicherungen“ abgelegt. Ältere Sicherungen bleiben erhalten.</p>`, 'Jetzt sichern')) return;
    el.disabled = true; el.textContent = 'Sichere …';
    try { await doBackup(); }
    catch (e) { await ask(`<h3>Sicherung fehlgeschlagen</h3><div class="errbox"><b>${esc(e.step || 'Fehler')}</b>: ${esc(e.message)}</div><p class="mut">${/Aktion/.test(e.message) ? 'Das Skript in der Tabelle ist noch die alte Version – bitte aktualisieren.' : 'Dein Stand auf dem iPhone ist unverändert.'}</p>`, 'OK'); }
    render(); return;
  }
  if (a === 'b-list') {
    const o = $('#bout'); o.innerHTML = '<p class="mut">Lade Liste …</p>';
    try {
      const r = await gs({ action: 'backups' });
      o.innerHTML = r.list.length ? r.list.map(f => `<button class="cand" style="grid-template-columns:1fr" data-a="b-pick" data-id="${esc(f.id)}"><span><b>${esc(tm(f.date))}</b><br><span class="mut">${esc(f.name)} · ${fmt(Math.round(f.size / 1024))} KB</span></span></button>`).join('') : '<p class="mut">Noch keine Sicherungen in Drive.</p>';
    } catch (e) { o.innerHTML = `<div class="errbox"><b>${esc(e.step || 'Fehler')}</b>: ${esc(e.message)}</div>`; }
    return;
  }
  if (a === 'b-pick') {
    const o = $('#bout');
    let j, r;
    try {
      r = await gs({ action: 'restore', id: el.dataset.id });
      if (r.sha !== await sha256(r.data)) throw Object.assign(new Error('Prüfsumme stimmt nicht – Sicherung unvollständig übertragen'), { step: 'pruefen' });
      j = JSON.parse(r.data);
      if (j.app !== 'lego-lager' || !j.sets || typeof j.sets !== 'object') throw Object.assign(new Error('Datei ist keine Lego-Lager-Sicherung'), { step: 'pruefen' });
      const bad = Object.values(j.sets).filter(s => !s || !Array.isArray(s.items));
      if (bad.length) throw Object.assign(new Error(bad.length + ' Sets in der Sicherung sind unvollständig'), { step: 'pruefen' });
    } catch (e) { o.innerHTML = `<div class="errbox"><b>${esc(e.step || 'Fehler')}</b>: ${esc(e.message)}</div>`; return; }
    const now = summary(S.sets), then = summary(j.sets), fewer = then.found < now.found;
    if (!await ask(`<h3>Sicherung wiederherstellen?</h3><p><b>Sicherung</b> (${esc(tm(j.at))}):<br>${sumTxt(then)}</p><p><b>Jetzt auf dem iPhone:</b><br>${sumTxt(now)}</p>
      ${fewer ? '<div class="warnbox">⚠︎ Die Sicherung enthält weniger gefundene Teile als der aktuelle Stand.</div>' : ''}
      <p class="mut">Vorher wird der aktuelle Stand als eigene Sicherung in Drive abgelegt („vor-Wiederherstellung“).</p>`, 'Wiederherstellen', 'warn')) return;
    o.innerHTML = '<p class="mut">Sichere aktuellen Stand …</p>';
    try { if (Object.keys(S.sets).length) await doBackup('vor-Wiederherstellung', true); }
    catch (e) { o.innerHTML = `<div class="errbox">Aktueller Stand konnte nicht gesichert werden (${esc(e.message)}). Wiederherstellung abgebrochen – nichts geändert.</div>`; return; }
    S.sets = j.sets; S.damaged = 0; assignBags(); save('sets');
    S.meta.changes = 0; S.meta.lastBackup = { at: j.at, name: r.name, restored: new Date().toISOString(), ...then }; save('meta');
    toast('Wiederhergestellt – jetzt noch „Bilder offline laden“'); render();
  }
});
