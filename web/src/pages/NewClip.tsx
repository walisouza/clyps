import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { JobOptions } from '../lib/types';

const DEFAULTS: JobOptions = {
  language: 'pt',
  maxClips: 6,
  clipLength: 'medium',
  aspect: '9:16',
  layout: 'fill',
  captionStyle: 'karaoke',
  captionPosition: 'bottom',
  highlightColor: '#FFE14D',
};

const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
const ACCEPTED = ['video/mp4', 'video/quicktime', 'video/webm'];

type Option<T extends string> = { value: T; label: string; hint?: string };

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="field">
      <legend>{props.label}</legend>
      <div className="segmented">
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={o.value === props.value ? 'on' : ''}
            aria-pressed={o.value === props.value}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
            {o.hint && <small>{o.hint}</small>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export default function NewClip() {
  const navigate = useNavigate();
  const [source, setSource] = useState<'url' | 'upload'>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [opts, setOpts] = useState<JobOptions>(DEFAULTS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof JobOptions>(key: K, value: JobOptions[K]) => setOpts((o) => ({ ...o, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      let created: { id: string };
      if (source === 'url') {
        if (!/^https?:\/\/\S+$/i.test(url.trim())) throw new Error('Cole um link válido (começando com http).');
        setBusy('Criando o corte…');
        created = await api.createJob({ sourceType: 'url', url: url.trim() }, opts);
      } else {
        if (!file) throw new Error('Escolha um arquivo de vídeo.');
        if (!ACCEPTED.includes(file.type)) throw new Error('Formato não aceito. Use MP4, MOV ou WebM.');
        if (file.size > MAX_UPLOAD_BYTES) throw new Error('O arquivo passa de 4 GB.');
        setBusy('Enviando o vídeo… 0%');
        const { uploadId } = await api.upload(file, (p) => setBusy(`Enviando o vídeo… ${p}%`));
        setBusy('Criando o corte…');
        created = await api.createJob({ sourceType: 'upload', uploadId, title: file.name }, opts);
      }
      navigate(`/jobs/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Algo deu errado.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="page-head">
        <h1>Novo corte</h1>
        <p className="muted">
          Envie um vídeo com fala. A IA transcreve, escolhe os melhores trechos e entrega os clipes já no formato e com
          legenda.
        </p>
      </div>

      <section className="card">
        <Segmented
          label="Fonte do vídeo"
          value={source}
          onChange={setSource}
          options={[
            { value: 'url', label: 'Link' },
            { value: 'upload', label: 'Arquivo' },
          ]}
        />
        {source === 'url' ? (
          <label className="field">
            Link do vídeo
            <input
              type="url"
              placeholder="YouTube, Facebook, Instagram, TikTok, Twitch…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <small className="muted">
              Qualquer link público de vídeo. Vídeos privados ou restritos podem não baixar.
            </small>
          </label>
        ) : (
          <label className="field">
            Arquivo (MP4, MOV ou WebM, até 4 GB)
            <input type="file" accept={ACCEPTED.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        <Segmented
          label="Idioma da fala"
          value={opts.language}
          onChange={(v) => set('language', v)}
          options={[
            { value: 'pt', label: 'Português' },
            { value: 'en', label: 'English' },
            { value: 'es', label: 'Español' },
          ]}
        />
      </section>

      <section className="card">
        <h2>Cortes</h2>
        <Segmented
          label="Duração de cada clipe"
          value={opts.clipLength}
          onChange={(v) => set('clipLength', v)}
          options={[
            { value: 'short', label: 'Curto', hint: '15–40s' },
            { value: 'medium', label: 'Médio', hint: '30–60s' },
            { value: 'long', label: 'Longo', hint: '45–90s' },
          ]}
        />
        <label className="field">
          Quantidade máxima: <strong>{opts.maxClips}</strong>
          <input
            type="range"
            min={1}
            max={15}
            value={opts.maxClips}
            onChange={(e) => set('maxClips', Number(e.target.value))}
          />
        </label>
        <label className="field">
          Contexto para a IA (opcional)
          <textarea
            rows={2}
            maxLength={1000}
            placeholder="Ex.: podcast de marketing; priorize dicas práticas e histórias com número."
            value={opts.context ?? ''}
            onChange={(e) => set('context', e.target.value)}
          />
        </label>
      </section>

      <section className="card">
        <h2>Formato e legenda</h2>
        <Segmented
          label="Formato"
          value={opts.aspect}
          onChange={(v) => set('aspect', v)}
          options={[
            { value: '9:16', label: '9:16', hint: 'Shorts, Reels' },
            { value: '1:1', label: '1:1', hint: 'Quadrado' },
            { value: '4:5', label: '4:5', hint: 'Feed' },
            { value: 'original', label: 'Original' },
          ]}
        />
        {opts.aspect !== 'original' && (
          <Segmented
            label="Enquadramento"
            value={opts.layout}
            onChange={(v) => set('layout', v)}
            options={[
              { value: 'fill', label: 'Preencher', hint: 'corta as laterais' },
              { value: 'blur', label: 'Inteiro', hint: 'fundo desfocado' },
            ]}
          />
        )}
        <Segmented
          label="Estilo da legenda"
          value={opts.captionStyle}
          onChange={(v) => set('captionStyle', v)}
          options={[
            { value: 'karaoke', label: 'Karaokê', hint: 'palavra destacada' },
            { value: 'bold', label: 'Impacto', hint: 'poucas palavras, grande' },
            { value: 'minimal', label: 'Discreta' },
            { value: 'none', label: 'Sem legenda' },
          ]}
        />
        {opts.captionStyle !== 'none' && (
          <div className="row">
            <Segmented
              label="Posição"
              value={opts.captionPosition}
              onChange={(v) => set('captionPosition', v)}
              options={[
                { value: 'bottom', label: 'Embaixo' },
                { value: 'center', label: 'Centro' },
                { value: 'top', label: 'Em cima' },
              ]}
            />
            {opts.captionStyle !== 'minimal' && (
              <label className="field color">
                Cor do destaque
                <input type="color" value={opts.highlightColor} onChange={(e) => set('highlightColor', e.target.value)} />
              </label>
            )}
          </div>
        )}
      </section>

      {error && <p className="error">{error}</p>}
      <button className="primary big" disabled={busy !== null}>
        {busy ?? 'Gerar cortes'}
      </button>
    </form>
  );
}
