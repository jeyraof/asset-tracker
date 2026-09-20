import { describe, expect, it } from "vitest";
import {
  mapDomesticBalance,
  mapDomesticDailyQuotes,
  mapDomesticTrades,
  stripSymbol,
} from "../src/providers/kiwoom/endpoints/domestic";
import { mapGoldBalance, mapGoldDailyQuotes, mapGoldTrades } from "../src/providers/kiwoom/endpoints/gold";
import { mapUsBalance, mapUsDailyQuotes, mapUsFxRate, mapUsTrades } from "../src/providers/kiwoom/endpoints/us";

describe("stripSymbol", () => {
  it("removes the security-type prefix", () => {
    expect(stripSymbol("A005930")).toBe("005930");
    expect(stripSymbol("J069500")).toBe("069500");
    expect(stripSymbol("A0199C0")).toBe("0199C0");
    expect(stripSymbol("005930")).toBe("005930");
    expect(stripSymbol("")).toBeNull();
    expect(stripSymbol(undefined)).toBeNull();
  });

  it("normalizes NXT/unified exchange suffixes back to KRX", () => {
    expect(stripSymbol("005930_NX")).toBe("005930");
    expect(stripSymbol("005930_AL")).toBe("005930");
    expect(stripSymbol("A005930_NX")).toBe("005930");
    expect(stripSymbol("A0199C0_AL")).toBe("0199C0");
  });
});

describe("mapDomesticBalance", () => {
  it("normalizes summary and holdings", () => {
    const result = mapDomesticBalance(
      {
        tot_pur_amt: "000000017598258",
        tot_evlt_amt: "000000025789890",
        tot_evlt_pl: "000000008138825",
        prsm_dpst_aset_amt: "000001012632507",
        acnt_evlt_remn_indv_tot: [
          {
            stk_cd: "A005930",
            stk_nm: "삼성전자",
            evltv_prft: "-00000000196888",
            prft_rt: "-52.71",
            pur_pric: "000000000124500",
            rmnd_qty: "000000000000003",
            cur_prc: "000000059000",
            pur_amt: "000000000373500",
            evlt_amt: "000000000177000",
          },
        ],
      },
      { entr: "000000000017534", d1_entra: "000000000017450" },
      "2026-09-20",
    );

    expect(result.date).toBe("2026-09-20");
    expect(result.summary.depositTotal).toBe(17534);
    expect(result.summary.nextDaySettlement).toBe(17450);
    expect(result.summary.totalEvalAmount).toBe(25789890);
    expect(result.summary.purchaseAmountTotal).toBe(17598258);
    expect(result.summary.evalPflsAmount).toBe(8138825);
    expect(result.summary.netAssetAmount).toBe(1012632507);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      market: "KRX",
      symbol: "005930",
      productName: "삼성전자",
      quantity: 3,
      avgPrice: 124500,
      currentPrice: 59000,
      evalAmount: 177000,
      evalPflsAmount: -196888,
      evalPflsRate: -52.71,
    });
  });

  it("drops holdings without a symbol", () => {
    const result = mapDomesticBalance({ acnt_evlt_remn_indv_tot: [{ stk_nm: "no code" }] }, {}, "2026-09-20");
    expect(result.holdings).toHaveLength(0);
  });
});

describe("mapDomesticTrades", () => {
  it("keeps only buys/sells with executed quantity from the range history", () => {
    const trades = mapDomesticTrades({
      trst_ovrl_trde_prps_array: [
        {
          trde_dt: "20260902",
          trde_no: "000000001",
          io_tp_nm: "매수",
          rmrk_nm: "장내매수",
          stk_cd: "A0199C0",
          stk_nm: "ACE 고배당주Plus커버드콜액티브",
          trde_qty_jwa_cnt: "6",
          trde_unit: "9,285",
          trde_amt: "000000000055710",
          proc_tm: "02:03:22",
        },
        {
          trde_dt: "20260902",
          trde_no: "000000002",
          io_tp_nm: "매도",
          stk_cd: "A005930",
          trde_qty_jwa_cnt: "2",
          trde_unit: "70000",
        },
        { trde_dt: "20260902", trde_no: "000000003", io_tp_nm: "매수", stk_cd: "A005930", trde_qty_jwa_cnt: "0" },
        { trde_dt: "20260902", trde_no: "000000004", io_tp_nm: "기타", stk_cd: "A005930", trde_qty_jwa_cnt: "1" },
      ],
    });

    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      date: "2026-09-02",
      externalId: "000000001",
      market: "KRX",
      symbol: "0199C0",
      side: "BUY",
      quantity: 6,
      avgPrice: 9285,
      amount: 55710,
      orderTime: "02:03:22",
    });
    expect(trades[1]).toMatchObject({ symbol: "005930", side: "SELL", quantity: 2 });
  });
});

describe("mapDomesticDailyQuotes", () => {
  it("maps candles to normalized quotes", () => {
    const quotes = mapDomesticDailyQuotes(
      {
        stk_dt_pole_chart_qry: [
          {
            cur_prc: "70100",
            trde_qty: "9263135",
            dt: "20250908",
            open_pric: "69800",
            high_pric: "70500",
            low_pric: "69600",
          },
        ],
      },
      "005930",
    );

    expect(quotes).toEqual([
      {
        market: "KRX",
        symbol: "005930",
        date: "2025-09-08",
        open: 69800,
        high: 70500,
        low: 69600,
        close: 70100,
        volume: 9263135,
        currency: "KRW",
        provider: "kiwoom",
        source: "kiwoom-daily-chart",
        raw: expect.any(Object),
      },
    ]);
  });
});

describe("gold-spot mappers", () => {
  it("maps gold balance and holdings to the KRX-GOLD market", () => {
    const result = mapGoldBalance(
      {
        tot_entr: "000000000008482",
        tot_est_amt: "000000003374425",
        tot_book_amt2: "000000003481900",
        tot_dep_amt: "000000003382407",
        gold_acnt_evlt_prst: [
          {
            stk_cd: "M04020000",
            stk_nm: "금 99.99_1Kg",
            real_qty: "000000000002",
            avg_prc: "000000152385",
            cur_prc: "000000151780",
            est_amt: "000000301569",
            est_lspft: "-00000003201",
            est_ratio: "-1.0503",
            book_amt2: "000000304770",
          },
        ],
      },
      "2026-09-20",
    );

    expect(result.summary).toMatchObject({
      depositTotal: 8482,
      totalEvalAmount: 3374425,
      purchaseAmountTotal: 3481900,
      evalPflsAmount: -3201,
      netAssetAmount: 3382407,
    });
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      market: "KRX-GOLD",
      symbol: "M04020000",
      productName: "금 99.99_1Kg",
      quantity: 2,
      avgPrice: 152385,
      currentPrice: 151780,
      evalAmount: 301569,
      evalPflsAmount: -3201,
      evalPflsRate: -1.0503,
      purchaseAmount: 304770,
    });
  });

  it("maps gold candles to KRX-GOLD quotes", () => {
    const quotes = mapGoldDailyQuotes(
      {
        gds_day_chart_qry: [
          {
            cur_prc: "195310",
            acc_trde_qty: "148033",
            dt: "20260918",
            open_pric: "193450",
            high_pric: "195380",
            low_pric: "193450",
          },
        ],
      },
      "M04020000",
    );

    expect(quotes).toEqual([
      {
        market: "KRX-GOLD",
        symbol: "M04020000",
        date: "2026-09-18",
        open: 193450,
        high: 195380,
        low: 193450,
        close: 195310,
        volume: 148033,
        currency: "KRW",
        provider: "kiwoom",
        source: "kiwoom-gold-daily-chart",
        raw: expect.any(Object),
      },
    ]);
  });

  it("maps gold fills with the KRX-GOLD market", () => {
    const trades = mapGoldTrades({
      gold_trde_hist: [
        {
          deal_dt: "20260918",
          deal_no: "000000001",
          rmrk_nm: "금현물매수",
          deal_qty: "000000000000001",
          uv_exrt: "140000",
          deal_amt: "000000000140000",
          proc_time: "13:20:37",
          stk_cd: "M04020000",
          stk_nm: "금 99.99_1Kg",
        },
      ],
    });

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      date: "2026-09-18",
      externalId: "000000001",
      market: "KRX-GOLD",
      symbol: "M04020000",
      side: "BUY",
      quantity: 1,
      avgPrice: 140000,
      amount: 140000,
      orderTime: "13:20:37",
    });
  });
});

describe("US mappers", () => {
  const balanceBody = {
    crnc_code: "USD",
    tot_evlt_amt: "108719.8000",
    tot_prch_amt: "111453.3212",
    tot_pl_amt: "-3283.9512",
    result_list: [
      {
        stex_nm: "미국",
        crnc_code: "USD",
        stk_cd: "AAPL",
        frgn_stk_nm: "애플",
        poss_qty: "000000000395",
        frgn_stk_book_uv: "282.1603",
        frgn_stk_book_amt: "111453.3212",
        now_pric: "275.2400",
        evlt_amt: "108719.8000",
        pl_amt: "-3283.9512",
        pl_rt: "-2.94",
        exch_rate: "1524.50",
      },
    ],
  };

  it("maps US holdings with USD and a plain ticker", () => {
    const result = mapUsBalance(balanceBody, "2026-09-20");

    expect(result.summary.currency).toBe("USD");
    expect(result.holdings[0]).toMatchObject({
      market: "US",
      symbol: "AAPL",
      productName: "애플",
      currency: "USD",
      quantity: 395,
      avgPrice: 282.1603,
      purchaseAmount: 111453.3212,
      currentPrice: 275.24,
      evalAmount: 108719.8,
      evalPflsAmount: -3283.9512,
      evalPflsRate: -2.94,
    });
  });

  it("re-values holdings at the regular-session close when provided", () => {
    const result = mapUsBalance(balanceBody, "2026-09-20", (symbol) =>
      symbol === "AAPL" ? 270 : null,
    );

    expect(result.holdings[0]).toMatchObject({
      currentPrice: 270,
    });
    expect(result.holdings[0]?.evalAmount).toBeCloseTo(106650, 5);
    expect(result.holdings[0]?.evalPflsAmount).toBeCloseTo(106650 - 111453.3212, 3);
    expect(result.summary.totalEvalAmount).toBeCloseTo(106650, 5);
    expect(result.summary.purchaseAmountTotal).toBeCloseTo(111453.3212, 3);
  });

  it("falls back to the broker price when no candle exists (holiday)", () => {
    const result = mapUsBalance(balanceBody, "2026-09-07", () => null);

    expect(result.holdings[0]).toMatchObject({
      currentPrice: 275.24,
      evalAmount: 108719.8,
    });
  });

  it("maps US fills to the US market in USD", () => {
    const trades = mapUsTrades({
      result_list: [
        {
          deal_dt: "20260511",
          deal_kind_nm: "매매",
          rmrk_nm: "매수",
          deal_no: "000000001",
          stk_cd: "BAC",
          stk_nm: "뱅크오브아메리카",
          deal_qty: "20",
          uv_exrt: "54.1300",
          fc_deal_amt: "1082.60",
          crnc_code: "USD",
          proc_time: "08:25:42",
        },
        {
          deal_dt: "20260511",
          deal_kind_nm: "매매",
          rmrk_nm: "매도",
          deal_no: "000000002",
          stk_cd: "BAC",
          deal_qty: "0",
        },
        { deal_dt: "20260511", rmrk_nm: "기타", deal_no: "000000003", stk_cd: "BAC", deal_qty: "1" },
      ],
    });

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      date: "2026-05-11",
      externalId: "000000001",
      market: "US",
      symbol: "BAC",
      side: "BUY",
      quantity: 20,
      avgPrice: 54.13,
      amount: 1082.6,
      currency: "USD",
      orderTime: "08:25:42",
    });
  });

  it("maps US candles to USD quotes", () => {
    const quotes = mapUsDailyQuotes(
      {
        result_list: [
          {
            cur_prc: "201.3612",
            open_pric: "200.0400",
            high_pric: "203.7700",
            low_pric: "200.0000",
            acc_trde_qty: "153496196",
            dt: "20260623",
          },
        ],
      },
      "NVDA",
    );

    expect(quotes).toEqual([
      {
        market: "US",
        symbol: "NVDA",
        date: "2026-06-23",
        open: 200.04,
        high: 203.77,
        low: 200,
        close: 201.3612,
        volume: 153496196,
        currency: "USD",
        provider: "kiwoom",
        source: "kiwoom-us-daily-chart",
        raw: expect.any(Object),
      },
    ]);
  });

  it("maps a US FX rate, preferring the applied rate", () => {
    const rate = mapUsFxRate(
      { return_code: 0, aplc_exrt: "1524.50", sell_aplc_exrt: "1522.00", buy_aplc_exrt: "1527.00" },
      "2026-09-21",
    );

    expect(rate).toMatchObject({
      base: "USD",
      quote: "KRW",
      date: "2026-09-21",
      rate: 1524.5,
      provider: "kiwoom",
      source: "kiwoom-us-fx-rate",
      raw: expect.any(Object),
    });
    expect(mapUsFxRate({ sell_aplc_exrt: "1522.00" }, "2026-09-21")?.rate).toBe(1522);
    expect(mapUsFxRate({ aplc_exrt: "0" }, "2026-09-21")).toBeNull();
    expect(mapUsFxRate({}, "2026-09-21")).toBeNull();
  });
});
