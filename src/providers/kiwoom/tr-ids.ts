export type KiwoomEnvironment = "prod" | "mock";

export const KIWOOM_BASE_URLS: Record<KiwoomEnvironment, string> = {
  prod: "https://api.kiwoom.com",
  mock: "https://mockapi.kiwoom.com",
};

export const KIWOOM_PATHS = {
  token: "/oauth2/token",
  account: "/api/dostk/acnt",
  chart: "/api/dostk/chart",
  usAccount: "/api/us/acnt",
  usChart: "/api/us/chart",
  usStockInfo: "/api/us/stkinfo",
} as const;

export const KIWOOM_API_IDS = {
  accountList: "ka00001",
  deposit: "kt00001",
  balance: "kt00018",
  tradeHistory: "kt00015",
  dailyChart: "ka10081",
  goldBalance: "kt50020",
  goldTradeHistory: "kt50032",
  goldDailyChart: "ka50081",
  usBalance: "ust21070",
  usTradeHistory: "ust21100",
  usExchange: "usa10098",
  usDailyChart: "usa06012",
} as const;

export function normalizeKiwoomEnv(value: string | undefined): KiwoomEnvironment {
  return value === "mock" || value === "vts" || value === "paper" || value === "demo"
    ? "mock"
    : "prod";
}
