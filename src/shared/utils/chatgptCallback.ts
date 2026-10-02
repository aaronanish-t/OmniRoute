/** Parse only: never navigate to or fetch the pasted URL. Errors must not echo its code. */
export function parseChatGptManualCallback(
  value: string,
  expected: { redirectUri: string; state: string }
): { code: string; clientId?: string } {
  const invalid = () => new Error("Paste the full callback URL from this sign-in attempt.");
  if (value.length > 16384) throw invalid();
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    `${url.origin}${url.pathname}` !== expected.redirectUri ||
    url.username ||
    url.password ||
    url.hash
  )
    throw invalid();
  const params = url.searchParams;
  for (const key of ["code", "state", "client_id", "error"])
    if (params.getAll(key).length > 1) throw invalid();
  if (params.get("state") !== expected.state) throw invalid();
  if (params.has("error"))
    throw new Error("ChatGPT did not authorize this sign-in. Start again and allow access.");
  const code = params.get("code");
  const clientId = params.get("client_id");
  if (
    !code?.trim() ||
    code.length > 8192 ||
    (clientId !== null && (!clientId || clientId.length > 200))
  )
    throw invalid();
  return { code, ...(clientId ? { clientId } : {}) };
}

/** Untrusted origin: the callback page requires explicit user confirmation before following. */
export function chatGptCallbackLink(params: URLSearchParams): string | null {
  try {
    const parts = (params.get("state") || "").split(".");
    if (parts.length !== 3 || parts[0] !== "siwc" || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]))
      return null;
    const origin = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const site = new URL(origin);
    if (
      site.origin !== origin ||
      (site.protocol !== "https:" &&
        !(site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname)))
    )
      return null;
    const callback = new URLSearchParams();
    for (const key of ["state", "code", "client_id", "error"]) {
      const value = params.get(key);
      if (value && value.length <= 8192) callback.set(key, value);
    }
    return `${origin}/dashboard/providers/chatgpt/connect#${callback}`;
  } catch {
    return null;
  }
}
