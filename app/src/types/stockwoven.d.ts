// Types for the design system's js/stockwoven.js, which registers window.Stockwoven.
declare module "*/js/stockwoven.js";

type StockwovenWeaveOptions = { seed?: number; light?: boolean; fade?: number };

interface Window {
  Stockwoven?: {
    markPath: string;
    mark(color?: string): string;
    weave(canvas: HTMLCanvasElement, options?: StockwovenWeaveOptions): void;
    mountMarks(root?: ParentNode): void;
    mountWeaves(root?: ParentNode): void;
  };
}
