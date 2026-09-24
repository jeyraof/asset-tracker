-- Drop previously stored FX rows: they were Kiwoom's 환전 적용환율(가환율), not a
-- market reference rate, and are meaningless for valuation. The FX task now
-- records Korea Eximbank's 매매기준율 (deal_bas_r) instead.

DELETE FROM fx_rates;
