import {
  LoginRateLimiter,
  hashPassword,
  parseCookies,
  serializeSessionCookie,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./auth";
import { Router } from "./http";
import { isValidId } from "./store";

describe("whiteboard-server auth", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    // salted: same password, different hash
    expect(await hashPassword("correct horse")).not.toBe(hash);
  });

  it("validates usernames and passwords", () => {
    expect(validateUsername("maya.chen")).toBe(null);
    expect(validateUsername("a")).not.toBe(null);
    expect(validateUsername("bad name")).not.toBe(null);
    expect(validateUsername("../x")).not.toBe(null);
    expect(validatePassword("12345")).not.toBe(null);
    expect(validatePassword("123456")).toBe(null);
  });

  it("parses and writes session cookies", () => {
    expect(parseCookies("a=1; wb_session=abc%3D; b=2")).toEqual({
      a: "1",
      wb_session: "abc=",
      b: "2",
    });
    const cookie = serializeSessionCookie("tok", {
      maxAgeSeconds: 60,
      secure: true,
    });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(
      serializeSessionCookie("tok", { maxAgeSeconds: 60, secure: false }),
    ).not.toContain("Secure");
  });

  it("blocks repeated failed logins", () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10; i++) {
      expect(limiter.isBlocked("ip|maya")).toBe(false);
      limiter.fail("ip|maya");
    }
    expect(limiter.isBlocked("ip|maya")).toBe(true);
    expect(limiter.isBlocked("ip|other")).toBe(false);
    limiter.reset("ip|maya");
    expect(limiter.isBlocked("ip|maya")).toBe(false);
  });

  it("only accepts safe ids (they end up in file paths)", () => {
    expect(isValidId("abc_DEF-123")).toBe(true);
    expect(isValidId("../../etc/passwd")).toBe(false);
    expect(isValidId("a/b")).toBe(false);
    expect(isValidId("")).toBe(false);
    expect(isValidId(42)).toBe(false);
  });

  it("routes with params", () => {
    const router = new Router<{}>();
    const handler = () => {};
    router.get("/api/papers/:id/files/:fileId", handler);
    const match = router.match("GET", "/api/papers/p1/files/f%201");
    expect(match).toMatchObject({ params: { id: "p1", fileId: "f 1" } });
    expect(router.match("POST", "/api/papers/p1/files/f1")).toBe(
      "method-not-allowed",
    );
    expect(router.match("GET", "/api/nope")).toBe(null);
  });
});
