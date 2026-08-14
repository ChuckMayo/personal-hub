#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const CONFIG_PATH = join(SITE, "hub.config.js");
const KINDS = new Set(["outcome", "milestone", "decision", "blocker", "next-step"]);

export function requireOptIn(config) {
  const settings = config?.activityLog;
  if (settings?.enabled !== true) {
    throw new Error("The activity log is not enabled. A human must explicitly set activityLog.enabled to true.");
  }
  if (typeof settings.owner !== "string" || !settings.owner.trim()) {
    throw new Error("The activity log needs a named human owner before an agent may post.");
  }
  return settings;
}

function oneLine(value, label, max) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (/\r|\n/.test(text)) throw new Error(`${label} must be a single line`);
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return text;
}

export function parseLink(value) {
  const raw = oneLine(value, "link", 500);
  const split = raw.indexOf("|");
  if (split < 1 || split === raw.length - 1) {
    throw new Error('Each link must use "label|url"');
  }
  const label = oneLine(raw.slice(0, split), "link label", 80);
  let href;
  try { href = new URL(raw.slice(split + 1).trim()); }
  catch { throw new Error("Each link URL must be valid HTTPS"); }
  if (href.protocol !== "https:") throw new Error("Each link URL must use HTTPS");
  const credentialParam = /^(access_?token|token|api_?key|secret|password|signature|sig|auth|authorization)$/i;
  if (href.username || href.password || [...href.searchParams.keys()].some((key) => credentialParam.test(key))) {
    throw new Error("Project-record links must not contain credentials");
  }
  return { label, href: href.href };
}

const slug = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "update";

export function buildEntry(config, input, now = new Date()) {
  const settings = requireOptIn(config);
  const kind = oneLine(input?.kind, "kind", 32);
  if (!KINDS.has(kind)) throw new Error(`kind must be one of: ${[...KINDS].join(", ")}`);
  const workstream = oneLine(input?.workstream, "workstream", 80);
  const summary = oneLine(input?.summary, "summary", 280);
  const links = (input?.links || []).map(parseLink);
  if (!links.length) throw new Error("At least one link to the true project record is required");
  const timestamp = now.toISOString();

  return {
    id: `${timestamp.replace(/[.:]/g, "-")}-${slug(workstream)}`,
    timestamp,
    kind,
    workstream,
    summary,
    owner: oneLine(settings.owner, "human owner", 120),
    links,
  };
}

export function addEntry(document, entry) {
  const entries = Array.isArray(document?.entries) ? document.entries : [];
  if (entries.some((item) => item?.id === entry.id)) throw new Error(`Entry id already exists: ${entry.id}`);
  return { version: 1, entries: [entry, ...entries] };
}

function parseArgs(argv) {
  const args = { links: [] };
  for (const token of argv) {
    const match = token.match(/^--([a-z-]+)=(.*)$/s);
    if (!match) throw new Error(`Expected --key=value, received: ${token}`);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "link") args.links.push(match[2]);
    else args[key] = match[2];
  }
  return args;
}

function activityPath(settings) {
  const dataFile = settings.dataFile || "activity.json";
  if (isAbsolute(dataFile) || dataFile.includes("..") || !dataFile.endsWith(".json")) {
    throw new Error("activityLog.dataFile must be a JSON file inside site/");
  }
  const path = resolve(SITE, dataFile);
  if (relative(SITE, path).startsWith("..")) throw new Error("activityLog.dataFile must stay inside site/");
  return path;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Usage:
  node scripts/add-activity.mjs \\
    --kind=outcome \\
    --workstream="Checkout" \\
    --summary="The retry path now preserves the cart." \\
    --link="Pull request|https://github.com/acme/shop/pull/42"

Kinds: outcome, milestone, decision, blocker, next-step
Repeat --link for additional true project records.`);
    return;
  }

  await import(pathToFileURL(CONFIG_PATH).href);
  const config = globalThis.HUB_CONFIG;
  const settings = requireOptIn(config);
  const entry = buildEntry(config, parseArgs(process.argv.slice(2)));
  const path = activityPath(settings);
  let document = { version: 1, entries: [] };
  try { document = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  writeFileSync(path, JSON.stringify(addEntry(document, entry), null, 2) + "\n");
  console.log(`Added ${entry.kind} update to ${relative(ROOT, path)} for ${entry.owner}.`);
  console.log("Review the diff before committing. Do not post reasoning traces, messages, credentials, personal or customer data, raw logs, or secrets.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`activity log: ${error.message}`);
    process.exitCode = 1;
  });
}
