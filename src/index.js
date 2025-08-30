import express from "express";
import cors from "cors";
import yahooFinance from "yahoo-finance2";
import holdingsData from "./models/portfolio-holdings.json" assert { type: "json" };
import { fileURLToPath } from "url";
// import { dirname } from "path";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const WS_PORT = 8080;

app.use(cors());
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`✅ WebSocket server running on ws://localhost:${WS_PORT}`);

const fetchDataAndBroadcast = async () => {
  try {
    const allHoldings = holdingsData.flatMap((sector) => sector.holdings);
    const symbols = [...new Set(allHoldings.map((h) => h.symbol))];

    console.log(`Fetching symbols:`, symbols);

    const quoteSummaries = await Promise.all(
      symbols.map((symbol) =>
        yahooFinance.quoteSummary(symbol, {
          modules: [
            "price",
            "defaultKeyStatistics",
            "financialData",
            "earnings",
            "summaryDetail",
            "assetProfile",
          ],
        })
      )
    );

    const findSummary = (symbol) =>
      quoteSummaries.find((q) => q?.price?.symbol === symbol);

    const totalInvestment = allHoldings.reduce(
      (sum, h) => sum + h.purchasePrice * h.quantity,
      0
    );

    const enrichedSectors = holdingsData.map((sector) => {
      const enrichedHoldings = sector.holdings.map((h) => {
        const summary = findSummary(h.symbol);
        if (!summary || !summary.price) {
          return {
            ...h,
            cmp: 0,
            presentValue: 0,
            gainLoss: 0,
            gainLossPct: 0,
          };
        }

        const { price, financialData, summaryDetail, earnings } = summary;

        const cmp = price.regularMarketPrice || 0;
        const investment = h.purchasePrice * h.quantity;
        const presentValue = cmp * h.quantity;
        const gainLoss = presentValue - investment;
        const gainLossPct = investment > 0 ? (gainLoss / investment) * 100 : 0;
        const portfolioPercentage =
          totalInvestment > 0 ? (investment / totalInvestment) * 100 : 0;

        return {
          ...h,
          cmp,
          investment,
          presentValue,
          gainLoss,
          gainLossPct,
          portfolioPercentage,
          marketCap: price.marketCap || 0,
          peRatio: summaryDetail?.trailingPE || null,
          latestEarnings:
            earnings?.financialsChart?.quarterly?.[3]?.date || "N/A",
          revenue: financialData?.revenue?.raw || 0,
          ebitda: financialData?.ebitda?.raw || 0,
          pat: earnings?.financialsChart?.yearly?.[3]?.earnings?.raw || 0,
          freeCashFlow: financialData?.freeCashflow?.raw || 0,
          cfo: financialData?.totalCashFromOperatingActivities?.raw || 0,
          priceToSales: summaryDetail?.priceToSalesTrailing12Months || null,
          priceToBook: summaryDetail?.priceToBook || null,
          revenuePercent: (financialData?.revenueGrowth?.raw || 0) * 100,
          profitPercent: (financialData?.grossMargins?.raw || 0) * 100,
        };
      });

      const sectorInvestment = enrichedHoldings.reduce(
        (sum, h) => sum + h.investment,
        0
      );
      const sectorValue = enrichedHoldings.reduce(
        (sum, h) => sum + h.presentValue,
        0
      );

      return {
        sector: sector.sector,
        sectorInvestment,
        sectorValue,
        sectorGainLoss: sectorValue - sectorInvestment,
        holdings: enrichedHoldings,
      };
    });

    const response = {
      totalInvestment,
      totalValue: enrichedSectors.reduce(
        (sum, s) => sum + s.sectorValue,
        0
      ),
      sectors: enrichedSectors,
      timestamp: new Date(),
    };

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(response));
      }
    });
    console.log(
      `Broadcasted update at ${new Date().toLocaleTimeString()}`
    );
  } catch (err) {
    console.error("Error:", err.message);
  }
};

fetchDataAndBroadcast();
setInterval(fetchDataAndBroadcast, 15000);

app.listen(PORT, () => {
  console.log(`Express running at http://localhost:${PORT}`);
});