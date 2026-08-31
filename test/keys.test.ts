import { describe, expect, test } from "bun:test";
import { dateLabel, mediaKind, parseKey, thumbKey } from "../src/keys";

describe("parseKey", () => {
  test("accepts the documented layout", () => {
    expect(parseKey("2022/08/29/IMG_1234.jpg", 1024)).toEqual({
      key: "2022/08/29/IMG_1234.jpg",
      date: "2022-08-29",
      bytes: 1024,
      kind: "image",
    });
  });

  test("accepts jpeg and mp4, case-insensitively", () => {
    expect(parseKey("2022/08/29/a.JPEG", 1)?.kind).toBe("image");
    expect(parseKey("2022/08/29/a.Mp4", 1)?.kind).toBe("video");
  });

  test("keeps names containing dots, spaces and non-ASCII", () => {
    const r = parseKey("2022/08/29/café (1).v2.jpg", 1);
    expect(r?.key).toBe("2022/08/29/café (1).v2.jpg");
    expect(r?.kind).toBe("image");
  });

  test("rejects thumbnails", () => {
    expect(parseKey(".thumbs/2022/08/29/IMG_1234.jpg", 1)).toBeNull();
  });

  test("rejects unknown extensions", () => {
    expect(parseKey("2022/08/29/notes.txt", 1)).toBeNull();
    expect(parseKey("2022/08/29/raw.heic", 1)).toBeNull();
  });

  test("rejects malformed or out-of-range dates", () => {
    expect(parseKey("22/08/29/a.jpg", 1)).toBeNull();
    expect(parseKey("2022/8/29/a.jpg", 1)).toBeNull();
    expect(parseKey("2022/13/01/a.jpg", 1)).toBeNull();
    expect(parseKey("2022/00/01/a.jpg", 1)).toBeNull();
    expect(parseKey("2022/02/30/a.jpg", 1)).toBeNull();
    expect(parseKey("2022/08/32/a.jpg", 1)).toBeNull();
  });

  test("rejects keys with no file or extra nesting", () => {
    expect(parseKey("2022/08/29/", 1)).toBeNull();
    expect(parseKey("2022/08/29/sub/a.jpg", 1)).toBeNull();
    expect(parseKey("2022/08/a.jpg", 1)).toBeNull();
  });
});

describe("thumbKey", () => {
  test("prefixes without touching the extension", () => {
    expect(thumbKey("2022/08/29/IMG_1234.jpg")).toBe(".thumbs/2022/08/29/IMG_1234.jpg");
    expect(thumbKey("2022/08/29/VID_0001.mp4")).toBe(".thumbs/2022/08/29/VID_0001.mp4");
  });
});

describe("mediaKind", () => {
  test("only mp4 is video", () => {
    expect(mediaKind("a/b/c/x.mp4")).toBe("video");
    expect(mediaKind("a/b/c/x.MP4")).toBe("video");
    expect(mediaKind("a/b/c/x.jpg")).toBe("image");
    expect(mediaKind("a/b/c/x.jpeg")).toBe("image");
  });
});

describe("dateLabel", () => {
  test("formats as day, date month year", () => {
    expect(dateLabel("2022-08-29")).toBe("Mon, 29 Aug 2022");
    expect(dateLabel("2026-01-01")).toBe("Thu, 1 Jan 2026");
  });

  test("does not shift across timezones", () => {
    expect(dateLabel("2022-01-01")).toContain("1 Jan 2022");
    expect(dateLabel("2022-12-31")).toContain("31 Dec 2022");
  });
});
