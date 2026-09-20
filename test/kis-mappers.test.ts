import { describe, expect, it } from "vitest";
import {
  mapDomesticBalance,
  mapDomesticDailyQuotes,
  mapDomesticTrades,
} from "../src/providers/kis/endpoints/domestic";
import { parseKisAccount } from "../src/providers/kis/index";

describe("mapDomesticBalance", () => {
  it("normalizes summary and holdings", () => {
    const result = mapDomesticBalance(
      {
        output1: [
          {
            pdno: "005930",
            prdt_name: "삼성전자",
            hldg_qty: "10",
            pchs_avg_pric: "70000",
            pchs_amt: "700000",
            prpr: "75000",
            evlu_amt: "750000",
            evlu_pfls_amt: "50000",
            evlu_pfls_rt: "7.14",
          },
        ],
        output2: [
          {
            dnca_tot_amt: "1,000,000",
            nxdy_excc_amt: "900000",
            tot_evlu_amt: "1,750,000",
            scts_evlu_amt: "750000",
            pchs_amt_smtl_amt: "700000",
            evlu_pfls_smtl_amt: "50000",
            nass_amt: "1750000",
          },
        ],
      },
      "2026-09-20",
    );

    expect(result.date).toBe("2026-09-20");
    expect(result.summary.depositTotal).toBe(1000000);
    expect(result.summary.totalEvalAmount).toBe(1750000);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      market: "KRX",
      symbol: "005930",
      quantity: 10,
      avgPrice: 70000,
      currentPrice: 75000,
    });
  });

  it("drops holdings without a symbol", () => {
    const result = mapDomesticBalance({ output1: [{ prdt_name: "no code" }], output2: [] }, "2026-09-20");
    expect(result.holdings).toHaveLength(0);
  });
});

describe("mapDomesticTrades", () => {
  it("keeps only buy/sell fills with executed quantity", () => {
    const trades = mapDomesticTrades({
      output1: [
        {
          odno: "1",
          pdno: "005930",
          sll_buy_dvsn_cd: "02",
          tot_ccld_qty: "10",
          avg_prvs: "71000",
          tot_ccld_amt: "710000",
          ord_dt: "20260918",
          ord_tmd: "090501",
        },
        { odno: "2", pdno: "000660", sll_buy_dvsn_cd: "01", tot_ccld_qty: "5", ord_dt: "20260918" },
        { odno: "3", pdno: "035420", sll_buy_dvsn_cd: "02", tot_ccld_qty: "0", ord_dt: "20260918" },
        { odno: "4", pdno: "051910", sll_buy_dvsn_cd: "99", tot_ccld_qty: "3", ord_dt: "20260918" },
      ],
    });

    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      date: "2026-09-18",
      externalId: "1",
      symbol: "005930",
      side: "BUY",
      quantity: 10,
      avgPrice: 71000,
      orderTime: "090501",
    });
    expect(trades[1]).toMatchObject({ symbol: "000660", side: "SELL", quantity: 5 });
  });
});

describe("mapDomesticDailyQuotes", () => {
  it("maps candles to normalized quotes", () => {
    const quotes = mapDomesticDailyQuotes(
      {
        output2: [
          {
            stck_bsop_date: "20260919",
            stck_oprc: "70000",
            stck_hgpr: "76000",
            stck_lwpr: "69000",
            stck_clpr: "75000",
            acml_vol: "12345678",
          },
        ],
      },
      "005930",
    );

    expect(quotes).toEqual([
      {
        market: "KRX",
        symbol: "005930",
        date: "2026-09-19",
        open: 70000,
        high: 76000,
        low: 69000,
        close: 75000,
        volume: 12345678,
        currency: "KRW",
        provider: "kis",
        source: "kis-daily-chart",
        raw: expect.any(Object),
      },
    ]);
  });
});

describe("parseKisAccount", () => {
  it("reads from the external id", () => {
    expect(parseKisAccount({ externalId: "12345678-01", meta: {} })).toEqual({
      cano: "12345678",
      prdtCd: "01",
    });
  });

  it("prefers explicit meta values", () => {
    expect(
      parseKisAccount({ externalId: "12345678-01", meta: { cano: "87654321", prdtCd: "22" } }),
    ).toEqual({ cano: "87654321", prdtCd: "22" });
  });

  it("rejects invalid CANO", () => {
    expect(() => parseKisAccount({ externalId: "abc", meta: {} })).toThrow(/8-digit CANO/);
  });
});
