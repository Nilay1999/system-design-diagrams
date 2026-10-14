import { Navigate, Route, Routes, useLocation } from "react-router";

import { parseLegacyHash, topicPath, useTopics } from "./topics";
import { TopicPage } from "./pages/topic/TopicPage";
import { EditTopicPage, NewTopicPage } from "./pages/myTopic/TopicFormPage";
import { UserPage } from "./pages/user/UserPage";

/** `/` → the first topic. Also upgrades the old `#/<slug>/<view>` links to real routes. */
function Home() {
  const { hash, search } = useLocation();
  const catalog = useTopics();
  const { slug, view } = parseLegacyHash(hash);
  const topic = catalog.find(slug) ?? catalog.first;
  return <Navigate to={{ pathname: topicPath(topic, view), search }} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/topics/:slug/:view?" element={<TopicPage source="curated" />} />
      <Route path="/my/new" element={<NewTopicPage />} />
      <Route path="/my/:slug/edit" element={<EditTopicPage />} />
      <Route path="/my/:slug/:view?" element={<TopicPage source="local" />} />
      <Route path="/u/:handle" element={<UserPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
