import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'clyps-meta-test-'));
const { db } = await import('../src/db.js');
const { initPublications, metaAvailable, signedMediaUrl, validMediaSignature, schedulePublication, publicationTick } = await import('../src/meta.js');
const { assertAiConfigured } = await import('../src/pipeline.js');

const owner = 'owner';
Object.assign(process.env, {
  META_OWNER_USER_ID: owner, META_IG_USER_ID: '123', META_ACCESS_TOKEN: 'test-token',
  META_GRAPH_VERSION: 'v99.0', PUBLIC_BASE_URL: 'https://clyps.example.com', MEDIA_SIGNING_SECRET: 'a'.repeat(64),
});
initPublications();
db().prepare('insert into users (id, email, password_hash) values (?, ?, ?)').run(owner, 'owner@example.com', 'fixture');
db().prepare("insert into jobs (id, user_id, source_type) values ('job', ?, 'upload')").run(owner);
const file = path.join(process.env.DATA_DIR!, 'clip.mp4'); writeFileSync(file, 'fixture');
db().prepare("insert into clips (id, job_id, user_id, idx, title, start_ms, end_ms, file_path, aspect) values ('clip', 'job', ?, 0, 't', 0, 30000, ?, '9:16')").run(owner, file);
const clip: any = db().prepare("select * from clips where id = 'clip'").get();

test('configuration errors are actionable and mock mode is blocked in production', () => {
  process.env.NODE_ENV = 'production'; process.env.MOCK_AI = '1';
  assert.throws(assertAiConfigured, /Modo de teste bloqueado/);
  process.env.MOCK_AI = '0';
  assert.throws(assertAiConfigured, /chaves de IA/);
});

test('only configured owner has publishing access and signed URLs cannot be tampered with', () => {
  assert.equal(metaAvailable(owner), true); assert.equal(metaAvailable('someone-else'), false);
  const url = new URL(signedMediaUrl('clip'));
  const expires = url.searchParams.get('expires'); const sig = url.searchParams.get('signature');
  assert.equal(validMediaSignature('clip', expires, sig), true);
  assert.equal(validMediaSignature('other', expires, sig), false);
  assert.equal(validMediaSignature('clip', 1, sig), false);
  assert.equal(validMediaSignature('clip', expires, 'bad'), false);
});

test('future schedules, duplicate protection, container readiness and uncertain publish outcome', async () => {
  const original = globalThis.fetch;
  try {
    assert.throws(() => schedulePublication('other', clip, 'caption', null), /não está configurada/);
    assert.throws(() => schedulePublication(owner, clip, 'caption', 'invalid'), /horário/);
    assert.throws(() => schedulePublication(owner, clip, 'caption', new Date(Date.now() - 1000).toISOString()), /horário/);
    assert.throws(() => schedulePublication(owner, clip, 'a'.repeat(2201), null), /2.200/);
    const id = schedulePublication(owner, clip, 'caption', new Date(Date.now() + 120_000).toISOString());
    assert.throws(() => schedulePublication(owner, clip, 'caption', null), /pendente/);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
    await publicationTick(); assert.equal(calls, 0);
    db().prepare('update publications set scheduled_at = ? where id = ?').run(Date.now() - 1, id);
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal((init?.headers as any).Authorization, 'Bearer test-token');
      assert.match(String(url), /\/123\/media$/);
      return Response.json({ id: 'container' });
    };
    await publicationTick(); assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ status_code: 'IN_PROGRESS' });
    await publicationTick();
    assert.equal((db().prepare('select status from publications where id = ?').get(id) as any).status, 'processing');
    globalThis.fetch = async (url) => String(url).includes('media_publish') ? Response.json({ id: 'published-media' }) : Response.json({ status_code: 'FINISHED' });
    await publicationTick();
    assert.equal((db().prepare('select status from publications where id = ?').get(id) as any).status, 'published');
    const second = schedulePublication(owner, clip, 'caption', null);
    globalThis.fetch = async () => Response.json({ id: 'container-2' }); await publicationTick();
    globalThis.fetch = async (url) => {
      if (String(url).includes('media_publish')) throw new Error('lost response');
      return Response.json({ status_code: 'FINISHED' });
    };
    await publicationTick();
    assert.equal((db().prepare('select status from publications where id = ?').get(second) as any).status, 'uncertain');
    globalThis.fetch = async () => { throw new Error('must not retry'); }; await publicationTick();
    assert.throws(() => schedulePublication(owner, clip, 'caption', null), /pendente/);
    db().prepare("update publications set status = 'publishing' where id = ?").run(second);
    initPublications();
    assert.equal((db().prepare('select status from publications where id = ?').get(second) as any).status, 'uncertain');
  } finally { globalThis.fetch = original; }
});
