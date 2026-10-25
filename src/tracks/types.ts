import type { LegendEntry } from "../diagrams/dsl";
import type { TopicCatalog } from "../topics/catalog";
import type { TopicSource, TrackId } from "../topics/types";

/** A sidebar section listing one source's topics. */
export interface SourceSection {
  source: TopicSource;
  label: string;
  emptyText?: string;
}

/** A short idea shown on a track's overview page. */
export interface OverviewPoint {
  title: string;
  text: string;
}

/**
 * A self-contained library of topics. Tracks share the app's components but get their own URLs,
 * sidebar, diagram legend, overview page and theme (`<html data-track>`), so they never mix.
 */
export interface Track {
  id: TrackId;
  /** Section name, e.g. "Kubernetes": in the switcher, the top bar and page titles. */
  name: string;
  /** Small square icon for the section (the site's own logo is SITE.logo). */
  logo: string;
  /** Where the switcher sends you: the overview page, or the first topic. */
  home: string;
  catalog: TopicCatalog;
  /** Sidebar sections, in display order. */
  sources: readonly SourceSection[];
  legend: readonly LegendEntry[];
  searchPlaceholder: string;
  /** Content for the overview page, for tracks that have one. */
  overview?: {
    title: string;
    lead: string;
    points: readonly OverviewPoint[];
  };
}
