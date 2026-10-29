// Exportações: DOCX (Word editável), PDF, TXT, Markdown (zip com imagens),
// CSV de tarefas, áudio original e backup/restauração do histórico.

import * as db from './db.js';
import { parseMd, inlineRuns, mdToText, tasksCsv } from './core/formats.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.js';
import { wavHeader } from './core/audio-dsp.js';

let docxLib = null, jspdfLib = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src)); document.head.appendChild(s); }); }
async function getDocx() { if (!docxLib) { await loadScript(new URL('../vendor/docx.iife.js', import.meta.url).href); docxLib = window.docx; } return docxLib; }
async function getJsPdf() { if (!jspdfLib) { await loadScript(new URL('../vendor/jspdf.umd.min.js', import.meta.url).href); jspdfLib = window.jspdf.jsPDF; } return jspdfLib; }

export function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export const safeName = s => (s || 'reuniao').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'reuniao';

async function imgSize(blob) { const b = await createImageBitmap(blob); const r = { w: b.width, h: b.height }; b.close?.(); return r; }

export async function toDocx(md, shotsById) {
  const d = await getDocx();
  const runs = (t) => inlineRuns(t).map(r => new d.TextRun({ text: r.text, bold: r.bold, italics: r.italics }));
  const children = [];
  for (const b of parseMd(md)) {
    if (b.type === 'h') children.push(new d.Paragraph({ children: runs(b.text), heading: [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3][b.level - 1], spacing: { before: 200, after: 80 } }));
    else if (b.type === 'li') children.push(new d.Paragraph({ children: runs(b.text), bullet: { level: 0 } }));
    else if (b.type === 'check') children.push(new d.Paragraph({ children: [new d.TextRun({ text: b.done ? '☑ ' : '☐ ' }), ...runs(b.text)], indent: { left: 360 } }));
    else if (b.type === 'quote') children.push(new d.Paragraph({ children: runs(b.text), shading: { fill: 'FFF4E5' }, border: { left: { style: 'single', size: 12, color: 'D97706', space: 6 } } }));
    else if (b.type === 'hr') children.push(new d.Paragraph({ border: { bottom: { style: 'single', size: 6, color: 'BBBBBB', space: 1 } } }));
    else if (b.type === 'table') {
      children.push(new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE },
        rows: b.rows.map((r, i) => new d.TableRow({ tableHeader: i === 0, children: r.map(c => new d.TableCell({ children: [new d.Paragraph({ children: inlineRuns(c).map(x => new d.TextRun({ text: x.text, bold: i === 0 || x.bold, size: 18 })) })] })) })),
      }));
    } else if (b.type === 'img') {
      const s = shotsById.get(b.id); if (!s) continue;
      const { w, h } = await imgSize(s.blob); const W = Math.min(600, w), H = Math.round(h * W / w);
      children.push(new d.Paragraph({ children: [new d.ImageRun({ type: 'jpg', data: await s.blob.arrayBuffer(), transformation: { width: W, height: H } })] }));
      children.push(new d.Paragraph({ children: [new d.TextRun({ text: b.caption, italics: true, size: 18, color: '555555' })] }));
    } else children.push(new d.Paragraph({ children: runs(b.text) }));
  }
  const doc = new d.Document({
    creator: 'Pedro Agent', title: 'Ata de reunião',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }],
  });
  return d.Packer.toBlob(doc);
}

// Fontes padrão do PDF usam WinAnsi: troca símbolos fora dessa tabela
const pdfSafe = s => s.replace(/☐/g, '[ ]').replace(/☑/g, '[x]').replace(/⚠/g, '(!)').replace(/[^\x00-\xFF—–•“”‘’…€]/g, '?');

export async function toPdf(md, shotsById) {
  const J = await getJsPdf();
  const pdf = new J({ unit: 'pt', format: 'a4' });
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), M = 48;
  let y = M;
  const need = h => { if (y + h > H - M) { pdf.addPage(); y = M; } };
  const write = (text, { size = 10.5, bold = false, italic = false, indent = 0, color = [20, 24, 28], gap = 4 } = {}) => {
    pdf.setFont('helvetica', bold ? (italic ? 'bolditalic' : 'bold') : (italic ? 'italic' : 'normal'));
    pdf.setFontSize(size); pdf.setTextColor(...color);
    const lines = pdf.splitTextToSize(pdfSafe(text), W - 2 * M - indent);
    for (const l of lines) { need(size * 1.35); pdf.text(l, M + indent, y + size); y += size * 1.35; }
    y += gap;
  };
  const plain = t => inlineRuns(t).map(r => r.text).join('');
  for (const b of parseMd(md)) {
    if (b.type === 'h') { y += b.level === 1 ? 4 : 8; write(plain(b.text), { size: [18, 13.5, 11.5][b.level - 1], bold: true, color: b.level === 1 ? [14, 59, 67] : [20, 24, 28] }); }
    else if (b.type === 'li') write('•  ' + plain(b.text), { indent: 8 });
    else if (b.type === 'check') write((b.done ? '[x]  ' : '[ ]  ') + plain(b.text), { indent: 14 });
    else if (b.type === 'quote') write(plain(b.text), { bold: true, color: [180, 83, 9] });
    else if (b.type === 'hr') { need(10); pdf.setDrawColor(190); pdf.line(M, y + 4, W - M, y + 4); y += 12; }
    else if (b.type === 'table') { for (const [i, r] of b.rows.entries()) write(r.join('  |  '), { size: 9, bold: i === 0, gap: 1 }); y += 4; }
    else if (b.type === 'img') {
      const s = shotsById.get(b.id); if (!s) continue;
      const { w, h } = await imgSize(s.blob);
      const iw = W - 2 * M, ih = Math.min(H - 2 * M - 30, iw * h / w), iw2 = ih * w / h;
      need(ih + 24);
      const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(s.blob); });
      pdf.addImage(dataUrl, 'JPEG', M, y, iw2, ih); y += ih + 4;
      write(b.caption, { size: 9, italic: true, color: [90, 90, 90] });
    } else write(plain(b.text));
  }
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) { pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(140); pdf.text(`Pedro Agent · página ${i} de ${n}`, W - M, H - 24, { align: 'right' }); }
  return pdf.output('blob');
}

export async function toMarkdownZip(md, shotsById, base) {
  const ids = [...md.matchAll(/\(shot:([^)]+)\)/g)].map(m => m[1]);
  if (!ids.length) return { blob: new Blob([md], { type: 'text/markdown' }), name: base + '.md' };
  const files = {};
  let out = md;
  for (const id of ids) {
    const s = shotsById.get(id); if (!s) continue;
    const f = `imagens/${id}.jpg`;
    files[f] = new Uint8Array(await s.blob.arrayBuffer());
    out = out.replaceAll(`(shot:${id})`, `(${f})`);
  }
  files[base + '.md'] = strToU8(out);
  return { blob: new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), name: base + '_markdown.zip' };
}

export const toText = md => new Blob([mdToText(md)], { type: 'text/plain;charset=utf-8' });
export const toCsv = ctx => new Blob([tasksCsv(ctx)], { type: 'text/csv;charset=utf-8' });

/** Áudio preparado em WAV (16 kHz) — o mesmo usado na transcrição e nos horários. */
export async function pcmWavBlob(meeting) {
  const parts = (await db.byMeeting('pcm', meeting.id)).sort((a, b) => a.seq - b.seq);
  const total = parts.reduce((a, p) => a + p.data.byteLength / 2, 0);
  return new Blob([wavHeader(total), ...parts.map(p => p.data)], { type: 'audio/wav' });
}

const extOf = mime => /mp4|m4a|aac/.test(mime || '') ? 'm4a' : /ogg/.test(mime || '') ? 'ogg' : 'webm';

// ---------------- Backup ----------------

/**
 * Backup em .zip: metadados (JSON) de todas as reuniões selecionadas,
 * transcrições, atas, tarefas, capturas e memória de correções.
 * Com includeAudio=true inclui também o áudio original e o PCM (arquivo maior).
 */
export async function backup(meetingIds, includeAudio, onStage) {
  const files = {};
  const meetings = [];
  for (const id of meetingIds) {
    const m = await db.get('meetings', id); if (!m) continue;
    onStage?.(`Copiando ${m.title}…`);
    const segs = await db.byMeeting('segments', id);
    const shots = await db.byMeeting('shots', id);
    meetings.push(m);
    files[`reunioes/${id}/segmentos.json`] = strToU8(JSON.stringify(segs));
    files[`reunioes/${id}/capturas.json`] = strToU8(JSON.stringify(shots.map(({ blob, ...s }) => s)));
    for (const s of shots) files[`reunioes/${id}/capturas/${s.id}.jpg`] = new Uint8Array(await s.blob.arrayBuffer());
    if (includeAudio) {
      for (const b of await db.byMeeting('blobs', id)) files[`reunioes/${id}/audio/${b.track}_${String(b.seq).padStart(5, '0')}.${extOf(b.type)}`] = new Uint8Array(await b.data.arrayBuffer());
      const blobsMeta = (await db.byMeeting('blobs', id)).map(({ data, ...b }) => b);
      files[`reunioes/${id}/audio.json`] = strToU8(JSON.stringify(blobsMeta));
      for (const p of await db.byMeeting('pcm', id)) files[`reunioes/${id}/pcm/${String(p.seq).padStart(5, '0')}.pcm`] = new Uint8Array(p.data);
      files[`reunioes/${id}/pcm.json`] = strToU8(JSON.stringify((await db.byMeeting('pcm', id)).map(p => ({ seq: p.seq, energy: p.energy }))));
    }
  }
  files['reunioes.json'] = strToU8(JSON.stringify(meetings));
  files['correcoes.json'] = strToU8(JSON.stringify(await db.getAll('corrections')));
  files['manifesto.json'] = strToU8(JSON.stringify({ app: 'Pedro Agent', formato: 1, criadoEm: new Date().toISOString(), incluiAudio: !!includeAudio, reunioes: meetings.length }));
  onStage?.('Compactando…');
  return new Blob([zipSync(files, { level: 1 })], { type: 'application/zip' });
}

/** Restaura um backup. Nunca sobrescreve reuniões existentes (pula as que já existem). */
export async function restore(file, onStage) {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const man = z['manifesto.json'] ? JSON.parse(strFromU8(z['manifesto.json'])) : null;
  if (!man || man.app !== 'Pedro Agent') throw new Error('Arquivo não reconhecido como backup do Pedro Agent.');
  const meetings = JSON.parse(strFromU8(z['reunioes.json']));
  let added = 0, skipped = 0, withoutAudio = 0;
  for (const m of meetings) {
    if (await db.get('meetings', m.id)) { skipped++; continue; }
    onStage?.(`Restaurando ${m.title}…`);
    await db.put('meetings', m);
    const p = `reunioes/${m.id}/`;
    for (const s of JSON.parse(strFromU8(z[p + 'segmentos.json'] || strToU8('[]')))) await db.put('segments', s);
    for (const s of JSON.parse(strFromU8(z[p + 'capturas.json'] || strToU8('[]')))) { const img = z[`${p}capturas/${s.id}.jpg`]; if (img) await db.put('shots', { ...s, blob: new Blob([img], { type: 'image/jpeg' }) }); }
    if (z[p + 'audio.json']) {
      for (const b of JSON.parse(strFromU8(z[p + 'audio.json']))) { const f = z[`${p}audio/${b.track}_${String(b.seq).padStart(5, '0')}.${extOf(b.type)}`]; if (f) await db.put('blobs', { ...b, data: new Blob([f], { type: b.type }) }); }
      const pm = JSON.parse(strFromU8(z[p + 'pcm.json'] || strToU8('[]')));
      for (const r of pm) { const f = z[`${p}pcm/${String(r.seq).padStart(5, '0')}.pcm`]; if (f) await db.put('pcm', { meetingId: m.id, seq: r.seq, data: f.slice().buffer, energy: r.energy }); }
    } else { withoutAudio++; await db.updateMeeting(m.id, x => { x.audioMissing = true; }); }
    added++;
  }
  let corr = 0;
  for (const c of JSON.parse(strFromU8(z['correcoes.json'] || strToU8('[]')))) if (!(await db.get('corrections', c.id))) { await db.put('corrections', c); corr++; }
  return { added, skipped, withoutAudio, corrections: corr, includesAudio: man.incluiAudio };
}
