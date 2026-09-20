import { describe, expect, it } from "vitest";
import {
  mapDomesticBalance,
  mapDomesticDailyQuotes,
  mapDomesticTrades,
  stripSymbol,
} from "../src/providers/kiwoom/endpoints/domestic";
import { mapGoldBalance, mapGoldDailyQuotes, mapGoldTrades } from "../src/providers/kiwoom/endpoints/gold";

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
