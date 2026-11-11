import { useEffect, useRef, useState } from 'react';
import HashtagChips from './HashtagChips';

/** Popup com a legenda sugerida para o post. Editável antes de copiar. */
export default function PostCaptionModal({
  clipId,
  title,
  caption,
  downloading,
  onClose,
}: {
  clipId: string;
  title: string;
  caption: string;
  downloading: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState(caption);
  const [copied, setCopied] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Sem permissão de área de transferência (HTTP sem domínio): seleciona para Ctrl+C.
      areaRef.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="post-modal-title">
        <div className="modal-head">
          <h2 id="post-modal-title">Legenda para o post</h2>
          <button type="button" className="link" onClick={onClose} aria-label="Fechar">
            Fechar
          </button>
        </div>
        {downloading && <p className="ok small">O download de “{title}” começou.</p>}
        <textarea ref={areaRef} rows={7} value={text} onChange={(e) => setText(e.target.value)} />
        <HashtagChips clipId={clipId} text={text} onChange={setText} />
        <div className="row">
          <button type="button" className="primary" onClick={copy}>
            {copied ? 'Copiada!' : 'Copiar legenda'}
          </button>
          <span className="muted small">{text.length} caracteres · dá para editar antes de copiar</span>
        </div>
      </div>
    </div>
  );
}
