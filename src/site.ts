/**
 * The site's identity. Yggdrasil is the world tree of Norse myth, whose branches hold the nine worlds;
 * here each branch is a section (System Design, Kubernetes) of one tree of engineering knowledge.
 */
export const SITE = {
  name: "Yggdrasil",
  tagline: "The tree of engineering knowledge",
  description:
    "System design and Kubernetes, drawn and explained: in-depth write-ups beside editable diagrams of architectures, request flows, failure modes and the YAML you'd actually write.",
  logo: "/yggdrasil.svg",
} as const;

/** Browser-tab and link-preview title: most specific part first, the site name last. */
export const pageTitle = (...parts: string[]) => [...parts, SITE.name].join(" · ");
