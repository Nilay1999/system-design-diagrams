import { isStored, type Topic } from "../../topics";
import { LocalDiagram } from "./LocalDiagram";
import { ShippedDiagram } from "./ShippedDiagram";

interface Props {
  topic: Topic;
  /** Selected tab; falls back to the first one. */
  viewId?: string;
  onViewChange: (id: string) => void;
}

/** The diagram pane: the user's own drawing for My Topics, otherwise the shipped diagram. */
export function DiagramView({ topic, viewId, onViewChange }: Props) {
  const tab = topic.diagrams.find((d) => d.id === viewId) ?? topic.diagrams[0];
  return isStored(tab) ? (
    <LocalDiagram topic={topic} tab={tab} onViewChange={onViewChange} />
  ) : (
    <ShippedDiagram topic={topic} tab={tab} onViewChange={onViewChange} />
  );
}
