// 费用估算。价目取自 2026-11-11 的 https://api-docs.deepseek.com/quick_start/pricing，
// 单位：美元 / 百万 token，[非高峰, 高峰]。价目变化后需要同步这里；未知模型或非官方端点不估算。
import type { FimUsage } from './fim/client';

interface Price {
  hit: [number, number];
  miss: [number, number];
  out: [number, number];
}

const PRICES: Record<string, Price> = {
  'deepseek-flash': { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
  'deepseek-v4-pro': { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
};

/** 高峰：UTC 周一至周五 01:00–04:00、06:00–10:00。官方另排除中国法定节假日，这里无法得知，节假日会略微高估。 */
export function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

export interface CostEstimate {
  usd: number;
  /** 同样的 token 若输入全部未命中缓存的费用，用于衡量缓存节省。 */
  noCacheUsd: number;
}

export function estimateCost(endpoint: string, model: string, usage: FimUsage, at: Date): CostEstimate | undefined {
  const price = PRICES[model];
  if (!price || !endpoint.includes('api.deepseek.com')) {
    return undefined;
  }
  const i = isPeak(at) ? 1 : 0;
  const out = usage.completion * price.out[i];
  return {
    usd: (usage.cacheHit * price.hit[i] + usage.cacheMiss * price.miss[i] + out) / 1e6,
    noCacheUsd: ((usage.cacheHit + usage.cacheMiss) * price.miss[i] + out) / 1e6,
  };
}
