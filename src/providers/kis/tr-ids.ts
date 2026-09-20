export type KisEnvironment = "prod" | "vts";

export const KIS_BASE_URLS: Record<KisEnvironment, string> = {
  prod: "https://openapi.koreainvestment.com:9443",
  vts: "https://openapivts.koreainvestment.com:29443",
};

export interface KisTrIds {
  domesticBalance: string;
  domesticCclDRecent: string;
  domesticCclDOld: string;
  domesticDailyChart: string;
  domesticCurrentPrice: string;
  overseasBalance: string;
}

const PROD_TR_IDS: KisTrIds = {
  domesticBalance: "TTTC8434R",
  domesticCclDRecent: "TTTC0081R",
  domesticCclDOld: "CTSC9215R",
  domesticDailyChart: "FHKST03010100",
  domesticCurrentPrice: "FHKST01010100",
  overseasBalance: "TTTS3012R",
};

const VTS_TR_IDS: KisTrIds = {
  domesticBalance: "VTTC8434R",
  domesticCclDRecent: "VTTC0081R",
  domesticCclDOld: "VTSC9215R",
  domesticDailyChart: "FHKST03010100",
  domesticCurrentPrice: "FHKST01010100",
  overseasBalance: "VTTS3012R",
};

export function normalizeKisEnv(value: string | undefined): KisEnvironment {
  return value === "vts" || value === "mock" || value === "paper" ? "vts" : "prod";
}

export function getTrIds(env: KisEnvironment): KisTrIds {
  return env === "vts" ? VTS_TR_IDS : PROD_TR_IDS;
}

/** The daily-ccld TR differs when the query window starts more than 3 months ago. */
export function cclDTrId(env: KisEnvironment, from: string, today: string): string {
  const ids = getTrIds(env);
  const boundary = new Date(`${today}T00:00:00Z`);
  boundary.setUTCMonth(boundary.getUTCMonth() - 3);
  const fromDate = new Date(`${from}T00:00:00Z`);
  return fromDate >= boundary ? ids.domesticCclDRecent : ids.domesticCclDOld;
}
