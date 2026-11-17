ALTER TABLE "runs" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "handoff" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "requirement_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;