// Thin client for the local server. Everything is same-origin on 127.0.0.1.

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Home network: the PC removed this device (or it never paired), so go pair it.
  if (res.status === 401 && data.pair) location.replace(typeof data.pair === "string" ? data.pair : "/pair");
  if (!res.ok) {
    const err = new Error(data.pcOnly ? "Change this on the PC." : data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => call("GET", path),
  post: (path, body = {}) => call("POST", path, body),
  put: (path, body = {}) => call("PUT", path, body),
};

/** Where this screen is on the home network: "pc", "device" or "stranger". Servers without home network answer "pc". */
let here = null;
export function whereAmI() {
  here ??= fetch("/api/lan/hello")
    .then((r) => (r.ok ? r.json() : {}))
    .then((h) => h.where ?? "pc")
    .catch(() => "pc");
  return here;
}
