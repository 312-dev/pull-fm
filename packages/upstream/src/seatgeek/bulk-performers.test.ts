import { describe, expect, it } from "vitest";

import {
  indexBulkPerformers,
  parseBulkPerformerLine,
} from "./bulk-performers.js";

const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe("parseBulkPerformerLine", () => {
  it("parses a dump row and produces the crosswalk key", () => {
    const performer = parseBulkPerformerLine(
      line({
        id: 8741,
        name: "Sigur Rós",
        slug: "sigur-ros",
        taxonomy_id: 2_000_000,
        updated_at_utc: "2026-07-20T00:00:00Z",
      }),
    );
    // The same normaliser the MBID crosswalk uses, so the two can be joined.
    expect(performer?.normalizedKey).toBe("sigur ros");
    expect(performer?.id).toBe(8741);
    expect(performer?.taxonomyId).toBe(2_000_000);
  });

  it("skips a bad line instead of aborting an import of millions", () => {
    expect(parseBulkPerformerLine("")).toBeNull();
    expect(parseBulkPerformerLine("{ truncated")).toBeNull();
    expect(parseBulkPerformerLine(line({ name: "no id" }))).toBeNull();
    expect(parseBulkPerformerLine(line({ id: 1, name: "!!!" }))).toBeNull();
  });
});

describe("indexBulkPerformers", () => {
  it("indexes by normalised name", () => {
    const index = indexBulkPerformers([
      line({ id: 1, name: "Radiohead", slug: "radiohead" }),
      line({ id: 2, name: "Björk", slug: "bjork" }),
    ]);
    expect(index.get("radiohead")?.id).toBe(1);
    expect(index.get("bjork")?.id).toBe(2);
  });

  it("prefers the lower id on a name collision", () => {
    // SeatGeek ids are broadly ascending by creation, so the lower one is the
    // long-established performer rather than a newer duplicate.
    const index = indexBulkPerformers([
      line({ id: 900_000, name: "The Cure" }),
      line({ id: 42, name: "the cure" }),
    ]);
    expect(index.get("the cure")?.id).toBe(42);
  });

  it("is a separate parser from the API one, as the shapes differ", () => {
    // Bulk rows carry taxonomy_id / updated_at_utc; API rows carry url/images.
    const performer = parseBulkPerformerLine(
      line({ id: 7, name: "Wilco", taxonomy_id: 2_000_000 }),
    );
    expect(performer).not.toBeNull();
    expect(Object.keys(performer ?? {})).toContain("taxonomyId");
    expect(Object.keys(performer ?? {})).not.toContain("url");
  });
});
