export const BETA_PATHS: string[];
export interface BetaState {
  major: number;
  minor: number;
  fingerprint: string;
  serial: number;
  base: string;
}
export const START: BetaState;
export function fingerprint(diff: string): string;
export function planBeta(
  previous: Partial<BetaState> | null,
  current: { fingerprint: string; base: string; mainBuild: string },
): { publish: boolean; retire: boolean; beta: string; build: string; state: BetaState };
export function betaNotes(version: string, beta: string, changelog?: string): string;
export function labelBeta(xml: string, display: string): string;
export function composeFeed(mainXml: string, betaXml?: string): string;
