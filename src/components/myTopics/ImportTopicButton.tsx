import { useRef, useState } from "react";
import { useNavigate } from "react-router";

import { FILE_EXTENSION, MAX_FILE_BYTES, TopicFileError } from "../../myTopics/fileFormat";
import { toTopic } from "../../myTopics/model";
import { useImportTopic } from "../../myTopics/queries";
import { topicPath } from "../../topics";

/** Pick an exported topic file, add it to My Topics and open it. */
export function ImportTopicButton({ className, onImported }: { className?: string; onImported?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const importTopic = useImportTopic();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      if (file.size > MAX_FILE_BYTES) throw new TopicFileError("That file is too large to import.");
      const topic = await importTopic.mutateAsync(await file.text());
      onImported?.();
      navigate(topicPath(toTopic(topic)));
    } catch (e) {
      setError(e instanceof TopicFileError ? e.message : "The topic couldn't be saved in this browser.");
    } finally {
      // Let the same file be picked again after fixing it.
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <button className={className} onClick={() => input.current?.click()} disabled={importTopic.isPending}>
        Import
      </button>
      <input
        ref={input}
        type="file"
        accept={`${FILE_EXTENSION},application/json`}
        hidden
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
