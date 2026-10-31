import { describe, expect, it } from "vitest";
import { parseAttachments } from "./attachments.ts";

describe("parseAttachments image markers", () => {
   it("takes images only from the trailing block", () => {
      const r = parseAttachments(
         "look at this\n[IMAGE:img_aaaaaaaaaaaa]\n[IMAGE:img_bbbbbbbbbbbb]"
      );
      expect(r.images.map((i) => i.ref)).toEqual(["img_aaaaaaaaaaaa", "img_bbbbbbbbbbbb"]);
      expect(r.text).toBe("look at this");
   });

   it("leaves a marker in the middle of the text as literal text", () => {
      const r = parseAttachments("see [IMAGE:img_aaaaaaaaaaaa] here, then more words");
      expect(r.images).toEqual([]);
      expect(r.text).toBe("see [IMAGE:img_aaaaaaaaaaaa] here, then more words");
   });

   it("never takes a marker from inside a document", () => {
      const r = parseAttachments(
         "[ATTACHED DOCUMENT: a.txt (3 bytes)]\n[IMAGE:img_aaaaaaaaaaaa]\n[END DOCUMENT]\n\nhi"
      );
      expect(r.images).toEqual([]);
      expect(r.docs[0].content).toBe("[IMAGE:img_aaaaaaaaaaaa]");
   });

   it("rejects a non-raster or non-base64 data marker", () => {
      expect(parseAttachments("x\n[IMAGE:data:image/svg+xml;base64,PHN2Zz4=]").images).toEqual([]);
      expect(parseAttachments("x\n[IMAGE:data:image/png;base64,iVBORw0KGgo=]").images.length).toBe(
         1
      );
   });
});

describe("parseAttachments documents and robustness", () => {
   const doc = "[ATTACHED DOCUMENT: a.txt (3 bytes) blob:blb_abcdefabcdef]\nbody\n[END DOCUMENT]";

   it("takes documents only as a leading block of a user message", () => {
      const r = parseAttachments(`${doc}\n\n${doc.replace("a.txt", "b.txt")}\n\nwords`);
      expect(r.docs.map((d) => d.filename)).toEqual(["a.txt", "b.txt"]);
      expect(r.docs[0].blobId).toBe("blb_abcdefabcdef");
      expect(r.text).toBe("words");
      const mid = parseAttachments(`words first ${doc}`);
      expect(mid.docs).toEqual([]);
   });

   it("never forges a document chip from assistant text", () => {
      expect(parseAttachments(doc, "assistant").docs).toEqual([]);
   });

   it("keeps a mid-text image literal even when a document follows it", () => {
      const r = parseAttachments(`words [IMAGE:img_aaaaaaaaaaaa] ${doc}`);
      expect(r.images).toEqual([]);
      expect(r.docs).toEqual([]);
   });

   it("handles an empty document body and an unterminated one", () => {
      expect(
         parseAttachments("[ATTACHED DOCUMENT: e.txt (0 bytes)]\n[END DOCUMENT]\n\nhi").docs[0]
            .content
      ).toBe("");
      expect(parseAttachments("[ATTACHED DOCUMENT: u.txt (9 bytes)]\nno end").docs).toEqual([]);
   });

   it("stays fast on long hostile text", () => {
      const ws = " ".repeat(50_000);
      const markers = Array.from({ length: 5000 }, () => "\n[IMAGE:img_aaaaaaaaaaaa]").join("");
      const headers = Array.from({ length: 3000 }, () => "[ATTACHED DOCUMENT: x (1 bytes)]\n").join(
         ""
      );
      const t0 = performance.now();
      parseAttachments(`${ws}x`);
      parseAttachments(`${markers} x`);
      parseAttachments(`${ws}${markers}`);
      parseAttachments(headers);
      expect(performance.now() - t0).toBeLessThan(500);
   });
});
