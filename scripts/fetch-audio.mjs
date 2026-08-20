#!/usr/bin/env node
/**
 * fetch-audio.mjs — Scan all ChuckMayo GitHub repos for audio files.
 *
 * Uses `gh search code` with user-scoped queries (one per extension) to avoid
 * hitting the secondary rate limit from per-repo bursts. Outputs `site/audio.json`.
 *
 * Requirements:
 *   GH_TOKEN or `gh auth status` — needs repo scope.
 *   Run from repo root: `cd personal-hub && node scripts/fetch-audio.mjs`.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "site", "audio.json");

const DELAY_MS = 6500; // ~9 req/min — safe under GitHub's 30/min + burst limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXTENSIONS = [
  "mp3", "wav", "ogg", "flac", "aiff", "aif",
  "m4a", "wma", "opus",
];

function gh(...args) {
  const out = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return out;
}

const BASE_URL = "https://github.com/ChuckMayo";

console.error(`Scanning ChuckMayo repos for audio files… (${EXTENSIONS.length} ext × 1 user query each)`);

const results = [];
const stats = { total: 0, byExt: {}, byRepo: {} };

for (let i = 0; i < EXTENSIONS.length; i++) {
  const ext = EXTENSIONS[i];
  if (i > 0) await sleep(DELAY_MS);

  try {
    const result = gh(
      "search", "code",
      `extension:${ext} user:ChuckMayo`,
      "--json", "path,repository,url",
      "--limit", "500",
    );
    const matches = JSON.parse(result);
    for (const m of matches) {
      const repo = (m.repository && m.repository.name) || "unknown";
      results.push({
        repo,
        path: m.path,
        ext,
        url: m.url || m.html_url || `${BASE_URL}/${repo}/blob/main/${m.path}`,
      });
      stats.total++;
      stats.byRepo[repo] = (stats.byRepo[repo] || 0) + 1;
      stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
    }
    console.error(`  .${ext}: ${matches.length} hits`);
  } catch (e) {
    console.error(`  .${ext}: skipped (${e.message || "no matches"})`);
  }
}

const output = {
  generatedAt: new Date().toISOString(),
  sources: [
    { type: "github", owner: "ChuckMayo" },
  ],
  files: results,
  stats,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
console.error(`\nWrote ${results.length} audio files → ${OUT}`);
