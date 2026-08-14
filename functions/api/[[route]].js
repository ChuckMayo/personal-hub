/**
 * Team hub file API — Cloudflare Pages Function over an R2 bucket.
 *
 * Pages caps a static asset at 25 MiB and a request body at ~100 MB, so builds
 * and meeting video cannot live in the deploy or ride a single POST. Everything
 * large goes to R2: small files in one shot, big ones via R2 multipart upload
 * driven from the browser a chunk at a time.
 *
 * The whole site already sits behind Cloudflare Access, so these routes inherit
 * that gate. Access forwards the verified identity, which we record as the
 * uploader — never trust a client-supplied name for it.
 *
 * Binding: HUB_FILES -> R2 bucket (see README, "File sharing & builds").
 *
 *   GET    /api/whoami
 *   GET    /api/files?prefix=share/
 *   POST   /api/files?key=share/x.zip        single-shot upload
 *   DELETE /api/files?key=share/x.zip
 *   GET    /api/dl?key=share/x.zip[&inline=1]
 *   POST   /api/mpu/create?key=builds/x.zip  -> { uploadId }
 *   PUT    /api/mpu/part?key&uploadId&part   -> { partNumber, etag }
 *   POST   /api/mpu/complete?key&uploadId    body: { parts: [...] }
 *   DELETE /api/mpu/abort?key&uploadId
 */

/** Top-level prefixes the API will touch. Anything else is rejected. */
const AREAS = ["share", "builds", "meetings", "clips"];

/** Single-shot uploads stay well under the Pages request-body ceiling. */
const SINGLE_SHOT_MAX = 90 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

/**
 * Keys are attacker-controlled. Allow only a known area plus safe path
 * segments — no traversal, no absolute paths, no empty or dot-only segments.
 */
function cleanKey(raw) {
  if (!raw) return null;
  const key = String(raw).replace(/^\/+/, "");
  if (key.length === 0 || key.length > 512) return null;
  if (key.includes("..") || key.includes("\\") || key.includes("//")) return null;
  const parts = key.split("/");
  if (parts.length < 2) return null;
  if (!AREAS.includes(parts[0])) return null;
  for (const p of parts.slice(1)) {
    if (!p || p === "." || p === "..") return null;
    if (!/^[\w. ()+@-]+$/.test(p)) return null;
  }
  return key;
}

function cleanPrefix(raw) {
  if (!raw) return null;
  const p = String(raw).replace(/^\/+/, "");
  if (p.includes("..") || p.includes("\\")) return null;
  const area = p.split("/")[0];
  return AREAS.includes(area) ? p : null;
}

/** Cloudflare Access forwards the verified identity on every request. */
function identity(request) {
  const h = request.headers;
  return (
    h.get("Cf-Access-Authenticated-User-Email") ||
    h.get("cf-access-authenticated-user-email") ||
    "unknown"
  );
}

function describe(obj) {
  const key = obj.key;
  const name = key.slice(key.lastIndexOf("/") + 1);
  return {
    key,
    name,
    area: key.split("/")[0],
    folder: key.slice(0, key.lastIndexOf("/")),
    size: obj.size,
    uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : obj.uploaded,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    uploader: obj.customMetadata?.uploader || "",
    note: obj.customMetadata?.note || "",
    etag: obj.httpEtag,
  };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const bucket = env.HUB_FILES;
  const url = new URL(request.url);
  const route = Array.isArray(params.route) ? params.route.join("/") : params.route || "";
  const method = request.method.toUpperCase();

  if (!bucket) {
    return json(
      { error: "R2 bucket not bound. Add the HUB_FILES binding — see README." },
      503
    );
  }

  try {
    if (route === "whoami") return json({ email: identity(request) });

    // ---- listing -----------------------------------------------------------
    if (route === "files" && method === "GET") {
      const prefix = cleanPrefix(url.searchParams.get("prefix") || "share/");
      if (!prefix) return bad("bad prefix");

      const files = [];
      let cursor;
      do {
        // R2 omits httpMetadata and customMetadata from list results unless
        // asked. Without this every row renders as application/octet-stream
        // with a blank uploader, even though the stored object is correct.
        const page = await bucket.list({
          prefix, cursor, limit: 1000,
          include: ["httpMetadata", "customMetadata"],
        });
        for (const o of page.objects) files.push(describe(o));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && files.length < 5000);

      files.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
      return json({ prefix, count: files.length, files });
    }

    // ---- single-shot upload -------------------------------------------------
    if (route === "files" && method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");

      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > SINGLE_SHOT_MAX) {
        return bad("file too large for a single request — use the multipart routes", 413);
      }
      if (await bucket.head(key)) return bad("a file with that name already exists", 409);

      await bucket.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("x-file-type") ||
            request.headers.get("content-type") ||
            "application/octet-stream",
        },
        customMetadata: {
          uploader: identity(request),
          note: (url.searchParams.get("note") || "").slice(0, 200),
        },
      });
      const head = await bucket.head(key);
      return json({ ok: true, file: head ? describe(head) : { key } }, 201);
    }

    if (route === "files" && method === "DELETE") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");
      await bucket.delete(key);
      return json({ ok: true, deleted: key });
    }

    // ---- download -----------------------------------------------------------
    if (route === "dl" && method === "GET") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");

      const obj = await bucket.get(key, { range: request.headers });
      if (!obj) return bad("not found", 404);

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("cache-control", "private, max-age=3600");
      headers.set("accept-ranges", "bytes");

      const name = key.slice(key.lastIndexOf("/") + 1);
      const inline = url.searchParams.get("inline") === "1";
      headers.set(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`
      );

      // A ranged hit carries .range; reply 206 so media seeking works.
      const status = obj.range && obj.size !== obj.range.length ? 206 : 200;
      if (status === 206) {
        const { offset = 0, length = obj.size } = obj.range;
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      }
      return new Response(obj.body, { status, headers });
    }

    // ---- multipart upload ---------------------------------------------------
    if (route === "mpu/create" && method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");
      if (await bucket.head(key)) return bad("a file with that name already exists", 409);

      const mpu = await bucket.createMultipartUpload(key, {
        httpMetadata: {
          contentType: url.searchParams.get("type") || "application/octet-stream",
        },
        customMetadata: {
          uploader: identity(request),
          note: (url.searchParams.get("note") || "").slice(0, 200),
        },
      });
      return json({ key, uploadId: mpu.uploadId });
    }

    if (route === "mpu/part" && method === "PUT") {
      const key = cleanKey(url.searchParams.get("key"));
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = Number(url.searchParams.get("part"));
      if (!key || !uploadId) return bad("bad key or uploadId");
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return bad("bad part number");
      }
      const mpu = bucket.resumeMultipartUpload(key, uploadId);
      const part = await mpu.uploadPart(partNumber, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (route === "mpu/complete" && method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      const uploadId = url.searchParams.get("uploadId");
      if (!key || !uploadId) return bad("bad key or uploadId");

      const body = await request.json();
      const parts = Array.isArray(body?.parts) ? body.parts : null;
      if (!parts || parts.length === 0) return bad("no parts");

      const mpu = bucket.resumeMultipartUpload(key, uploadId);
      await mpu.complete(
        parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
      );
      const head = await bucket.head(key);
      return json({ ok: true, file: head ? describe(head) : { key } }, 201);
    }

    if (route === "mpu/abort" && method === "DELETE") {
      const key = cleanKey(url.searchParams.get("key"));
      const uploadId = url.searchParams.get("uploadId");
      if (!key || !uploadId) return bad("bad key or uploadId");
      await bucket.resumeMultipartUpload(key, uploadId).abort();
      return json({ ok: true });
    }

    return bad("no such route", 404);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}
