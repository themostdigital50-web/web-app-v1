import { Router } from "express";
import { pool } from "../db.js";
import requireAuth from "../middleware/require-auth.js";

const router = Router();

router.use(requireAuth);

function productResponse(row) {
  return {
    id: String(row.id),
    name: row.name,
    sku: row.sku,
    quantity: row.quantity,
    unitPriceCents: Number(row.unit_price_cents),
  };
}

function validId(id) {
  return /^\d{1,19}$/.test(id) && BigInt(id) <= 9223372036854775807n;
}

// GET /api/products?q=shirt&stock=low
router.get("/", async (request, response) => {
  const tenantId = request.session.user.tenantId;
  const search = typeof request.query.q === "string"
    ? request.query.q.trim().slice(0, 100)
    : "";
  const stock = request.query.stock;

  if (stock && stock !== "low" && stock !== "in") {
    return response.status(400).json({
      message: "Stock filter must be 'low' or 'in'.",
    });
  }

  const values = [tenantId];
  const filters = ["tenant_id = $1"];

  if (search) {
    values.push(`%${search}%`);
    filters.push(`(name ILIKE $${values.length} OR sku ILIKE $${values.length})`);
  }

  if (stock === "low") filters.push("quantity < 10");
  if (stock === "in") filters.push("quantity >= 10");

  try {
    const result = await pool.query(
      `SELECT id, name, sku, quantity, unit_price_cents
       FROM products
       WHERE ${filters.join(" AND ")}
       ORDER BY name`,
      values,
    );

    response.json({ products: result.rows.map(productResponse) });
  } catch (error) {
    console.error("Could not list products:", error.message);
    response.status(500).json({ message: "Could not load products." });
  }
});

// POST /api/products
router.post("/", async (request, response) => {
  const name = typeof request.body?.name === "string"
    ? request.body.name.trim()
    : "";
  const sku = typeof request.body?.sku === "string"
    ? request.body.sku.trim().toUpperCase()
    : "";
  const quantity = request.body?.quantity;
  const unitPriceCents = request.body?.unitPriceCents;
  const tenantId = request.session.user.tenantId;

  if (
    !name || name.length > 120 ||
    !sku || sku.length > 40 ||
    !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 2147483647 ||
    !Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0
  ) {
    return response.status(400).json({
      message: "Provide a name, SKU, whole-number quantity, and price in cents.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (tenant_id, name, sku, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, sku, quantity, unit_price_cents`,
      [tenantId, name, sku, quantity, unitPriceCents],
    );

    response.status(201).json({ product: productResponse(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({
        message: "That SKU is already used by your company.",
      });
    }

    console.error("Could not create product:", error.message);
    response.status(500).json({ message: "Could not create product." });
  }
});

// PATCH /api/products/:id
router.patch("/:id", async (request, response) => {
  const { id } = request.params;
  const tenantId = request.session.user.tenantId;

  if (!validId(id)) {
    return response.status(400).json({ message: "Invalid product ID." });
  }

  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response.status(400).json({ message: "Provide product fields to update." });
  }

  const changes = [];
  const values = [];

  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
      return response.status(400).json({ message: "Product name must be 1–120 characters." });
    }
    values.push(body.name.trim());
    changes.push(`name = $${values.length}`);
  }

  if (Object.hasOwn(body, "sku")) {
    if (typeof body.sku !== "string" || !body.sku.trim() || body.sku.trim().length > 40) {
      return response.status(400).json({ message: "SKU must be 1–40 characters." });
    }
    values.push(body.sku.trim().toUpperCase());
    changes.push(`sku = $${values.length}`);
  }

  if (Object.hasOwn(body, "quantity")) {
    if (!Number.isSafeInteger(body.quantity) || body.quantity < 0 || body.quantity > 2147483647) {
      return response.status(400).json({ message: "Quantity must be a non-negative whole number." });
    }
    values.push(body.quantity);
    changes.push(`quantity = $${values.length}`);
  }

  if (Object.hasOwn(body, "unitPriceCents")) {
    if (!Number.isSafeInteger(body.unitPriceCents) || body.unitPriceCents < 0) {
      return response.status(400).json({ message: "Price must be a non-negative whole number of cents." });
    }
    values.push(body.unitPriceCents);
    changes.push(`unit_price_cents = $${values.length}`);
  }

  if (!changes.length) {
    return response.status(400).json({ message: "Provide at least one valid field to update." });
  }

  values.push(tenantId, id);

  try {
    const result = await pool.query(
      `UPDATE products
       SET ${changes.join(", ")}
       WHERE tenant_id = $${values.length - 1} AND id = $${values.length}
       RETURNING id, name, sku, quantity, unit_price_cents`,
      values,
    );

    if (!result.rowCount) {
      return response.status(404).json({ message: "Product not found." });
    }

    response.json({ product: productResponse(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({
        message: "That SKU is already used by your company.",
      });
    }

    console.error("Could not update product:", error.message);
    response.status(500).json({ message: "Could not update product." });
  }
});

export default router;