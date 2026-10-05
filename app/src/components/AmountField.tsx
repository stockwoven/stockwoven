import { ReactNode, useId } from "react";

export const isAmount = (v: string) => /^\d*\.?\d*$/.test(v.trim());

export function AmountField({
  label,
  value,
  onChange,
  suffix,
  hint,
  action,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  suffix: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field__row">
        <label htmlFor={id} className="t-label">
          {label}
        </label>
        {hint && <span className="t-data muted">{hint}</span>}
      </div>
      <div className="field__box" data-invalid={!isAmount(value)}>
        <input
          id={id}
          className="t-data-lg"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
          aria-invalid={!isAmount(value)}
        />
        <span className="field__suffix t-data">{suffix}</span>
        {action}
      </div>
    </div>
  );
}
