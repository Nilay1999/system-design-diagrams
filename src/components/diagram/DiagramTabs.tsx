import type { ReactNode } from "react";

import type { Topic } from "../../topics";
import { Tabs } from "../Tabs";

interface Props {
  topic: Topic;
  value: string;
  onChange: (id: string) => void;
  /** e.g. an "add tab" button. */
  trailing?: ReactNode;
}

/** The topic's diagram tabs. Hidden for a single tab, unless there's something to put beside it. */
export function DiagramTabs({ topic, value, onChange, trailing }: Props) {
  if (topic.diagrams.length < 2 && !trailing) return null;
  const items = topic.diagrams.map((d) => ({ id: d.id, label: d.name }));
  return <Tabs className="diagram-tabs" label="Diagram views" items={items} value={value} onChange={onChange} trailing={trailing} />;
}
