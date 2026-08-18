import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

function classes(base: string, className?: string): string {
  return className ? `${base} ${className}` : base;
}

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className, disabled, loading = false, type = 'button', ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classes('church-button', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <>
          <Spinner label="Loading" />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

export interface InputProps extends ComponentPropsWithoutRef<'input'> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error, id, className, 'aria-describedby': describedBy, ...props },
  ref,
) {
  const errorId = id && error ? `${id}-error` : undefined;
  const description = [describedBy, errorId].filter(Boolean).join(' ');

  return (
    <div className="church-field">
      <input
        {...props}
        id={id}
        ref={ref}
        className={classes('church-input', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={description || undefined}
      />
      {error ? (
        <span id={errorId} className="church-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});

export const Select = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<'select'>>(
  function Select({ className, ...props }, ref) {
    return <select {...props} ref={ref} className={classes('church-select', className)} />;
  },
);

export const Card = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function Card(
  { className, ...props },
  ref,
) {
  return <div {...props} ref={ref} className={classes('church-card', className)} />;
});

export const Badge = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<'span'>>(function Badge(
  { className, ...props },
  ref,
) {
  return <span {...props} ref={ref} className={classes('church-badge', className)} />;
});

export interface SpinnerProps extends ComponentPropsWithoutRef<'span'> {
  label?: string;
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { className, label = 'Loading', ...props },
  ref,
) {
  return (
    <span {...props} ref={ref} className={classes('church-spinner', className)} role="status">
      <span className="church-spinner__mark" aria-hidden="true" />
      <span className="church-visually-hidden">{label}</span>
    </span>
  );
});

export interface EmptyStateProps extends ComponentPropsWithoutRef<'section'> {
  title: string;
  action?: ReactNode;
}

export const EmptyState = forwardRef<HTMLElement, EmptyStateProps>(function EmptyState(
  { title, children, action, className, ...props },
  ref,
) {
  return (
    <section {...props} ref={ref} className={classes('church-empty', className)}>
      <h2>{title}</h2>
      {children ? <div>{children}</div> : null}
      {action}
    </section>
  );
});
