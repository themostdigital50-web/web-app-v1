import { Router } from "express";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { pool } from "../db.js";
import requireAuth from "../middleware/require-auth.js";

const router = Router();

router.use(requireAuth);

const MAX_BIGINT = 9223372036854775807n;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

function money(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Number(cents) / 100);
}

function validId(value) {
  return typeof value === "string" &&
    /^\d{1,19}$/.test(value) &&
    BigInt(value) <= MAX_BIGINT;
}

// GET /api/invoices
router.get("/", async (request, response) => {
  const tenantId = request.session.user.tenantId;

  try {
    const result = await pool.query(
      `SELECT id, invoice_number, client_name, client_email,
              status, total_cents, issued_at
       FROM invoices
       WHERE tenant_id = $1
       ORDER BY issued_at DESC
       LIMIT 100`,
      [tenantId],
    );

    const invoices = result.rows.map((row) => ({
      id: String(row.id),
      invoiceNumber: row.invoice_number,
      clientName: row.client_name,
      clientEmail: row.client_email,
      status: row.status,
      totalCents: Number(row.total_cents),
      date: row.issued_at.toISOString().slice(0, 10),
      lines: [],
    }));

    if (invoices.length === 0) {
      return response.json({ invoices });
    }

    const invoiceIds = invoices.map((invoice) => invoice.id);
    const itemsResult = await pool.query(
      `SELECT invoice_id, product_id, product_name, sku,
              quantity, unit_price_cents
       FROM invoice_items
       WHERE tenant_id = $1 AND invoice_id = ANY($2::bigint[])
       ORDER BY id`,
      [tenantId, invoiceIds],
    );

    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]));

    for (const row of itemsResult.rows) {
      invoicesById.get(String(row.invoice_id)).lines.push({
        productId: String(row.product_id),
        name: row.product_name,
        sku: row.sku,
        quantity: row.quantity,
        unitPriceCents: Number(row.unit_price_cents),
      });
    }

    response.json({ invoices });
  } catch (error) {
    console.error("Could not list invoices:", error.message);
    response.status(500).json({ message: "Could not load invoices." });
  }
});

router.get("/:id/pdf", async (request, response) => {
  const tenantId = request.session.user.tenantId;
  const { id } = request.params;

  if (!validId(id)) {
    return response.status(400).json({ message: "Invalid invoice ID." });
  }

  try {
    const invoiceResult = await pool.query(
      `SELECT invoices.id, invoices.invoice_number, invoices.client_name,
              invoices.client_email, invoices.status, invoices.total_cents,
              invoices.issued_at, tenants.name AS tenant_name
       FROM invoices
       JOIN tenants ON tenants.id = invoices.tenant_id
       WHERE invoices.tenant_id = $1 AND invoices.id = $2`,
      [tenantId, id],
    );

    if (!invoiceResult.rowCount) {
      return response.status(404).json({ message: "Invoice not found." });
    }

    const invoice = invoiceResult.rows[0];
    const itemsResult = await pool.query(
      `SELECT product_name, sku, quantity, unit_price_cents
       FROM invoice_items
       WHERE tenant_id = $1 AND invoice_id = $2
       ORDER BY id`,
      [tenantId, id],
    );

    const filename = `invoice-${invoice.invoice_number.replace(/[^a-zA-Z0-9_-]/g, "")}.pdf`;
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const document = new PDFDocument({ size: "A4", margin: 52, bufferPages: true });
    document.on("error", (error) => {
      console.error("Could not generate invoice PDF:", error.message);
      response.destroy(error);
    });
    document.pipe(response);

    const pageWidth = document.page.width - document.page.margins.left - document.page.margins.right;
    const right = document.page.width - document.page.margins.right;
    const issuedDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(invoice.issued_at);

    document.fillColor("#267260").font("Helvetica-Bold").fontSize(23).text(invoice.tenant_name);
    document.moveDown(0.3);
    document.fillColor("#75817b").font("Helvetica").fontSize(10).text("INVOICE");
    document.moveDown(0.6);
    document.fillColor("#26332e").font("Helvetica-Bold").fontSize(18).text(invoice.invoice_number);
    document.moveDown(0.3);
    document.fillColor("#75817b").font("Helvetica").fontSize(10).text(`Issued ${issuedDate}`);
    document.moveDown(1.6);

    const detailsY = document.y;
    document.fillColor("#929d97").font("Helvetica-Bold").fontSize(9).text("BILL TO", 52, detailsY);
    document.fillColor("#26332e").font("Helvetica-Bold").fontSize(12).text(invoice.client_name, 52, detailsY + 16);
    document.fillColor("#75817b").font("Helvetica").fontSize(10).text(invoice.client_email, 52, detailsY + 34);
    document.fillColor("#929d97").font("Helvetica-Bold").fontSize(9).text("PAYMENT STATUS", right - 150, detailsY);
    document.fillColor(invoice.status === "paid" ? "#317a60" : "#ae7639")
      .font("Helvetica-Bold").fontSize(10).text(invoice.status.toUpperCase(), right - 150, detailsY + 18);

    document.y = detailsY + 72;
    const columns = { item: 52, qty: right - 160, unit: right - 105, amount: right - 48 };
    const drawTableHeader = () => {
      const y = document.y;
      document.rect(52, y, pageWidth, 25).fill("#f1f6f3");
      document.fillColor("#68766e").font("Helvetica-Bold").fontSize(9);
      document.text("ITEM", columns.item + 8, y + 8);
      document.text("QTY", columns.qty, y + 8, { width: 35, align: "right" });
      document.text("UNIT", columns.unit, y + 8, { width: 48, align: "right" });
      document.text("AMOUNT", columns.amount, y + 8, { width: 50, align: "right" });
      document.y = y + 25;
    };

    drawTableHeader();
    for (const item of itemsResult.rows) {
      if (document.y > document.page.height - 105) {
        document.addPage();
        drawTableHeader();
      }

      const y = document.y;
      const amountCents = BigInt(item.unit_price_cents) * BigInt(item.quantity);
      document.fillColor("#35423b").font("Helvetica").fontSize(10);
      document.text(item.product_name, columns.item + 8, y + 9, { width: 240 });
      document.fillColor("#929d97").fontSize(8).text(item.sku, columns.item + 8, y + 23);
      document.fillColor("#59665f").fontSize(9);
      document.text(String(item.quantity), columns.qty, y + 10, { width: 35, align: "right" });
      document.text(money(item.unit_price_cents), columns.unit, y + 10, { width: 48, align: "right" });
      document.text(money(amountCents), columns.amount, y + 10, { width: 50, align: "right" });
      document.moveTo(52, y + 42).lineTo(right, y + 42).strokeColor("#e7ece9").stroke();
      document.y = y + 48;
    }

    if (document.y > document.page.height - 100) document.addPage();
    document.moveDown(1);
    document.fillColor("#59665f").font("Helvetica").fontSize(11)
      .text(invoice.status === "paid" ? "Total paid" : "Total due", right - 190, document.y, {
      width: 95,
      align: "right",
    });
    document.fillColor("#245f50").font("Helvetica-Bold").fontSize(16).text(money(invoice.total_cents), right - 85, document.y - 1, {
      width: 85,
      align: "right",
    });
    document.moveDown(4);
    document.fillColor("#929d97").font("Helvetica").fontSize(9)
      .text("Thank you for your business.", 52, document.y, { width: pageWidth, align: "center" });
    document.end();
  } catch (error) {
    console.error("Could not create invoice PDF:", error.message);
    if (!response.headersSent) {
      response.status(500).json({ message: "Could not create invoice PDF." });
    } else {
      response.destroy(error);
    }
  }
});

// POST /api/invoices
router.post("/", async (request, response) => {
  const tenantId = request.session.user.tenantId;
  const userId = request.session.user.id;
  const clientName = typeof request.body?.clientName === "string"
    ? request.body.clientName.trim()
    : "";
  const clientEmail = typeof request.body?.clientEmail === "string"
    ? request.body.clientEmail.trim().toLowerCase()
    : "";
  const status = request.body?.status;
  const lines = request.body?.lines;

  if (
    !clientName ||
    clientName.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) ||
    clientEmail.length > 254 ||
    !["paid", "unpaid"].includes(status) ||
    !Array.isArray(lines) ||
    lines.length < 1 ||
    lines.length > 5
  ) {
    return response.status(400).json({
      message: "Provide a client name, valid email, payment status, and 1–5 invoice items.",
    });
  }

  const requestedQuantities = new Map();

  for (const line of lines) {
    if (
      !line ||
      !validId(line.productId) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 2147483647
    ) {
      return response.status(400).json({
        message: "Each item needs a valid product ID and a positive whole-number quantity.",
      });
    }

    const productId = line.productId;
    const totalQuantity = (requestedQuantities.get(productId) || 0) + line.quantity;

    if (!Number.isSafeInteger(totalQuantity) || totalQuantity > 2147483647) {
      return response.status(400).json({
        message: "The requested quantity is too large.",
      });
    }

    requestedQuantities.set(productId, totalQuantity);
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const productIds = [...requestedQuantities.keys()];
    const productsResult = await client.query(
      `SELECT id, name, sku, quantity, unit_price_cents
       FROM products
       WHERE tenant_id = $1 AND id = ANY($2::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [tenantId, productIds],
    );

    if (productsResult.rows.length !== productIds.length) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return response.status(400).json({
        message: "One or more selected products are unavailable.",
      });
    }

    const productsById = new Map(
      productsResult.rows.map((product) => [String(product.id), product]),
    );

    for (const [productId, quantity] of requestedQuantities) {
      const product = productsById.get(productId);

      if (product.quantity < quantity) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return response.status(409).json({
          message: `Not enough stock for ${product.name}. Available: ${product.quantity}.`,
        });
      }
    }

    let totalCents = 0n;

    for (const line of lines) {
      const product = productsById.get(line.productId);
      totalCents += BigInt(product.unit_price_cents) * BigInt(line.quantity);
    }

    if (totalCents > MAX_BIGINT || totalCents > MAX_SAFE_CENTS) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return response.status(400).json({
        message: "The invoice total is too large.",
      });
    }

    const invoiceNumber = `INV-${randomUUID().toUpperCase()}`;
    const invoiceResult = await client.query(
      `INSERT INTO invoices
         (tenant_id, created_by_user_id, invoice_number,
          client_name, client_email, status, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, invoice_number, client_name, client_email,
                 status, total_cents, issued_at`,
      [
        tenantId,
        userId,
        invoiceNumber,
        clientName,
        clientEmail,
        status,
        totalCents.toString(),
      ],
    );

    const invoice = invoiceResult.rows[0];

    for (const line of lines) {
      const product = productsById.get(line.productId);

      await client.query(
        `INSERT INTO invoice_items
           (tenant_id, invoice_id, product_id, product_name,
            sku, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          invoice.id,
          product.id,
          product.name,
          product.sku,
          line.quantity,
          product.unit_price_cents,
        ],
      );
    }

    for (const [productId, quantity] of requestedQuantities) {
      await client.query(
        `UPDATE products
         SET quantity = quantity - $1
         WHERE tenant_id = $2 AND id = $3`,
        [quantity, tenantId, productId],
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;

    response.status(201).json({
      invoice: {
        id: String(invoice.id),
        invoiceNumber: invoice.invoice_number,
        clientName: invoice.client_name,
        clientEmail: invoice.client_email,
        status: invoice.status,
        totalCents: Number(invoice.total_cents),
        date: invoice.issued_at.toISOString().slice(0, 10),
        lines: lines.map((line) => {
          const product = productsById.get(line.productId);
          return {
            productId: String(product.id),
            name: product.name,
            sku: product.sku,
            quantity: line.quantity,
            unitPriceCents: Number(product.unit_price_cents),
          };
        }),
      },
    });
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }

    console.error("Could not create invoice:", error.message);
    response.status(500).json({ message: "Could not create invoice." });
  } finally {
    client.release();
  }
});

export default router;