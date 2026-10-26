import { Link } from "react-router";

import { topicPath, useTopics, type Topic } from "../topics";

/** "Previous / Next" links at the end of a document, following the order of the topic list. */
export function TopicPager({ topic }: { topic: Topic }) {
  const { previous, next } = useTopics().neighbours(topic);
  if (!previous && !next) return null;
  return (
    <nav className="pager" aria-label="More topics">
      {previous && (
        <Link className="pager-link pager-previous" to={topicPath(previous)}>
          <span>← Previous</span>
          <strong>{previous.title}</strong>
        </Link>
      )}
      {next && (
        <Link className="pager-link pager-next" to={topicPath(next)}>
          <span>Next →</span>
          <strong>{next.title}</strong>
        </Link>
      )}
    </nav>
  );
}
