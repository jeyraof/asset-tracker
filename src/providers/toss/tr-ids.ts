/** Default Toss Securities Open API base URL (production). */
export const TOSS_BASE_URL = "https://openapi.tossinvest.com";

export const TOSS_PATHS = {
  token: "/oauth2/token",
  accounts: "/api/v1/accounts",
  holdings: "/api/v1/holdings",
  orders: "/api/v1/orders",
  buyingPower: "/api/v1/buying-power",
  candles: "/api/v1/candles",
  stocks: "/api/v1/stocks",
} as const;
