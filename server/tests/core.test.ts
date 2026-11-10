import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { parseTranscript, transcribeFile, transcribe } from '../src/transcribe.js';
import { normalizeOptions, type Word } from '../src/types.js';
import { refine, rankByEnergy } from '../src/select.js';
import { parseEnergy, audioFilter } from '../src/audio.js';
import { excerpt, postCaption } from '../src/post-caption.js';

const words: Word[] = Array.from({ length: 120 }, (_, i) => ({ word: i % 10 === 9 ? 'fim.' : 'fala', start: i * 0.5, end: i * 0.5 + 0.4 }));

test('production cannot activate fake AI, even with the old example setting', () => {
  const old = { env: process.env.NODE_ENV, mock: process.env.MOCK_AI };
  try {
    process.env.MOCK_AI = '1'; process.env.NODE_ENV = 'production'; assert.equal(config.mock, false);
    process.env.NODE_ENV = 'development'; assert.equal(config.mock, false);
    process.env.NODE_ENV = 'test'; assert.equal(config.mock, true);
  } finally {
    if (old.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old.env;
    if (old.mock === undefined) delete process.env.MOCK_AI; else process.env.MOCK_AI = old.mock;
  }
});

test('transcription requires usable word timestamps; no invented timing fallback', () => {
  assert.deepEqual(parseTranscript({ words: [{ word: ' real ', start: 1, end: 2 }] }), [{ word: 'real', start: 1, end: 2 }]);
  assert.throws(() => parseTranscript({ text: 'conteúdo real sem tempos' }), /tempos por palavra/);
  assert.throws(() => parseTranscript({ words: [{ word: 'fala', start: null, end: 2 }] }), /inválidos/);
  assert.throws(() => parseTranscript({ words: [{ word: 'fala', start: 3, end: 2 }] }), /inválidos/);
  assert.deepEqual(parseTranscript({ text: '', words: [] }), []);
});

test('speech energy excludes loud frames without transcribed words', () => {
  const data = [0, 1, 2, 3].map((t, i) => `frame:${i} pts_time:${t}\nlavfi.astats.Overall.RMS_level=${[-40, -30, -20, -1][i]}`).join('\n');
  const samples = parseEnergy(data, [{ word: 'fala', start: 0, end: 2.5 }]);
  assert.equal(samples.length, 3);
  assert.ok(samples[0].level < samples[2].level);
  const picks = [0, 2].map(start => ({ start, end: start + 0.5, title: 't', reason: 'r', score: 75 }));
  assert.equal(rankByEnergy(picks, samples, 'impact')[0].score, 75);
  const ranked = rankByEnergy(picks, samples, 'energy');
  assert.ok(ranked[1].score > ranked[0].score);
  assert.deepEqual(rankByEnergy(picks, [], 'energy'), picks);
});

test('refinement respects sentence edges, selected duration and non-overlap', () => {
  const opts = normalizeOptions({ clipLength: 'short', maxClips: 3 });
  const picks = [{ start: 1, end: 20, title: 'A', reason: '', score: 90 }, { start: 5, end: 25, title: 'B', reason: '', score: 80 }, { start: 35, end: 59.9, title: 'C', reason: '', score: 70 }];
  const result = refine(picks, words, opts, 60);
  assert.equal(result.length, 2);
  for (const r of result) assert.ok(r.end - r.start >= 15 && r.end - r.start <= 40);
  assert.ok(result[0].end <= result[1].start);
  assert.deepEqual(refine([{ ...picks[0], start: NaN }], words, opts, 60), []);
});

test('audio settings are allowlisted; original applies no filter', () => {
  assert.equal(normalizeOptions({ audioEnhancement: 'malicious-filter' }).audioEnhancement, 'clean');
  assert.equal(audioFilter('off'), undefined);
  assert.match(audioFilter('voice')!, /agate=/);
  assert.match(audioFilter('clean')!, /loudnorm=/);
});

test('real transcript responses, segment offsets, auth errors and summary fallback', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'clyps-test-'));
  const file = path.join(tmp, 'audio.mp3'); await writeFile(file, 'fixture');
  const originalFetch = globalThis.fetch;
  process.env.STT_API_KEY = 'fixture'; process.env.LLM_API_KEY = 'fixture'; process.env.LLM_MODEL = 'fixture';
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal((init?.body as FormData).get('response_format'), 'verbose_json');
      return Response.json({ words: [{ word: 'verdadeiro', start: 1, end: 2 }] });
    };
    const all = await transcribe([file, file], 'pt', async () => {});
    assert.equal(all[1].start, 1201);
    assert.equal(all[0].word, 'verdadeiro');
    globalThis.fetch = async () => new Response('secret provider data', { status: 401 });
    await assert.rejects(transcribeFile(file, 'pt'), /chave de transcrição foi recusada/);
    const text = 'Uma fala real com conteúdo suficiente para criar a legenda.';
    assert.deepEqual(await postCaption(text, 'pt'), { caption: text, source: 'excerpt' });
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ caption: 'Resumo da fala.' }) } }] });
    assert.deepEqual(await postCaption(text, 'pt'), { caption: 'Resumo da fala.', source: 'ai' });
    assert.ok(excerpt('palavra '.repeat(100)).length <= 281);
  } finally { globalThis.fetch = originalFetch; await rm(tmp, { recursive: true, force: true }); }
});
