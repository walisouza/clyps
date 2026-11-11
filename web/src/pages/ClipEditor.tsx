import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Segmented from '../components/Segmented';
import { api } from '../lib/api';
import { MAX_ZOOM, placement, targetSize, type Framing } from '../lib/framing';
import type { CaptionSettings, EditorData } from '../lib/types';

const MIN_LEN = 2;
const SIZE_SCALE = { small: 0.8, medium: 1, large: 1.3 } as const;

/** Tempo relativo em m:ss.d */
function fmt(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export default function ClipEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtEnd = useRef(false);
  const bgRef = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);

  const [data, setData] = useState<EditorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [captions, setCaptions] = useState<CaptionSettings | null>(null);
  const [texts, setTexts] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [post, setPost] = useState('');
  const [time, setTime] = useState(0);
  const [framing, setFraming] = useState<Framing | null>(null);
  const [srcSize, setSrcSize] = useState<{ w: number; h: number } | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .getEditor(id)
      .then((d) => {
        setData(d);
        setStart(d.clip.startMs / 1000);
        setEnd(d.clip.endMs / 1000);
        setCaptions(d.captions);
        setFraming(d.framing);
        setTexts(d.segments.map((s) => s.text));
        setTitle(d.clip.title);
        setPost(d.clip.postCaption ?? '');
        setTime(d.clip.startMs / 1000);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Erro ao abrir o editor.'));
  }, [id]);

  const cleanStart = data ? data.clean.startMs / 1000 : 0;
  const cleanEnd = data ? data.clean.endMs / 1000 : 0;
  const total = Math.max(0.1, cleanEnd - cleanStart);
  const pct = (t: number) => `${(((t - cleanStart) / total) * 100).toFixed(3)}%`;

  // Ao abrir, posiciona o vídeo no início do corte.
  function onLoaded() {
    const v = videoRef.current;
    if (!v || !data) return;
    if (v.videoWidth && v.videoHeight) setSrcSize({ w: v.videoWidth, h: v.videoHeight });
    v.currentTime = Math.max(0, start - cleanStart);
  }

  // O fundo desfocado é uma segunda cópia do vídeo, sem som, que acompanha a principal.
  function syncBg() {
    const v = videoRef.current;
    const b = bgRef.current;
    if (!v || !b) return;
    if (Math.abs(b.currentTime - v.currentTime) > 0.25) b.currentTime = v.currentTime;
    if (v.paused !== b.paused) void (v.paused ? b.pause() : b.play().catch(() => {}));
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    stopAtEnd.current = false;
    if (v.paused) void v.play();
    else v.pause();
  }

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    const abs = cleanStart + v.currentTime;
    setTime(abs);
    syncBg();
    if (stopAtEnd.current && abs >= end) {
      v.pause();
      stopAtEnd.current = false;
    }
  }

  function seek(abs: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, abs - cleanStart), total);
    setTime(abs);
  }

  function playSelection() {
    const v = videoRef.current;
    if (!v) return;
    seek(start);
    stopAtEnd.current = true;
    void v.play();
  }

  function onTrackClick(e: MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    seek(cleanStart + ((e.clientX - r.left) / r.width) * total);
  }

  const clampStart = (v: number) => Math.min(Math.max(cleanStart, v), end - MIN_LEN);
  const clampEnd = (v: number) => Math.max(Math.min(cleanEnd, v), start + MIN_LEN);

  // Prévia da legenda sobre o vídeo (aproximada: o resultado final é gerado no servidor).
  const preview = useMemo(() => {
    if (!data || !captions?.enabled || time < start || time > end) return null;
    const i = data.segments.findIndex((s) => time >= s.start - 0.05 && time <= s.end + 0.35);
    if (i < 0 || !texts[i]?.trim()) return null;
    const unchanged = texts[i] === data.segments[i].text;
    const seg = data.segments[i];
    const words = unchanged
      ? data.words.filter((w) => w.start >= seg.start - 1e-6 && w.end <= seg.end + 1e-6).map((w) => ({ ...w, word: w.word.trim() }))
      : texts[i].trim().split(/\s+/).map((w) => ({ word: w, start: -1, end: -1 }));
    return words.map((w, k) => {
      const active = captions.style !== 'minimal' && unchanged && time >= w.start && time < w.end + 0.05;
      const text = captions.style === 'bold' ? w.word.toUpperCase() : w.word;
      return (
        <span key={k} style={active ? { color: captions.highlightColor } : undefined}>
          {text}{' '}
        </span>
      );
    });
  }, [data, captions, texts, time, start, end]);

  const visibleSegments = useMemo(
    () => (data ? data.segments.map((s, i) => ({ ...s, i })).filter((s) => s.end >= start && s.start <= end) : []),
    [data, start, end],
  );
  const editedCount = data ? texts.filter((t, i) => t !== data.segments[i].text).length : 0;

  async function save() {
    if (!data || !captions || !id) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveEditor(id, {
        version: data.clip.version,
        startMs: Math.round(start * 1000),
        endMs: Math.round(end * 1000),
        title,
        postCaption: post,
        captions,
        texts,
        framing: framing!,
      });
      navigate(`/jobs/${data.clip.jobId}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Não foi possível salvar.');
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div className="stack">
        <p className="error">{error}</p>
        <button className="link" onClick={() => navigate(-1)}>
          ← Voltar
        </button>
      </div>
    );
  }
  if (!data || !captions || !framing) return <p className="muted">Carregando o editor…</p>;

  const setCap = <K extends keyof CaptionSettings>(k: K, v: CaptionSettings[K]) => setCaptions({ ...captions, [k]: v });
  const setFrame = <K extends keyof Framing>(k: K, v: Framing[K]) => setFraming({ ...framing, [k]: v });
  // Clipes antigos guardaram a versão limpa já reenquadrada: só dá para dar zoom dentro dela.
  const legacy = data.cleanKind === 'framed';
  const canChangeLayout = !legacy && data.clip.aspect !== 'original';
  const target = srcSize ? targetSize(data.clip.aspect, data.cleanKind, srcSize) : null;
  const place = srcSize && target ? placement(srcSize, target, framing) : null;
  const slackX = place && target ? target.w - place.fw : 0;
  const slackY = place && target ? target.h - place.fh : 0;
  const ratio = target ? target.w / target.h : 9 / 16;
  const box = (p: { fw: number; fh: number; ox: number; oy: number }) =>
    target
      ? {
          left: `${(p.ox / target.w) * 100}%`,
          top: `${(p.oy / target.h) * 100}%`,
          width: `${(p.fw / target.w) * 100}%`,
          height: `${(p.fh / target.h) * 100}%`,
        }
      : undefined;
  const bgPlace = srcSize && target ? placement(srcSize, target, { layout: 'fill', zoom: 1, x: 0.5, y: 0.5 }) : null;
  const showBg = Boolean(place && target && (place.ox > 0.5 || place.oy > 0.5 || place.ox + place.fw < target.w - 0.5 || place.oy + place.fh < target.h - 0.5));

  // Arrastar o vídeo muda a posição; um toque sem arrastar dá play/pausa.
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: framing!.x, y: framing!.y, moved: false };
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !target) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const k = target.w / e.currentTarget.getBoundingClientRect().width;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    setFraming({
      ...framing!,
      x: Math.abs(slackX) > 1 ? clamp(d.x + (dx * k) / slackX) : framing!.x,
      y: Math.abs(slackY) > 1 ? clamp(d.y + (dy * k) / slackY) : framing!.y,
    });
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) togglePlay();
  }

  return (
    <div className="stack">
      <div className="page-head">
        <Link to={`/jobs/${data.clip.jobId}`} className="link">
          ← Voltar ao corte
        </Link>
        <h1>Editar clipe</h1>
        <p className="muted">
          O vídeo abaixo é a versão sem legenda, com alguns segundos a mais antes e depois. Ajuste o corte, a legenda e
          os textos; ao salvar, o clipe é gerado de novo.
        </p>
      </div>

      {data.clip.rerendering && <p className="notice-box small">Este clipe ainda está sendo atualizado. Aguarde terminar para salvar outra edição.</p>}

      <div className="editor">
        <div className="editor-player">
          <div
            className={`player-frame framed${place ? '' : ' loading'}`}
            style={{ aspectRatio: String(ratio), width: `min(100%, calc(62vh * ${ratio.toFixed(4)}))` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (drag.current = null)}
            title="Arraste para enquadrar · toque para dar play"
          >
            {showBg && bgPlace && (
              <video
                ref={bgRef}
                className="frame-bg"
                src={api.clipUrl(data.clip.id, false, data.clip.version, 'clean')}
                muted
                playsInline
                preload="auto"
                style={box(bgPlace)}
                onLoadedMetadata={syncBg}
              />
            )}
            <video
              ref={videoRef}
              className="frame-video"
              src={api.clipUrl(data.clip.id, false, data.clip.version, 'clean')}
              playsInline
              preload="auto"
              style={place ? box(place) : undefined}
              onLoadedMetadata={onLoaded}
              onTimeUpdate={onTimeUpdate}
              onSeeked={onTimeUpdate}
              onPlay={() => { setPlaying(true); syncBg(); }}
              onPause={() => { setPlaying(false); syncBg(); }}
            />
            {preview && (
              <div
                className={`cap-preview cap-${captions.position} cap-${captions.style}`}
                style={{ ['--cap-scale' as string]: SIZE_SCALE[captions.size] }}
              >
                {preview}
              </div>
            )}
          </div>

          <div className="timeline" onClick={onTrackClick} role="presentation">
            <div className="timeline-range" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
            <div className="timeline-head" style={{ left: pct(time) }} />
          </div>
          <div className="timeline-labels mono small muted">
            <span>{fmt(0)}</span>
            <span>{fmt(total)}</span>
          </div>
          <p className="mono small">
            corte {fmt(start - cleanStart)} → {fmt(end - cleanStart)} · <strong>{(end - start).toFixed(1)}s</strong>
            <span className="muted"> · vídeo em {fmt(time - cleanStart)}</span>
          </p>
          <div className="row">
            <button type="button" className="chip strong" onClick={togglePlay} aria-label={playing ? 'Pausar' : 'Tocar'}>
              {playing ? '❚❚ Pausar' : '▶ Tocar'}
            </button>
            <button type="button" className="primary" onClick={playSelection}>
              ▶ Assistir o corte
            </button>
          </div>
        </div>

        <div className="editor-panel stack">
          <section className="card">
            <h2>Corte</h2>
            <div className="trim-row">
              <span className="trim-label">Início</span>
              <span className="mono">{fmt(start - cleanStart)}</span>
              <button type="button" className="chip" onClick={() => setStart(clampStart(start - 0.5))}>−0,5s</button>
              <button type="button" className="chip" onClick={() => setStart(clampStart(start + 0.5))}>+0,5s</button>
              <button type="button" className="chip strong" onClick={() => setStart(clampStart(time))}>Marcar aqui</button>
            </div>
            <div className="trim-row">
              <span className="trim-label">Fim</span>
              <span className="mono">{fmt(end - cleanStart)}</span>
              <button type="button" className="chip" onClick={() => setEnd(clampEnd(end - 0.5))}>−0,5s</button>
              <button type="button" className="chip" onClick={() => setEnd(clampEnd(end + 0.5))}>+0,5s</button>
              <button type="button" className="chip strong" onClick={() => setEnd(clampEnd(time))}>Marcar aqui</button>
            </div>
            <p className="muted small">"Marcar aqui" usa o ponto onde o vídeo está pausado. O corte pode ir até a borda da faixa.</p>
          </section>

          <section className="card">
            <h2>Enquadramento</h2>
            {canChangeLayout && (
              <Segmented
                label="Vídeo na tela"
                value={framing.layout}
                onChange={(v) => setFrame('layout', v)}
                options={[
                  { value: 'fill', label: 'Preencher' },
                  { value: 'blur', label: 'Inteiro com fundo' },
                ]}
              />
            )}
            <label className="field slider">
              <span>
                Zoom <span className="mono">{framing.zoom.toFixed(2).replace('.', ',')}×</span>
              </span>
              <input type="range" min={1} max={MAX_ZOOM} step={0.05} value={framing.zoom} onChange={(e) => setFrame('zoom', Number(e.target.value))} />
            </label>
            <label className="field slider">
              <span>Horizontal</span>
              <input type="range" min={0} max={1} step={0.005} value={framing.x} disabled={Math.abs(slackX) <= 1} onChange={(e) => setFrame('x', Number(e.target.value))} />
            </label>
            <label className="field slider">
              <span>Vertical</span>
              <input type="range" min={0} max={1} step={0.005} value={framing.y} disabled={Math.abs(slackY) <= 1} onChange={(e) => setFrame('y', Number(e.target.value))} />
            </label>
            <div className="row">
              <button type="button" className="chip" onClick={() => setFraming({ ...framing, zoom: 1, x: 0.5, y: 0.5 })}>
                Centralizar
              </button>
              <span className="muted small">Arraste o vídeo para escolher o que aparece.</span>
            </div>
            {legacy && (
              <p className="muted small">
                Este clipe foi gerado antes do enquadramento: dá para dar zoom e mover dentro do que já estava na tela. Cortes novos
                guardam o vídeo inteiro e permitem enquadrar à vontade.
              </p>
            )}
          </section>

          <section className="card">
            <h2>Legenda</h2>
            <Segmented
              label="Legenda"
              value={captions.enabled ? 'on' : 'off'}
              onChange={(v) => setCap('enabled', v === 'on')}
              options={[
                { value: 'on', label: 'Ligada' },
                { value: 'off', label: 'Desligada' },
              ]}
            />
            {captions.enabled && (
              <>
                <Segmented
                  label="Estilo"
                  value={captions.style}
                  onChange={(v) => setCap('style', v)}
                  options={[
                    { value: 'karaoke', label: 'Karaokê' },
                    { value: 'bold', label: 'Impacto' },
                    { value: 'minimal', label: 'Discreta' },
                  ]}
                />
                <Segmented
                  label="Tamanho"
                  value={captions.size}
                  onChange={(v) => setCap('size', v)}
                  options={[
                    { value: 'small', label: 'Pequena' },
                    { value: 'medium', label: 'Média' },
                    { value: 'large', label: 'Grande' },
                  ]}
                />
                <div className="row">
                  <Segmented
                    label="Posição"
                    value={captions.position}
                    onChange={(v) => setCap('position', v)}
                    options={[
                      { value: 'top', label: 'Em cima' },
                      { value: 'center', label: 'Centro' },
                      { value: 'bottom', label: 'Embaixo' },
                    ]}
                  />
                  {captions.style !== 'minimal' && (
                    <label className="field color">
                      Cor do destaque
                      <input type="color" value={captions.highlightColor} onChange={(e) => setCap('highlightColor', e.target.value)} />
                    </label>
                  )}
                </div>
              </>
            )}
          </section>

          {captions.enabled && (
            <section className="card">
              <h2>Texto da legenda {editedCount > 0 && <span className="badge processing">{editedCount} editado(s)</span>}</h2>
              <p className="muted small">Corrija o que a transcrição errou. Apague o texto de um trecho para tirá-lo da legenda.</p>
              {visibleSegments.length === 0 && <p className="muted small">Não há fala dentro do corte.</p>}
              <div className="seg-list">
                {visibleSegments.map((s) => (
                  <div key={s.i} className={`seg-row${time >= s.start && time <= s.end ? ' current' : ''}`}>
                    <button type="button" className="chip mono" onClick={() => seek(s.start)} title="Ir para este trecho">
                      {fmt(s.start - cleanStart)}
                    </button>
                    <input
                      value={texts[s.i]}
                      maxLength={300}
                      onChange={(e) => setTexts(texts.map((t, k) => (k === s.i ? e.target.value : t)))}
                      onFocus={() => seek(s.start)}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <h2>Publicação</h2>
            <label className="field">
              Título
              <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              Legenda do post
              <textarea rows={5} value={post} maxLength={2200} onChange={(e) => setPost(e.target.value)} />
            </label>
          </section>

          {saveError && <p className="error">{saveError}</p>}
          <div className="row">
            <button type="button" className="primary big" onClick={save} disabled={saving || data.clip.rerendering}>
              {saving ? 'Salvando…' : 'Salvar e gerar o clipe'}
            </button>
            <Link to={`/jobs/${data.clip.jobId}`} className="link">
              Cancelar
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
