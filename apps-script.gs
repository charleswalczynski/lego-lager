/**
 * Lego-Lager – Schreibzugriff für die App
 * Einfügen in: Google-Tabelle → Erweiterungen → Apps Script
 * Bereitstellen als Web-App: Ausführen als „Ich“, Zugriff „Jeder“.
 *
 * Jede Schreibaktion wird im Blatt „Protokoll“ festgehalten (vorher/nachher),
 * damit sich jeder Fehler nachvollziehen und rückgängig machen lässt.
 */
const TOKEN = '__TOKEN__';
const SHEET = 'Kästchen';
const LOG_SHEET = 'Protokoll';
const PHOTO_FOLDER = 'Lego-Lager Fotos';
const BACKUP_FOLDER = 'Lego-Lager Sicherungen';
const SCRIPT_VERSION = 3;

function doGet(e) { return handle_(e && e.parameter ? e.parameter : {}); }
function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); }
  catch (err) { return out_({ ok: false, step: 'anfrage', error: 'Anfrage nicht lesbar (kein JSON).' }); }
  return handle_(p);
}

function handle_(p) {
  if (!p || p.token !== TOKEN) return out_({ ok: false, step: 'schluessel', error: 'Falscher oder fehlender Schlüssel.' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return out_({ ok: false, step: 'sperre', error: 'Tabelle ist gerade belegt. Bitte gleich nochmal.' });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET);
    if (!sh) return out_({ ok: false, step: 'blatt', error: 'Blatt „' + SHEET + '“ nicht gefunden.' });
    const data = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 4).getDisplayValues();

    if (p.action === 'ping') {
      const filled = data.slice(1).filter(r => /^\d+$/.test(r[0].trim()) && r[1].trim()).length;
      return out_({ ok: true, version: SCRIPT_VERSION, spreadsheet: ss.getName(), filled: filled });
    }
    if (p.action === 'read') {
      return out_({ ok: true, version: SCRIPT_VERSION, rows: data.slice(1) });
    }
    if (p.action === 'write') return write_(ss, sh, data, p);
    if (p.action === 'backup') return backup_(ss, p);
    if (p.action === 'backups') return listBackups_();
    if (p.action === 'restore') return restore_(p);
    return out_({ ok: false, step: 'anfrage', error: 'Unbekannte Aktion: ' + p.action });
  } catch (err) {
    return out_({ ok: false, step: 'skript', error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function write_(ss, sh, data, p) {
  const box = String(p.box || '').trim();
  if (!/^\d+$/.test(box)) return out_({ ok: false, step: 'pruefen', error: 'Ungültige Kästchennummer: „' + box + '“' });
  const want = { parts: String(p.parts || '').trim(), name: String(p.name || '').trim(), note: String(p.note || '').trim() };
  if (!want.parts) return out_({ ok: false, step: 'pruefen', error: 'Keine Teilenummer angegeben.' });

  let idx = -1;
  for (let i = 1; i < data.length; i++) if (data[i][0].trim() === box) { if (idx >= 0) return out_({ ok: false, step: 'pruefen', error: 'Kästchen ' + box + ' steht mehrfach in Spalte A (Zeilen ' + (idx + 1) + ' und ' + (i + 1) + ').' }); idx = i; }
  if (idx < 0) return out_({ ok: false, step: 'pruefen', error: 'Kästchen ' + box + ' nicht in Spalte A gefunden.' });
  const row = idx + 1;
  const cur = { parts: data[idx][1].trim(), name: data[idx][2].trim(), note: data[idx][3].trim() };

  // Schon genau so gespeichert (z. B. Antwort ging verloren) → nichts doppelt schreiben
  const same = cur.parts === want.parts && cur.name === want.name && cur.note === want.note;
  if (!same && String(p.expect == null ? '' : p.expect).trim() !== cur.parts) {
    return out_({ ok: false, step: 'konflikt', error: 'Kästchen ' + box + ' hat inzwischen einen anderen Inhalt.', row: row, current: cur });
  }

  let photo = null;
  if (p.photo) {
    try { photo = savePhoto_(box, p.photo, same); }
    catch (err) { return out_({ ok: false, step: 'foto', error: 'Foto konnte nicht gespeichert werden: ' + (err.message || err) + ' (Tabelle wurde NICHT geändert)', row: row }); }
  }

  if (!same) {
    const rg = sh.getRange(row, 2, 1, 3);
    rg.setNumberFormat('@');
    rg.setValues([[want.parts, want.name, want.note]]);
    SpreadsheetApp.flush();
  }
  const back = sh.getRange(row, 1, 1, 4).getDisplayValues()[0];
  const written = { box: back[0].trim(), parts: back[1].trim(), name: back[2].trim(), note: back[3].trim() };
  const verified = written.box === box && written.parts === want.parts && written.name === want.name && written.note === want.note;

  log_(ss, [new Date(), p.client || '', box, row, cur.parts, cur.name, cur.note, written.parts, written.name, written.note,
            same ? 'war schon gespeichert' : (verified ? 'ok' : 'ABWEICHUNG'), photo ? photo.url : '']);

  if (!verified) return out_({ ok: false, step: 'gegenpruefung', error: 'Nach dem Schreiben steht etwas anderes in Zeile ' + row + '.', row: row, written: written });
  return out_({ ok: true, already: same, row: row, previous: cur, written: written, photo: photo });
}

function savePhoto_(box, b64, onlyIfMissing) {
  const props = PropertiesService.getScriptProperties();
  let folder = null;
  const id = props.getProperty('photoFolder');
  if (id) { try { folder = DriveApp.getFolderById(id); if (folder.isTrashed()) folder = null; } catch (e) { folder = null; } }
  if (!folder) { folder = DriveApp.createFolder(PHOTO_FOLDER); props.setProperty('photoFolder', folder.getId()); }
  const name = box + '.jpg';
  const old = folder.getFilesByName(name);
  if (old.hasNext()) {
    const f = old.next();
    if (onlyIfMissing) return { url: f.getUrl(), name: name, kept: true };
    f.setName(box + '_alt_' + Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyyMMdd-HHmmss') + '.jpg');
  }
  const blob = Utilities.newBlob(Utilities.base64Decode(String(b64).replace(/^data:[^,]+,/, '')), 'image/jpeg', name);
  const f = folder.createFile(blob);
  return { url: f.getUrl(), name: name };
}

function log_(ss, row) {
  let lg = ss.getSheetByName(LOG_SHEET);
  if (!lg) {
    lg = ss.insertSheet(LOG_SHEET);
    lg.appendRow(['Zeitpunkt', 'Vorgang', 'Kästchen', 'Zeile', 'vorher Teile', 'vorher Name', 'vorher Notiz', 'nachher Teile', 'nachher Name', 'nachher Notiz', 'Ergebnis', 'Foto']);
    lg.setFrozenRows(1);
  }
  lg.getRange(lg.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row.map((v, i) => i === 0 ? Utilities.formatDate(v, 'Europe/Berlin', 'yyyy-MM-dd HH:mm:ss') : String(v))]);
}

function folder_(prop, name) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(prop);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = DriveApp.createFolder(name); props.setProperty(prop, f.getId()); return f;
}
function sha_(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function backup_(ss, p) {
  const data = String(p.data || '');
  if (!data) return out_({ ok: false, step: 'pruefen', error: 'Keine Daten zum Sichern.' });
  if (sha_(data) !== p.sha) return out_({ ok: false, step: 'uebertragung', error: 'Daten kamen beschädigt an (Prüfsumme falsch). Nichts gespeichert.' });
  const name = 'Sicherung_' + Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy-MM-dd_HH-mm-ss') + (p.label ? '_' + String(p.label).replace(/[^\w-]+/g, '') : '') + '.json';
  const f = folder_('backupFolder', BACKUP_FOLDER).createFile(name, data, 'application/json');
  const back = f.getBlob().getDataAsString('UTF-8');
  const sha = sha_(back);
  log_(ss, [new Date(), p.client || '', '', '', '', '', '', '', '', '', sha === p.sha ? 'Sicherung ok: ' + name : 'Sicherung ABWEICHUNG: ' + name, f.getUrl()]);
  if (sha !== p.sha) return out_({ ok: false, step: 'gegenpruefung', error: 'Gespeicherte Sicherung weicht ab: ' + name });
  let pruned = 0;
  if (p.label === 'auto') { try { pruned = pruneAuto_(); } catch (e) {} }
  return out_({ ok: true, id: f.getId(), name: name, size: back.length, sha: sha, url: f.getUrl(), pruned: pruned });
}
/** Automatische Sicherungen ausdünnen: die 30 neuesten bleiben, ältere eine pro Tag (90 Tage). Rest in den Papierkorb (30 Tage wiederherstellbar). Manuelle Sicherungen bleiben immer. */
function pruneAuto_() {
  const it = folder_('backupFolder', BACKUP_FOLDER).getFiles(), list = [];
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && /_auto\.json$/.test(f.getName())) list.push(f); }
  list.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  const days = {}, limit = Date.now() - 90 * 864e5; let n = 0;
  list.forEach((f, i) => {
    if (i < 30) return;
    const d = Utilities.formatDate(f.getDateCreated(), 'Europe/Berlin', 'yyyy-MM-dd');
    if (!days[d] && f.getDateCreated().getTime() > limit) { days[d] = 1; return; }
    f.setTrashed(true); n++;
  });
  return n;
}

function listBackups_() {
  const it = folder_('backupFolder', BACKUP_FOLDER).getFiles(), list = [];
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && /\.json$/.test(f.getName())) list.push({ id: f.getId(), name: f.getName(), size: f.getSize(), date: f.getDateCreated().toISOString() }); }
  list.sort((a, b) => b.date.localeCompare(a.date));
  return out_({ ok: true, list: list.slice(0, 40) });
}
function restore_(p) {
  let f;
  try { f = DriveApp.getFileById(String(p.id || '')); } catch (e) { return out_({ ok: false, step: 'laden', error: 'Sicherung nicht gefunden.' }); }
  const data = f.getBlob().getDataAsString('UTF-8');
  return out_({ ok: true, name: f.getName(), data: data, sha: sha_(data) });
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Einmal im Editor ausführen (▶), um die Berechtigungen zu erteilen. */
function berechtigungenErteilen() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  DriveApp.getRootFolder().getName();
}
