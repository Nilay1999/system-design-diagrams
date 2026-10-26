import { pageTitle, SITE } from "../site";
import { topicPath, type Topic, type TrackId } from "../topics";
import type { Track } from "../tracks/types";

export { SITE };

/**
 * What a link to each page looks like when it's shared (LinkedIn, Slack, X…). Link previews never
 * run JavaScript, so the build writes one static HTML file per page with these tags in its <head>
 * (see the share-pages plugin in vite.config.ts), and `npm run og` draws the preview images.
 */

/** Production URL, used for absolute links in previews. Override with SITE_URL at build time. */
export const DEFAULT_SITE_URL = "https://yggdrasil-books.vercel.app";

export interface SharePage {
  /** URL path, e.g. `/kubernetes/pods`. */
  path: string;
  title: string;
  description: string;
  /** Preview image path under `public/`, e.g. `/og/kubernetes/pods.png`. */
  image: string;
  /** Image to use when `image` hasn't been generated yet. */
  fallbackImage: string;
}

export const siteImage = "/og/site.png";
export const trackImage = (track: TrackId) => `/og/${track}.png`;
export const topicImage = (topic: Topic) => `/og/${topic.track}/${topic.slug}.png`;

const diagramsLine = (topic: Topic) => `${topic.diagrams.length} interactive diagrams.`;

/** Every page worth sharing: the home page, each track's overview, each topic and each diagram tab. */
export function sharePages(tracks: readonly Track[]): SharePage[] {
  const pages: SharePage[] = [
    { path: "/", title: `${SITE.name} — ${SITE.tagline}`, description: SITE.description, image: siteImage, fallbackImage: siteImage },
  ];
  for (const track of tracks) {
    // A track whose overview is the home page is already covered by the "/" entry above.
    if (track.overview && track.home !== "/") {
      pages.push({
        path: track.home,
        title: pageTitle(track.overview.title),
        description: track.overview.lead,
        image: trackImage(track.id),
        fallbackImage: siteImage,
      });
    }
    for (const topic of track.catalog.topics) {
      const base = {
        description: `${topic.summary} ${diagramsLine(topic)}`,
        image: topicImage(topic),
        fallbackImage: trackImage(track.id),
      };
      pages.push({ ...base, path: topicPath(topic), title: pageTitle(topic.title, track.name) });
      for (const tab of topic.diagrams.slice(1)) {
        pages.push({ ...base, path: topicPath(topic, tab.id), title: pageTitle(`${tab.name} — ${topic.title}`, track.name) });
      }
    }
  }
  return pages;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The <head> tags for one page. `siteUrl` has no trailing slash. */
export function headTags(page: SharePage, siteUrl: string, image = page.image): string {
  const url = `${siteUrl}${page.path === "/" ? "/" : page.path}`;
  const imageUrl = `${siteUrl}${image}`;
  return [
    `<title>${escape(page.title)}</title>`,
    `<meta name="description" content="${escape(page.description)}" />`,
    `<link rel="canonical" href="${escape(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE.name}" />`,
    `<meta property="og:title" content="${escape(page.title)}" />`,
    `<meta property="og:description" content="${escape(page.description)}" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    `<meta property="og:image" content="${escape(imageUrl)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(page.title)}" />`,
    `<meta name="twitter:description" content="${escape(page.description)}" />`,
    `<meta name="twitter:image" content="${escape(imageUrl)}" />`,
  ].join("\n    ");
}
