// Geração da ata por IA (orquestração). Usa js/core/minutes.js para prompts e
// verificação e js/llm.js para o modelo.

import * as db from './db.js';
import { runMinutesPipeline, toMinutesRecord, rewritePrompt } from './core/minutes.js';
import { factsForRewrite } from './core/formats.js';

/** Nome exibido do locutor — só usa nomes com evidência ou confirmação. */
export function speakerNameFn(meeting) {
  const names = meeting.speakerNames || {};
  return (s) => {
    if (s.speaker) return s.speaker;                       // confirmado pelo usuário
    if (s.platformSpeaker) return s.platformSpeaker;       // informado pela plataforma (bot)
    if (s.channel === 'mic') return names.mic || 'Você (microfone)';
    if (s.channel === 'sys') return names.sys || 'Participante remoto';
    return 'Locutor não identificado';
  };
}

export function participantNames(meeting) {
  return (meeting.participants || []).filter(p => p.confirmed !== false).map(p => p.name).filter(Boolean);
}

/**
 * Gera a ata. events: onStage(text), onProgress(fraction)
 * Lança erro com .kind; a transcrição e o áudio nunca são alterados aqui.
 */
export async function generateMinutes(meetingId, llm, events = {}, { allowPartial = false } = {}) {
  const meeting = await db.get('meetings', meetingId);
  if (!meeting) throw new db.MeetingGone(meetingId);
  const segments = await db.byMeeting('segments', meetingId);
  if (!segments.some(s => (s.text || '').trim())) { const e = new Error('A transcrição está vazia: não há conteúdo para gerar uma ata. Nada foi gerado.'); e.kind = 'sem-texto'; throw e; }
  await llm.check();
  const corrections = (await db.getAll('corrections')).filter(c => c.enabled);
  const r = await runMinutesPipeline({
    segments, plan: meeting.transcription?.plan || [], transcriptionDone: meeting.transcription?.status === 'concluída',
    meta: { title: meeting.title, date: new Date(meeting.startedAt || meeting.createdAt).toLocaleString('pt-BR'), participants: participantNames(meeting) },
    speakerName: speakerNameFn(meeting), participants: participantNames(meeting), glossary: [...new Set(corrections.map(c => c.to))].slice(0, 60),
    chat: (messages, o) => llm.chat(messages, { ...o, onStage: events.onStage }), contextTokens: llm.contextTokens, allowPartial,
    onStage: events.onStage, onProgress: events.onProgress, onLog: (msg) => db.log({ meetingId, stage: 'ata', message: msg }),
  });
  const rec = toMinutesRecord(r.facts, { partial: r.partial, coverage: r.coverage, provider: llm.provider, model: llm.model, warnings: r.warnings });
  const prev = meeting.minutes;
  await db.updateMeeting(meetingId, m => {
    if (prev?.status === 'pronta') { m.minutesHistory = [...(m.minutesHistory || []), prev].slice(-5); } // preserva versões anteriores (com edições)
    m.minutes = rec;
    for (const k of Object.keys(m.renditions || {})) m.renditions[k].stale = true;
  });
  return rec;
}

/** Formatos escritos pela IA (narrativo / personalizado) a partir dos FATOS da ata. */
export async function generateRendition(meetingId, key, style, llm, events = {}) {
  const meeting = await db.get('meetings', meetingId);
  if (!meeting?.minutes) throw new Error('Gere a ata antes.');
  await llm.check();
  events.onStage?.('IA reescrevendo no formato pedido…');
  let text = await llm.chat([{ role: 'system', content: 'Você reescreve atas em português do Brasil sem alterar fatos.' }, { role: 'user', content: rewritePrompt({ facts: factsForRewrite(meeting.minutes, participantNames(meeting)), style }) }], { maxTokens: 2500 });
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (meeting.minutes.partial) text = '> **ATA PARCIAL**\n\n' + text;
  await db.updateMeeting(meetingId, m => { m.renditions = m.renditions || {}; m.renditions[key] = { text, style, generatedAt: new Date().toISOString(), by: `${llm.provider} · ${llm.model}` }; });
  return text;
}
