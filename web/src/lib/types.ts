import type { CleanKind, Framing } from './framing';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type JobOptions = {
  language: 'pt' | 'en' | 'es';
  maxClips: number;
  clipLength: 'short' | 'medium' | 'long';
  aspect: '9:16' | '1:1' | '4:5' | 'original';
  layout: 'fill' | 'blur';
  captionStyle: 'karaoke' | 'bold' | 'minimal' | 'none';
  captionPosition: 'bottom' | 'center' | 'top';
  highlightColor: string;
  captionSize: 'small' | 'medium' | 'large';
  audioEnhance: 'off' | 'light' | 'strong' | 'auphonic';
  context?: string;
};

export type Job = {
  id: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  source_type: 'url' | 'upload';
  source_url: string | null;
  title: string | null;
  duration_seconds: number | null;
  options: Partial<JobOptions>;
  error: string | null;
  notice: string | null;
  created_at: string;
};

export type Features = { auphonic: boolean; transcription: 'speaches' | 'assemblyai' | 'openai' | null; textAi?: boolean; meta?: boolean };

export type Clip = {
  id: string;
  idx: number;
  title: string;
  reason: string | null;
  score: number | null;
  start_ms: number;
  end_ms: number;
  transcript: string | null;
  aspect: string;
  post_caption: string | null;
  energy: number | null;
  version: number;
  rerendering: boolean;
  render_error: string | null;
  editable: boolean;
};

export type CaptionSettings = {
  enabled: boolean;
  style: 'karaoke' | 'bold' | 'minimal';
  position: 'bottom' | 'center' | 'top';
  highlightColor: string;
  size: 'small' | 'medium' | 'large';
};

export type Word = { word: string; start: number; end: number };
export type Segment = { start: number; end: number; text: string };

export type EditorData = {
  clip: {
    id: string;
    jobId: string;
    title: string;
    postCaption: string | null;
    startMs: number;
    endMs: number;
    version: number;
    rerendering: boolean;
    aspect: string;
  };
  clean: { startMs: number; endMs: number };
  captions: CaptionSettings;
  framing: Framing;
  cleanKind: CleanKind;
  segments: Segment[];
  words: Word[];
};

export type VideoPreview = {
  title: string;
  duration: number;
  thumbnail: string | null;
  uploader: string | null;
  site: string | null;
  tooLong: boolean;
};

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Na fila',
  processing: 'Processando',
  completed: 'Pronto',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

export const STAGE_LABEL: Record<string, string> = {
  starting: 'Iniciando',
  downloading: 'Baixando o vídeo',
  analyzing: 'Medindo a energia do áudio',
  preparing_stt: 'Preparando a transcrição (na primeira vez baixa o modelo)',
  transcribing: 'Transcrevendo a fala',
  selecting: 'Escolhendo os melhores trechos',
  enhancing: 'Tratando a voz no Auphonic',
  rendering: 'Renderizando os clipes',
  done: 'Concluído',
};

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export type Network = 'instagram' | 'facebook';
export type PostStatus = 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
export type Post = {
  id: string;
  account: string | null;
  clipId: string;
  network: Network;
  pageId: string;
  caption: string;
  scheduledAt: string;
  status: PostStatus;
  permalink: string | null;
  error: string | null;
  createdAt: string;
  publishedAt: string | null;
};
export type MetaAccount = {
  pageId: string;
  pageName: string;
  pagePicture: string | null;
  instagram: { id: string; username: string | null; picture: string | null } | null;
  updatedAt: string;
};
export type MetaStatus = { configured: boolean; callbackUrl: string; accounts: MetaAccount[] };

export type TrendNews = { title: string; url: string; source: string };
export type Trend = { title: string; traffic: string; startedAt: string | null; picture: string | null; news: TrendNews[]; niche: boolean; hashtag: string };
export type NicheQuery = { query: string; value: string; kind: 'rising' | 'top'; seed: string; hashtag: string };
export type TrendsData = {
  geo: string;
  niche: { name: string; seeds: string[] };
  trending: Trend[];
  nicheQueries: NicheQuery[];
  trendingAt: string | null;
  nicheAt: string | null;
  trendingError: string | null;
  nicheError: string | null;
  refreshing: boolean;
};
export type HashtagSuggestion = { tag: string; reason: 'em alta' | 'nicho em alta' | 'nicho' };
