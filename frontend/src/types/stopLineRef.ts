import type { LineDirection } from "./lineDirection";

export interface StopLineRef {
  lineId: string;
  direction?: LineDirection;
  sequence?: number;
}
