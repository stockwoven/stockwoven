import { ElementType, ReactNode } from "react";

/**
 * A heading that steps one style down the type scale on small screens (e.g. display-lg → heading-md).
 * Both styles come from tokens.css; only one is displayed, so assistive tech reads the text once.
 */
export function Display({
  as: Tag = "h2",
  base,
  up,
  id,
  children,
}: {
  as?: ElementType;
  base: string;
  up: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <Tag id={id} style={{ margin: 0 }}>
      <span className={`t-${base} rt-base`}>{children}</span>
      <span className={`t-${up} rt-up`}>{children}</span>
    </Tag>
  );
}
