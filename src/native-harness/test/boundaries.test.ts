import { expect, test } from "bun:test";

test("kernel imports only contracts, and contracts have no runtime dependencies", async () => {
  const root = new URL("../src/", import.meta.url).pathname;
  for (const folder of ["kernel", "contracts"]) {
    for await (const relative of new Bun.Glob("**/*.ts").scan(`${root}${folder}`)) {
      const source = await Bun.file(`${root}${folder}/${relative}`).text();
      const imports = [...source.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)];
      for (const match of imports) {
        if (folder === "kernel") expect(match[2]?.startsWith("../contracts/")).toBe(true);
        else {
          expect(match[1]).toBe("type ");
          expect(match[2]?.startsWith("./")).toBe(true);
        }
      }
    }
  }
});
