import fs from "node:fs";
import path from "node:path";
import { DOCS, SearchEntry, slugify } from "./docs";

/** Search index built at build time from the MDX sources: page titles, headings and the prose under them. */
export function searchIndex(): SearchEntry[] {
  const dir = path.join(process.cwd(), "src/content/docs");
  return DOCS.flatMap(({ slug, title }) => {
    const source = fs.readFileSync(path.join(dir, `${slug}.mdx`), "utf8").replace(/^import .*$/gm, "");
    const entries: SearchEntry[] = [{ slug, page: title, text: "" }];
    for (const line of source.split("\n")) {
      const h = line.match(/^#{2,3} (.+)/);
      if (h) entries.push({ slug, page: title, heading: h[1], anchor: slugify(h[1]), text: "" });
      else if (!line.startsWith("#")) entries[entries.length - 1].text += ` ${line.replace(/[`*_<>|]/g, "")}`;
    }
    return entries;
  });
}
