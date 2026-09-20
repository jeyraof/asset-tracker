/** Raw KIS OpenAPI response envelopes and rows (fields arrive as strings). */

export interface KisEnvelope {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  [key: string]: unknown;
}

export interface KisTokenResponse {
  access_token?: string;
  access_token_token_expired?: string;
  token_type?: string;
  expires_in?: number;
  error_code?: string;
  error_description?: string;
  msg_cd?: string;
  msg1?: string;
}

export interface KisDomesticHoldingRaw {
  pdno?: string;
  prdt_name?: string;
  hldg_qty?: string;
  ord_psbl_qty?: string;
  pchs_avg_pric?: string;
  pchs_amt?: string;
  prpr?: string;
  evlu_amt?: string;
  evlu_pfls_amt?: string;
  evlu_pfls_rt?: string;
  [key: string]: unknown;
}

export interface KisDomesticSummaryRaw {
  dnca_tot_amt?: string;
  nxdy_excc_amt?: string;
  tot_evlu_amt?: string;
  scts_evlu_amt?: string;
  pchs_amt_smtl_amt?: string;
  evlu_pfls_smtl_amt?: string;
  nass_amt?: string;
  [key: string]: unknown;
}

export interface KisDomesticBalanceResponse extends KisEnvelope {
  output1?: KisDomesticHoldingRaw[];
  output2?: KisDomesticSummaryRaw[];
  ctx_area_fk100?: string;
  ctx_area_nk100?: string;
}

export interface KisDomesticCclDRaw {
  odno?: string;
  pdno?: string;
  prdt_name?: string;
  sll_buy_dvsn_cd?: string;
  tot_ccld_qty?: string;
  avg_prvs?: string;
  tot_ccld_amt?: string;
  ord_dt?: string;
  ord_tmd?: string;
  [key: string]: unknown;
}

export interface KisDomesticCclDResponse extends KisEnvelope {
  output1?: KisDomesticCclDRaw[];
  output2?: Record<string, unknown>;
  ctx_area_fk100?: string;
  ctx_area_nk100?: string;
}

export interface KisDomesticCandleRaw {
  stck_bsop_date?: string;
  stck_oprc?: string;
  stck_hgpr?: string;
  stck_lwpr?: string;
  stck_clpr?: string;
  acml_vol?: string;
  [key: string]: unknown;
}

export interface KisDomesticDailyChartResponse extends KisEnvelope {
  output1?: Record<string, unknown>;
  output2?: KisDomesticCandleRaw[];
}
