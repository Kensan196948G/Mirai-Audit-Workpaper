// web/dist の index.html を src/embedded-assets.ts に埋め込む（単一HTML）
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "..", "web", "dist");
const outFile = join(here, "..", "src", "embedded-assets.ts");

const html = readFileSync(join(webDist, "index.html"), "utf-8");
const ts = `// 埋め込みフロントエンドアセット（scripts/build-embedded.mjs による自動生成。手編集禁止）
export const EMBEDDED_INDEX_HTML: string = ${JSON.stringify(html)};
`;
writeFileSync(outFile, ts, "utf-8");
console.log(`embedded-assets.ts generated: ${(ts.length / 1024).toFixed(1)} KB`);
