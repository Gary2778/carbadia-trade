import { describe, expect, it } from "vitest";
import { registryUpstreamUrl, REGISTRY_ALLOWLIST } from "./registry-proxy";

describe("registryUpstreamUrl", () => {
  it("白名单里的路径拼到上游,查询串原样带过去", () => {
    expect(registryUpstreamUrl(["overview"], "", "https://carbadia.io")).toBe("https://carbadia.io/api/real/overview");
    expect(registryUpstreamUrl(["projects"], "?registry=verra&page=2", "https://carbadia.io")).toBe(
      "https://carbadia.io/api/real/projects?registry=verra&page=2",
    );
  });
  it("上游末尾多一个斜杠也不会拼出双斜杠", () => {
    expect(registryUpstreamUrl(["overview"], "", "https://carbadia.io/")).toBe("https://carbadia.io/api/real/overview");
  });
  it("白名单之外、多段路径、空路径都返回 null", () => {
    expect(registryUpstreamUrl(["co2"], "", "https://carbadia.io")).toBeNull();
    expect(registryUpstreamUrl(["projects", "x"], "", "https://carbadia.io")).toBeNull();
    expect(registryUpstreamUrl([], "", "https://carbadia.io")).toBeNull();
  });
  it("白名单只有 overview 与 projects", () => {
    expect([...REGISTRY_ALLOWLIST].sort()).toEqual(["overview", "projects"]);
  });
});
