// Diagnóstico das integrações de IA. Na VPS:
//   docker compose exec app npx tsx src/check-ai.ts
// Mostra se cada chave é aceita e quais formatos de pedido o LLM Gateway aceita. Nunca imprime as chaves.
import { config, isPlaceholder } from './config.js';
import { chat, probeGateway } from './llm.js';

const mask = (k: string) => (k ? `${k.slice(0, 4)}… (${k.length} caracteres)` : '(vazia)');
const line = (ok: boolean, text: string) => console.log(`${ok ? '  OK    ' : '  FALHA '} ${text}`);

console.log(`Modo de teste (MOCK_AI): ${config.mock ? 'LIGADO — a IA não é chamada nos cortes' : 'desligado'}`);
console.log(`Transcrição: ${config.sttProvider ?? 'não configurada'}`);
console.log(`LLM: ${config.llmViaAssemblyAI ? 'LLM Gateway da AssemblyAI' : config.llmBaseUrl} · modelo ${(() => {
  try {
    return config.llmModel;
  } catch {
    return '(não configurado)';
  }
})()}`);
console.log('');

if (config.sttProvider === 'speaches') {
  console.log(`Speaches — ${config.speachesUrl} · modelo ${config.speachesModel}`);
  try {
    const h = await fetch(config.speachesUrl.replace(/\/v1$/, '') + '/health');
    line(h.ok, `serviço: HTTP ${h.status}`);
    const m = await fetch(`${config.speachesUrl}/models/${config.speachesModel}`);
    line(m.ok, m.ok ? 'modelo instalado' : `modelo ainda não instalado (HTTP ${m.status}); é baixado no primeiro corte`);
  } catch (err) {
    line(false, `sem resposta (${(err as Error).message}). Confira: docker compose ps / docker compose logs speaches`);
  }
  console.log(config.llmConfigured ? '' : 'IA de texto: não configurada — os trechos serão escolhidos pela energia da fala e pelas frases.\n');
}

if (config.sttProvider === 'openai') {
  console.log(`Transcrição (padrão OpenAI) — ${config.sttBaseUrl} · modelo ${config.sttModel} · chave ${mask(config.sttApiKey)}`);
  try {
    const r = await fetch(`${config.sttBaseUrl}/models`, { headers: { Authorization: `Bearer ${config.sttApiKey}` } });
    line(r.ok, `chave: HTTP ${r.status}${r.ok ? '' : ` — ${(await r.text()).replace(/\s+/g, ' ').slice(0, 160)}`}`);
  } catch (err) {
    line(false, `sem resposta (${(err as Error).message})`);
  }
  console.log('');
}

if (config.llmConfigured && !config.llmViaAssemblyAI) {
  console.log(`IA de texto — ${config.llmBaseUrl} · modelo ${config.llmModel} · chave ${mask(config.llmApiKey)}`);
  if (isPlaceholder(config.llmApiKey)) line(false, 'a chave ainda é o texto de exemplo');
  try {
    const reply = await chat('Responda só com JSON.', 'Responda exatamente {"ok":true}');
    line(/ok/.test(reply), `resposta: ${reply.replace(/\s+/g, ' ').slice(0, 80)}`);
  } catch (err) {
    line(false, (err as Error).message);
  }
  console.log('');
}

if (config.assemblyaiApiKey) {
  console.log(`AssemblyAI — chave ${mask(config.assemblyaiApiKey)}`);
  if (isPlaceholder(config.assemblyaiApiKey)) line(false, 'a chave ainda é o texto de exemplo');
  const res = await fetch(`${config.assemblyaiBaseUrl}/v2/transcript?limit=1`, {
    headers: { authorization: config.assemblyaiApiKey },
  });
  line(res.ok, `transcrição: HTTP ${res.status}${res.ok ? '' : ` — ${(await res.text()).slice(0, 160)}`}`);

  if (config.llmViaAssemblyAI) {
    for (const r of await probeGateway()) {
      line(r.status >= 200 && r.status < 300, `LLM Gateway [${r.label}]: HTTP ${r.status} — ${r.body}`);
    }
  }
  console.log('');
}

if (config.auphonicApiKey) {
  console.log(`Auphonic — chave ${mask(config.auphonicApiKey)}`);
  const res = await fetch(`${config.auphonicBaseUrl}/api/user.json`, {
    headers: { Authorization: `bearer ${config.auphonicApiKey}` },
  });
  const body: any = await res.json().catch(() => ({}));
  const credits = body?.data?.credits;
  line(res.ok, `conta: HTTP ${res.status}${res.ok ? ` — usuário ${body?.data?.username ?? '?'}${credits !== undefined ? `, créditos ${credits} h` : ''}` : ''}`);
} else {
  console.log('Auphonic — não configurado (opcional)');
}
