import { describe, expect, it, vi } from "vitest";
import { customAgentWebFetch, customAgentWebSearch } from "./CustomAgentWeb.ts";

describe("CustomAgentWeb", () => {
  it("maps Exa search results into compact safe results", async () => {
    const search = vi.fn(async () => ({
      results: [
        {
          title: "Docs",
          url: "https://docs.example.com/page",
          publishedDate: "2026-01-01",
          author: "Example",
          text: "x".repeat(200),
        },
      ],
    }));

    const result = await customAgentWebSearch({
      query: "official docs",
      environment: { EXA_API_KEY: "test-key" },
      clientFactory: () => ({ search, getContents: vi.fn() }),
      maxTextCharacters: 80,
    });

    expect(search).toHaveBeenCalledWith("official docs", {
      numResults: 5,
      contents: { text: { maxCharacters: 80 } },
    });
    expect(result.results).toEqual([
      {
        title: "Docs",
        url: "https://docs.example.com/page",
        publishedDate: "2026-01-01",
        author: "Example",
        text: `${"x".repeat(80)}...`,
        provider: { name: "exa" },
      },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("rejects missing Exa key without leaking secrets", async () => {
    await expect(
      customAgentWebSearch({
        query: "docs",
        environment: { EXA_API_KEY: "" },
        clientFactory: () => ({ search: vi.fn(), getContents: vi.fn() }),
      }),
    ).rejects.toThrow("EXA_API_KEY is not configured");
  });

  it("rejects unsafe fetch URLs before calling Exa", async () => {
    const getContents = vi.fn();

    await expect(
      customAgentWebFetch({
        urls: ["http://localhost:3000/private"],
        environment: { EXA_API_KEY: "test-key" },
        clientFactory: () => ({ search: vi.fn(), getContents }),
      }),
    ).rejects.toThrow("Refusing to fetch localhost or private network URL");
    expect(getContents).not.toHaveBeenCalled();
  });

  it("keeps partial fetch results when one URL fails", async () => {
    const getContents = vi.fn(async (url: string | ReadonlyArray<string>) => {
      const requestedUrl = Array.isArray(url) ? url[0] : url;
      if (requestedUrl.includes("bad.example.com")) throw new Error("503 upstream");
      return {
        results: [
          {
            title: "Good",
            url: requestedUrl,
            text: "content",
          },
        ],
      };
    });

    const result = await customAgentWebFetch({
      urls: ["https://good.example.com/docs", "https://bad.example.com/docs"],
      environment: { EXA_API_KEY: "test-key" },
      clientFactory: () => ({ search: vi.fn(), getContents }),
    });

    expect(result.pages).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.url).toBe("https://bad.example.com/docs");
  });
});
