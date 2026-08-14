import assert from "node:assert/strict";
import test from "node:test";

import { addEntry, buildEntry, parseLink, requireOptIn } from "./add-activity.mjs";

const enabled = {
  activityLog: {
    enabled: true,
    owner: "Jordan Lee",
    dataFile: "activity.json",
  },
};

test("requires explicit opt-in and a named human owner", () => {
  assert.throws(
    () => requireOptIn({ activityLog: { enabled: false, owner: "Jordan Lee" } }),
    /not enabled/i,
  );
  assert.throws(
    () => requireOptIn({ activityLog: { enabled: true, owner: "" } }),
    /human owner/i,
  );
  assert.deepEqual(requireOptIn(enabled), enabled.activityLog);
});

test("accepts only labelled HTTPS links to project records", () => {
  assert.deepEqual(parseLink("Pull request|https://github.com/acme/widget/pull/42"), {
    label: "Pull request",
    href: "https://github.com/acme/widget/pull/42",
  });
  assert.throws(() => parseLink("https://github.com/acme/widget/pull/42"), /label\|url/i);
  assert.throws(() => parseLink("Local file|file:///tmp/proof.txt"), /https/i);
  assert.throws(() => parseLink("Record|https://token@example.com/work/42"), /credentials/i);
  assert.throws(() => parseLink("Record|https://example.com/work/42?access_token=secret"), /credentials/i);
});

test("builds a concise, owner-accountable activity entry", () => {
  const entry = buildEntry(
    enabled,
    {
      kind: "milestone",
      workstream: "Save flow",
      summary: "Restart recovery now preserves the selected slot.",
      links: ["Pull request|https://github.com/acme/widget/pull/42"],
    },
    new Date("2026-08-14T18:30:00.000Z"),
  );

  assert.deepEqual(entry, {
    id: "2026-08-14T18-30-00-000Z-save-flow",
    timestamp: "2026-08-14T18:30:00.000Z",
    kind: "milestone",
    workstream: "Save flow",
    summary: "Restart recovery now preserves the selected slot.",
    owner: "Jordan Lee",
    links: [{ label: "Pull request", href: "https://github.com/acme/widget/pull/42" }],
  });
});

test("rejects unsupported kinds and spill-prone free-form content", () => {
  const base = {
    kind: "status",
    workstream: "Save flow",
    summary: "A concise update.",
    links: ["Ticket|https://example.com/tickets/42"],
  };
  assert.throws(() => buildEntry(enabled, base), /kind/i);
  assert.throws(
    () => buildEntry(enabled, { ...base, kind: "outcome", summary: "line one\nline two" }),
    /single line/i,
  );
  assert.throws(
    () => buildEntry(enabled, { ...base, kind: "outcome", summary: "x".repeat(281) }),
    /280/i,
  );
  assert.throws(
    () => buildEntry(enabled, { ...base, kind: "outcome", links: [] }),
    /project record/i,
  );
});

test("prepends entries without discarding the existing log", () => {
  const previous = {
    version: 1,
    entries: [{ id: "older", timestamp: "2026-08-13T10:00:00.000Z" }],
  };
  const next = { id: "newer", timestamp: "2026-08-14T10:00:00.000Z" };
  assert.deepEqual(addEntry(previous, next), {
    version: 1,
    entries: [next, previous.entries[0]],
  });
});
