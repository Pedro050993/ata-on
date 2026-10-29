"""Gera áudios de teste com fala conhecida em português (Piper TTS, vozes pt_BR).

Uso: python3 make_fixtures.py <pasta_vozes> <pasta_saida>
Vozes: pt_BR-faber-medium, pt_BR-cadu-medium, pt_BR-jeff-medium
       (https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR)
Saídas (16 kHz mono WAV) + referencia.json com o texto falado e horários.
"""
import json, subprocess, sys, wave, random, os
import numpy as np

VOZES, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
V = {'Pedro': 'faber', 'Marcos': 'cadu', 'Ana': 'jeff'}
ROTEIRO = [
    ('Pedro', 'Bom dia a todos. Vamos começar a reunião de planejamento da Torre B do residencial em Indaiatuba.'),
    ('Marcos', 'O concreto do quinto pavimento atrasou porque a usina não entregou na terça-feira. Perdemos dois dias de ciclo.'),
    ('Pedro', 'Então ficou decidido: a nova concretagem será na quinta-feira, dia seis, às sete horas da manhã.'),
    ('Ana', 'Eu fico responsável por confirmar com a usina até amanhã ao meio-dia.'),
    ('Marcos', 'Talvez valha a pena trocar de fornecedor, mas isso precisa ser aprovado pelo diretor.'),
    ('Pedro', 'Marcos, você pode atualizar o cronograma no MS Project até sexta-feira?'),
    ('Marcos', 'Posso sim, eu atualizo o cronograma até sexta.'),
    ('Ana', 'Outro ponto: o orçamento das esquadrias veio em trezentos e vinte mil reais, acima do previsto.'),
    ('Pedro', 'Não vamos aprovar esse valor agora. Vamos pedir mais duas cotações.'),
    ('Ana', 'Existe um risco: se o elevador não chegar em dezembro, a entrega das unidades atrasa.'),
    ('Pedro', 'Certo. Encerramos por hoje. Obrigado a todos.'),
]
SR = 16000

def tts(voz, texto, cache={}):
    key = (voz, texto)
    if key in cache: return cache[key]
    tmp = os.path.join(OUT, '_tmp.wav')
    subprocess.run([sys.executable, '-m', 'piper', '-m', os.path.join(VOZES, f'pt_BR-{voz}-medium.onnx'), '-f', tmp], input=texto.encode(), check=True, capture_output=True)
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', tmp, '-ar', str(SR), '-ac', '1', '-f', 'f32le', '-'], check=True, capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.float32).copy()
    a = a / (np.abs(a).max() + 1e-9) * 0.5
    cache[key] = a
    return a

def save(name, a):
    a = np.clip(a, -1, 1)
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((a * 32767).astype(np.int16).tobytes())

def reuniao(repeticoes=1, pausa=(0.6, 1.4), seed=1):
    rnd = random.Random(seed)
    partes, ref, t = [], [], 0.0
    for r in range(repeticoes):
        for quem, txt in ROTEIRO:
            a = tts(V[quem], txt)
            ref.append({'quem': quem, 'texto': txt, 'inicio': round(t, 2), 'fim': round(t + len(a) / SR, 2), 'rodada': r})
            partes.append(a); t += len(a) / SR
            p = np.zeros(int(rnd.uniform(*pausa) * SR), dtype=np.float32)
            partes.append(p); t += len(p) / SR
    return np.concatenate(partes), ref

base, ref = reuniao()
save('reuniao_normal.wav', base)
save('reuniao_volume_baixo.wav', base * 10 ** (-32 / 20))  # ~ -38 dBFS de fala
rng = np.random.default_rng(7)
ruido = rng.normal(0, 1, len(base)).astype(np.float32)
ruido = np.convolve(ruido, np.ones(8) / 8, mode='same')  # ruído "rosado" simples
fala_rms = np.sqrt(np.mean(base[np.abs(base) > 0.01] ** 2))
save('reuniao_ruido_snr10.wav', base + ruido / np.sqrt(np.mean(ruido ** 2)) * fala_rms * 10 ** (-10 / 20))
save('silencio_60s.wav', rng.normal(0, 10 ** (-70 / 20), 60 * SR).astype(np.float32))
save('ruido_sem_fala_60s.wav', (ruido[: 60 * SR] if len(ruido) >= 60 * SR else np.resize(ruido, 60 * SR)) / np.sqrt(np.mean(ruido ** 2)) * 0.01)
reps20 = max(1, round(20 * 60 / (len(base) / SR)))
longa20, ref20 = reuniao(reps20, seed=2)
save('reuniao_20min.wav', longa20)
reps46 = max(1, round(46 * 60 / (len(base) / SR)))
longa46, ref46 = reuniao(reps46, seed=3)
save('reuniao_46min.wav', longa46)
os.remove(os.path.join(OUT, '_tmp.wav'))
json.dump({'roteiro': ROTEIRO, 'normal': ref, 'longa20': ref20, 'longa46': ref46,
           'duracoes': {'normal': len(base) / SR, 'longa20': len(longa20) / SR, 'longa46': len(longa46) / SR}},
          open(os.path.join(OUT, 'referencia.json'), 'w'), ensure_ascii=False, indent=1)
print('ok', {k: round(v / 60, 1) for k, v in {'normal': len(base) / SR, '20': len(longa20) / SR, '46': len(longa46) / SR}.items()})
