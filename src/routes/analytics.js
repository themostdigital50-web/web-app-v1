import { Router } from "express";
import { pool } from "../db.js";
import requireRole from "../middleware/require-role.js";

const router = Router();

router.use(requireRole("tenant_admin"));

router.get("/summary", async (request, response) => {
  const tenantId = request.session.user.tenantId;

  try {
    const totalsResult = await pool.query(
      `SELECT
         COALESCE(SUM(total_cents) FILTER (WHERE status = 'paid'), 0) AS collected_cents,
         COALESCE(SUM(total_cents) FILTER (WHERE status = 'unpaid'), 0) AS unpaid_cents,
         COUNT(*)::int AS invoice_count,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
         COUNT(*) FILTER (WHERE status = 'unpaid')::int AS unpaid_count
       FROM invoices
       WHERE tenant_id = $1`,
      [tenantId],
    );

    const topProductsResult = await pool.query(
      `SELECT ii.product_id, ii.product_name,
              SUM(ii.quantity)::bigint AS units_sold,
              SUM(ii.quantity::bigint * ii.unit_price_cents)
                FILTER (WHERE invoices.status = 'paid') AS collected_cents
       FROM invoice_items ii
       JOIN invoices
         ON invoices.id = ii.invoice_id
        AND invoices.tenant_id = ii.tenant_id
       WHERE ii.tenant_id = $1
       GROUP BY ii.product_id, ii.product_name
       ORDER BY units_sold DESC, ii.product_name
       LIMIT 3`,
      [tenantId],
    );

    const monthlyResult = await pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE) - interval '5 months',
           date_trunc('month', CURRENT_DATE),
           interval '1 month'
         ) AS month_start
       )
       SELECT months.month_start,
              COALESCE(SUM(invoices.total_cents), 0) AS collected_cents
       FROM months
       LEFT JOIN invoices
         ON invoices.tenant_id = $1
        AND invoices.status = 'paid'
        AND invoices.issued_at >= months.month_start
        AND invoices.issued_at < months.month_start + interval '1 month'
       GROUP BY months.month_start
       ORDER BY months.month_start`,
      [tenantId],
    );

    const totals = totalsResult.rows[0];
    response.json({
      revenueCollectedCents: Number(totals.collected_cents),
      unpaidTotalCents: Number(totals.unpaid_cents),
      invoiceCount: totals.invoice_count,
      paidInvoiceCount: totals.paid_count,
      unpaidInvoiceCount: totals.unpaid_count,
      topProducts: topProductsResult.rows.map((row) => ({
        productId: String(row.product_id),
        name: row.product_name,
        unitsSold: Number(row.units_sold),
        revenueCents: Number(row.collected_cents || 0),
      })),
      monthlyRevenue: monthlyResult.rows.map((row) => ({
        month: row.month_start.toISOString().slice(0, 7),
        revenueCents: Number(row.collected_cents),
      })),
    });
  } catch (error) {
    console.error("Could not load analytics:", error.message);
    response.status(500).json({ message: "Could not load analytics." });
  }
});

export default router;