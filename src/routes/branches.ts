/**
 * Staff — GET /api/branches (auth required).
 *
 * Returns active branches for populating dropdowns in the intake form.
 */
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types";

const branches = new Hono<AppEnv>();

branches.use("*", requireAuth);

branches.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, city, address, whatsapp_number
       FROM branches
      WHERE is_active = 1
      ORDER BY name ASC`,
  ).all();

  return c.json({ branches: results });
});

export default branches;
