// Assembles automation/site-health-seed-workflow.template.json with the current
// contents of automation/site-health-seed-task.js and applies it via `dtctl apply`.
// Uses `dtctl apply --write-id` on first run so the workflow ID gets stamped back
// into a generated -deployed.json file, keeping subsequent runs idempotent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TEMPLATE_PATH = resolve(REPO_ROOT, "automation/site-health-seed-workflow.template.json");
const TASK_JS_PATH  = resolve(REPO_ROOT, "automation/site-health-seed-task.js");
const DEPLOYED_PATH = resolve(REPO_ROOT, "automation/site-health-seed-workflow.deployed.json");

function whoamiUserId(): string {
  const proc = spawnSync("dtctl", ["auth", "whoami", "-o", "json"], { encoding: "utf8" });
  if (proc.status !== 0) {
    console.error("dtctl auth whoami failed — is dtctl logged in?");
    console.error(proc.stderr);
    process.exit(1);
  }
  const parsed = JSON.parse(proc.stdout) as {
    userId?: string;
    user_id?: string;
    result?: { userId?: string; user_id?: string };
  };
  const userId = parsed.userId ?? parsed.user_id ?? parsed.result?.userId ?? parsed.result?.user_id;
  if (!userId) {
    console.error("Could not extract user_id from dtctl auth whoami output");
    process.exit(1);
  }
  return userId;
}

function main(): void {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as {
    tasks: Record<string, { input: { script: string } }>;
    [k: string]: unknown;
  };
  const taskJs = readFileSync(TASK_JS_PATH, "utf8");

  template.tasks.seed_bizevents.input.script = taskJs;

  const userId = whoamiUserId();
  (template as { actor?: string; owner?: string }).actor = userId;
  (template as { actor?: string; owner?: string }).owner = userId;
  console.log(`Using workflow actor/owner = ${userId}`);

  // If a previous deploy stamped an id into deployed.json, preserve it so apply updates in place.
  if (existsSync(DEPLOYED_PATH)) {
    const prev = JSON.parse(readFileSync(DEPLOYED_PATH, "utf8")) as { id?: string };
    if (prev.id) (template as { id?: string }).id = prev.id;
  }

  writeFileSync(DEPLOYED_PATH, JSON.stringify(template, null, 2) + "\n");
  console.log(`Assembled workflow → ${DEPLOYED_PATH}`);

  const args = ["apply", "workflow", "-f", DEPLOYED_PATH, "-o", "json"];
  console.log(`Running: dtctl ${args.join(" ")}`);
  const proc = spawnSync("dtctl", args, { stdio: ["ignore", "pipe", "inherit"] });
  if (proc.status !== 0) {
    console.error(`dtctl apply failed with exit code ${proc.status}`);
    process.exit(proc.status ?? 1);
  }
  const stdout = proc.stdout.toString();
  console.log(stdout);

  // Stamp the returned id back into the deployed file so future runs UPDATE in place.
  try {
    const applied = JSON.parse(stdout) as { id?: string };
    if (applied.id && !("id" in template)) {
      const current = JSON.parse(readFileSync(DEPLOYED_PATH, "utf8")) as { id?: string };
      if (!current.id) {
        current.id = applied.id;
        writeFileSync(DEPLOYED_PATH, JSON.stringify(current, null, 2) + "\n");
        console.log(`Stamped id=${applied.id} into deployed.json for idempotency.`);
      }
    }
  } catch {
    // Non-fatal: warning already printed if id write-back was skipped.
  }
}

main();
