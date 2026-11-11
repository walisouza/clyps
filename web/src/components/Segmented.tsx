import type { ReactNode } from 'react';

type Option<T extends string> = { value: T; label: string; hint?: string };

export default function Segmented<T extends string>(props: {
  label: ReactNode;
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

