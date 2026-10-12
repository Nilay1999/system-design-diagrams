import { useMemo, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";

import { TopicForm } from "../../components/myTopics/TopicForm";
import { AppShell } from "../../layout/AppShell";
import { emptyDraft, toTopic, type LocalTopic, type TopicDraft } from "../../myTopics/model";
import { useCreateTopic, useLocalTopics, useUpdateTopic } from "../../myTopics/queries";
import { topicPath, useTopics } from "../../topics";

function FormLayout({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <AppShell
      heading={
        <div className="topic-heading">
          <h1>{heading}</h1>
          <p>Saved in this browser only. Export a topic to share it or move it to another device.</p>
        </div>
      }
    >
      <div className="page-scroll">{children}</div>
    </AppShell>
  );
}

function useCategories() {
  const catalog = useTopics();
  return useMemo(() => [...new Set(catalog.topics.map((t) => t.category))], [catalog]);
}

/** `/my/new` */
export function NewTopicPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const create = useCreateTopic();
  const categories = useCategories();
  const initial = useMemo(emptyDraft, []);

  return (
    <FormLayout heading="New topic">
      <TopicForm
        initial={initial}
        submitLabel="Create topic"
        categories={categories}
        onSubmit={async (draft) => navigate(topicPath(toTopic(await create.mutateAsync(draft))))}
        // Go back if the user came from inside the app; a direct visit has nowhere to go back to.
        onCancel={() => (location.key === "default" ? navigate("/") : navigate(-1))}
      />
    </FormLayout>
  );
}

/** `/my/:id/edit` */
export function EditTopicPage() {
  const { slug: id } = useParams();
  const topics = useLocalTopics();
  const topic = topics.data?.find((t) => t.id === id);

  if (topics.isPending) return <FormLayout heading="Edit topic">{null}</FormLayout>;
  if (!topic) return <Navigate to="/" replace />;
  return <EditTopicForm key={topic.id} topic={topic} />;
}

function EditTopicForm({ topic }: { topic: LocalTopic }) {
  const navigate = useNavigate();
  const update = useUpdateTopic();
  const categories = useCategories();
  const path = topicPath(toTopic(topic));
  const initial = useMemo<TopicDraft>(
    () => ({
      title: topic.title,
      summary: topic.summary,
      category: topic.category,
      tags: topic.tags,
      difficulty: topic.difficulty,
      statement: topic.statement,
    }),
    [topic],
  );

  return (
    <FormLayout heading={`Edit "${topic.title}"`}>
      <TopicForm
        initial={initial}
        submitLabel="Save changes"
        categories={categories}
        onSubmit={async (draft) => {
          await update.mutateAsync({ id: topic.id, draft });
          navigate(path);
        }}
        onCancel={() => navigate(path)}
      />
    </FormLayout>
  );
}
