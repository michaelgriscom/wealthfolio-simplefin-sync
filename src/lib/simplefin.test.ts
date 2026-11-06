import { readFileSync } from "node:fs";
import type { NetworkRequest, NetworkResponse } from "@wealthfolio/addon-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_BRIDGE_HOSTS,
  DisallowedHostError,
  claimToken,
  explainRequestError,
  fetchAccounts,
  isAccessUrl,
  resolveAccessUrl,
  splitAccessUrl,
} from "./simplefin";

const respond = (status: number, body: string): NetworkResponse => ({ status, headers: {}, body });

/** A broker stub that answers every request with the given response. */
function broker(response: NetworkResponse | Error) {
  return vi.fn(async (_req: NetworkRequest): Promise<NetworkResponse> => {
    if (response instanceof Error) throw response;
    return response;
  });
}

const CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-TOKEN";
const ACCESS_URL = "https://user123:pa55word@beta-bridge.simplefin.org/simplefin";

describe("ALLOWED_BRIDGE_HOSTS", () => {
  it("matches network.allowedHosts in manifest.json (the broker enforces the manifest)", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
    ) as { network: { allowedHosts: string[] } };
    expect([...ALLOWED_BRIDGE_HOSTS].sort()).toEqual([...manifest.network.allowedHosts].sort());
  });
});

describe("isAccessUrl", () => {
  it("distinguishes access URLs from base64 setup tokens", () => {
    expect(isAccessUrl(ACCESS_URL)).toBe(true);
    expect(isAccessUrl("  HTTPS://x@bridge.simplefin.org/simplefin\n")).toBe(true);
    // a setup token is base64 of a claim URL, so it starts "aHR0c..." not "http"
    expect(isAccessUrl(btoa(CLAIM_URL))).toBe(false);
  });
});

describe("splitAccessUrl", () => {
  it("separates the credential from the base URL", () => {
    expect(splitAccessUrl(ACCESS_URL)).toEqual({
      baseUrl: "https://beta-bridge.simplefin.org/simplefin",
      credentials: btoa("user123:pa55word"),
    });
  });

  it("strips surrounding whitespace and a trailing slash", () => {
    expect(splitAccessUrl(`  ${ACCESS_URL}/ \n`).baseUrl).toBe(
      "https://beta-bridge.simplefin.org/simplefin",
    );
  });

  it("percent-decodes credentials before encoding them for Basic auth", () => {
    const { credentials } = splitAccessUrl("https://us%40er:p%3Ass%2F@bridge.simplefin.org/simplefin");
    expect(atob(credentials)).toBe("us@er:p:ss/");
  });

  it("never leaves the credential in the base URL", () => {
    const { baseUrl } = splitAccessUrl(ACCESS_URL);
    expect(baseUrl).not.toContain("user123");
    expect(baseUrl).not.toContain("pa55word");
  });

  it("rejects hosts outside the manifest allowlist with an explanatory error", () => {
    expect(() => splitAccessUrl("https://u:p@my-bridge.example.com/simplefin")).toThrow(
      DisallowedHostError,
    );
    expect(() => splitAccessUrl("https://u:p@my-bridge.example.com/simplefin")).toThrow(
      /my-bridge\.example\.com.*self-hosted/s,
    );
    // lookalike suffix must not pass a naive endsWith check
    expect(() => splitAccessUrl("https://u:p@evilbridge.simplefin.org.example/x")).toThrow(
      DisallowedHostError,
    );
  });

  // BUG (minor): a URL with no `user:pass@` passes isAccessUrl and splits into
  // credentials of btoa(":"). The addon saves it, toasts "access URL saved",
  // and every subsequent request fails with an opaque HTTP 403.
  it.fails("rejects an access URL that carries no credentials", () => {
    expect(() => splitAccessUrl("https://bridge.simplefin.org/simplefin")).toThrow();
  });

  it("throws on input that isn't a URL", () => {
    expect(() => splitAccessUrl("not a url")).toThrow();
  });
});

describe("claimToken", () => {
  it("POSTs to the decoded claim URL and returns the access URL", async () => {
    const request = broker(respond(200, `${ACCESS_URL}\n`));
    await expect(claimToken(`  ${btoa(CLAIM_URL)}  `, request)).resolves.toBe(ACCESS_URL);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ url: CLAIM_URL, method: "POST" });
  });

  it("rejects input that isn't base64 without making a request", async () => {
    const request = broker(respond(200, ACCESS_URL));
    await expect(claimToken("not*base64!", request)).rejects.toThrow(/not base64/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects base64 that doesn't decode to a URL without making a request", async () => {
    const request = broker(respond(200, ACCESS_URL));
    await expect(claimToken(btoa("hello world"), request)).rejects.toThrow(/not a claim URL/);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses to spend a token whose claim URL is on a disallowed host", async () => {
    const request = broker(respond(200, ACCESS_URL));
    await expect(
      claimToken(btoa("https://evil.example.com/claim/abc"), request),
    ).rejects.toBeInstanceOf(DisallowedHostError);
    expect(request).not.toHaveBeenCalled();
  });

  it("explains an already-used token and includes the Bridge's body", async () => {
    const request = broker(respond(403, "  Token already claimed  "));
    await expect(claimToken(btoa(CLAIM_URL), request)).rejects.toThrow(
      "SimpleFIN claim failed (HTTP 403). The token may already have been used. Token already claimed",
    );
  });

  it("rejects a 2xx whose body isn't an access URL", async () => {
    const request = broker(respond(200, "<html>oops</html>"));
    await expect(claimToken(btoa(CLAIM_URL), request)).rejects.toThrow(/did not return an access URL/);
  });

  it("propagates broker failures", async () => {
    const request = broker(new Error("host not approved"));
    await expect(claimToken(btoa(CLAIM_URL), request)).rejects.toThrow("host not approved");
  });
});

describe("resolveAccessUrl", () => {
  it("returns an access URL as-is (trimmed) without spending anything", async () => {
    const request = broker(respond(500, ""));
    await expect(resolveAccessUrl(` ${ACCESS_URL} `, request)).resolves.toBe(ACCESS_URL);
    expect(request).not.toHaveBeenCalled();
  });

  it("claims a setup token", async () => {
    const request = broker(respond(200, ACCESS_URL));
    await expect(resolveAccessUrl(btoa(CLAIM_URL), request)).resolves.toBe(ACCESS_URL);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("fetchAccounts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const BASE = "https://beta-bridge.simplefin.org/simplefin";

  it("names the secret for the broker instead of sending credentials, and pins start-date to now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T12:00:00.999Z"));
    const body = { errors: [], accounts: [{ id: "a", name: "A", balance: "1" }] };
    const request = broker(respond(200, JSON.stringify(body)));

    await expect(fetchAccounts(BASE, "bridge_credentials", request)).resolves.toEqual(body);

    const sent = request.mock.calls[0][0];
    expect(sent).toEqual({
      url: `${BASE}/accounts?start-date=${Date.UTC(2026, 10, 6, 12) / 1000}`,
      method: "GET",
      auth: { type: "basic", secretKey: "bridge_credentials" },
    });
    // the broker rejects addon-supplied Authorization headers
    expect(sent.headers).toBeUndefined();
  });

  it("refuses a base URL on a disallowed host before making a request", async () => {
    const request = broker(respond(200, "{}"));
    await expect(fetchAccounts("https://example.com/simplefin", "k", request)).rejects.toBeInstanceOf(
      DisallowedHostError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces HTTP errors with status and body", async () => {
    const request = broker(respond(402, "Payment required"));
    await expect(fetchAccounts(BASE, "k", request)).rejects.toThrow(
      "SimpleFIN request failed (HTTP 402). Payment required",
    );
  });

  it("omits an empty body from the error", async () => {
    const request = broker(respond(500, "   "));
    await expect(fetchAccounts(BASE, "k", request)).rejects.toThrow(
      /^SimpleFIN request failed \(HTTP 500\)\.$/,
    );
  });

  it("reports non-JSON bodies clearly", async () => {
    const request = broker(respond(200, "<html>maintenance</html>"));
    await expect(fetchAccounts(BASE, "k", request)).rejects.toThrow(/wasn't valid JSON/);
  });
});

describe("explainRequestError", () => {
  it("turns the broker's 'not approved' refusal into remediation steps", () => {
    const msg = explainRequestError(new Error("Network host bridge.simplefin.org is NOT APPROVED"));
    expect(msg).toMatch(/Settings → Addons/);
    expect(msg).toMatch(/Network hosts/);
  });

  it("passes other errors through", () => {
    expect(explainRequestError(new Error("boom"))).toBe("boom");
    expect(explainRequestError("plain string")).toBe("plain string");
    expect(explainRequestError(null)).toBe("null");
  });
});
