import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Serverless deployments normally use a pooled DATABASE_URL at runtime.
  // Migration tools need a direct connection when the provider supplies one.
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED
      || process.env.DATABASE_URL
      || "postgres://placeholder:placeholder@localhost:5432/placeholder",
  },
  strict: true,
});
