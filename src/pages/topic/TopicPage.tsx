import { Suspense, lazy, useCallback, useEffect } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";

import { isNonDefaultView, topicPath, useTopics, type Topic } from "../../topics";
import { AppShell } from "../../layout/AppShell";
import { DocView } from "../../components/DocView";
import { Tabs } from "../../components/Tabs";
import { VIEW_MODE_TABS, useViewMode } from "./useViewMode";

// Excalidraw is by far the heaviest dependency; only load it when a diagram is shown.
const DiagramView = lazy(() => import("../../components/diagram/DiagramView").then((m) => ({ default: m.DiagramView })));

/** `/topics/:slug/:view?`. Unknown topics go to the first one; unknown or default tabs to the bare topic URL. */
export function TopicPage() {
  const { slug, view } = useParams();
  const { search } = useLocation();
  const catalog = useTopics();
  const topic = catalog.find(slug);

  if (!topic) return <Navigate to={{ pathname: topicPath(catalog.first), search }} replace />;
  if (view !== undefined && !isNonDefaultView(topic, view))
    return <Navigate to={{ pathname: topicPath(topic), search }} replace />;
  return <TopicLayout topic={topic} diagramId={view} />;
}

function TopicLayout({ topic, diagramId }: { topic: Topic; diagramId?: string }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { mode, setMode, revealDiagram } = useViewMode();

  useEffect(() => {
    document.title = `${topic.title} · System Design Diagrams`;
    document.querySelector(".doc-pane")?.scrollTo({ top: 0 });
  }, [topic]);

  const selectDiagram = useCallback(
    // Keep the tab in the URL so it can be shared, without adding a history entry per click.
    (id: string) => navigate({ pathname: topicPath(topic, id), search }, { replace: true }),
    [navigate, topic, search],
  );

  /** Called from the document: show a diagram tab, opening the diagram pane if it is hidden. */
  const openDiagram = useCallback(
    (id?: string) => {
      if (id) selectDiagram(id);
      revealDiagram();
    },
    [selectDiagram, revealDiagram],
  );

  return (
    <AppShell
      current={topic}
      mainClassName={`view-${mode}`}
      heading={
        <div className="topic-heading">
          <h1>{topic.title}</h1>
          <p>{topic.summary}</p>
        </div>
      }
      actions={<Tabs className="segmented" label="View" items={VIEW_MODE_TABS} value={mode} onChange={setMode} />}
    >
      {mode !== "diagram" && (
        <div className="doc-pane">
          <DocView
            topic={topic}
            activeDiagram={mode === "doc" ? undefined : (diagramId ?? topic.diagrams[0].id)}
            onOpenDiagram={openDiagram}
          />
        </div>
      )}
      {mode !== "doc" && (
        <div className="diagram-pane">
          <Suspense fallback={<div className="diagram-loading">Loading diagram…</div>}>
            <DiagramView topic={topic} viewId={diagramId} onViewChange={selectDiagram} />
          </Suspense>
        </div>
      )}
    </AppShell>
  );
}
