ALTER TABLE "users" ADD COLUMN "username" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx"
  ON "users" (lower("username"))
  WHERE "username" IS NOT NULL;
