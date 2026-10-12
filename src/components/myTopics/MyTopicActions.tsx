import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { useDeleteTopic, useExportTopic } from "../../myTopics/queries";
import { editTopicPath, type Topic } from "../../topics";

/** Edit, export and delete for a topic in My Topics. */
export function MyTopicActions({ topic }: { topic: Topic }) {
  const exportTopic = useExportTopic();
  const deleteTopic = useDeleteTopic();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const onExport = () => exportTopic(topic.slug).catch(() => setError("The topic couldn't be exported."));

  const onDelete = async () => {
    if (!window.confirm(`Delete "${topic.title}" and all its diagrams? Export it first if you might want it back.`)) return;
    try {
      await deleteTopic.mutateAsync(topic.slug);
      navigate("/", { replace: true });
    } catch {
      setError("The topic couldn't be deleted.");
    }
  };

  return (
    <>
      <Link className="button" to={editTopicPath(topic)}>
        Edit
      </Link>
      <button className="button" onClick={onExport} title="Download as a file you can share or import later">
        Export
      </button>
      <button className="button danger" onClick={onDelete} disabled={deleteTopic.isPending}>
        Delete
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
