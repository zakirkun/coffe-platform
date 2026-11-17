CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"ticket_id" uuid,
	"runner_id" uuid NOT NULL,
	"container_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"status" text NOT NULL,
	"status_detail" text,
	"ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docker_environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"build" jsonb,
	"command" jsonb,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mount_worktree" boolean DEFAULT true NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "previews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid,
	"runner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"port" integer NOT NULL,
	"container_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ssh_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ssh_host_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"sealed" "bytea" NOT NULL,
	"public_key_fingerprint" text,
	"auth_type" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_hosts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"host_key_fingerprint" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_vaults" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kdf" jsonb NOT NULL,
	"check_nonce" text NOT NULL,
	"check_box" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"doc_name" text NOT NULL,
	"thumbnail_attachment_id" uuid,
	"lease_user_id" text,
	"lease_expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_graphs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"runner_repo_id" uuid NOT NULL,
	"commit" text NOT NULL,
	"nodes" jsonb NOT NULL,
	"edges" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_preferences" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"leaderboard_opt_out" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_preferences_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_run_id" uuid,
	"created_by" text,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_canvases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canvas_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"content" "bytea" NOT NULL,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text,
	"source_ref" text,
	"files" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_canvases" (
	"ticket_id" uuid NOT NULL,
	"canvas_id" uuid NOT NULL,
	"export_attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_canvases_ticket_id_canvas_id_pk" PRIMARY KEY("ticket_id","canvas_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cited_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_commit" text,
	"status" text DEFAULT 'generating' NOT NULL,
	"error" text,
	"generated_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yjs_documents" (
	"name" text PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_environment_id_docker_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."docker_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_environments" ADD CONSTRAINT "docker_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_environments" ADD CONSTRAINT "docker_environments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_credentials" ADD CONSTRAINT "ssh_credentials_ssh_host_id_ssh_hosts_id_fk" FOREIGN KEY ("ssh_host_id") REFERENCES "public"."ssh_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_credentials" ADD CONSTRAINT "ssh_credentials_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_credentials" ADD CONSTRAINT "ssh_credentials_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_hosts" ADD CONSTRAINT "ssh_hosts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_hosts" ADD CONSTRAINT "ssh_hosts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vaults" ADD CONSTRAINT "user_vaults_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_thumbnail_attachment_id_attachments_id_fk" FOREIGN KEY ("thumbnail_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_lease_user_id_user_id_fk" FOREIGN KEY ("lease_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_graphs" ADD CONSTRAINT "code_graphs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_graphs" ADD CONSTRAINT "code_graphs_runner_repo_id_runner_repos_id_fk" FOREIGN KEY ("runner_repo_id") REFERENCES "public"."runner_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_preferences" ADD CONSTRAINT "member_preferences_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_preferences" ADD CONSTRAINT "member_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_canvases" ADD CONSTRAINT "published_canvases_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_canvases" ADD CONSTRAINT "published_canvases_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_canvases" ADD CONSTRAINT "ticket_canvases_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_canvases" ADD CONSTRAINT "ticket_canvases_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_canvases" ADD CONSTRAINT "ticket_canvases_export_attachment_id_attachments_id_fk" FOREIGN KEY ("export_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_generated_by_run_id_runs_id_fk" FOREIGN KEY ("generated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "containers_runner_container_uq" ON "containers" USING btree ("runner_id","container_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_environments_project_name_uq" ON "docker_environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "previews_slug_uq" ON "previews" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "previews_project_idx" ON "previews" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_credentials_host_runner_uq" ON "ssh_credentials" USING btree ("ssh_host_id","runner_id");--> statement-breakpoint
CREATE INDEX "ssh_hosts_workspace_idx" ON "ssh_hosts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_items_user_kind_ref_uq" ON "vault_items" USING btree ("user_id","kind","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_doc_name_uq" ON "canvases" USING btree ("doc_name");--> statement-breakpoint
CREATE INDEX "canvases_project_idx" ON "canvases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "code_graphs_project_created_idx" ON "code_graphs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "memories_project_status_idx" ON "memories" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "memories_fts_idx" ON "memories" USING gin (to_tsvector('simple', "title" || ' ' || "body"));--> statement-breakpoint
CREATE UNIQUE INDEX "published_canvases_slug_uq" ON "published_canvases" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skills_workspace_idx" ON "skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_project_slug_uq" ON "wiki_pages" USING btree ("project_id","slug");