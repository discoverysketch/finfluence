// api/financials.js — Vercel serverless function
// Primary source: SEC EDGAR (official, free, every US filer — no API key needed).
// Fallback: Anthropic web-search pull (only used if EDGAR has no data AND a key is set).
//
// IMPORTANT: SEC requires a real User-Agent with contact info. Replace the email below.
const UA = { "User-Agent": "FinFluency dan.wain1@gmail.com", "Accept-Encoding": "gzip, deflate" };

let TICKERS = null; // cached across warm invocations

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const ticker = (req.query.ticker || "").toString().trim().toUpperCase();
  if (!ticker) { res.status(400).json({ error: "Missing ticker" }); return; }

  // 1) Try SEC EDGAR
  try {
    const edgar = await fromEdgar(ticker);
    if (edgar && (edgar.revenue != null || edgar.totalAssets != null)) {
      res.status(200).json(edgar);
      return;
    }
  } catch (e) { /* fall through to AI */ }

  // 2) Fallback: Anthropic (only if a key is configured)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const ai = await fromAnthropic(ticker);
      if (ai) { res.status(200).json(ai); return; }
    } catch (e) { /* fall through */ }
  }

  res.status(200).json({ error: "No data found for " + ticker + " (not a US filer on EDGAR, and no fallback available)." });
}

/* ---------------- SEC EDGAR ---------------- */
async function getCik(ticker) {
  if (!TICKERS) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: UA });
    if (!r.ok) throw new Error("ticker map failed");
    TICKERS = await r.json();
  }
  const cand = [ticker, ticker.replace(/\./g, "-"), ticker.replace(/-/g, ".")];
  for (const k in TICKERS) {
    const row = TICKERS[k];
    if (cand.includes(String(row.ticker).toUpperCase())) {
      return { cik: String(row.cik_str).padStart(10, "0"), title: row.title };
    }
  }
  return null;
}

async function fromEdgar(ticker) {
  const found = await getCik(ticker);
  if (!found) return null;
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${found.cik}.json`, { headers: UA });
  if (!r.ok) return null;
  const facts = await r.json();

  const usd = (c) => facts.facts?.["us-gaap"]?.[c]?.units?.USD || null;
  const days = (s, e) => Math.round((new Date(e) - new Date(s)) / 86400000);

  // Pick the value from the most RECENT reporting period across ALL listed concepts.
  // (Gathering across concepts avoids returning a deprecated tag's stale data — e.g. a
  // company that switched revenue tags years ago. Concept order is only a tie-break.)
  const sortRows = (a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : a._ci - b._ci));
  const pickInstant = (concepts) => {
    const rows = [];
    concepts.forEach((c, ci) => { const arr = usd(c); if (arr) for (const x of arr) if (x.form === "10-Q" || x.form === "10-K") rows.push({ ...x, _ci: ci }); });
    if (!rows.length) return null;
    rows.sort(sortRows);
    return { val: rows[0].val, end: rows[0].end };
  };
  const pickDuration = (concepts) => {
    const all = [];
    concepts.forEach((c, ci) => { const arr = usd(c); if (arr) for (const x of arr) if (x.start && x.end && (x.form === "10-Q" || x.form === "10-K")) all.push({ ...x, _ci: ci }); });
    if (!all.length) return null;
    const std = all.filter((x) => { const d = days(x.start, x.end); return (d >= 80 && d <= 100) || (d >= 350 && d <= 380); });
    const pool = std.length ? std : all;
    pool.sort(sortRows);
    const t = pool[0];
    return { val: t.val, end: t.end, fy: t.fy, fp: t.fp, days: days(t.start, t.end) };
  };
  const M = (v) => (v == null ? undefined : Math.round((v / 1e6) * 10) / 10);

  const rev = pickDuration(["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RegulatedAndUnregulatedOperatingRevenue", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]);
  let cogs = pickDuration(["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"]);
  const opInc = pickDuration(["OperatingIncomeLoss"]);
  const ni = pickDuration(["NetIncomeLoss", "ProfitLoss"]);
  const intexp = pickDuration(["InterestExpense", "InterestAndDebtExpense", "InterestExpenseNonoperating"]);
  const cfo = pickDuration(["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]);
  const capex = pickDuration(["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForCapitalImprovements", "PaymentsToAcquireProductiveAssets"]);
  const assets = pickInstant(["Assets"]);
  const liab = pickInstant(["Liabilities"]);
  const equity = pickInstant(["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
  const cash = pickInstant(["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]);
  const ca = pickInstant(["AssetsCurrent"]);
  const cl = pickInstant(["LiabilitiesCurrent"]);
  const ltd = pickInstant(["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebt"]);
  const cd = pickInstant(["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "DebtCurrent"]);
  const stb = pickInstant(["ShortTermBorrowings", "CommercialPaper", "OtherShortTermBorrowings"]);

  // COGS tags are unreliable for utilities — a mis-tagged sliver (Southern's $231M) or a
  // figure above revenue (Duke's $6.8B) would build a nonsense gross-margin question.
  // Only keep COGS when it's a plausible share of revenue (20%–100%).
  if (cogs && rev && (cogs.val <= 0 || cogs.val >= rev.val || cogs.val < rev.val * 0.2)) cogs = null;

  let debt;
  const dparts = [ltd, cd, stb].filter(Boolean).map((x) => x.val);
  if (dparts.length) debt = dparts.reduce((a, b) => a + b, 0);

  const anchor = ni || rev;
  let period = "Latest period";
  if (anchor) {
    const tag = anchor.fp && anchor.fy ? (anchor.fp === "FY" ? `FY${anchor.fy}` : `${anchor.fp} FY${anchor.fy}`) : anchor.end;
    period = (anchor.days >= 80 && anchor.days <= 100) ? tag : (anchor.days >= 350 ? `FY${anchor.fy || ""}` : `${anchor.days}-day period to ${anchor.end}`);
  }
  period += " · SEC EDGAR";

  const data = {
    company: found.title, period,
    revenue: M(rev?.val), cogs: M(cogs?.val), operatingIncome: M(opInc?.val), netIncome: M(ni?.val), interestExpense: M(intexp?.val),
    totalAssets: M(assets?.val), totalLiabilities: M(liab?.val), totalEquity: M(equity?.val),
    cash: M(cash?.val), currentAssets: M(ca?.val), currentLiabilities: M(cl?.val),
    totalDebt: M(debt), operatingCashFlow: M(cfo?.val),
    capex: capex ? -Math.abs(M(capex.val)) : undefined,
  };
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
  return data;
}

/* ---------------- Anthropic fallback ---------------- */
async function fromAnthropic(ticker) {
  const prompt =
    `Return ONLY a JSON object (no prose, no markdown) with the most recent quarterly financials for ${ticker}. ` +
    `Values in millions USD as plain numbers; omit fields not reported. Fields: company, period, revenue, cogs, ` +
    `operatingIncome, netIncome, totalAssets, totalLiabilities, totalEquity, cash, currentAssets, currentLiabilities, ` +
    `totalDebt, operatingCashFlow, capex (negative).`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [{ role: "user", content: prompt }], tools: [{ type: "web_search_20250305", name: "web_search" }] }),
  });
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) return null;
  const d = JSON.parse(text.slice(s, e + 1));
  if (d.period) d.period += " · AI estimate (verify)";
  return d;
}
