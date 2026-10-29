// TESTE NO NAVEGADOR: edição da ata e das tarefas → formatos → exportações
// (DOCX, PDF, TXT, Markdown com imagens, CSV, áudio) → backup → restauração em
// outro perfil → reabrir → excluir.
// O CONTEÚDO da ata aqui é montado pelo teste (sem IA) para isolar a exportação;
// a geração por IA real é testada em tests/model/ata-real.mjs e e2e-ata.mjs.
// Uso: node tests/browser/e2e-exportar.mjs <reuniao.wav> <pasta_saida>
import fs from 'node:fs';
import path from 'node:path';
import { launch, BASE, db, dlg, log } from './helpers.mjs';

const [wav, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const ref = JSON.parse(fs.readFileSync(path.join(path.dirname(wav), 'referencia.json'), 'utf8'));
const res = {};
let { browser, ctx, page, errors } = await launch({});
const save = async (name, b64) => { fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, 'base64')); return fs.statSync(path.join(outDir, name)).size; };
const blobB64 = `async (b) => await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); })`;
try {
  await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
  await page.click('button.card:has-text("Importar arquivo")');
  await page.setInputFiles('input[type=file]', wav);
  await page.waitForSelector('.tabs', { timeout: 120000 });
  const id = page.url().split('/').pop();
  // transcrição de gabarito (uma frase por trecho) + ata montada + 1 captura
  await page.evaluate(async ([id, ref]) => {
    const db = await import('/js/db.js'); const { verifyFacts, normalizeFacts, toMinutesRecord } = await import('/js/core/minutes.js');
    const segs = ref.normal.map((r, i) => ({ meetingId: id, i, id: `T${i + 1}`, start: r.inicio, end: r.fim, text: r.texto, rawText: r.texto, speaker: r.quem, done: true }));
    for (const s of segs) await db.guardedPut(id, 'segments', s);
    const c = document.createElement('canvas'); c.width = 960; c.height = 540; const g = c.getContext('2d'); g.fillStyle = '#523'; g.fillRect(0, 0, 960, 540); g.fillStyle = '#fff'; g.font = '44px sans-serif'; g.fillText('Orçamento esquadrias: R$ 320 mil', 60, 280);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .85));
    await db.guardedPut(id, 'shots', { id: 'sx1', meetingId: id, t: 40, blob, w: 960, h: 540, manual: true, caption: 'Planilha de orçamento', createdAt: new Date().toISOString() });
    const facts = normalizeFacts({ titulo: 'Planejamento Torre B', proposito: 'Replanejar a concretagem e tratar pendências', resumo: ['Concretagem do 5º pavimento atrasou 2 dias', 'Orçamento das esquadrias acima do previsto'],
      assuntos: [{ titulo: 'Concretagem', pontos: ['Usina não entregou na terça'], refs: ['T2', 'T3'] }, { titulo: 'Esquadrias', pontos: ['Orçamento de R$ 320 mil'], refs: ['T8', 'T9'] }],
      decisoes: [{ texto: 'Nova concretagem na quinta-feira, dia 6, às 7h', status: 'acordado', refs: ['T3'] }, { texto: 'Não aprovar o orçamento de esquadrias agora', status: 'acordado', refs: ['T9'] }],
      propostas: [{ texto: 'Trocar de fornecedor de concreto', tipo: 'sugestão', autor: 'Marcos', refs: ['T5'] }], restricoes: [], riscos: [{ texto: 'Atraso do elevador em dezembro atrasa a entrega', refs: ['T10'] }],
      tarefas: [{ descricao: 'Confirmar com a usina', responsavel: 'Ana', prazo: 'amanhã ao meio-dia', compromisso: 'assumido', refs: ['T4'] }, { descricao: 'Atualizar o cronograma no MS Project', responsavel: 'Marcos', prazo: 'sexta', compromisso: 'assumido', refs: ['T6', 'T7'] }, { descricao: 'Pedir mais duas cotações de esquadrias', responsavel: 'A confirmar', prazo: 'Não definido', compromisso: 'atribuído', refs: ['T9'] }] });
    const v = verifyFacts(facts, segs, s => s.speaker, ['Pedro', 'Marcos', 'Ana']);
    await db.updateMeeting(id, m => { m.title = 'Planejamento Torre B'; m.participants = ['Pedro', 'Marcos', 'Ana'].map(name => ({ name, confirmed: true, evidence: 'teste' })); m.transcription = { status: 'concluída', plan: segs.map(s => ({ i: s.i, start: s.start, end: s.end })) }; m.minutes = toMinutesRecord(v.facts, { partial: false, coverage: 1, provider: 'teste', model: 'conteúdo montado pelo teste', warnings: v.warnings }); });
  }, [id, ref]);
  res.verifyWarnings = (await db(page, (d, id) => d.get('meetings', id), id)).minutes.warnings;
  await page.reload(); await page.waitForSelector('.tabs');
  // --- editar uma tarefa pela interface: concluir + mudar responsável ---
  await page.click('button.tab:has-text("Tarefas")');
  await page.waitForSelector('.task');
  const t3 = page.locator('.task', { hasText: 'Pedir mais duas cotações' });
  await t3.locator('input[type=text]').first().fill('Pedro'); await t3.locator('input[type=text]').first().press('Tab');
  await page.waitForTimeout(500);
  await page.locator('.task', { hasText: 'Confirmar com a usina' }).locator('input[type=checkbox]').check();
  await page.waitForTimeout(500);
  await page.locator('.task', { hasText: 'Confirmar com a usina' }).locator('input[type=checkbox]').uncheck(); // reabrir
  await page.waitForTimeout(300);
  await page.locator('.task', { hasText: 'Confirmar com a usina' }).locator('input[type=checkbox]').check();
  await page.waitForTimeout(500);
  const m1 = await db(page, (d, id) => d.get('meetings', id), id);
  res.tarefasAposEdicao = m1.minutes.tarefas.map(t => `${t.descricao} | ${t.responsavel} | ${t.situacao}`);
  // --- editar texto de decisão pela aba Ata ---
  await page.click('button.tab:has-text("Ata")');
  const dec = page.locator('.item [contenteditable]', { hasText: 'Nova concretagem' }).first();
  await dec.click(); await page.keyboard.press('End'); await page.keyboard.type(' (confirmado pelo Pedro)'); await page.locator('h3').first().click();
  await page.waitForTimeout(500);
  // --- formatos: cada um renderiza; edição de um formato não altera os outros nem a ata ---
  await page.click('button.tab:has-text("Formatos")');
  await page.waitForSelector('textarea.preview');
  res.formatos = {};
  for (const key of ['notas', 'ata', 'bullets', 'executivo', 'cronologico', 'tarefas', 'tabela', 'resumo_transcricao', 'transcricao']) {
    await page.selectOption('select', key); await page.waitForTimeout(150);
    const v = await page.inputValue('textarea.preview'); res.formatos[key] = v.length;
  }
  await page.selectOption('select', 'executivo');
  await page.fill('textarea.preview', (await page.inputValue('textarea.preview')) + '\n\nNota do Pedro: enviar à diretoria.');
  await page.waitForTimeout(900);
  await page.selectOption('select', 'ata'); await page.waitForTimeout(200);
  const ataMd = await page.inputValue('textarea.preview');
  res.ataContemEdicaoDaDecisao = ataMd.includes('(confirmado pelo Pedro)');
  res.ataNaoContemNotaDoExecutivo = !ataMd.includes('Nota do Pedro');
  await page.selectOption('select', 'executivo'); await page.waitForTimeout(200);
  res.executivoManteveEdicao = (await page.inputValue('textarea.preview')).includes('Nota do Pedro');
  await page.selectOption('select', 'ata'); await page.waitForTimeout(200);
  // --- exportações (mesmas funções dos botões) ---
  const files = await page.evaluate(async ([id, md, conv]) => {
    const ex = await import('/js/export.js'); const db = await import('/js/db.js'); const { tasksCsv } = await import('/js/core/formats.js');
    const toB64 = (0, eval)(conv);
    const m = await db.get('meetings', id); const shots = await db.byMeeting('shots', id); const sb = new Map(shots.map(s => [s.id, s]));
    const segs = await db.byMeeting('segments', id);
    const out = {};
    out.docx = await toB64(await ex.toDocx(md, sb));
    out.pdf = await toB64(await ex.toPdf(md, sb));
    out.txt = await toB64(ex.toText(md));
    const z = await ex.toMarkdownZip(md, sb, 'ata'); out.mdzip = await toB64(z.blob);
    out.csv = await toB64(ex.toCsv({ meeting: m, minutes: m.minutes, segIndex: new Map(segs.map(s => [s.id, s])) }));
    out.audio = await toB64(await db.trackBlob(id, 'original'));
    out.backupSemAudio = await toB64(await ex.backup([id], false));
    out.backupComAudio = await toB64(await ex.backup([id], true));
    return out;
  }, [id, ataMd, blobB64]);
  res.arquivos = {};
  for (const [k, ext] of [['docx', 'docx'], ['pdf', 'pdf'], ['txt', 'txt'], ['mdzip', 'zip'], ['csv', 'csv'], ['audio', 'wav'], ['backupSemAudio', 'zip'], ['backupComAudio', 'zip']]) res.arquivos[k] = await save(`${k}.${ext}`, files[k]);
  res.meetingId = id;
  await browser.close();
  // --- restaurar em OUTRO perfil (simula outro computador / reinstalação) ---
  ({ browser, ctx, page, errors: res.errors2 = [] } = await launch({}));
  await page.goto(BASE); await page.waitForSelector('text=Nova reunião');
  await page.click('button[data-route=config]');
  await page.waitForSelector('text=Armazenamento, backup');
  await page.setInputFiles('input[type=file][accept=".zip"]', path.join(outDir, 'backupSemAudio.zip'));
  await page.waitForSelector('text=Restauradas', { timeout: 60000 });
  res.restauracaoSemAudio = await page.textContent('.alert.ok');
  await page.setInputFiles('input[type=file][accept=".zip"]', path.join(outDir, 'backupComAudio.zip'));
  await page.waitForSelector('text=já existiam', { timeout: 60000 });
  res.restauracaoRepetida = await page.textContent('.alert.ok');
  const r = await db(page, async (d, id) => { const m = await d.get('meetings', id); return { titulo: m?.title, tarefas: m?.minutes?.tarefas?.length, segs: (await d.byMeeting('segments', id)).length, shots: (await d.byMeeting('shots', id)).length, pcm: (await d.byMeeting('pcm', id)).length, audioMissing: m?.audioMissing }; }, id);
  res.reaberta = r;
  // reabrir a reunião restaurada e excluir
  await page.goto(BASE + '#/reuniao/' + id); await page.waitForSelector('.tabs');
  res.reabertaMostraAta = (await page.textContent('#view')).includes('Planejamento Torre B');
  await page.click('button:has-text("Excluir reunião")'); await page.locator('#dlg[open] button:has-text("Excluir")').click();
  await page.waitForURL(/reunioes/);
  res.aposExcluir = await db(page, async (d, id) => ({ meeting: !!(await d.get('meetings', id)), segs: (await d.byMeeting('segments', id)).length, shots: (await d.byMeeting('shots', id)).length }), id);
} catch (e) { res.error = e.stack; await page.screenshot({ path: path.join(outDir, 'erro.png') }).catch(() => {}); }
res.errors = errors;
console.log(JSON.stringify(res, null, 1));
await browser.close().catch(() => {});
process.exit(0);
