export const BINANCE_HOSTS: string[];
export function fetchBinanceGlobal(
  path: string,
  options?: { fetchImpl?: typeof fetch; hosts?: string[] },
): Promise<{ res: Response; host: string }>;
