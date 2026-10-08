import { Navigate, Route, Routes, useLocation } from "react-router";

import { parseLegacyHash, topicPath, useTopics } from "./topics";
import { TopicPage } from "./pages/topic/TopicPage";

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
      <Route path="/topics/:slug/:view?" element={<TopicPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
