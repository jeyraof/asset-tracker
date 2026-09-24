/** Raw Kiwoom REST API response envelopes and rows (fields arrive as strings). */

export interface KiwoomEnvelope {
  return_code?: number | string;
  return_msg?: string;
  [key: string]: unknown;
}

export interface KiwoomTokenResponse {
  token?: string;
  token_type?: string;
  expires_dt?: string;
  return_code?: number;
  return_msg?: string;
  [key: string]: unknown;
}

export interface KiwoomAccountListResponse extends KiwoomEnvelope {
  acctNo?: string;
}

export interface KiwoomDepositResponse extends KiwoomEnvelope {
  entr?: string;
  d1_entra?: string;
  d2_entra?: string;
  ord_alow_amt?: string;
  pymn_alow_amt?: string;
  [key: string]: unknown;
}

export interface KiwoomHoldingRaw {
  stk_cd?: string;
  stk_nm?: string;
  evltv_prft?: string;
  prft_rt?: string;
  pur_pric?: string;
  rmnd_qty?: string;
  cur_prc?: string;
  pur_amt?: string;
  evlt_amt?: string;
  [key: string]: unknown;
}

export interface KiwoomBalanceResponse extends KiwoomEnvelope {
  tot_pur_amt?: string;
  tot_evlt_amt?: string;
  tot_evlt_pl?: string;
  tot_prft_rt?: string;
  prsm_dpst_aset_amt?: string;
  acnt_evlt_remn_indv_tot?: KiwoomHoldingRaw[];
}

export interface KiwoomTradeHistoryRaw {
  trde_dt?: string;
  trde_no?: string;
  rmrk_nm?: string;
  io_tp_nm?: string;
  stk_cd?: string;
  stk_nm?: string;
  trde_qty_jwa_cnt?: string;
  trde_unit?: string;
  trde_amt?: string;
  exct_amt?: string;
  proc_tm?: string;
  cntr_dt?: string;
  [key: string]: unknown;
}

export interface KiwoomTradeHistoryResponse extends KiwoomEnvelope {
  trst_ovrl_trde_prps_array?: KiwoomTradeHistoryRaw[];
}

export interface KiwoomCandleRaw {
  cur_prc?: string;
  trde_qty?: string;
  trde_prica?: string;
  dt?: string;
  open_pric?: string;
  high_pric?: string;
  low_pric?: string;
  [key: string]: unknown;
}

export interface KiwoomDailyChartResponse extends KiwoomEnvelope {
  stk_cd?: string;
  stk_dt_pole_chart_qry?: KiwoomCandleRaw[];
}

/** Gold-spot (금현물) raw shapes. */

export interface KiwoomGoldHoldingRaw {
  stk_cd?: string;
  stk_nm?: string;
  real_qty?: string;
  avg_prc?: string;
  cur_prc?: string;
  est_amt?: string;
  est_lspft?: string;
  est_ratio?: string;
  book_amt2?: string;
  [key: string]: unknown;
}

export interface KiwoomGoldBalanceResponse extends KiwoomEnvelope {
  tot_entr?: string;
  net_entr?: string;
  tot_est_amt?: string;
  net_amt?: string;
  tot_book_amt2?: string;
  tot_dep_amt?: string;
  paym_alowa?: string;
  pl_amt?: string;
  gold_acnt_evlt_prst?: KiwoomGoldHoldingRaw[];
}

export interface KiwoomGoldCandleRaw {
  cur_prc?: string;
  acc_trde_qty?: string;
  acc_trde_prica?: string;
  dt?: string;
  open_pric?: string;
  high_pric?: string;
  low_pric?: string;
  [key: string]: unknown;
}

export interface KiwoomGoldDailyChartResponse extends KiwoomEnvelope {
  gds_day_chart_qry?: KiwoomGoldCandleRaw[];
}

export interface KiwoomGoldTradeRaw {
  deal_dt?: string;
  deal_no?: string;
  rmrk_nm?: string;
  deal_qty?: string;
  uv_exrt?: string;
  deal_amt?: string;
  exct_amt?: string;
  proc_time?: string;
  cntr_dt?: string;
  stk_cd?: string;
  stk_nm?: string;
  [key: string]: unknown;
}

export interface KiwoomGoldTradeHistoryResponse extends KiwoomEnvelope {
  gold_trde_hist?: KiwoomGoldTradeRaw[];
}

/** US (overseas) stock raw shapes. The list key is `result_list`. */

export interface KiwoomUsHoldingRaw {
  stex_nm?: string;
  crnc_code?: string;
  stk_cd?: string;
  frgn_stk_nm?: string;
  qty?: string;
  poss_qty?: string;
  sell_alowq?: string;
  frgn_stk_book_uv?: string;
  now_pric?: string;
  evlt_amt?: string;
  pl_amt?: string;
  pl_rt?: string;
  evlt_amt_krw?: string;
  pl_amt_krw?: string;
  natn_nm?: string;
  exch_rate?: string;
  frgn_stk_book_amt?: string;
  frgn_stk_book_amt_krw?: string;
  [key: string]: unknown;
}

export interface KiwoomUsBalanceResponse extends KiwoomEnvelope {
  crnc_code?: string;
  tot_evlt_amt?: string;
  tot_prch_amt?: string;
  tot_pl_amt?: string;
  tot_pl_rt?: string;
  result_list?: KiwoomUsHoldingRaw[];
}

export interface KiwoomUsTradeRaw {
  deal_dt?: string;
  deal_kind_nm?: string;
  rmrk_nm?: string;
  deal_no?: string;
  stk_cd?: string;
  stk_nm?: string;
  deal_qty?: string;
  uv_exrt?: string;
  fc_deal_amt?: string;
  deal_amt?: string;
  fc_cmsn?: string;
  crnc_code?: string;
  proc_time?: string;
  [key: string]: unknown;
}

export interface KiwoomUsTradeHistoryResponse extends KiwoomEnvelope {
  result_list?: KiwoomUsTradeRaw[];
}

export interface KiwoomUsExchangeRaw {
  stex_tp?: string;
  stk_cd?: string;
  stk_nm?: string;
  stk_enm?: string;
  mkgb?: string;
  [key: string]: unknown;
}

export interface KiwoomUsExchangeResponse extends KiwoomEnvelope {
  list?: KiwoomUsExchangeRaw[];
}

export interface KiwoomUsCandleRaw {
  cur_prc?: string;
  open_pric?: string;
  high_pric?: string;
  low_pric?: string;
  acc_trde_qty?: string;
  dt?: string;
  upd_stkpc_tp?: string;
  [key: string]: unknown;
}

export interface KiwoomUsDailyChartResponse extends KiwoomEnvelope {
  result_list?: KiwoomUsCandleRaw[];
}
