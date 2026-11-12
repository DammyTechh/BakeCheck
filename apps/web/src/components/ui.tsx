/**
 * The small set of primitives every screen is built from.
 *
 * Kept in one file on purpose: a lab tool needs a handful of controls that
 * behave identically everywhere, not a component library. Anything that
 * appears once lives with the screen that uses it.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { FALLBACK_ICON, ICONS } from './icon-paths';
import './ui.css';

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  const def = ICONS[name] ?? FALLBACK_ICON;

  // aria-hidden throughout: every icon in this app sits beside its own label,
  // so announcing it would just repeat the text.
  //
  // Drawn rather than loaded from an icon font: a font that has not arrived
  // yet renders its ligature as literal text, so a button reads
  // "photo_camera" until the network catches up. On a slow laboratory
  // connection that is the state a user actually sees.
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {def.paths.map((d) => (
        <path key={d} d={d} {...(def.fill ? { fill: 'currentColor', stroke: 'none' } : {})} />
      ))}
      {def.circles?.map(([cx, cy, r]) => (
        <circle key={`${cx}-${cy}-${r}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'md' | 'sm';
  icon?: string;
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : null}
      {icon && !loading ? <Icon name={icon} className="icon-sm" /> : null}
      {children}
    </button>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title ? <h2 className="panel-title">{title}</h2> : null}
            {description ? <p className="panel-desc">{description}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      )}
      <div className={padded ? 'panel-body' : undefined}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`} role="alert">
          <Icon name="error" className="icon-sm" />
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({
  invalid,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={`control ${invalid ? 'control-invalid' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Select({
  invalid,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={`control ${invalid ? 'control-invalid' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Textarea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`control control-area ${className}`} {...rest} />;
}

export type PillTone = 'neutral' | 'ok' | 'caution' | 'stop' | 'accent';

/**
 * A status label. The word carries the meaning; colour only reinforces it,
 * so this stays readable in monochrome and for colour-blind readers.
 */
export function Pill({
  tone = 'neutral',
  children,
  icon,
}: {
  tone?: PillTone;
  children: ReactNode;
  icon?: string;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon ? <Icon name={icon} className="icon-sm" /> : null}
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} className="icon-lg empty-icon" />
      <h3 className="empty-title">{title}</h3>
      {children ? <p className="empty-body">{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** A short run of label/value pairs — sample metadata, model details. */
export function DataList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; mono?: boolean }>;
}) {
  return (
    <dl className="datalist">
      {items.map((item) => (
        <div className="datalist-row" key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? 'mono' : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Banner({
  tone = 'neutral',
  icon,
  title,
  children,
}: {
  tone?: 'neutral' | 'caution' | 'stop' | 'accent';
  icon?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'stop' ? 'alert' : undefined}>
      {icon ? <Icon name={icon} /> : null}
      <div>
        {title ? <strong className="banner-title">{title}</strong> : null}
        <div className="banner-body">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message =
    error instanceof Error ? error.message : 'Something went wrong. Try again.';
  return (
    <Banner tone="stop" icon="error" title="That did not work">
      {message}
    </Banner>
  );
}
