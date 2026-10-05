import { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost";

const classes = (variant: Variant, block?: boolean, extra?: string) =>
  ["sw-btn", `sw-btn--${variant}`, block && "sw-btn--block", extra].filter(Boolean).join(" ");

export function Button({
  variant = "primary",
  block,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean }) {
  return <button type="button" className={classes(variant, block, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  block,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; block?: boolean }) {
  return <a className={classes(variant, block, className)} {...props} />;
}
