// /api/fonts/google?family=Geist: a font from Google Fonts for Kurviq's
// "Add font", fetched here so visitors' browsers never talk to Google (and
// the page's CSP stays strict). Nothing is stored: Cloudflare's cache keeps
// the answer for a day.

const FAMILY_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
const MAX_BYTES = 2 * 1024 * 1024;

const json = (status: number, body: unknown, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
  });

const toDataUrl = (bytes: ArrayBuffer) => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
};

/** Google's CSS for a family → its Latin files (latin, latin-ext) as data URLs */
const googleFaces = async (family: string) => {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`, {
    headers: {
      // a current browser: Google answers with woff2
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    },
  });
  if (!css.ok) {
    return null;
  }
  const blocks = [...(await css.text()).matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)];
  const wanted = blocks.filter(([, subset]) => subset === "latin" || subset === "latin-ext");
  const faces: Array<{ data: string; range?: string }> = [];
  for (const [, , body] of (wanted.length ? wanted : blocks).slice(0, 4)) {
    const url = body.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
    if (!url) {
      continue;
    }
    const file = await fetch(url);
    if (!file.ok) {
      throw new Error(`Google Fonts answered ${file.status}`);
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error("The font is too large");
    }
    faces.push({ data: toDataUrl(bytes), ...(range ? { range } : {}) });
  }
  return faces.length ? faces : null;
};

export const handleFonts = async (request: Request, ctx: ExecutionContext): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/api/fonts/google") {
    return null;
  }
  const family = (url.searchParams.get("family") || "").trim();
  if (request.method !== "GET" || !FAMILY_RE.test(family)) {
    return json(400, { error: "Name: letters, digits, spaces, . _ - (up to 60)" });
  }
  const key = new Request(`${url.origin}/api/fonts/google?family=${encodeURIComponent(family.toLowerCase())}`);
  const hit = await caches.default.match(key);
  if (hit) {
    return hit;
  }
  let response: Response;
  try {
    const faces = await googleFaces(family);
    response = faces
      ? json(200, { family, faces }, "public, max-age=86400")
      : json(404, { error: `"${family}" is not on Google Fonts (check the spelling on fonts.google.com)` }, "public, max-age=600");
  } catch (error: any) {
    return json(502, { error: error.message || "Google Fonts not reachable" });
  }
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
};
