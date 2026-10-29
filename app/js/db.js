// Armazenamento local (IndexedDB). Nada sai do dispositivo.
// Atualizações do aplicativo NUNCA apagam este banco: a versão do esquema só
// cresce, e as migrações apenas criam estruturas novas.

const DB_NAME = 'pedro-agent';
const DB_VERSION = 1;
let dbp = null;

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // v1
      if (e.oldVersion < 1) {
        db.createObjectStore('meetings', { keyPath: 'id' });
        const blobs = db.createObjectStore('blobs', { keyPath: ['meetingId', 'track', 'seq'] });
        blobs.createIndex('meetingId', 'meetingId');
        const pcm = db.createObjectStore('pcm', { keyPath: ['meetingId', 'seq'] });
        pcm.createIndex('meetingId', 'meetingId');
        const seg = db.createObjectStore('segments', { keyPath: ['meetingId', 'i'] });
        seg.createIndex('meetingId', 'meetingId');
        const shots = db.createObjectStore('shots', { keyPath: 'id' });
        shots.createIndex('meetingId', 'meetingId');
        db.createObjectStore('corrections', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'key' });
        const logs = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        logs.createIndex('meetingId', 'meetingId');
      }
      // futuras versões: apenas acrescentar (if (e.oldVersion < 2) {...})
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Banco de dados bloqueado por outra aba do Pedro Agent. Feche as outras abas.'));
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new DOMException('Transação abortada', 'AbortError')); });

export async function get(store, key) { const db = await openDb(); return wrap(db.transaction(store).objectStore(store).get(key)); }
export async function getAll(store) { const db = await openDb(); return wrap(db.transaction(store).objectStore(store).getAll()); }
export async function put(store, val) { const db = await openDb(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val); return done(tx); }
export async function del(store, key) { const db = await openDb(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); return done(tx); }
export async function byMeeting(store, meetingId) {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index('meetingId').getAll(meetingId));
}

export class MeetingGone extends Error { constructor(id) { super(`A reunião ${id} foi excluída; gravação de dados descartada.`); this.name = 'MeetingGone'; } }

/**
 * Gravação protegida: na MESMA transação confere se a reunião ainda existe.
 * Assim um processo atrasado (transcrição, bot, captura) não recria dados de
 * uma reunião excluída.
 */
export async function guardedPut(meetingId, store, val) {
  const db = await openDb();
  const stores = store === 'meetings' ? ['meetings'] : ['meetings', store];
  const tx = db.transaction(stores, 'readwrite');
  const m = await wrap(tx.objectStore('meetings').get(meetingId));
  if (!m) { tx.abort(); throw new MeetingGone(meetingId); }
  tx.objectStore(store).put(val);
  return done(tx);
}

/** Atualiza a reunião com uma função (lê-modifica-grava atômico). */
export async function updateMeeting(id, fn) {
  const db = await openDb();
  const tx = db.transaction('meetings', 'readwrite');
  const st = tx.objectStore('meetings');
  const m = await wrap(st.get(id));
  if (!m) { tx.abort(); throw new MeetingGone(id); }
  const r = fn(m) || m;
  r.updatedAt = new Date().toISOString();
  st.put(r);
  await done(tx);
  return r;
}

/** Exclui a reunião e TODOS os dados associados numa única transação. */
export async function deleteMeeting(id) {
  const db = await openDb();
  const stores = ['meetings', 'blobs', 'pcm', 'segments', 'shots', 'logs'];
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore('meetings').delete(id);
  for (const s of stores.slice(1)) {
    const idx = tx.objectStore(s).index('meetingId');
    const keys = await wrap(idx.getAllKeys(id));
    for (const k of keys) tx.objectStore(s).delete(k);
  }
  return done(tx);
}

export async function newMeeting(fields) {
  const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = new Date().toISOString();
  const m = {
    id, createdAt: now, updatedAt: now, startedAt: now, title: fields.title || `Reunião de ${new Date().toLocaleDateString('pt-BR')}`,
    source: 'mic', status: 'gravando', durationSec: 0, participants: [], speakerNames: {},
    tracks: {}, pcm: { sampleRate: 16000, samples: 0, chunks: 0 },
    transcription: { status: 'pendente' }, minutes: null, renditions: {}, notes: '', ...fields,
  };
  await put('meetings', m);
  return m;
}

export async function getSetting(key, def) { const r = await get('settings', key); return r ? r.value : def; }
export async function setSetting(key, value) { return put('settings', { key, value }); }

export async function log(entry) {
  try { await put('logs', { ts: new Date().toISOString(), ...entry }); } catch { /* diagnóstico não pode derrubar o app */ }
}

/** Blob de uma trilha gravada (concatena os pedaços na ordem). */
export async function trackBlob(meetingId, track) {
  const parts = (await byMeeting('blobs', meetingId)).filter(b => b.track === track).sort((a, b) => a.seq - b.seq);
  if (!parts.length) return null;
  return new Blob(parts.map(p => p.data), { type: parts[0].type || 'audio/webm' });
}

/** Lê amostras PCM (16 kHz, Int16) entre dois instantes. */
export async function readPcm(meetingId, startSec, endSec, chunkSamples) {
  const sr = 16000;
  const s0 = Math.floor(startSec * sr), s1 = Math.ceil(endSec * sr);
  const c0 = Math.floor(s0 / chunkSamples), c1 = Math.floor((s1 - 1) / chunkSamples);
  const db = await openDb();
  const st = db.transaction('pcm').objectStore('pcm');
  const out = new Float32Array(Math.max(0, s1 - s0));
  for (let c = c0; c <= c1; c++) {
    const rec = await wrap(st.get([meetingId, c]));
    if (!rec) continue;
    const data = new Int16Array(rec.data);
    const base = c * chunkSamples;
    const from = Math.max(s0, base), to = Math.min(s1, base + data.length);
    for (let k = from; k < to; k++) out[k - s0] = data[k - base] / 32768;
  }
  return out;
}

export async function storageInfo() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { usage: est?.usage, quota: est?.quota, persisted };
}
