import type { Framing } from './framing';
import type { CaptionSettings, Clip, EditorData, Features, Job, JobOptions, HashtagSuggestion, MetaStatus, Network, Post, TrendsData, VideoPreview } from './types';

export type User = { id: string; email: string; credits: number; isAdmin: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Algo deu errado. Tente de novo.');
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  me: () => request<{ user: User | null; signupOpen: boolean; mock: boolean; features?: Features }>('/me'),
  preview: (url: string) => request<VideoPreview>(`/preview?url=${encodeURIComponent(url)}`),
  login: (email: string, password: string) => post<{ user: User }>('/login', { email, password }),
  signup: (email: string, password: string) => post<{ user: User }>('/signup', { email, password }),
  logout: () => post<{ ok: true }>('/logout', {}),
  changePassword: (current: string, next: string) => post<{ ok: true }>('/account/password', { current, next }),
  listUsers: () => request<{ users: { id: string; email: string; createdAt: string; isAdmin: boolean }[] }>('/users'),
  createUser: (email: string, password: string) => post<{ id: string }>('/users', { email, password }),
  resetUserPassword: (id: string, password: string) => post<{ ok: true }>(`/users/${id}/password`, { password }),
  deleteUser: (id: string) => request<{ ok: true }>(`/users/${id}`, { method: 'DELETE' }),

  listJobs: () => request<{ jobs: Job[] }>('/jobs'),
  getJob: (id: string) => request<{ job: Job; clips: Clip[]; posts: Post[] }>(`/jobs/${id}`),
  deleteJob: (id: string) => request<{ ok: true }>(`/jobs/${id}`, { method: 'DELETE' }),
  retryJob: (id: string) => post<{ ok: true }>(`/jobs/${id}/retry`, {}),
  createJob: (
    source: { sourceType: 'url'; url: string } | { sourceType: 'upload'; uploadId: string; title: string },
    options: JobOptions,
  ) => post<{ id: string }>('/jobs', { ...source, options }),

  /** Envia o arquivo como corpo da requisição, com progresso. */
  upload(file: File, onProgress: (percent: number) => void): Promise<{ uploadId: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/uploads');
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        let data: { uploadId?: string; error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* resposta sem JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.uploadId) resolve({ uploadId: data.uploadId });
        else reject(new Error(data.error || 'O envio falhou.'));
      };
      xhr.onerror = () => reject(new Error('O envio falhou. Confira sua conexão.'));
      xhr.send(file);
    });
  },

  /** URL do vídeo do clipe; a versão muda a cada edição, o que evita mostrar o arquivo antigo do cache. */
  clipUrl: (clipId: string, download = false, version = 0, variant?: 'clean') => {
    const q = new URLSearchParams();
    if (download) q.set('download', '1');
    if (version) q.set('v', String(version));
    if (variant) q.set('variant', variant);
    const s = q.toString();
    return `/api/clips/${clipId}/file${s ? `?${s}` : ''}`;
  },

  getEditor: (clipId: string) => request<EditorData>(`/clips/${clipId}/editor`),
  saveEditor: (
    clipId: string,
    body: {
      version: number;
      startMs: number;
      endMs: number;
      title: string;
      postCaption: string;
      captions: CaptionSettings;
      texts: string[];
      framing: Framing;
    },
  ) => request<{ ok: true }>(`/clips/${clipId}/editor`, { method: 'PUT', body: JSON.stringify(body) }),

  trends: (refresh = false) => request<TrendsData>(`/trends${refresh ? '?refresh=1' : ''}`),
  hashtags: (clipId: string) => request<{ hashtags: HashtagSuggestion[] }>(`/trends/hashtags?clipId=${encodeURIComponent(clipId)}`),

  meta: {
    status: () => request<MetaStatus>('/meta/status'),
    connectUrl: '/api/meta/connect',
    disconnect: () => request<{ ok: true }>('/meta', { method: 'DELETE' }),
    publish: (clipId: string, body: { targets: { network: Network; pageId: string }[]; caption: string; scheduledAt?: string }) =>
      post<{ posts: Post[] }>(`/clips/${clipId}/posts`, body),
    cancel: (postId: string) => request<{ ok: true }>(`/posts/${postId}`, { method: 'DELETE' }),
    retry: (postId: string) => post<{ ok: true }>(`/posts/${postId}/retry`, {}),
  },

  cookies: {
    status: () => request<{ hasCookies: boolean; uploadedAt?: string; size?: number }>('/cookies'),
    remove: () => request<{ ok: true }>('/cookies', { method: 'DELETE' }),
    async upload(file: File): Promise<{ hasCookies: boolean; uploadedAt?: string; size?: number }> {
      const res = await fetch('/api/cookies', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'text/plain' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Falha ao enviar os cookies.');
      return data as { hasCookies: boolean; uploadedAt?: string; size?: number };
    },
  },
};
