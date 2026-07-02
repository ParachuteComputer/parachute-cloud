import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run once per worker, OUTSIDE isolated storage — so the schema
// persists across all tests while each test's own row writes roll back.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
