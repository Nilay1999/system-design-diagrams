import { useEffect } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";

import { AppShell } from "../../layout/AppShell";
import { pageTitle } from "../../site";
import { SIM_LABEL, buildPath, topicPath, useTopics, type Topic } from "../../topics";
import { useTrack } from "../../tracks/context";
import type { Simulation } from "../../simulations/types";
import { SimDiagram } from "./SimDiagram";
import { useSimulation } from "./useSimulation";

/** `/topics/:slug/simulate`. Topics without a simulator go to their normal page. */
export function SimulatePage() {
  const { slug } = useParams();
  const { search } = useLocation();
  const catalog = useTopics();
  const topic = catalog.find(slug);

  if (!topic) return <Navigate to={{ pathname: topicPath(catalog.first), search }} replace />;
  if (!topic.simulation) return <Navigate to={{ pathname: topicPath(topic), search }} replace />;
  return <SimulateLayout key={`${topic.track}:${topic.slug}`} topic={topic} sim={topic.simulation} />;
}

function SimulateLayout({ topic, sim }: { topic: Topic; sim: Simulation }) {
  const track = useTrack();
  const { inputs, snapshot, paused, setPaused, scenario, setValue, toggle, run } = useSimulation(sim);
  const stoppable = sim.nodes.filter((n) => n.stoppable);

  useEffect(() => {
    document.title = pageTitle(`${SIM_LABEL}: ${topic.title}`, track.name);
  }, [topic, track]);

  return (
    <AppShell
      current={topic}
      mainClassName="view-sim"
      heading={
        <div className="topic-heading">
          <h1>{topic.title}</h1>
          <p>{SIM_LABEL}</p>
        </div>
      }
      actions={
        <>
          {topic.evolution && (
            <Link className="topbar-link" to={buildPath(topic)}>
              Build it
            </Link>
          )}
          <Link className="topbar-link" to={topicPath(topic)}>
            Full write-up
          </Link>
        </>
      }
    >
      <div className="sim-pane">
        <div className="sim-panel">
          <p className="build-intro">{sim.intro}</p>

          <section>
            <h2>Experiments</h2>
            <ul className="sim-scenarios">
              {sim.scenarios.map((s) => (
                <li key={s.id}>
                  <button className={s.id === scenario?.id ? "on" : ""} aria-pressed={s.id === scenario?.id} onClick={() => run(s)}>
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
            {scenario && (
              <p className="sim-notice">
                <strong>What to look for.</strong> {scenario.notice}
              </p>
            )}
          </section>

          <section>
            <h2>Size the system</h2>
            {sim.controls.map((c) => (
              <label key={c.id} className="sim-control">
                <span className="sim-control-head">
                  <span>{c.label}</span>
                  <output>{c.format(inputs.values[c.id])}</output>
                </span>
                <input
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={inputs.values[c.id]}
                  onChange={(e) => setValue(c.id, Number(e.target.value))}
                />
                <span className="sim-help">{c.help}</span>
              </label>
            ))}
          </section>

          <section>
            <h2>Break something</h2>
            <p className="sim-help">Stop a part here, or click its box in the diagram. Click again to restart it.</p>
            <div className="sim-switches">
              {stoppable.map((n) => {
                const down = inputs.down.includes(n.id);
                return (
                  <button key={n.id} className={down ? "down" : ""} aria-pressed={down} onClick={() => toggle(n.id)}>
                    {down ? "Restart" : "Stop"} {n.label}
                  </button>
                );
              })}
            </div>
          </section>

          <p className="sim-caveat">{sim.caveat}</p>
        </div>
      </div>

      <div className="sim-stage">
        <dl className="sim-readings">
          {snapshot.readings.map((r) => (
            <div key={r.id} className={`sim-reading-${r.health}`}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
        <div className="sim-canvas">
          <SimDiagram sim={sim} inputs={inputs} snapshot={snapshot} onToggle={toggle} />
          <button className="sim-pause" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
        <section className="sim-remarks" aria-label="What is happening">
          <h2>What is happening</h2>
          <ul>
            {snapshot.remarks.map((r, i) => (
              <li key={i} className={`sim-remark-${r.level}`}>
                {r.text}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
