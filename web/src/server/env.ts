import "server-only";
import { z } from "zod";

const schema = z.object({
  PLAID_CLIENT_ID: z.string().min(1),
  PLAID_SECRET: z.string().min(1),
  PLAID_ENV: z.enum(["sandbox", "production"]),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  // base64-encoded argon2 PHC string (raw `$` would be mangled by dotenv expansion)
  DASHBOARD_PASSWORD_HASH: z.string().min(1),
  DATABASE_PATH: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated env, read lazily so `next build` doesn't need secrets. Errors name variables, never values. */
export function env(): Env {
  if (!cached) {
    const result = schema.safeParse(process.env);
    if (!result.success) {
      const names = result.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Missing or invalid environment variables: ${names}`);
    }
    cached = result.data;
  }
  return cached;
}
