import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";

import { AppShell } from "../../layout/AppShell";
import { pageTitle } from "../../site";
import { BUILD_LABEL, topicPath, useTopics, type Topic } from "../../topics";
import { useTrack } from "../../tracks/context";
import type { Evolution, Step, Verdict } from "../../evolutions/types";
import {
  START,
  bestChoice,
  diagramView,
  isAnswered,
  isSummary,
  pick,
  pickedChoice,
  progressStore,
  score,
  type Progress,
} from "../../evolutions/progress";
import { InlineMd, Md } from "./Md";

// Excalidraw is by far the heaviest dependency; load it apart from the page.
const StageCanvas = lazy(() => import("../../components/diagram/StageCanvas").then((m) => ({ default: m.StageCanvas })));

const VERDICT_LABEL: Record<Verdict, string> = {
  best: "Best fit",
  ok: "Works, at a cost",
  poor: "Falls short",
};

/** `/topics/:slug/build`. Topics without a step-by-step build go to their normal page. */
export function BuildPage() {
  const { slug } = useParams();
  const { search } = useLocation();
  const catalog = useTopics();
  const topic = catalog.find(slug);

  if (!topic) return <Navigate to={{ pathname: topicPath(catalog.first), search }} replace />;
  if (!topic.evolution) return <Navigate to={{ pathname: topicPath(topic), search }} replace />;
  return <BuildLayout key={`${topic.track}:${topic.slug}`} topic={topic} evolution={topic.evolution} />;
}

function BuildLayout({ topic, evolution }: { topic: Topic; evolution: Evolution }) {
  const track = useTrack();
  const [progress, setProgress] = useState<Progress>(() => progressStore.load(topic, evolution));
  const pane = useRef<HTMLDivElement>(null);
  const { steps } = evolution;
  const summary = isSummary(evolution, progress);

  useEffect(() => {
    document.title = pageTitle(`${BUILD_LABEL}: ${topic.title}`, track.name);
  }, [topic, track]);

  useEffect(() => progressStore.save(topic, progress), [topic, progress]);

  // A new step starts at the top of the panel.
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 });
  }, [progress.step]);

  const { level, markAdded } = diagramView(evolution, progress);
  const build = useCallback(() => evolution.diagram(level, markAdded), [evolution, level, markAdded]);

  // The reader can go back to any finished step, and forward as far as the first open decision.
  const firstOpen = steps.findIndex((s) => !isAnswered(s, progress));
  const furthest = firstOpen === -1 ? steps.length : firstOpen;
  const goTo = (step: number) => setProgress((p) => ({ ...p, step: Math.max(0, Math.min(step, furthest)) }));
  const restart = () => setProgress(START);

  const caption = summary
    ? "The finished design"
    : markAdded
      ? `After step ${progress.step + 1}: new parts are tagged NEW`
      : `The design so far (after step ${level + 1})`;

  return (
    <AppShell
      current={topic}
      mainClassName="view-build"
      heading={
        <div className="topic-heading">
          <h1>{topic.title}</h1>
          <p>{BUILD_LABEL}</p>
        </div>
      }
      actions={
        <Link className="topbar-link" to={topicPath(topic)}>
          Full write-up
        </Link>
      }
    >
      <div className="build-pane" ref={pane}>
        <div className="build">
          <nav className="build-steps" aria-label="Steps">
            <ol>
              {steps.map((s, i) => (
                <li key={s.id}>
                  <button
                    className={`${i === progress.step ? "current" : ""} ${i < furthest ? "done" : ""}`}
                    aria-current={i === progress.step ? "step" : undefined}
                    disabled={i > furthest}
                    onClick={() => goTo(i)}
                    title={`Step ${i + 1}: ${s.title}`}
                  >
                    {i + 1}
                  </button>
                </li>
              ))}
              <li>
                <button
                  className={`wide ${summary ? "current" : ""}`}
                  aria-current={summary ? "step" : undefined}
                  disabled={furthest < steps.length}
                  onClick={() => goTo(steps.length)}
                  title="Summary"
                >
                  Summary
                </button>
              </li>
            </ol>
            {(progress.step > 0 || Object.keys(progress.picks).length > 0) && (
              <button className="link" onClick={restart}>
                Start over
              </button>
            )}
          </nav>

          {summary ? (
            <Summary topic={topic} evolution={evolution} progress={progress} onBack={() => goTo(steps.length - 1)} onRestart={restart} />
          ) : (
            <StepView
              key={steps[progress.step].id}
              evolution={evolution}
              index={progress.step}
              progress={progress}
              onPick={(choiceId) => setProgress((p) => pick(steps[p.step], p, choiceId))}
              onBack={() => goTo(progress.step - 1)}
              onNext={() => goTo(progress.step + 1)}
            />
          )}
        </div>
      </div>
      <div className="diagram-pane">
        <Suspense fallback={<div className="diagram-loading">Loading diagram…</div>}>
          <StageCanvas build={build} caption={caption} />
        </Suspense>
      </div>
    </AppShell>
  );
}

interface StepViewProps {
  evolution: Evolution;
  index: number;
  progress: Progress;
  onPick: (choiceId: string) => void;
  onBack: () => void;
  onNext: () => void;
}

function StepView({ evolution, index, progress, onPick, onBack, onNext }: StepViewProps) {
  const step = evolution.steps[index];
  const total = evolution.steps.length;
  const answered = isAnswered(step, progress);
  const last = index === total - 1;
  const result = useRef<HTMLElement>(null);
  const wasAnswered = useRef(answered);

  // Right after a choice is made, bring the explanation into view.
  useEffect(() => {
    if (answered && !wasAnswered.current) result.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    wasAnswered.current = answered;
  }, [answered]);

  return (
    <article className="build-step">
      <p className="build-kicker">
        Step {index + 1} of {total} · {index === 0 ? "Where we begin" : "A new problem"}
      </p>
      <h2>{step.title}</h2>
      {index === 0 && <p className="build-intro">{evolution.intro}</p>}
      <Md>{step.situation}</Md>
      {step.metrics && (
        <dl className="build-metrics">
          {step.metrics.map((m) => (
            <div key={m.label}>
              <dt>{m.label}</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {step.decision && <Decision step={step} progress={progress} onPick={onPick} />}

      {answered && (
        <section className="build-result" ref={result}>
          <h3>{index === 0 ? "The starting design" : "What the design does now"}</h3>
          <Md>{step.result}</Md>
          {step.tradeoff && (
            <div className="build-cost">
              <strong>{index === 0 ? "The weak spot" : "What it costs"}</strong>
              <Md>{step.tradeoff}</Md>
            </div>
          )}
        </section>
      )}

      <div className="build-actions">
        {index > 0 && (
          <button className="button" onClick={onBack}>
            ← Back
          </button>
        )}
        {answered && (
          <button className="button primary" onClick={onNext}>
            {last ? "See the summary →" : index === 0 ? "Bring on the first problem →" : "Next problem →"}
          </button>
        )}
      </div>
    </article>
  );
}

function Decision({ step, progress, onPick }: { step: Step; progress: Progress; onPick: (choiceId: string) => void }) {
  const decision = step.decision!;
  const picked = pickedChoice(step, progress);
  const best = bestChoice(step);
  // Explanations on show. After the first pick: the reader's choice and the best one; the rest open on click.
  const [extra, setExtra] = useState<readonly string[]>([]);
  const isOpen = (id: string) => !!picked && (id === picked.id || id === best?.id || extra.includes(id));

  const onClick = (id: string) => {
    if (!picked) onPick(id);
    else setExtra((open) => (open.includes(id) ? open.filter((x) => x !== id) : [...open, id]));
  };

  return (
    <section className="build-decision">
      <h3>{decision.question}</h3>
      {!picked && <p className="build-hint">Pick one. The diagram shows the design as it stands now.</p>}
      {picked && picked !== best && <p className="build-hint">Not the choice this design makes. Compare the two explanations below.</p>}
      {picked && picked === best && <p className="build-hint">That is the choice this design makes. Click another option to see why it loses.</p>}
      <ul className="choices">
        {decision.choices.map((c) => (
          <li key={c.id} className={picked ? `choice-${c.verdict}` : ""}>
            <button
              className={`choice ${picked?.id === c.id ? "picked" : ""}`}
              aria-expanded={picked ? isOpen(c.id) : undefined}
              onClick={() => onClick(c.id)}
            >
              <span className="choice-label">
                <InlineMd>{c.label}</InlineMd>
              </span>
              {picked && (
                <span className="choice-tags">
                  {picked.id === c.id && <span className="choice-yours">Your pick</span>}
                  <span className="verdict">{VERDICT_LABEL[c.verdict]}</span>
                </span>
              )}
            </button>
            {isOpen(c.id) && (
              <div className="choice-feedback">
                <Md>{c.feedback}</Md>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SummaryProps {
  topic: Topic;
  evolution: Evolution;
  progress: Progress;
  onBack: () => void;
  onRestart: () => void;
}

function Summary({ topic, evolution, progress, onBack, onRestart }: SummaryProps) {
  const { right, total } = score(evolution, progress);
  const decisions = evolution.steps.filter((s) => s.decision);

  return (
    <article className="build-step">
      <p className="build-kicker">Summary</p>
      <h2>You built it</h2>
      <p className="build-intro">
        You made the same choice as this design, first time, in <strong>{right}</strong> of <strong>{total}</strong> decisions.
      </p>
      <Md>{evolution.wrapUp}</Md>

      <h3>The decisions, in order</h3>
      <ol className="build-recap">
        {decisions.map((s) => {
          const best = bestChoice(s);
          const picked = pickedChoice(s, progress);
          return (
            <li key={s.id} className={picked === best ? "right" : ""}>
              <span className="recap-problem">{s.title}</span>
              <span className="recap-fix">{best && <InlineMd>{best.label}</InlineMd>}</span>
              {picked && picked !== best && (
                <span className="recap-yours">
                  You picked: <InlineMd>{picked.label}</InlineMd>
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="build-actions">
        <button className="button" onClick={onBack}>
          ← Back
        </button>
        <Link className="button primary" to={topicPath(topic)}>
          Read the full write-up →
        </Link>
        <button className="button" onClick={onRestart}>
          Start over
        </button>
      </div>
    </article>
  );
}
