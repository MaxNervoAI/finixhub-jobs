/**
 * EPIC-030: 6-Month Opportunity Performance Archiver → Cloudflare R2
 *
 * Fetches opportunity_performance rows older than 180 days, uploads them as a
 * compressed JSON archive to Cloudflare R2 (S3-compatible), then deletes the
 * archived rows from Postgres.
 *
 * Run via GitHub Actions monthly cron (see .github/workflows/archive-opportunity-performance.yml).
 * Safe to run manually: --dry-run flag logs what would be archived without touching the DB or R2.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *
 * Optional:
 *   ARCHIVE_DAYS   — override the 180-day cutoff (default 180)
 */

import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");
const ARCHIVE_DAYS = parseInt(process.env.ARCHIVE_DAYS ?? "180", 10);
const BATCH_SIZE = 1000;

// ── Validate env ──────────────────────────────────────────────────────────────

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[archive] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

if (!DRY_RUN && (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME)) {
  console.error("[archive] Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)");
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const r2 = DRY_RUN
  ? null
  : new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

// ── Helpers ───────────────────────────────────────────────────────────────────

function cutoffDate() {
  const d = new Date();
  d.setDate(d.getDate() - ARCHIVE_DAYS);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

function archiveKey(runDate) {
  return `opportunity-performance/${runDate}-archive.json`;
}

// ── Fetch rows to archive ─────────────────────────────────────────────────────

async function fetchRowsToArchive(cutoff) {
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("opportunity_performance")
      .select("*")
      .lt("simulation_date", cutoff)
      .range(from, from + BATCH_SIZE - 1)
      .order("simulation_date", { ascending: true });

    if (error) throw new Error(`Supabase fetch error: ${error.message}`);
    if (!data || data.length === 0) break;

    rows.push(...data);
    console.log(`[archive] Fetched ${rows.length} rows so far...`);

    if (data.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }

  return rows;
}

// ── Upload to R2 ──────────────────────────────────────────────────────────────

async function uploadToR2(key, rows, runDate) {
  const payload = JSON.stringify({
    archived_at: new Date().toISOString(),
    archive_cutoff_days: ARCHIVE_DAYS,
    run_date: runDate,
    row_count: rows.length,
    rows,
  });

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: payload,
      ContentType: "application/json",
      Metadata: {
        row_count: String(rows.length),
        archived_at: new Date().toISOString(),
      },
    })
  );

  console.log(`[archive] ✓ Uploaded ${rows.length} rows to R2: ${R2_BUCKET_NAME}/${key}`);
}

// ── Delete from Postgres ──────────────────────────────────────────────────────

async function deleteArchivedRows(cutoff) {
  const { error, count } = await supabase
    .from("opportunity_performance")
    .delete({ count: "exact" })
    .lt("simulation_date", cutoff);

  if (error) throw new Error(`Supabase delete error: ${error.message}`);
  console.log(`[archive] ✓ Deleted ${count ?? "?"} rows from opportunity_performance`);
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().split("T")[0];
  const cutoff = cutoffDate();

  console.log(`\n[archive] ══════════════════════════════════════`);
  console.log(`[archive] Opportunity Performance Archiver ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`[archive] Cutoff: ${cutoff} (${ARCHIVE_DAYS} days ago)`);
  console.log(`[archive] Run date: ${runDate}`);
  console.log(`[archive] ══════════════════════════════════════\n`);

  const rows = await fetchRowsToArchive(cutoff);

  if (rows.length === 0) {
    console.log("[archive] No rows older than cutoff — nothing to archive.");
    return;
  }

  console.log(`[archive] Found ${rows.length} rows to archive.`);

  if (DRY_RUN) {
    console.log(`[archive] DRY RUN — skipping R2 upload and DB deletion.`);
    console.log(`[archive] Would upload to: ${archiveKey(runDate)}`);
    console.log(`[archive] Sample rows (first 3):`, rows.slice(0, 3).map((r) => ({
      id: r.id,
      asset_symbol: r.asset_symbol,
      simulation_date: r.simulation_date,
      final_status: r.final_status,
    })));
    return;
  }

  // 1. Upload to R2 first — don't delete until we know the archive exists
  const key = archiveKey(runDate);
  await uploadToR2(key, rows, runDate);

  // 2. Delete from Postgres
  await deleteArchivedRows(cutoff);

  console.log(`\n[archive] Done. ${rows.length} rows archived to R2 and removed from Postgres.`);
}

main().catch((err) => {
  console.error("[archive] Fatal:", err.message);
  process.exit(1);
});
