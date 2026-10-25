// Draws the link-preview images (1200×630 PNG) that LinkedIn, Slack and X show for shared pages.
//
//   npm run og
//
// Writes public/og/site.png, one image per track and one per topic. Run it after adding or renaming a
// topic and commit the results; until then, the build falls back to the track's image. Text uses the
// system's Inter font if installed (DejaVu Sans otherwise).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { runnerImport } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { module: share } = await runnerImport("/src/share/build.ts", { root, configFile: false, logLevel: "warn" });

const W = 1200;
const H = 630;
const PAD = 80;
const FONT = "Inter, 'DejaVu Sans', sans-serif";

const THEMES = {
  site: { from: "#0f172a", to: "#312e81", accent: "#a5b4fc" },
  "system-design": { from: "#16143d", to: "#3b37a0", accent: "#b9b7ff" },
  kubernetes: { from: "#0b1a3d", to: "#1d438f", accent: "#8db4ff" },
};

const dataUri = (file) => `data:image/svg+xml;base64,${readFileSync(join(root, "public", file)).toString("base64")}`;
const LOGO = dataUri("yggdrasil.svg");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough Inter advance widths in ems; generous, so lines never overflow. */
function textWidth(text, size, bold) {
  let em = 0;
  for (const ch of text) {
    if (ch === " ") em += 0.28;
    else if ("iljI.,:;'|!()[]{}·".includes(ch)) em += 0.3;
    else if ("mwMW".includes(ch)) em += 0.88;
    else if (/[A-Z]/.test(ch)) em += 0.7;
    else if (/[0-9]/.test(ch)) em += 0.62;
    else if (/[a-z]/.test(ch)) em += 0.56;
    else em += 0.62;
  }
  return em * size * (bold ? 1.06 : 1);
}

/** Greedy word wrap; the last allowed line gets an ellipsis if the text doesn't fit. */
function wrap(text, width, size, bold, maxLines) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || textWidth(next, size, bold) <= width) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (textWidth(`${last}…`, size, bold) > width) last = last.replace(/\s*\S+$/, "");
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

function card({ theme, eyebrow, title, summary, chips }) {
  const t = THEMES[theme];
  const width = W - 2 * PAD;
  let size = 68;
  let titleLines = wrap(title, width, size, true, 3);
  while (titleLines.length === 3 && size > 52 && wrap(title, width, size, true, 9).length > 2) {
    size -= 6;
    titleLines = wrap(title, width, size, true, 3);
  }
  const titleLead = Math.round(size * 1.15);
  const titleTop = 250;
  const summaryTop = titleTop + (titleLines.length - 1) * titleLead + 62;
  const summaryLines = wrap(summary, width, 28, false, titleLines.length > 2 ? 2 : 3);

  let chipX = PAD;
  const chipEls = chips.map((label) => {
    const w = Math.ceil(textWidth(label, 20, true)) + 36;
    const el = `<g><rect x="${chipX}" y="530" width="${w}" height="44" rx="22" fill="${t.accent}" fill-opacity="0.12" stroke="${t.accent}" stroke-opacity="0.55"/><text x="${chipX + w / 2}" y="559" text-anchor="middle" font-size="20" font-weight="700" fill="${t.accent}">${esc(label)}</text></g>`;
    chipX += w + 14;
    return el;
  });


  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${t.from}"/>
  <circle cx="1060" cy="350" r="430" fill="${t.to}" fill-opacity="0.55"/>
  <image href="${LOGO}" x="830" y="150" width="400" height="400" opacity="0.08"/>
  <rect x="0" y="0" width="${W}" height="8" fill="${t.accent}"/>
  <image href="${LOGO}" x="${PAD}" y="66" width="60" height="60"/>
  <text x="${PAD + 76}" y="108" font-size="34" font-weight="800" fill="#ffffff">${esc(share.SITE.name)}</text>
  <text x="${W - PAD}" y="106" text-anchor="end" font-size="18" font-weight="700" letter-spacing="3" fill="${t.accent}">${esc(eyebrow.toUpperCase())}</text>
  ${titleLines.map((l, i) => `<text x="${PAD}" y="${titleTop + i * titleLead}" font-size="${size}" font-weight="800" fill="#ffffff">${esc(l)}</text>`).join("\n  ")}
  ${summaryLines.map((l, i) => `<text x="${PAD}" y="${summaryTop + i * 40}" font-size="28" fill="#ffffff" fill-opacity="0.78">${esc(l)}</text>`).join("\n  ")}
  ${chipEls.join("\n  ")}
</svg>`;
}

function write(file, svg) {
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Inter" }, fitTo: { mode: "width", value: W } }).render().asPng();
  const out = join(root, "public", file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
}

const { SITE, TRACKS } = share;
const count = (id) => TRACKS.find((t) => t.id === id).catalog.topics.length;

write(
  share.siteImage,
  card({
    theme: "site",
    eyebrow: TRACKS.map((t) => t.name).join(" · "),
    title: SITE.tagline,
    summary: SITE.description,
    chips: [`${count("system-design")} system design topics`, `${count("kubernetes")} Kubernetes topics`, "Editable diagrams"],
  }),
);

const TRACK_CARDS = {
  "system-design": { title: "System design, drawn and explained", summary: "Requirements, capacity math, architecture, request flows and failure modes for classic interview designs, each beside editable diagrams." },
  kubernetes: { title: "Kubernetes, explained with diagrams", summary: "From desired state to EKS: every concept in plain language, with the YAML you'd write and diagrams you can edit." },
};

let written = 1;
for (const track of TRACKS) {
  const cardText = TRACK_CARDS[track.id];
  write(
    share.trackImage(track.id),
    card({
      theme: track.id,
      eyebrow: track.name,
      title: cardText.title,
      summary: cardText.summary,
      chips: [`${track.catalog.topics.length} topics`, `${track.catalog.topics.reduce((n, t) => n + t.diagrams.length, 0)} diagrams`, "Free to read"],
    }),
  );
  written++;
  for (const topic of track.catalog.topics) {
    write(
      share.topicImage(topic),
      card({
        theme: track.id,
        eyebrow: `${track.name} · ${topic.category}`,
        title: topic.title,
        summary: topic.summary,
        chips: [`${topic.diagrams.length} interactive diagrams`, ...topic.tags.slice(0, 2)],
      }),
    );
    written++;
  }
}
console.log(`Wrote ${written} preview images to public/og/`);
